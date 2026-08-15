// Worker-thread entry for the bge embedder: runs the vendored onnxruntime-web
// WASM session entirely off the host's main thread, so embedding never blocks
// the DSH event loop (verified in the M3 spike: ~9.6 texts/sec with zero main
// thread impact). The main thread tokenizes (fast, pure JS) and posts
// id/mask/typeId buffers; this worker runs the model, computes mask-aware
// mean pooling + L2 normalization over last_hidden_state (verified 1.0000
// cosine against transformers.js), and posts back the vectors as a
// transferable ArrayBuffer.
import { parentPort, workerData } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as ort from './vendor/ort/ort.all.min.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const { modelPath, vendorDir = join(here, 'vendor', 'ort'), dim = 512 } = workerData

let session = null

async function main() {
  try {
    ort.env.wasm.wasmBinary = readFileSync(join(vendorDir, 'ort-wasm-simd-threaded.wasm'))
    ort.env.wasm.wasmPaths = {
      mjs: pathToFileURL(join(vendorDir, 'ort-wasm-simd-threaded.mjs')).href,
      wasm: pathToFileURL(join(vendorDir, 'ort-wasm-simd-threaded.wasm')).href,
    }
    ort.env.wasm.numThreads = 1
    session = await ort.InferenceSession.create(readFileSync(modelPath))
    parentPort.postMessage({ type: 'ready' })
  } catch (error) {
    parentPort.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) })
    return
  }

  parentPort.on('message', async (msg) => {
    if (msg.type !== 'embed' || !session) return
    try {
      const { batch, seqLen, ids, mask, typeIds } = msg
      const out = await session.run({
        input_ids: new ort.Tensor('int64', new BigInt64Array(ids), [batch, seqLen]),
        attention_mask: new ort.Tensor('int64', new BigInt64Array(mask), [batch, seqLen]),
        token_type_ids: new ort.Tensor('int64', new BigInt64Array(typeIds), [batch, seqLen]),
      })
      const hidden = out.last_hidden_state.data // [batch, seq, dim]
      const maskArr = new BigInt64Array(mask)
      const vectors = new Float32Array(batch * dim)
      const sum = new Float32Array(dim)
      for (let b = 0; b < batch; b += 1) {
        sum.fill(0)
        let count = 0
        for (let s = 0; s < seqLen; s += 1) {
          if (maskArr[b * seqLen + s] === 0n) continue
          const off = (b * seqLen + s) * dim
          for (let d = 0; d < dim; d += 1) sum[d] += hidden[off + d]
          count += 1
        }
        if (count === 0) count = 1
        let norm = 0
        for (let d = 0; d < dim; d += 1) {
          sum[d] /= count
          norm += sum[d] * sum[d]
        }
        norm = Math.sqrt(norm) || 1
        for (let d = 0; d < dim; d += 1) vectors[b * dim + d] = sum[d] / norm
      }
      parentPort.postMessage({ type: 'vectors', data: vectors.buffer }, [vectors.buffer])
    } catch (error) {
      parentPort.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) })
    }
  })
}

main()
