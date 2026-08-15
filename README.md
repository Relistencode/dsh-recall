# dsh-recall

Conversation history recall for DeepSeek Harness (DSH) — search the **original
text of every past conversation**, like searching chat records in a messenger.

When long projects push conversations past the context window (repeated
compaction), details get lost. `recall` brings them back: agents can search
what was actually said in any session — a decision, a setting, a past
discussion — and get matches grouped by session with the surrounding context.

## Install

```sh
dsh plugin --profile web add dsh-recall
```

Restart `dsh web`. The `recall` tool is then available to every session.

## Usage (for agents)

Call the `recall` tool with a search query:

- `query` — the text to search for (literal keyword search)
- `workspace` — optional project directory to restrict the search
- `limit` — max sessions to return (default 10)
- `context` — surrounding messages around each hit (default 3)

Results are grouped per session: title, working directory, timestamp, the
matched snippet, and the surrounding message context.

## How it works

- Registers one tool (`recall`) on `ctx.tools` via `defineTool`
- Searches through the official `ctx.sessionQuery` service
  (`@deepseek-ai/dsh-session-query-sqlite`, enabled by default in the web
  profile): FTS5 full-text over the persisted JSONL session logs, **including
  history shadowed by compaction**
- Enriches each hit with the session title (`readTitle`) and a bounded context
  window around the match (`readEvent`)

No custom indexing, no parsing of private formats — everything rides on the
official session-query API.

## Roadmap

See [PROJECT.md](PROJECT.md) for the full plan: settings-page search UI
(phase 2), checkpoint-summary registration and decision distillation
(phase 2), semantic retrieval with local embeddings (phase 3), and an
evaluation of better compaction strategies (long-term).

## License

MIT
