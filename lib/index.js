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

export const name = 'recall'

export const inject = ['tools']

// Extract human-readable text from one session event for context windows.
function eventText(event) {
  if (!event || !event.data) return ''
  const d = event.data
  if (event.type === 'user/message') {
    const c = d.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join(' ')
    }
    return ''
  }
  if (event.type === 'assistant/message') {
    const m = d.message
    if (m && typeof m.content === 'string') return m.content
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
async function runRecall(sessionQuery, args) {
  const query = normText(args.query)
  if (query === '') return { ok: false, error: 'query is required' }
  const limit = Math.min(Math.max(Number.isFinite(args.limit) ? args.limit : 10, 1), 50)
  const contextN = Math.min(Math.max(Number.isFinite(args.context) ? args.context : 3, 0), 10)

  const sessionFilters = []
  if (typeof args.workspace === 'string' && args.workspace.trim() !== '') {
    sessionFilters.push({ kind: 'cwd', values: [args.workspace.trim()] })
  }

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
    try {
      const window = await sessionQuery.readEvent({ sessionId, seq: hit.bestMatch.seq, before: contextN, after: contextN })
      if (window && Array.isArray(window.events)) {
        group.context = window.events.map((e) => ({
          seq: e.seq,
          type: e.type,
          time: e.time || null,
          text: normText(eventText(e)),
        }))
      }
    } catch {
      // context window unavailable; hits still carry the snippet
    }
    groups.push(group)
  }
  return { ok: true, query, total: groups.length, groups }
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'recall',
    description: 'Search the original text of every past conversation in DSH (like searching chat records in a messenger). Use it when details from earlier sessions are no longer in your context — a decision, a setting, a past discussion — and you need to recall what was actually said. Returns matches grouped by session, each with the surrounding message context. Results come from the persisted session logs, so they survive compaction.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'The text to search for. Plain words are best; the search is literal (no fancy syntax).',
      },
      workspace: {
        type: 'string',
        description: 'Optional working directory to restrict the search to one project (e.g. "F:\\AI\\DSH\\dsh-extension-hub"). Omit to search every session.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum sessions to return (default 10, max 50).',
      },
      context: {
        type: 'integer',
        description: 'How many surrounding messages to include around each hit (default 3, max 10).',
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
                snippet: { type: 'string', required: true },
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
          lines.push(`- ${g.title ? `${g.title} ` : ''}(${g.sessionId}${g.cwd ? `, ${g.cwd}` : ''}) — ${g.snippet}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const sessionQuery = ctx.get('sessionQuery')
      if (!sessionQuery) {
        return { ok: false, error: 'sessionQuery service unavailable (is @deepseek-ai/dsh-session-query-sqlite enabled in this profile?)' }
      }
      return runRecall(sessionQuery, args)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Recall conversation history',
      kind: 'other',
      rawInput: args.query,
    }),
  }))
}
