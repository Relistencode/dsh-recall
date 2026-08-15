// Semantic layer for dsh-recall: local bge-small-zh-v1.5 (int8 ONNX, 512-dim)
// running on the vendored onnxruntime-web WASM build inside a worker thread.
// Zero npm runtime dependencies — every file ships inside the package.
//
// Loading follows the spike-verified recipe: bundled ort entry imported
// directly, wasmBinary + object-form wasmPaths pointing at the vendor dir,
// model bytes read with fs (no fetch, no node_modules tricks). The model's
// own `sentence_embedding` output is already mean-pooled and L2-normalized,
// so cosine similarity is a plain dot product. The worker thread keeps the
// host event loop unblocked (~9.6 texts/sec measured).
//
// Licenses: BAAI/bge-small-zh-v1.5 (MIT); ONNX conversion by onnx-community
// (derived from the MIT base model); onnxruntime-web (MIT).
import { readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BertTokenizer } from './tokenizer.js'

const here = dirname(fileURLToPath(import.meta.url))
export const EMBED_DIM = 512
export const MAX_LEN = 512

const TOKENIZER_PATH = join(here, 'vendor', 'tokenizer.json')
const WORKER_URL = new URL('./embed-worker.js', import.meta.url)

/** Query-side instruction prefix recommended for bge-zh-v1.5 retrieval. */
export const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'

/** Resolve the merged ONNX model: installed models package first, then the
 *  repository's models/ directory (local development). */
export function resolveModelPath() {
  const candidates = [
    // installed as a dependency (dsh-recall-models optional dependency)
    join(here, '..', 'node_modules', 'dsh-recall-models', 'models', 'model_merged.onnx'),
    // repo development layout
    join(here, '..', 'models', 'model_merged.onnx'),
  ]
  for (const p of candidates) {
    try {
      if (readFileSync(p).length > 0) return p
    } catch {
      // try next
    }
  }
  return null
}

/**
 * Embedder: lazy worker-thread session + batched encoding.
 * Safe to call concurrently; requests are serialized through the worker.
 */
export class Embedder {
  constructor({ modelPath = resolveModelPath(), tokenizerPath = TOKENIZER_PATH, dim = EMBED_DIM } = {}) {
    this.modelPath = modelPath
    this.tokenizerPath = tokenizerPath
    this.dim = dim
    this.worker = null
    this.tokenizer = null
    this.loadPromise = null
    this.queue = []
    this.ready = false
    this.failed = null
  }

  get available() {
    return this.modelPath !== null && this.modelPath !== undefined
  }

  /** Lazily boot the worker + tokenizer (idempotent, concurrent-safe). */
  async ensureLoaded() {
    if (this.failed) throw this.failed
    if (this.worker && this.ready) return this
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        this.tokenizer = BertTokenizer.load(this.tokenizerPath)
        await new Promise((resolve, reject) => {
          const worker = new Worker(WORKER_URL, { workerData: { modelPath: this.modelPath } })
          this.worker = worker
          const onMessage = (msg) => {
            if (msg.type === 'ready') {
              this.ready = true
              resolve()
            } else if (msg.type === 'error') {
              this.failed = new Error(msg.message)
              reject(this.failed)
            }
          }
          const onError = (error) => {
            this.failed = error
            reject(error)
          }
          worker.once('message', onMessage)
          worker.once('error', onError)
        })
      })().catch((error) => {
        this.loadPromise = null
        try {
          this.worker?.terminate()
        } catch {
          // already gone
        }
        this.worker = null
        throw error
      })
    }
    return this.loadPromise
  }

  /** Terminate the worker and release resources. */
  async dispose() {
    if (this.worker) {
      try {
        await this.worker.terminate()
      } catch {
        // already terminated
      }
      this.worker = null
      this.ready = false
      this.loadPromise = null
    }
  }

  /** One round-trip to the worker. */
  _request(payload, transfer = []) {
    return new Promise((resolve, reject) => {
      const onMessage = (msg) => {
        if (msg.type === 'vectors') {
          cleanup()
          resolve(new Float32Array(msg.data))
        } else if (msg.type === 'error') {
          cleanup()
          reject(new Error(msg.message))
        }
      }
      const onError = (error) => {
        cleanup()
        reject(error)
      }
      const cleanup = () => {
        this.worker.removeListener('message', onMessage)
        this.worker.removeListener('error', onError)
      }
      this.worker.on('message', onMessage)
      this.worker.on('error', onError)
      this.worker.postMessage(payload, transfer)
    })
  }

  /**
   * Embed one text. Returns a Float32Array of `dim` (already normalized).
   */
  async embed(text) {
    const vectors = await this.embedBatch([text])
    return vectors[0]
  }

  /**
   * Embed a batch of texts (padded to the longest, capped at MAX_LEN).
   * @returns Float32Array[] of `dim` each.
   */
  async embedBatch(texts) {
    await this.ensureLoaded()
    const encoded = texts.map((t) => this.tokenizer.encode(t, { maxLen: MAX_LEN }))
    const seqLen = Math.min(MAX_LEN, Math.max(...encoded.map((e) => e.ids.length), 1))
    const batch = encoded.length
    const ids = new BigInt64Array(batch * seqLen)
    const mask = new BigInt64Array(batch * seqLen)
    const typeIds = new BigInt64Array(batch * seqLen)
    for (let b = 0; b < batch; b += 1) {
      const e = encoded[b]
      for (let i = 0; i < e.ids.length && i < seqLen; i += 1) {
        ids[b * seqLen + i] = BigInt(e.ids[i])
        mask[b * seqLen + i] = BigInt(e.mask[i])
      }
    }
    const flat = await this._request(
      { type: 'embed', batch, seqLen, ids: ids.buffer, mask: mask.buffer, typeIds: typeIds.buffer },
      [ids.buffer, mask.buffer, typeIds.buffer],
    )
    const vectors = []
    for (let b = 0; b < batch; b += 1) {
      vectors.push(flat.slice(b * this.dim, (b + 1) * this.dim))
    }
    return vectors
  }
}
