// dsh-recall fuzzy recall layer: a self-built SQLite trigram index over the
// session corpus, using only node:sqlite (zero npm dependencies).
//
// Why a second index: the official @deepseek-ai/dsh-session-query-sqlite index
// uses the unicode61 tokenizer and matches the whole query as one quoted
// phrase, so it can only find exact literal strings — for Chinese, 2-char
// phrases fail outright and "remembered roughly" queries miss. This module
// keeps its own trigram index (SQLite 3.34+, bundled since Node 22.5) plus a
// char-bigram containment rerank to cover partial / paraphrased recall.
//
// Text extraction mirrors the official @deepseek-ai/dsh-session-query
// extractSessionEventText (MIT, deepseek-ai/deepseek-harness) so the index
// sees the same conversational surface as the official search — except we
// index only user/assistant messages: tool-call arguments and results are
// noise for recall and would dominate the index.
//
// Data source: live sessions come from ctx.sessions.list() (header + events);
// persisted sessions come from the optional ctx.sessionPersistence service
// (listSnapshots + inspect), exactly like the official engine — no zstd
// decoding or log-file reading is ever done by this plugin.
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Application id protecting unrelated databases from accidental resets. */
const APPLICATION_ID = 0x52454341 // 'RECA'
const SCHEMA_VERSION = 1

/** Default index location: <dsh home>/storages/recall-index.db */
export function defaultIndexPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'recall-index.db')
}

/** Test hook: RECALL_INDEX_PATH=:memory: keeps tests off the real index. */
export function recallIndexPath() {
  return process.env.RECALL_INDEX_PATH || defaultIndexPath()
}

/** Keep only letters and numbers (drops whitespace and punctuation). */
export function stripText(text) {
  return String(text || '').replace(/[^\p{L}\p{N}]/gu, '')
}

function codePoints(text) {
  return Array.from(text)
}

function ngrams(chars, n) {
  const out = []
  for (let i = 0; i + n <= chars.length; i += 1) out.push(chars.slice(i, i + n).join(''))
  return out
}

/**
 * Extract searchable conversational text from one event.
 * Mirrors the official extractSessionEventText surface for user/assistant
 * messages (text blocks, tool-call blocks, tool-result blocks); every other
 * event type contributes no text.
 */
export function extractEventText(event) {
  if (!event || typeof event !== 'object') return ''
  switch (event.type) {
    case 'user/message':
      return contentText(event.data && event.data.content)
    case 'assistant/message':
      return event.data && event.data.message ? contentText(event.data.message.content) : ''
    default:
      return ''
  }
}

function contentText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.map(blockText).filter(Boolean).join('\n')
}

function blockText(block) {
  if (!block || typeof block !== 'object') return ''
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text.trim() : ''
    case 'tool-call':
      return [block.name, block.arguments]
        .filter((v) => v !== undefined && v !== null)
        .map((v) => String(v).trim())
        .filter(Boolean)
        .join('\n')
    case 'tool-result':
      return block.content ? contentText(block.content) : ''
    default:
      return ''
  }
}

/**
 * Build search documents for one complete event log (ascending seq order).
 * The full append-only log is indexed (including shadowed/compacted history);
 * surface classification is intentionally omitted — for recall, all history
 * must stay searchable, and foldSurface lives in the official dsh-session
 * package we choose not to depend on.
 */
export function buildSearchDocs(sessionId, events) {
  const docs = []
  for (const event of events || []) {
    const text = extractEventText(event)
    if (!text) continue
    docs.push({
      sessionId,
      seq: event.seq,
      type: event.type,
      time: event.time ?? null,
      text,
    })
  }
  return docs
}

/**
 * Cheap append-only fingerprint: events only ever grow in the JSONL log, so
 * the length plus the identity of the last event determines the state.
 */
function fingerprint(events) {
  const last = events && events.length > 0 ? events[events.length - 1] : null
  if (!last) return 'empty'
  return `${events.length}:${last.seq}:${last.time}:${last.type}`
}

/**
 * Self-built fuzzy index over session conversation text.
 * - `docs` FTS5 virtual table (trigram tokenizer) over whitespace/punctuation
 *   stripped text: arbitrary-position substring recall for >= 3 chars.
 * - `doc_texts` plain table holding original text: used for the char-bigram
 *   LIKE recall pass (covers 1-2 char queries and paraphrase overlap) and for
 *   snippets.
 * - `sessions` table tracks per-session state (fingerprint/revision/max_seq)
 *   for incremental reconciliation.
 */
export class FuzzyIndex {
  constructor(path = recallIndexPath()) {
    this.path = path === ':memory:' ? ':memory:' : resolve(path)
    this.db = null
  }

  open() {
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true })
    const db = new DatabaseSync(this.path)
    const { application_id: appId } = db.prepare('PRAGMA application_id').get()
    if (appId !== 0 && appId !== APPLICATION_ID) {
      db.close()
      throw new Error(`recall index at "${this.path}" belongs to another application`)
    }
    const { user_version: version } = db.prepare('PRAGMA user_version').get()
    if (version !== SCHEMA_VERSION) {
      db.exec('DROP TABLE IF EXISTS sessions')
      db.exec('DROP TABLE IF EXISTS doc_texts')
      db.exec('DROP TABLE IF EXISTS docs')
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }
    if (this.path !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA busy_timeout = 5000')
    }
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        cwd        TEXT,
        created_at INTEGER,
        fingerprint TEXT,
        revision   TEXT,
        max_seq    INTEGER NOT NULL DEFAULT -1
      ) STRICT
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_texts (
        rowid      INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        type       TEXT NOT NULL,
        time       INTEGER,
        text       TEXT NOT NULL
      ) STRICT
    `)
    db.exec('CREATE INDEX IF NOT EXISTS doc_texts_session ON doc_texts(session_id)')
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
        norm,
        session_id UNINDEXED,
        seq UNINDEXED,
        type UNINDEXED,
        time UNINDEXED,
        tokenize = 'trigram'
      )
    `)
    this.db = db
    return this
  }

  close() {
    if (this.db) {
      try {
        this.db.close()
      } catch {
        // already closed
      }
      this.db = null
    }
  }

  requireDb() {
    if (!this.db) throw new Error('recall index is not open')
    return this.db
  }

  /**
   * Incremental reconcile against the live + persisted corpus.
   * services: { live(): [{header, events}], snapshots(): Promise<[{header,
   * revision}]>, inspect(id): Promise<{meta, events}> }
   */
  async reconcile(services) {
    const db = this.requireDb()
    const live = (services.live ? services.live() : []) || []
    const snaps = (await (services.snapshots ? services.snapshots() : Promise.resolve([]))) || []
    const liveById = new Map(live.map((s) => [s.header.id, s]))
    const snapById = new Map(snaps.map((s) => [s.header.id, s]))
    const rows = new Map(
      db.prepare('SELECT id, fingerprint, revision, max_seq FROM sessions').all().map((r) => [r.id, r]),
    )

    const reindex = [] // full doc rebuild (live change or persisted revision change)
    const metaOnly = [] // revision-only updates for sessions already live-indexed
    for (const s of live) {
      const fp = fingerprint(s.events)
      const row = rows.get(s.header.id)
      if (!row || row.fingerprint !== fp) {
        reindex.push({
          id: s.header.id,
          header: s.header,
          events: s.events,
          fingerprint: fp,
          revision: snapById.get(s.header.id) ? snapById.get(s.header.id).revision : null,
        })
      } else {
        const rev = snapById.get(s.header.id) ? snapById.get(s.header.id).revision : null
        if (row.revision !== rev) metaOnly.push({ id: s.header.id, revision: rev })
      }
    }
    for (const s of snaps) {
      if (liveById.has(s.header.id)) continue
      const row = rows.get(s.header.id)
      if (row && row.revision === s.revision) continue
      const loaded = await services.inspect(s.header.id)
      reindex.push({
        id: s.header.id,
        header: s.header,
        events: loaded.events,
        fingerprint: null,
        revision: s.revision,
      })
    }
    const removed = [...rows.keys()].filter((id) => !liveById.has(id) && !snapById.has(id))

    if (reindex.length === 0 && metaOnly.length === 0 && removed.length === 0) return { reindexed: 0 }

    const insertData = db.prepare(
      'INSERT INTO doc_texts (session_id, seq, type, time, text) VALUES (?, ?, ?, ?, ?)',
    )
    const insertDoc = db.prepare(
      'INSERT INTO docs (rowid, norm, session_id, seq, type, time) VALUES (?, ?, ?, ?, ?, ?)',
    )
    const upsertSession = db.prepare(`
      INSERT INTO sessions (id, cwd, created_at, fingerprint, revision, max_seq)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        cwd = excluded.cwd, created_at = excluded.created_at,
        fingerprint = excluded.fingerprint, revision = excluded.revision,
        max_seq = excluded.max_seq
    `)
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const p of reindex) {
        // Append-only delta: only re-insert documents newer than max_seq.
        // A persisted rebuild must start from a clean slate (revision changed).
        const row = rows.get(p.id)
        const fromSeq = p.events === undefined || p.events === null || (row && row.fingerprint === null && p.fingerprint === null)
          ? -1
          : (row ? row.max_seq : -1)
        if (fromSeq === -1) {
          db.prepare('DELETE FROM docs WHERE session_id = ?').run(p.id)
          db.prepare('DELETE FROM doc_texts WHERE session_id = ?').run(p.id)
        }
        let maxSeq = row ? row.max_seq : -1
        for (const d of buildSearchDocs(p.id, p.events)) {
          if (d.seq <= fromSeq) continue
          const norm = stripText(d.text)
          if (!norm) continue
          const info = insertData.run(d.sessionId, d.seq, d.type, d.time, d.text)
          insertDoc.run(info.lastInsertRowid, norm, d.sessionId, d.seq, d.type, d.time)
          if (d.seq > maxSeq) maxSeq = d.seq
        }
        upsertSession.run(
          p.id,
          p.header.cwd ?? null,
          p.header.createdAt ?? null,
          p.fingerprint,
          p.revision,
          maxSeq,
        )
      }
      for (const m of metaOnly) {
        db.prepare('UPDATE sessions SET revision = ? WHERE id = ?').run(m.revision, m.id)
      }
      for (const id of removed) {
        db.prepare('DELETE FROM docs WHERE session_id = ?').run(id)
        db.prepare('DELETE FROM doc_texts WHERE session_id = ?').run(id)
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
      }
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // no transaction to roll back
      }
      throw error
    }
    return { reindexed: reindex.length }
  }

  /**
   * Fuzzy recall: trigram FTS pass + char-bigram LIKE pass, then a
   * containment rerank. Returns hits sorted by score desc, each with
   * { rowid, session_id, cwd, created_at, seq, type, time, text, score }.
   */
  search({ query, limit = 20, sessionId, cwd, minScore = 0.15 }) {
    const db = this.requireDb()
    const raw = String(query || '').trim()
    if (!raw) return []
    const q = stripText(raw)
    const chars = codePoints(q)
    const cap = Math.min(Math.max(Number.isFinite(limit) ? limit : 20, 1), 100)

    const scopeExists = (alias) =>
      sessionId
        ? ` EXISTS (SELECT 1 FROM sessions s WHERE s.id = ${alias}.session_id AND s.id = ?)`
        : cwd
          ? ` EXISTS (SELECT 1 FROM sessions s WHERE s.id = ${alias}.session_id AND s.cwd = ?)`
          : ''
    const scopeParam = sessionId || cwd

    // ── recall passes ──────────────────────────────────────────────────────
    const candidates = new Map() // rowid -> hit (first occurrence wins)
    const add = (row) => {
      if (!candidates.has(row.rowid)) candidates.set(row.rowid, row)
    }

    if (chars.length >= 3) {
      const trigrams = [...new Set(ngrams(chars, 3))]
      const expr = trigrams.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ')
      const where = scopeExists('docs') ? `WHERE docs MATCH ? AND ${scopeExists('docs')}` : 'WHERE docs MATCH ?'
      const params = [expr]
      if (scopeParam) params.push(scopeParam)
      params.push(800)
      for (const row of db.prepare(`
        SELECT docs.rowid AS rowid, docs.session_id, docs.seq, docs.type, docs.time, t.text, s.cwd AS cwd, s.created_at AS created_at
        FROM docs JOIN doc_texts t ON t.rowid = docs.rowid
        JOIN sessions s ON s.id = docs.session_id
        ${where} LIMIT ?
      `).all(...params)) add(row)
    }

    if (chars.length >= 2) {
      const bigrams = [...new Set(ngrams(chars, 2))]
      const likes = bigrams.map(() => 't.text LIKE ?').join(' OR ')
      const hitsSql = bigrams.map(() => '(CASE WHEN t.text LIKE ? THEN 1 ELSE 0 END)').join(' + ')
      const where = scopeExists('t') ? `WHERE (${likes}) AND ${scopeExists('t')}` : `WHERE (${likes})`
      const params = [...bigrams.map((b) => `%${b}%`), ...bigrams.map((b) => `%${b}%`)]
      if (scopeParam) params.push(scopeParam)
      params.push(1500)
      for (const row of db.prepare(`
        SELECT t.rowid AS rowid, t.session_id, t.seq, t.type, t.time, t.text, s.cwd AS cwd, s.created_at AS created_at, (${hitsSql}) AS like_hits
        FROM doc_texts t JOIN sessions s ON s.id = t.session_id
        ${where}
        ORDER BY like_hits DESC, t.rowid ASC
        LIMIT ?
      `).all(...params)) add(row)
    } else if (chars.length === 1) {
      const where = scopeExists('t') ? `WHERE t.text LIKE ? AND ${scopeExists('t')}` : 'WHERE t.text LIKE ?'
      const params = [`%${chars[0]}%`]
      if (scopeParam) params.push(scopeParam)
      params.push(1500)
      for (const row of db.prepare(`
        SELECT t.rowid AS rowid, t.session_id, t.seq, t.type, t.time, t.text, s.cwd AS cwd, s.created_at AS created_at
        FROM doc_texts t JOIN sessions s ON s.id = t.session_id
        ${where} LIMIT ?
      `).all(...params)) add(row)
    }

    // ── rerank: query-ngram containment ────────────────────────────────────
    const qBigrams = chars.length >= 2 ? new Set(ngrams(chars, 2)) : null
    const qTrigrams = chars.length >= 3 ? new Set(ngrams(chars, 3)) : null
    const results = []
    for (const c of candidates.values()) {
      const normChars = codePoints(stripText(c.text).slice(0, 1000))
      let score
      if (qBigrams) {
        const dBigrams = new Set(ngrams(normChars, 2))
        let hit = 0
        for (const b of qBigrams) if (dBigrams.has(b)) hit += 1
        const containment = hit / qBigrams.size
        let tri = 0
        if (qTrigrams) {
          const dTrigrams = new Set(ngrams(normChars, 3))
          for (const t of qTrigrams) if (dTrigrams.has(t)) tri += 1
          tri /= qTrigrams.size
        }
        score = 0.7 * containment + 0.3 * tri
        if (normChars.join('').includes(q)) score = Math.max(score, 0.9)
      } else {
        score = normChars.join('').includes(chars[0]) ? 0.8 : 0
      }
      if (score >= minScore) results.push({ ...c, score })
    }
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, cap)
  }

  /** Total indexed documents (tests / diagnostics). */
  stats() {
    const db = this.requireDb()
    return {
      sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
      docs: db.prepare('SELECT COUNT(*) AS n FROM doc_texts').get().n,
    }
  }
}
