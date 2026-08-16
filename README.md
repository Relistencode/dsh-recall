# dsh-recall

🌏 [中文](README.zh.md) · English

<div align="center">

**Conversation history recall plugin — a "memory maze" for your DeepSeek Harness agent**

[![Version](https://img.shields.io/badge/version-0.2.1-2563EB)](https://www.npmjs.com/package/dsh-recall)
[![License](https://img.shields.io/badge/License-MIT-22C55E)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-16A34A)](package.json)
[![Platform](https://img.shields.io/badge/DSH-web-0F172A)](https://github.com/deepseek-ai/deepseek-harness)
[![Offline](https://img.shields.io/badge/offline-100%25-0891B2)

</div>

> **AI never forgets what you told it.**

A native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that gives the agent a **memory maze** — corridors and rooms built from every conversation you have had together. Every decision, setting, discussion, or casually mentioned requirement is remembered. Ask "where were we?" and it walks the maze, brings back the conversation **verbatim**, and answers as naturally as if it had never forgotten — you won't even notice it thought for a moment.

Conversation history recall · Three-layer retrieval (literal / fuzzy / semantic) · Fully local & offline · Compaction-proof

- While searching, a quiet sweeping light appears in the corner:

  ![Recalling](assets/recalling.png)

- When done, no trace:

  ![Recall complete](assets/recall-done.png)

## Who is it for

- **Heavy users of long sessions** — conversations spanning days and hundreds of turns, too long to scroll back through
- **Writers / RP / tavern players** — settings, foreshadowing, and character relationships scattered across months of chat
- **Code & doc maintainers** — the reasoning behind past decisions and pitfalls, now reduced to a one-line summary
- **Anyone who has said "didn't we discuss this before?"** — it brings back the original words instead of making you retell them

Conversely, if your sessions are short and easy to scroll, you probably don't need it — it is built for "history too long, memory compacted" scenarios.

## Quick start

```sh
dsh plugin --profile web add dsh-recall@0.2.1
```

One command: the package ships its own composition patch (bundle layer), so the plugin and the search index it needs are wired up automatically. Restart `dsh web`. Nothing else to do — the model ships with the package (~37MB full install), the index builds on first search, and semantic warm-up finishes quietly in the background (a few minutes, imperceptible to you).

> You can also install / disable / uninstall dsh-recall from the **Add-ons** block of the Plugin Management tab in [dsh-extension-hub](https://github.com/Relistencode/dsh-extension-hub).

**Install from source (git clone):**

```sh
dsh plugin --profile web add git+https://github.com/Relistencode/dsh-recall.git
```

The repository tracks the model (`models/model_merged.onnx`) and the vendored runtime, so a git install is fully functional offline with no build step and no `allowBuilds` entry. The optional `dsh-recall-models` dependency is still attempted from npm; if it fails to resolve, the in-repo model is used instead — either way the semantic layer works. The harness resolves all paths through `$DSH_HOME` (default `~/.dsh`), so this works identically regardless of where your harness home lives.

### Optional configuration

```yaml
- id: recall
  name: dsh-recall
  config:
    semantic: false   # disable the semantic layer (literal + fuzzy only, smaller package)
    warmup: gentle    # slower warm-up, lower background CPU (only during warm-up; zero afterwards)
```

## What it is not

- ❌ **Not context engineering** — it does not cram history into the model window
- ❌ **Not prompt engineering** — it does not rely on prompts to make the model "pretend to remember"
- ❌ **Not a memory-document system** — no MEMORY.md or manual notes to maintain
- ✅ It is **actual recall**: on-demand retrieval of the **original records** — including history **already compacted away** (compaction only summarizes; the original text stays searchable forever)

## Capability overview

| Capability | Implementation |
|---|---|
| Three-layer hybrid retrieval | Literal / fuzzy / semantic merged automatically with a coverage gate (≥90%) and a silent degradation chain |
| Progressive disclosure | Light coarse recall by default (titles + snippets + events, ~100–800 tokens); `detail` drills into the original text — hit list / exact window / paged browsing |
| Event aggregation | Repeated mentions of one topic merge into events (`[startSeq..endSeq]`, ≤5 text blocks apart) — one complete episode instead of scattered fragments; the full event text is one `detail` browse away |
| Proactive recall | The agent recalls on its own when needed (after compaction, when details are missing); explicit user requests also work |
| Compaction anchor | On `compaction/summary`, one lightweight anchor is injected automatically (summary + key original fragments, expires after 3 turns) |
| Scope control | Current session only by default; `workspace` / `all` only on explicit user request |
| Compaction-proof | Index covers the full history, including shadowed (compacted) events |
| Incremental indexing | Live sessions via `ctx.sessions`, persisted via `sessionPersistence`, append-only deltas |
| Background warm-up | Worker-thread embedding (~10 texts/sec), host event loop never blocked |
| Invisible UI | "Recalling…" sweep → one quiet "Recall complete" line; results never enter the UI, the agent presents them naturally |
| Fully local & offline | Zero npm runtime dependencies; no external model APIs; works with no network at all |

## Architecture

<img src="docs/assets/recall-architecture.svg" width="100%" alt="dsh-recall architecture: turn lifecycle on top, capability layers below">

- **Turn lifecycle (top)**: one recall is a straight line — the user asks, the agent calls the `recall` tool, the three layers are searched, hits are grouped into events per session, and the agent receives either a light coarse recall or a drill-down window, depending on what it needs.
- **Retrieval layer**: three independent retrieval channels (literal / fuzzy / semantic) that merge under a coverage gate (see [Three-layer hybrid retrieval](#three-layer-hybrid-retrieval)).
- **Index & data**: everything is read through official services (`ctx.sessions` / `ctx.sessionPersistence` / `ctx.sessionQuery`) — no `.zstd` parsing, no private formats. The plugin's own `recall-index.db` (SQLite) holds the fuzzy index, the vectors and the trigram FTS.
- **Governance & scope**: the scope red line (session by default), the coverage gate, the degradation chain, and the token budget live here.
- **Automatic layer**: a `compaction/summary` listener that turns every compaction into one lightweight anchor, so the agent keeps its bearings after history is folded away.

## Core mechanisms

### Three-layer hybrid retrieval

| Layer | Technique | Covers |
|---|---|---|
| Literal | Official FTS5 full-text index | Exact keyword matches |
| Fuzzy | Self-built trigram + char-bigram index (zero dependencies) | Rough wording, remembered fragments, typos / missing chars |
| Semantic | Local bge-small-zh model (int8, 24MB, bundled) | Paraphrase, word substitution, "roughly what it was about" |

<img src="docs/assets/recall-retrieval.svg" width="100%" alt="Three-layer retrieval: query fans out to literal/fuzzy/semantic, merges through the coverage gate">

- The fuzzy layer is the **primary path** (it already covers the literal layer's ground with far more tolerance); the official FTS5 layer is the fallback; the semantic layer **joins the mix only when it covers ≥90% of the literal/fuzzy hits** — otherwise it stays silent rather than dragging the ranking down.
- Any layer failure degrades silently to the layer below — semantic → fuzzy → literal, never an error. The recall tool always answers.
- Inference runs in a **worker thread** (WASM on the main thread would block the host event loop; measured ~9.6 texts/sec with zero main-thread impact).
- Everything runs locally and offline — no external model APIs, no network.

### Progressive disclosure

Recall happens in two stages, and the second stage only fires when the agent actually needs it:

| Stage | What the agent gets | Cost |
|---|---|---|
| 1 — coarse recall (default) | Session titles + snippets + same-topic events, grouped, ranked | ~100–800 tokens for up to 10 sessions |
| 2 — `detail` drill-down | A session's hit list / the exact original-text window (`readEvent`) / paged browsing | ~300 tokens per session (e.g. a ±3 event window) |

Measured live on a real instance: coarse recall saved **~80% of tokens** versus the old full-context windows (2500–3000 → ~600 on a 10-session hit, pre-aggregation). Event aggregation keeps the same discipline — snippets only, full event text one drill-down away — so a coarse call stays under ~800 tokens. Irrelevant content never enters the context — and when it matters, the original text is always one drill-down away.

### Compaction anchors

Compaction is where memories get lost — the harness summarizes, the original text is shadowed. dsh-recall listens for `compaction/summary` and immediately injects one lightweight anchor into the compacted session:

- **Content**: the LLM summary + up to 3 key original fragments (user messages first, then longest text blocks).
- **Expiry**: after 3 assemblies, the anchor disappears — it is a bearing, not a crutch.
- **Escape hatch**: the exact original text stays one `detail` drill-down away, always.
- Verified end-to-end on a live instance: a real `/compact` produced the anchor in the very next assembly, with the correct content, expiring automatically after 3 turns.

### Scope & privacy

- Default scope is the **current session only** — cross-session (`workspace`) and cross-project (`all`) searches happen only on the user's explicit request.
- The reply layer is invisible: a quiet "Recalling…" sweep, one "Recall complete" line, nothing else. Results never enter the UI — the agent presents them naturally.
- Data stays on this machine: no external APIs, no telemetry, no network.

## Measured

### Token benefit (live, v0.2.1)

| Measurement | Result |
|---|---|
| Coarse recall cost (default) | ~100–800 tokens per call |
| Old full-context windows (10 sessions) | ~2500–3000 tokens — **3–4× more** |
| `detail` ±3 window | ~300 tokens per session |
| Compaction anchor | Verified live: real `/compact` → anchor injected next assembly, correct content, auto-expires after 3 turns |
| Semantic warm-up | ~10 texts/sec in a worker thread, host event loop zero-blocked |

### Retrieval quality (golden set)

Synthetic 4-session corpus (32 docs) with 23 hand-annotated queries (exact / fuzzy-typo / paraphrase / cross-session), run in-memory with the real model — repro: `node eval/run-golden.mjs`:

| Variant | recall@5 | MRR | nDCG@10 |
|---|---|---|---|
| Literal only (simulated official FTS5) | 0.196 | 0.217 | 0.201 |
| Fuzzy only | 0.587 | 0.652 | 0.579 |
| Semantic only | 0.533 | 0.609 | 0.529 |
| **Hybrid (production path)** | **0.696** | **0.761** | **0.687** |

- The hybrid merge beats every single layer (**+19% recall@5** over the best solo layer) — all three layers contribute, none is decoration.
- The literal layer alone is the weakest (exact match only; FTS5 unicode61 is word-splitting-blind for Chinese) — confirming its fallback role.
- The fuzzy layer is the primary path (beats semantic solo); the semantic layer adds recall on paraphrase and word-swap queries.
- **Coverage gate verified**: at half warm-up the gate correctly falls back to fuzzy-only (0.587 = fuzzy-only); running the half-warmed semantic layer anyway yields a small gain on this small corpus (0.674) — the 0.90 gate is a conservative safety default for real long sessions, not tuned to this set.
- Known misses (documented boundaries): zero literal-overlap paraphrases below the semantic min-score (e.g. "打码" for "脱敏") and abstract-concept queries (e.g. "方案").

## Recent updates

<details>
<summary>Recent updates (click to expand)</summary>

> The npm package first published as **0.1.0**; the 0.0.x entries below are development milestones.

- **2026-08** — **Result aggregation**: repeated mentions of one topic now merge into complete events (`[startSeq..endSeq]`, hits ≤5 text blocks apart; threshold measured on real index data — p50 same-topic gap 3, 61% ≤5). Coarse recall returns up to 3 events per session with the same token discipline (snippets only; full event text stays one `detail` browse away). v2 roadmap complete.
- **2026-08** — Retrieval quality evaluation: golden set (4 sessions / 32 docs / 23 hand-annotated queries) measures the production hybrid path at recall@5 **0.696** / MRR **0.761** / nDCG@10 **0.687** — +19% over the best single layer. Ablation confirms fuzzy-as-primary and literal-as-fallback; the coverage gate is verified live (half warm-up falls back to fuzzy-only). Repro: `node eval/run-golden.mjs`.
- **2026-08** — Measured live on v0.2.1: coarse recall costs ~100–600 tokens vs ~2500–3000 for the old full-context windows on a 10-session hit (~80% saved); a `detail` ±3 window costs ~300 tokens per session. Compaction anchor verified end-to-end: a real `/compact` injected the LLM summary + 3 key original fragments into the next assembly on a live instance, expiring automatically after 3 turns.
- **2026-08** — v0.2.1: fix — detail windows now extract assistant/message text blocks (block arrays) and filter by block type, so the exact original text of assistant replies appears in drill-down results (found during live verification).
- **2026-08** — v0.2.0: **progressive disclosure + manual/automatic dual mode** — `recall` returns a light coarse recall by default (titles + snippets, far fewer tokens), with a new `detail` parameter for the second stage (a session's hit list / the exact original-text window via readEvent / paged browsing); description rewritten so the agent recalls proactively (after compaction, when details are missing — no need for the user to ask), keeping the scope red line and invisible-presentation rules; **compaction anchor** — after a compaction, one lightweight anchor (LLM summary + key original fragments, expires after 3 turns) is injected automatically, with exact text always one drill-down away.
- **2026-08** — v0.1.0: first release — one-command install (`dsh.bundle.patch` wires the plugin row and enables full-text session search automatically), optional `dsh-recall-models` package for the 23.9MB embedding model (`--omit=optional` for a lightweight build), bilingual README + locale-aware UI.
- **2026-08** — v0.0.6: semantic layer — local bge-small-zh (int8, bundled, fully offline) running in a worker thread; three-layer hybrid retrieval (literal / fuzzy / semantic) with a coverage gate (≥90%) and silent degradation; background warm-up (~10 texts/sec, host event loop never blocked).
- **2026-08** — v0.0.4: fuzzy retrieval — self-built trigram + char-bigram index (zero npm dependencies): find conversations when you remember only fragments, rough wording, typos or missing characters.
- **2026-08** — v0.0.2: the `recall` tool — official FTS5 full-text search over every past session (including compacted history), grouped by session with a bounded context window; scope control (current session by default); invisible UI (Recalling… / Recall complete).

</details>

## Roadmap

**v1 · Done** — Three-layer hybrid retrieval: official FTS5 literal / self-built trigram+bigram fuzzy / local bge embedding semantic; coverage gate, background warm-up, silent degradation chain.

**v2 · Retrieval control**
- [x] **Two-stage recall (browse/detail drill-down)**: lightweight coarse recall by default (title + snippet, ~100–800 tokens); the agent picks the relevant sessions and requests full context on demand — irrelevant content never enters the context
- [x] **Compaction anchors**: on `compaction/summary`, inject one lightweight anchor (summary + key fragments) automatically; the original text stays one drill-down away
- [x] **Proactive recall**: the agent calls on its own when needed (after compaction, when details are missing); explicit user requests also work
- [x] **Result aggregation**: repeated mentions of one topic merge into complete "episodes" — consecutive hits ≤5 text blocks apart group into `[startSeq..endSeq]` events (threshold measured on real data: p50 same-topic gap = 3, 61% ≤ 5); the full event text stays one `detail` browse away

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
node .smoke-recall.mjs      # unit + integration (mocked, no model needed) — 90+ assertions
node .smoke-semantic.mjs    # real-model integration (requires models/ present)
```

Covers: tokenizer alignment (token-for-token against transformers.js), index increments, scoping, hybrid ranking, degradation, warm-up, event aggregation.

### Modules

| File | Responsibility |
|---|---|
| `lib/index.js` | Tool registration, scope resolution, hybrid ranking, session & event aggregation, warm-up scheduling |
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
