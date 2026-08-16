// Golden-set retrieval evaluation for dsh-recall.
//
// Runs the golden corpus (eval/golden.json) through every retrieval variant —
// literal (simulated official FTS5), fuzzy, semantic, hybrid merge with the
// coverage gate, and a half-warm-up gate on/off comparison — and reports
// recall@5, recall@10, MRR and nDCG@10 per variant.
//
//   node eval/run-golden.mjs
//
// The semantic layer needs the model (models/ present or dsh-recall-models
// installed); without it the semantic/hybrid variants are skipped and a
// warning is printed. Everything else runs offline on an in-memory index.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { FuzzyIndex } from '../lib/fuzzy-index.js'
import { Embedder, QUERY_PREFIX } from '../lib/semantic.js'
import { mergeHits } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const golden = JSON.parse(readFileSync(join(here, 'golden.json'), 'utf8'))

// ── corpus → events (the shape extractEventText understands) ────────────────
function toEvents(messages) {
  return messages.map((m) =>
    m.type === 'user/message'
      ? { seq: m.seq, type: m.type, time: m.time, data: { content: [{ type: 'text', text: m.text }] } }
      : { seq: m.seq, type: m.type, time: m.time, data: { message: { content: [{ type: 'text', text: m.text }] } } },
  )
}

const corpus = golden.sessions.map((s) => ({
  header: { id: s.id, cwd: s.cwd, createdAt: s.createdAt },
  events: toEvents(s.messages),
}))
const services = {
  live: () => corpus,
  snapshots: async () => [],
  inspect: async () => null,
}

const positives = golden.queries.filter((q) => q.relevant.length > 0)
const negatives = golden.queries.filter((q) => q.relevant.length === 0)
const relSet = (q) => new Set(q.relevant.map((k) => k.toLowerCase()))

// ── literal layer: simulate the official FTS5 (unicode61) pass ───────────────
function literalSearch(db, query) {
  const tokens = String(query || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (tokens.length === 0) return []
  const expr = tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ')
  const rows = db.prepare('SELECT session_id, seq, bm25(lit) AS s FROM lit WHERE lit MATCH ? ORDER BY s').all(expr)
  return rows.map((r) => ({ session_id: r.session_id, seq: r.seq, score: -r.s }))
}

// ── metrics ─────────────────────────────────────────────────────────────────
function rankKey(h) {
  return `${h.session_id}:${h.seq}`.toLowerCase()
}

function metrics(ranked, relevant) {
  const rel = relevant.size
  if (rel === 0) return null
  let r5 = 0
  let r10 = 0
  let mrr = 0
  let dcg = 0
  let idcg = 0
  for (let i = 1; i <= rel; i += 1) idcg += 1 / Math.log2(i + 1)
  let first = -1
  for (let i = 0; i < ranked.length; i += 1) {
    const k = i + 1
    const hit = relevant.has(rankKey(ranked[i]))
    if (hit) {
      if (k <= 5) r5 += 1
      if (k <= 10) r10 += 1
      if (first < 0) first = k
      dcg += 1 / Math.log2(k + 1)
    }
  }
  return {
    recall5: r5 / rel,
    recall10: r10 / rel,
    mrr: first < 0 ? 0 : 1 / first,
    ndcg10: idcg > 0 ? dcg / idcg : 0,
  }
}

function avg(variants, key) {
  const vals = variants.map((r) => r.m && r.m[key]).filter((v) => v !== null && v !== undefined)
  return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0) / vals.length
}

// ── set up the in-memory index (full + half-warm copies) ─────────────────────
const idxFull = new FuzzyIndex(':memory:').open()
const idxHalf = new FuzzyIndex(':memory:').open()
await idxFull.reconcile(services)
await idxHalf.reconcile(services)

// Literal simulation table (rowid order must match doc_texts insertion order;
// we carry session_id/seq in the table itself so alignment is explicit).
const litDb = new DatabaseSync(':memory:')
litDb.exec(`CREATE VIRTUAL TABLE lit USING fts5(text, session_id UNINDEXED, seq UNINDEXED, tokenize='unicode61')`)
for (const row of idxFull.db.prepare('SELECT rowid, session_id, seq, text FROM doc_texts').all()) {
  litDb.prepare('INSERT INTO lit (rowid, text, session_id, seq) VALUES (?, ?, ?, ?)').run(row.rowid, row.text, row.session_id, row.seq)
}

// ── semantic layer (real model when available) ───────────────────────────────
const embedder = new Embedder()
let semanticOk = false
if (embedder.available) {
  await embedder.ensureLoaded()
  semanticOk = true
  const pendingFull = idxFull.pendingVectors(1000)
  const vecsFull = await embedder.embedBatch(pendingFull.map((p) => p.text))
  idxFull.storeVectors(pendingFull.map((p, i) => ({ rowid: p.rowid, vec: vecsFull[i] })))

  const pendingHalf = idxHalf.pendingVectors(1000)
  const half = pendingHalf.slice(0, Math.floor(pendingHalf.length / 2))
  const vecsHalf = await embedder.embedBatch(half.map((p) => p.text))
  idxHalf.storeVectors(half.map((p, i) => ({ rowid: p.rowid, vec: vecsHalf[i] })))
} else {
  console.log('warning: semantic model not found — semantic & hybrid variants skipped')
}

async function semanticHits(idx, query, limit) {
  const qVec = await embedder.embed(QUERY_PREFIX + query)
  return idx.semanticSearch(qVec, limit)
}

const GATE = 0.9
const N = 10 // effective top-N for ranking (recall@10 / nDCG@10 / MRR)

// ── run every variant ────────────────────────────────────────────────────────
const results = {} // variant -> [{ q, m, top }]
async function runVariant(name, fn) {
  const rows = []
  for (const q of golden.queries) {
    const ranked = await fn(q)
    rows.push({ q: q.id, m: metrics(ranked, relSet(q)), top: ranked.slice(0, 5).map(rankKey) })
  }
  results[name] = rows
}

await runVariant('literal', (q) => literalSearch(litDb, q.q))
await runVariant('fuzzy', (q) => idxFull.search({ query: q.q, limit: N * 2 }).map((h) => ({ session_id: h.session_id, seq: h.seq, score: h.score })))

if (semanticOk) {
  await runVariant('semantic', async (q) => (await semanticHits(idxFull, q.q, N * 2)).map((h) => ({ session_id: h.session_id, seq: h.seq, score: h.score })))
  await runVariant('hybrid (gate 0.90, full warm)', async (q) => {
    const semHits = idxFull.vectorCoverage() >= GATE ? await semanticHits(idxFull, q.q, N * 2) : []
    const fuzzyHits = idxFull.search({ query: q.q, limit: N * 2 })
    return mergeHits(semHits, fuzzyHits, N).map((h) => ({ session_id: h.session_id, seq: h.seq, score: h.score }))
  })
  await runVariant('hybrid (gate 0.90, half warm)', async (q) => {
    const semHits = idxHalf.vectorCoverage() >= GATE ? await semanticHits(idxHalf, q.q, N * 2) : []
    const fuzzyHits = idxHalf.search({ query: q.q, limit: N * 2 })
    return mergeHits(semHits, fuzzyHits, N).map((h) => ({ session_id: h.session_id, seq: h.seq, score: h.score }))
  })
  await runVariant('hybrid (no gate, half warm)', async (q) => {
    const semHits = await semanticHits(idxHalf, q.q, N * 2)
    const fuzzyHits = idxHalf.search({ query: q.q, limit: N * 2 })
    return mergeHits(semHits, fuzzyHits, N).map((h) => ({ session_id: h.session_id, seq: h.seq, score: h.score }))
  })
}

// ── report ───────────────────────────────────────────────────────────────────
const docs = idxFull.stats()
console.log(`\n=== golden evaluation (eval/golden.json) ===`)
console.log(`corpus: ${docs.sessions} sessions, ${docs.docs} docs · ${positives.length} positive + ${negatives.length} negative queries`)
console.log(`semantic layer: ${semanticOk ? `enabled (coverage ${(idxFull.vectorCoverage() * 100).toFixed(0)}% full / ${(idxHalf.vectorCoverage() * 100).toFixed(0)}% half)` : 'NOT AVAILABLE'}\n`)

const names = Object.keys(results)
console.log('variant'.padEnd(34) + 'recall@5'.padStart(9) + 'recall@10'.padStart(10) + 'MRR'.padStart(8) + 'nDCG@10'.padStart(9))
for (const name of names) {
  const rows = results[name]
  const f = (k) => avg(rows, k)
  console.log(
    name.padEnd(34) +
      (f('recall5') === null ? '-'.padStart(9) : f('recall5').toFixed(3).padStart(9)) +
      (f('recall10') === null ? '-'.padStart(10) : f('recall10').toFixed(3).padStart(10)) +
      (f('mrr') === null ? '-'.padStart(8) : f('mrr').toFixed(3).padStart(8)) +
      (f('ndcg10') === null ? '-'.padStart(9) : f('ndcg10').toFixed(3).padStart(9)),
  )
}

// per-query detail for the primary (hybrid full-warm) variant
const primary = semanticOk ? 'hybrid (gate 0.90, full warm)' : 'fuzzy'
console.log(`\n=== per-query detail (${primary}) ===`)
for (const q of golden.queries) {
  const row = results[primary].find((r) => r.q === q.id)
  const rel = relSet(q)
  if (rel.size === 0) {
    const top = row.top[0] || '(none)'
    console.log(`${q.id} ${q.q}  (negative) → top1 ${top}`)
    continue
  }
  const hit = row.top.filter((k) => rel.has(k)).length
  console.log(`${q.id} ${q.q}  → ${row.top.length ? row.top.join(', ') : '(no hits)'}  · hit ${hit}/${rel.size}${hit === rel.size ? ' ✓' : ''}`)
}

// negatives: false-positive count for the primary variant
const fp = negatives.filter((q) => results[primary].find((r) => r.q === q.id).top.length > 0)
console.log(`\nnegative queries with any top-5 hit (false positives): ${fp.length}/${negatives.length} → ${fp.map((q) => q.id).join(', ') || 'none'}`)
console.log('')

// release the embedder worker, then exit (a lingering worker handle keeps the
// process alive otherwise)
if (semanticOk) {
  try { await embedder.dispose() } catch { /* already gone */ }
}
process.exit(0)
