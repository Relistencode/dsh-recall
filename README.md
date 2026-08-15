# dsh-recall

🌏 [中文](README.zh.md) · English

> **AI never forgets what you told it.**

A native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that gives the agent a **memory maze** — corridors and rooms built from every conversation you have had together. Every decision, setting, discussion, or casually mentioned requirement is remembered. Ask "where were we?" and it walks the maze, brings back the conversation **verbatim**, and answers as naturally as if it had never forgotten — you won't even notice it thought for a moment.

Conversation history recall · Three-layer retrieval (literal / fuzzy / semantic) · Fully local & offline · Compaction-proof

- While searching, a quiet sweeping light appears in the corner:

  ![Recalling](assets/recalling.png)

- When done, no trace:

  ![Recall complete](assets/recall-done.png)

## What it is not

- ❌ **Not context engineering** — it does not cram history into the model window
- ❌ **Not prompt engineering** — it does not rely on prompts to make the model "pretend to remember"
- ❌ **Not a memory-document system** — no MEMORY.md or manual notes to maintain
- ✅ It is **actual recall**: on-demand retrieval of the **original records** — including history **already compacted away** (compaction only summarizes; the original text stays searchable forever)

## Three-layer retrieval

| Layer | Technique | Covers |
|---|---|---|
| Literal | Official FTS5 full-text index | Exact keyword matches |
| Fuzzy | Self-built trigram + char-bigram index (zero dependencies) | Rough wording, remembered fragments, typos / missing chars |
| Semantic | Local bge-small-zh model (int8, 24MB, bundled) | Paraphrase, word substitution, "roughly what it was about" |

Every recall merges the three layers automatically, ranks by relevance, and groups by session. **Everything runs locally and offline** — no external model APIs.

## Quick start

```sh
dsh plugin --profile web add dsh-recall
```

One command: the package ships its own composition patch (bundle layer), so the plugin and the search index it needs are wired up automatically. Restart `dsh web`. Nothing else to do — the model ships with the package (~37MB full install), the index builds on first search, and semantic warm-up finishes quietly in the background (a few minutes, imperceptible to you).

> You can also install / disable / uninstall dsh-recall from the **Add-ons** block of the Plugin Management tab in [dsh-extension-hub](https://github.com/Relistencode/dsh-extension-hub).

### Optional configuration

```yaml
- id: recall
  name: dsh-recall
  config:
    semantic: false   # disable the semantic layer (literal + fuzzy only, smaller package)
    warmup: gentle    # slower warm-up, lower background CPU (takes longer to be ready)
```

## Feature matrix

| Capability | Description |
|---|---|
| Three-layer hybrid retrieval | Literal / fuzzy / semantic merged automatically; silent degradation chain (any failure falls back to the layer below) |
| Scope control | Current session only by default; `workspace` / `all` only on explicit user request |
| Context window | ±N original messages around every hit (configurable, default 3) |
| Compaction-proof | Index covers the full history, including shadowed (compacted) events |
| Incremental indexing | Live sessions via `ctx.sessions`, persisted via `sessionPersistence`, append-only deltas |
| Background warm-up | Worker-thread embedding (~10 texts/sec), host event loop never blocked |
| Invisible UI | "Recalling…" sweep → one quiet "Recall complete" line; results never enter the UI, the agent presents them naturally |

## Recent updates

<details>
<summary>Recent updates (click to expand)</summary>

> The npm package first published as **0.1.0**; the 0.0.x entries below are development milestones.

- **2026-08** — v0.1.0: first release — one-command install (`dsh.bundle.patch` wires the plugin row and enables full-text session search automatically), optional `dsh-recall-models` package for the 23.9MB embedding model (`--omit=optional` for a lightweight build), bilingual README + locale-aware UI.
- **2026-08** — v0.0.6: semantic layer — local bge-small-zh (int8, bundled, fully offline) running in a worker thread; three-layer hybrid retrieval (literal / fuzzy / semantic) with a coverage gate (≥90%) and silent degradation; background warm-up (~10 texts/sec, host event loop never blocked).
- **2026-08** — v0.0.4: fuzzy retrieval — self-built trigram + char-bigram index (zero npm dependencies): find conversations when you remember only fragments, rough wording, typos or missing characters.
- **2026-08** — v0.0.2: the `recall` tool — official FTS5 full-text search over every past session (including compacted history), grouped by session with a bounded context window; scope control (current session by default); invisible UI (Recalling… / Recall complete).

</details>

## How it works

```
recall tool (defineTool)
├─ Semantic: bge-small-zh int8 ONNX (23MB bundled) → worker-thread WASM inference
│            → 512-dim cosine search, joins the mix only after ≥90% coverage
├─ Fuzzy:    self-built SQLite trigram FTS + bigram LIKE + containment rerank (primary)
├─ Literal:  official ctx.sessionQuery (fallback)
└─ Mix:      semantic ∪ fuzzy, best score per doc → group by session → title + context window
```

- Data comes from official services (`ctx.sessions` / `ctx.sessionPersistence`) — no .zstd parsing, no private formats
- Index & model: `~/.dsh/storages/recall-index.db`, bundled `models/`
- Inference runs in a **worker thread** — WASM on the main thread would block the host event loop (measured: ~9.6 texts/sec with zero main-thread impact)

## Roadmap

**v1 · Now** — Three-layer hybrid retrieval: official FTS5 literal / self-built trigram+bigram fuzzy / local bge embedding semantic; coverage gate, background warm-up, silent degradation chain.

**v2 · Retrieval control**
- **`browse` mode**: read a full session forward from a hit event (paginated) — turn "recall" into "scrolling the chat log"
- **Two-stage recall**: lightweight coarse recall by default (title + snippet, ~600 tokens); the agent picks the relevant sessions and requests full context on demand — irrelevant content never enters the context
- **Time-range filters**: constrain retrieval by message time windows
- **Result aggregation**: merge repeated mentions of one topic into a complete "episode" instead of scattered hits
- **Compaction anchors**: subscribe to `compaction/summary` log events, register summaries as searchable anchors, restore originals via `shadowedSeqs`

**v3 · Memory organization**
- **Topic clustering**: embed similarity clustering, present results grouped by topic
- **Memory distillation**: extract settings & decisions across sessions into durable long-term memory
- Longer term: evaluate topic-based / layered compaction mechanisms — evaluation only, no changes to DSH core

## Known boundaries

- Semantic bridging for very short queries (≤4 chars) is weak (bge short-text cosine has limited separation); the fuzzy layer's LIKE fallback covers it
- Semantic ranking is not fully reliable for queries with zero literal overlap — the fuzzy layer is always the primary path, and the agent makes the final call
- The model is int8-quantized: semantic quality is "good enough" by design; swap in an fp32 model (~4× size) for maximum quality

## Development & testing

```sh
node .smoke-recall.mjs      # unit + integration (mocked, no model needed) — 60+ assertions
node .smoke-semantic.mjs    # real-model integration (requires models/ present)
```

Covers: tokenizer alignment (token-for-token against transformers.js), index increments, scoping, hybrid ranking, degradation, warm-up.

### Modules

| File | Responsibility |
|---|---|
| `lib/index.js` | Tool registration, scope resolution, hybrid ranking, session aggregation, warm-up scheduling |
| `lib/fuzzy-index.js` | Self-built SQLite index (trigram FTS + bigram + vector table), zero npm dependencies |
| `lib/tokenizer.js` | BERT WordPiece tokenizer (pure JS, token-for-token aligned with the reference) |
| `lib/semantic.js` | Embedder: worker thread, batched embedding, lazy loading |
| `lib/embed-worker.js` | WASM inference + mask-aware mean pooling + L2 normalization inside the worker |
| `lib/vendor/` | Vendored onnxruntime-web (0.8MB entry + 12MB wasm) + tokenizer.json |
| `models/` | Merged single-file int8 model (23MB; split into an optional package at publish) |
| `lib/client.js` | Minimal ToolView ("Recalling…" / "Recall complete"), locale-aware zh/en |

### Publish structure

- `dsh-recall` — main package (code + vendored runtime + tokenizer)
- `dsh-recall-models` — optional dependency (23MB model); npm installs it by default; `--omit=optional` yields the lightweight build, which degrades silently when the model is absent

## References & acknowledgments

- Official: `@deepseek-ai/dsh-session-query(-sqlite)`, `dsh-tools`, `dsh-session-persistence`
- Model: BAAI/bge-small-zh-v1.5 (MIT) · onnx-community int8 export · onnxruntime-web (MIT)
- Ecosystem: [dsh-plugin-recall](https://github.com/truelove-dreamer/dsh-plugin-recall) (official-FTS recall tool), [dsh-mneme](https://github.com/modusensus/dsh-mneme) (local semantic memory, hybrid-recall degradation ideas)

## License

MIT
