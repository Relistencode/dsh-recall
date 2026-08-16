// dsh-recall host entry: registers the `recall` tool on ctx.tools.
//
// The tool searches the ORIGINAL text of every DSH session through the
// official `ctx.sessionQuery` service (FTS5, auto-indexed from the persisted
// JSONL logs — including history shadowed by compaction). Results are grouped
// per session with the surrounding context window, like searching chat
// records and opening the relevant messages.
//
// Registered per Cordis plugin convention: named exports { name, inject,
// apply } — the loader mounts this package through a patch row
// `- id: recall / name: dsh-recall`.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FuzzyIndex, recallIndexPath, stripText } from './fuzzy-index.js'
import { Embedder, QUERY_PREFIX } from './semantic.js'

export const name = 'recall'

export const inject = ['tools', 'sessions']

/** Semantic index is used only once at least this fraction of docs are embedded. */
const SEMANTIC_READY_COVERAGE = 0.9

// Extract human-readable text from one session event for context windows.
function eventText(event) {
  if (!event || !event.data) return ''
  const d = event.data
  if (event.type === 'user/message') {
    const c = d.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .filter(Boolean)
        .join(' ')
    }
    return ''
  }
  if (event.type === 'assistant/message') {
    const m = d.message
    const c = m && m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .filter(Boolean)
        .join(' ')
    }
    return ''
  }
  if (event.type === 'tool/call') {
    return `[tool:${d.name}] ${typeof d.arguments === 'string' ? d.arguments : ''}`
  }
  return `[${event.type}]`
}

function normText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

/**
 * Run one recall search: normalize the query, call searchSessions with
 * optional workspace filtering, then enrich each hit with the session title
 * and a bounded context window around its strongest match.
 */
async function runRecall(sessionQuery, args, exec, services = {}) {
  const query = normText(args.query)
  if (query === '') return { ok: false, error: 'query is required' }
  const limit = Math.min(Math.max(Number.isFinite(args.limit) ? args.limit : 10, 1), 50)
  const contextN = Math.min(Math.max(Number.isFinite(args.context) ? args.context : 3, 0), 10)

  // Second stage (progressive disclosure): drill into one session's original
  // text. When present, everything else (scope filters) is bypassed — the
  // target session is explicitly user-provided.
  const detail = args.detail && typeof args.detail === 'object' ? args.detail : null
  if (detail) return runDetail(sessionQuery, query, limit, contextN, detail, services)

  // Scope resolution. The DEFAULT is the current session only — an agent must
  // never broaden the search on its own; cross-session/cross-project recall
  // happens only when the user explicitly asks (scope=workspace | all).
  const scopeArg = typeof args.scope === 'string' ? args.scope : ''
  const scope = scopeArg === 'session' || scopeArg === 'workspace' || scopeArg === 'all' ? scopeArg : null
  const agentSession = exec && exec.agent && exec.agent.session ? exec.agent.session : null
  const sessionId = agentSession ? agentSession.id : null
  const agentCwd = agentSession && agentSession.header ? agentSession.header.cwd : null
  const explicitCwd = typeof args.workspace === 'string' && args.workspace.trim() !== '' ? args.workspace.trim() : null

  // The same scope expressed twice: id/cwd filters for the fuzzy index and
  // sessionFilters for the official literal search.
  let fuzzySessionId = null
  let fuzzyCwd = null
  const sessionFilters = []
  if (scope === 'all') {
    // no session filters — every session is searched
  } else if (scope === 'workspace') {
    const cwd = explicitCwd || agentCwd
    if (cwd) {
      sessionFilters.push({ kind: 'cwd', values: [cwd] })
      fuzzyCwd = cwd
    }
  } else if (scope === 'session') {
    if (sessionId) {
      sessionFilters.push({ kind: 'id', values: [sessionId] })
      fuzzySessionId = sessionId
    } else {
      const cwd = explicitCwd || agentCwd
      if (cwd) {
        sessionFilters.push({ kind: 'cwd', values: [cwd] })
        fuzzyCwd = cwd
      }
    }
  } else {
    // default: current session, falling back to the current workspace
    if (sessionId) {
      sessionFilters.push({ kind: 'id', values: [sessionId] })
      fuzzySessionId = sessionId
    } else {
      const cwd = explicitCwd || agentCwd
      if (cwd) {
        sessionFilters.push({ kind: 'cwd', values: [cwd] })
        fuzzyCwd = cwd
      }
    }
  }

  // ── fuzzy index path (primary; degrades to the official literal search) ──
  if (services.fuzzy) {
    try {
      await services.fuzzy.reconcile({
        live: services.live,
        snapshots: services.snapshots,
        inspect: services.inspect,
      })
    } catch (error) {
      services.fuzzy = null
    }
  }
  if (services.fuzzy) {
    try {
      // Semantic layer: incremental warm-up (worker-thread, host stays
      // responsive), then — once coverage is complete — semantic hits merged
      // with the fuzzy hits. Any semantic failure silently degrades to
      // fuzzy-only.
      let semHits = []
      if (services.embedder && services.embedder.available && services.semanticEnabled !== false) {
        try {
          await services.embedder.ensureLoaded()
          const pending = services.fuzzy.pendingVectors(services.semanticBudget ?? 48)
          if (pending.length > 0) {
            const vecs = await services.embedder.embedBatch(pending.map((p) => p.text))
            services.fuzzy.storeVectors(pending.map((p, i) => ({ rowid: p.rowid, vec: vecs[i] })))
          }
          if (services.fuzzy.vectorCoverage() >= SEMANTIC_READY_COVERAGE) {
            const qVec = await services.embedder.embed(QUERY_PREFIX + query)
            semHits = services.fuzzy.semanticSearch(qVec, limit * 3, { sessionId: fuzzySessionId, cwd: fuzzyCwd })
          }
        } catch {
          // semantic unavailable: fuzzy-only below
        }
      }
      const fuzzyHits = services.fuzzy.search({ query, limit: limit * 3, sessionId: fuzzySessionId, cwd: fuzzyCwd })
      const hits = mergeHits(semHits, fuzzyHits, limit)
      if (hits.length > 0) {
        const groups = await buildGroups(sessionQuery, hits, { limit, contextN, query })
        return { ok: true, query, total: groups.length, groups }
      }
    } catch {
      // fuzzy search failed: degrade to the official literal search below
    }
  }

  // ── official literal search (phase-1 path, also the degradation target) ──
  let page
  try {
    page = await sessionQuery.searchSessions({ query, sessionFilters: sessionFilters.length ? sessionFilters : undefined, limit })
  } catch (error) {
    return { ok: false, error: `search failed: ${error && error.message ? error.message : String(error)}` }
  }

  const hits = (page && Array.isArray(page.items) ? page.items : []).filter((h) => h && h.header && h.bestMatch)
  const groups = []
  for (const hit of hits) {
    const sessionId = hit.header.id
    const group = {
      sessionId,
      cwd: hit.header.cwd || null,
      createdAt: hit.header.createdAt || null,
      hitTime: hit.bestMatch.time || null,
      snippet: normText(hit.bestMatch.snippet),
      context: [],
    }
    try {
      const title = await sessionQuery.readTitle(sessionId)
      if (title && typeof title.title === 'string') group.title = title.title
    } catch {
      // title unavailable; keep the group without one
    }
    groups.push(group)
  }
  return { ok: true, query, total: groups.length, groups }
}

/**
 * Second stage (progressive disclosure): drill into one session's ORIGINAL
 * text. Three shapes:
 *   detail:{sessionId}                  — all hits inside that session (light)
 *   detail:{sessionId, seq, before, after} — exact original window around one seq
 *   detail:{sessionId, browse, fromSeq, pageSize} — page through the session
 * The target session is explicit user-provided, so no scope filter applies.
 */
async function runDetail(sessionQuery, query, limit, contextN, detail, services) {
  const sessionId = typeof detail.sessionId === 'string' && detail.sessionId !== '' ? detail.sessionId : null
  if (!sessionId) return { ok: false, error: 'detail.sessionId is required' }
  let title = null
  try {
    const t = await sessionQuery.readTitle(sessionId)
    if (t && typeof t.title === 'string' && t.title) title = t.title
  } catch {
    // title unavailable
  }

  // ── browse: page through the session's text blocks ──────────────────────
  if (detail.browse === true) {
    const fromSeq = Number.isFinite(detail.fromSeq) ? Math.max(0, Math.floor(detail.fromSeq)) : 0
    const pageSize = Math.min(Math.max(Number.isFinite(detail.pageSize) ? detail.pageSize : 20, 1), 50)
    if (services.fuzzy) {
      try {
        await services.fuzzy.reconcile({ live: services.live, snapshots: services.snapshots, inspect: services.inspect })
      } catch {
        services.fuzzy = null
      }
    }
    if (services.fuzzy) {
      try {
        const { rows, nextFromSeq } = services.fuzzy.browse(sessionId, fromSeq, pageSize)
        const group = {
          sessionId,
          title,
          context: rows.map((r) => ({ seq: r.seq, type: r.type, time: r.time || null, text: normText(r.text) })),
        }
        if (nextFromSeq !== null) group.nextFromSeq = nextFromSeq
        return { ok: true, query, total: 1, groups: [group] }
      } catch {
        // fall through to the official read
      }
    }
    try {
      const docs = await sessionQuery.filterEvents(sessionId, [{ kind: 'seq', range: { gte: fromSeq, lte: fromSeq + pageSize - 1 } }])
      const events = Array.isArray(docs) ? docs : []
      const group = {
        sessionId,
        title,
        context: events.map((d) => ({ seq: d.seq, type: d.type, time: d.time || null, text: normText(d.text) })),
      }
      if (events.length === pageSize) group.nextFromSeq = fromSeq + pageSize
      return { ok: true, query, total: 1, groups: [group] }
    } catch (error) {
      return { ok: false, error: `browse failed: ${error && error.message ? error.message : String(error)}` }
    }
  }

  // ── exact original-text window around one seq ───────────────────────────
  if (Number.isFinite(detail.seq)) {
    const seq = Math.floor(detail.seq)
    const before = Math.min(Math.max(Number.isFinite(detail.before) ? detail.before : contextN, 0), 10)
    const after = Math.min(Math.max(Number.isFinite(detail.after) ? detail.after : contextN, 0), 10)
    try {
      const window = await sessionQuery.readEvent({ sessionId, seq, before, after })
      const group = { sessionId, title }
      const header = window && window.session ? window.session.header : null
      if (header) {
        group.cwd = header.cwd || null
        group.createdAt = header.createdAt || null
      }
      group.context = (window && Array.isArray(window.events) ? window.events : []).map((e) => ({
        seq: e.seq,
        type: e.type,
        time: e.time || null,
        text: normText(eventText(e)),
      }))
      return { ok: true, query, total: 1, groups: [group] }
    } catch (error) {
      return { ok: false, error: `detail failed: ${error && error.message ? error.message : String(error)}` }
    }
  }

  // ── all hits inside one session (light list) ────────────────────────────
  try {
    const hits = await detailSessionHits(sessionQuery, query, limit, sessionId, services)
    const group = {
      sessionId,
      title,
      context: hits.map((h) => ({ seq: h.seq, type: h.type || 'text', time: h.time || null, text: makeFuzzySnippet(h.text, query) })),
    }
    if (hits.length > 0) {
      group.cwd = hits[0].cwd || null
      group.createdAt = hits[0].created_at || null
    }
    return { ok: true, query, total: 1, groups: [group] }
  } catch (error) {
    return { ok: false, error: `detail failed: ${error && error.message ? error.message : String(error)}` }
  }
}

/** All hits inside one explicit session (semantic ∪ fuzzy, official fallback). */
async function detailSessionHits(sessionQuery, query, limit, sessionId, services) {
  if (services.fuzzy) {
    try {
      await services.fuzzy.reconcile({ live: services.live, snapshots: services.snapshots, inspect: services.inspect })
    } catch {
      services.fuzzy = null
    }
  }
  if (services.fuzzy) {
    try {
      let semHits = []
      if (services.embedder && services.embedder.available && services.semanticEnabled !== false) {
        try {
          await services.embedder.ensureLoaded()
          const pending = services.fuzzy.pendingVectors(services.semanticBudget ?? 48)
          if (pending.length > 0) {
            const vecs = await services.embedder.embedBatch(pending.map((p) => p.text))
            services.fuzzy.storeVectors(pending.map((p, i) => ({ rowid: p.rowid, vec: vecs[i] })))
          }
          if (services.fuzzy.vectorCoverage() >= SEMANTIC_READY_COVERAGE) {
            const qVec = await services.embedder.embed(QUERY_PREFIX + query)
            semHits = services.fuzzy.semanticSearch(qVec, limit * 3, { sessionId })
          }
        } catch {
          // semantic unavailable: fuzzy-only
        }
      }
      const fuzzyHits = services.fuzzy.search({ query, limit: limit * 3, sessionId })
      return mergeHits(semHits, fuzzyHits, limit)
    } catch {
      // fall through to the official search
    }
  }
  const page = await sessionQuery.searchEvents({ sessionId, query, limit })
  const items = (page && Array.isArray(page.items) ? page.items : []).filter((h) => h && Number.isFinite(h.seq))
  return items.map((h) => ({
    session_id: sessionId,
    seq: h.seq,
    type: h.type,
    time: h.time,
    text: typeof h.snippet === 'string' ? h.snippet : '',
    cwd: null,
    created_at: null,
    score: 1,
  }))
}

/**
 * Bounded snippet windowed around the first query fragment occurrence.
 */
function makeFuzzySnippet(text, query) {
  const maxChars = 240
  const clean = normText(text)
  const chars = Array.from(clean)
  if (chars.length <= maxChars) return clean
  const q = stripText(query)
  let at = -1
  if (q) {
    for (let len = Math.min(q.length, 24); len >= 2 && at < 0; len -= 1) {
      at = clean.indexOf(q.slice(0, len))
      if (at < 0) at = clean.indexOf(q.slice(q.length - len))
    }
  }
  const matchAt = at >= 0 ? at : 0
  const start = Math.max(0, matchAt - Math.floor(maxChars / 3))
  const prefix = start > 0 ? '…' : ''
  const end = Math.min(chars.length, start + maxChars - prefix.length - 1)
  const suffix = end < chars.length ? '…' : ''
  return `${prefix}${chars.slice(start, end).join('')}${suffix}`
}

/**
 * Merge semantic and fuzzy hits (both score-sorted 0..1) by doc rowid,
 * keeping the best score per doc. Returns up to limit*2 candidates.
 */
export function mergeHits(semHits, fuzzyHits, limit) {
  const byRowid = new Map()
  for (const h of fuzzyHits) byRowid.set(h.rowid, h)
  for (const h of semHits) {
    const existing = byRowid.get(h.rowid)
    if (!existing) byRowid.set(h.rowid, h)
    else if (h.score > existing.score) existing.score = h.score
  }
  return [...byRowid.values()].sort((a, b) => b.score - a.score).slice(0, limit * 2)
}

/**
 * Build coarse-recall output groups from score-sorted hits: best hit per
 * session, enriched with the session title and a short snippet — NO context
 * window (progressive disclosure: the second stage via detail drills into
 * the original text when needed).
 */
async function buildGroups(sessionQuery, hits, { limit, contextN, query }) {
  const bestBySession = new Map()
  for (const hit of hits) {
    if (!bestBySession.has(hit.session_id)) bestBySession.set(hit.session_id, hit)
  }
  const groups = []
  for (const [hitSessionId, hit] of bestBySession) {
    if (groups.length >= limit) break
    const group = {
      sessionId: hitSessionId,
      cwd: hit.cwd || null,
      createdAt: hit.created_at || null,
      hitTime: hit.time || null,
      snippet: makeFuzzySnippet(hit.text, query),
      context: [],
    }
    try {
      const title = await sessionQuery.readTitle(hitSessionId)
      if (title && typeof title.title === 'string') group.title = title.title
    } catch {
      // title unavailable; keep the group without one
    }
    groups.push(group)
  }
  return groups
}

/** Background warm-up tick: embed a bounded batch, yield between chunks. */
async function warmupTick(embedder, fuzzy, warmup) {
  if (!embedder || !fuzzy) return
  try {
    await embedder.ensureLoaded()
    const budget = warmup === 'gentle' ? 16 : 64
    const pending = fuzzy.pendingVectors(budget)
    if (pending.length === 0) return
    const batchSize = 16
    for (let i = 0; i < pending.length; i += batchSize) {
      const chunk = pending.slice(i, i + batchSize)
      const vecs = await embedder.embedBatch(chunk.map((p) => p.text))
      fuzzy.storeVectors(chunk.map((p, j) => ({ rowid: p.rowid, vec: vecs[j] })))
      await new Promise((resolve) => setImmediate(resolve))
    }
  } catch {
    // silent: semantic warm-up failures never surface
  }
}

/**
 * Build the compaction anchor text for one compaction/summary event: the
 * LLM-written summary plus up to three key original fragments picked from
 * the shadowed seq range (pure-local heuristics — user messages first, then
 * the longest texts; no external LLM).
 */
export async function buildAnchorText(sessionQuery, sessionId, summaryEvent) {
  const data = summaryEvent && summaryEvent.data ? summaryEvent.data : {}
  const lines = []
  const summary = typeof data.summary === 'string' ? data.summary.trim() : ''
  if (summary) lines.push(`摘要:${summary.slice(0, 400)}`)
  const range = data.shadowedRange
  if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
    try {
      const docs = await sessionQuery.filterEvents(sessionId, [{ kind: 'seq', range: { gte: range.start, lte: range.end } }])
      const candidates = (Array.isArray(docs) ? docs : [])
        .filter(
          (d) =>
            d &&
            (d.type === 'user/message' || d.type === 'assistant/message') &&
            typeof d.text === 'string' &&
            d.text.trim().length > 0,
        )
        .map((d) => ({ seq: d.seq, type: d.type, text: normText(d.text) }))
      candidates.sort((a, b) =>
        a.type === b.type ? b.text.length - a.text.length : a.type === 'user/message' ? -1 : 1,
      )
      for (const p of candidates.slice(0, 3)) {
        const who = p.type === 'user/message' ? '你' : '助手'
        lines.push(`[${who}#${p.seq}] ${p.text.slice(0, 160)}`)
      }
    } catch {
      // fragments unavailable; the summary alone still anchors the range
    }
  }
  lines.push('以上为本会话被压缩区间的摘要与关键原文片段。需要精确原文时用 recall 工具下钻:detail:{sessionId, seq} 或 detail:{sessionId, browse:true}。')
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  // Lazily-opened self-built fuzzy index (see lib/fuzzy-index.js). `fuzzy` is
  // null before first use, the index instance after a successful open, and
  // `false` after a failed open (retried on the next call).
  let fuzzy = null
  const getFuzzy = () => {
    if (fuzzy === null) {
      const candidate = new FuzzyIndex(recallIndexPath())
      try {
        candidate.open()
        fuzzy = candidate
      } catch {
        try {
          candidate.close()
        } catch {
          // already closed
        }
        fuzzy = false
      }
    }
    return fuzzy || null
  }

  // Semantic layer (optional by configuration; model must be present).
  const semanticEnabled = config.semantic !== false
  const warmup = config.warmup === 'gentle' ? 'gentle' : 'fast'
  let embedder = null
  const getEmbedder = () => {
    if (!semanticEnabled) return null
    if (embedder === null) {
      const candidate = new Embedder()
      if (!candidate.available) return null
      embedder = candidate
    }
    return embedder
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      if (fuzzy) {
        try {
          fuzzy.close()
        } catch {
          // already closed
        }
      }
      fuzzy = null
      if (embedder) {
        embedder.dispose().catch(() => {})
        embedder = null
      }
    })
  }
  // Background warm-up: a plain setTimeout chain (no service dependency —
  // inject is for REQUIRED services only; a missing timer service must not
  // block the plugin). Embedding runs in a worker thread, so the host event
  // loop stays responsive. Disposed with the plugin fiber.
  let warmupTimer = null
  const scheduleWarmup = () => {
    warmupTimer = setTimeout(async () => {
      try {
        await warmupTick(getEmbedder(), getFuzzy(), warmup)
      } catch {
        // warm-up failures never surface
      }
      scheduleWarmup()
    }, 30000)
  }
  scheduleWarmup()
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      if (warmupTimer !== null) clearTimeout(warmupTimer)
    })
  }

  // ── compaction anchor injection (automatic layer) ────────────────────────
  // After a compaction, inject ONE lightweight anchor (the LLM-written
  // summary + a few key original fragments) into the compacted session's
  // agent for the next few assemblies. The exact original text stays one
  // recall detail() drill-down away — progressive disclosure, not a memory
  // dump. Best-effort: any failure silently degrades to no anchor.
  const anchorEnabled = config.anchor !== false
  if (anchorEnabled && typeof ctx.on === 'function') {
    const anchors = new Map() // sessionId -> { text, rounds }
    ctx.on('session/disposed', (session) => {
      if (session) anchors.delete(session.id)
    })
    ctx.on('session/event', (session, event) => {
      if (!event || event.type !== 'compaction/summary') return
      const sessionId = session ? session.id : null
      if (!sessionId) return
      const sessionQuerySvc = ctx.get('sessionQuery')
      if (!sessionQuerySvc || typeof sessionQuerySvc.filterEvents !== 'function') return
      try {
        if (!anchors.has(sessionId)) {
          const agentsSvc = ctx.get('agents')
          const agent = agentsSvc && typeof agentsSvc.get === 'function' ? agentsSvc.get(sessionId) : null
          if (agent && agent.ctx && agent.ctx.systemPrompt && typeof agent.ctx.systemPrompt.context === 'function') {
            const entry = { text: '', rounds: 0 }
            anchors.set(sessionId, entry)
            agent.ctx.systemPrompt.context({
              name: 'recall-anchor',
              order: 500,
              text: () => {
                if (entry.rounds <= 0) return ''
                entry.rounds -= 1
                return entry.text
              },
            })
          }
        }
      } catch {
        // anchor registration is best-effort
      }
      buildAnchorText(sessionQuerySvc, sessionId, event)
        .then((text) => {
          const entry = anchors.get(sessionId)
          if (entry) {
            entry.text = text
            entry.rounds = 3
          }
        })
        .catch(() => {})
    })
  }

  ctx.tools.register(defineTool({
    name: 'recall',
    description: 'Search the original text of past conversations in DSH (like searching chat records in a messenger). Use it proactively whenever details from earlier turns are missing from your context — after context compaction, or when a decision, a setting, or a past discussion matters — and whenever the user mentions something from before. You do not need the user to ask for it.\n\nTWO STAGES (keeps tokens low): the default call is a light coarse recall — session titles and short snippets only. Use it to locate the right session, then call again with detail:{sessionId} to list that session\'s hits, detail:{sessionId, seq} to open the exact original text around a message, or detail:{sessionId, browse:true} to read the session page by page.\n\nSCOPE: by default this searches ONLY the current session. Do NOT broaden the scope on your own — searching other sessions or other projects happens only when the user explicitly asks (e.g. "check what the other window worked on", "look at the recall project", "search our history for ..."). Pass scope=workspace to search the current project or scope=all to search every session in those cases.\n\nPRESENTATION: the recall itself must be invisible. Never narrate the act of searching or remembering (\'let me recall\', \'I checked the history\', \'we discussed this before\') and never emit result scaffolding. Fold the recalled content directly into a normal, confident reply, exactly as if you always knew it — the user should not be able to tell that a search happened.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'The text to search for. Plain words are best; the search is literal (no fancy syntax).',
      },
      scope: {
        type: 'string',
        enum: ['session', 'workspace', 'all'],
        description: 'Search scope. Default "session" (current session only). "workspace" searches the current project directory (or the directory given in `workspace`); "all" searches every session. Broaden the scope ONLY when the user explicitly asks.',
      },
      workspace: {
        type: 'string',
        description: 'Optional project directory to restrict a workspace-scoped search to (e.g. "F:\\AI\\DSH\\dsh-extension-hub"). Ignored for scope=session.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum sessions to return (default 10, max 50).',
      },
      context: {
        type: 'integer',
        description: 'Events around the opened seq when using detail (default 3, max 10). Ignored by the coarse recall.',
      },
      detail: {
        type: 'object',
        additionalProperties: false,
        description: 'Second stage: drill into one session\'s original text. detail:{sessionId} lists that session\'s hits; detail:{sessionId, seq, before, after} opens the exact original text window around a message; detail:{sessionId, browse:true, fromSeq, pageSize} pages through the session.',
        properties: {
          sessionId: { type: 'string', description: 'Session id from a previous coarse recall.' },
          seq: { type: 'integer', description: 'Message seq to open its exact original window.' },
          before: { type: 'integer', description: 'Events before seq (default 3, max 10).' },
          after: { type: 'integer', description: 'Events after seq (default 3, max 10).' },
          browse: { type: 'boolean', description: 'Page through the session starting at fromSeq.' },
          fromSeq: { type: 'integer', description: 'First seq of the browse page (default 0).' },
          pageSize: { type: 'integer', description: 'Browse page size (default 20, max 50).' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          query: { type: 'string' },
          total: { type: 'integer' },
          groups: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                title: { type: 'string' },
                cwd: { type: 'string' },
                createdAt: { type: 'integer' },
                hitTime: { type: 'integer' },
                snippet: { type: 'string' },
                nextFromSeq: { type: 'integer', description: 'Browse mode only: first seq of the next page; absent when the log ended.' },
                context: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      seq: { type: 'integer', required: true },
                      type: { type: 'string', required: true },
                      time: { type: 'integer' },
                      text: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value || value.ok === false) {
          return [{ type: 'text', text: `Recall failed: ${value && value.error ? value.error : 'unknown error'}` }]
        }
        const lines = [`Recall "${value.query}": ${value.total} session(s) matched.`]
        for (const g of value.groups || []) {
          if (g.context && g.context.length > 0) {
            // detail stage: render the original text itself
            lines.push(`- ${g.title ? `${g.title} ` : ''}(${g.sessionId})`)
            for (const c of g.context) {
              lines.push(`  [${c.seq} ${c.type}] ${String(c.text || '').slice(0, 240)}`)
            }
            if (g.nextFromSeq !== undefined) lines.push(`  → next page from seq ${g.nextFromSeq}`)
          } else {
            lines.push(`- ${g.title ? `${g.title} ` : ''}(${g.sessionId}${g.cwd ? `, ${g.cwd}` : ''}) — ${g.snippet}`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const sessionQuery = ctx.get('sessionQuery')
      if (!sessionQuery) {
        return { ok: false, error: 'sessionQuery service unavailable (is @deepseek-ai/dsh-session-query-sqlite enabled in this profile?)' }
      }
      const fuzzyIndex = ctx.get('sessions') ? getFuzzy() : null
      const persistence = ctx.get('sessionPersistence')
      const services = {
        fuzzy: fuzzyIndex,
        embedder: getEmbedder(),
        semanticEnabled,
        semanticBudget: warmup === 'gentle' ? 16 : 48,
        live: () => {
          try {
            return ctx.sessions.list()
          } catch {
            return []
          }
        },
        snapshots: async () => {
          if (!persistence || typeof persistence.listSnapshots !== 'function') return []
          try {
            return await persistence.listSnapshots()
          } catch {
            return []
          }
        },
        inspect: async (id) => {
          if (!persistence || typeof persistence.inspect !== 'function') {
            throw new Error('sessionPersistence service unavailable')
          }
          return persistence.inspect(id)
        },
      }
      return runRecall(sessionQuery, args, exec, services)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Recall conversation history',
      kind: 'other',
      rawInput: args.query,
    }),
  }))
}
