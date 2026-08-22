# dsh-compaction-tool

**Offload context compaction to a fast secondary model.**

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) plugin that decouples **context compression** from your main model. The main model keeps thinking and answering; a lightweight, fast model does the summarization — so compaction stays snappy and never times out, even when the main model is a slow local LLM.

> 🇨🇳 中文文档见 **[README.zh.md](./README.zh.md)**

---

## Why?

DSH's built-in compaction (`dsh-compaction-basic`) uses the **session's main model** for summarization. When that model is slow (a local 27B doing a long prefill), every compaction is a multi-minute wait that blocks the conversation. This plugin routes the summary call to a **separately selected, fast model** — the same model you pick in the settings panel, with zero hardcoding.

## Entry Points

| Entry | Who uses it | What it does |
|-------|-----------|-------------|
| **`compress_context`** | The main model (tool call) | Summarizes older history into a durable checkpoint when context is running low |
| **`/compact`** | You (slash command) | Forces a compaction immediately |
| **Settings → Compaction** | You (UI panel) | Pick the compaction model and tune every parameter — all live, no restart |
| **Auto-compaction** *(optional)* | The harness | Pressure-driven `agent/pre-step` hook, off by default |

## All Settings Are UI-Editable (No Hardcoding)

Every compaction setting lives in a single settings namespace (`compaction`) — the same mechanism the main-model selector uses:

- **Settings → Compaction** lists available models and all tunable fields
- `compress_context` / `/compact` / auto-hook **read the live settings on every call**
- Deployment config is only the **default** the settings start from (composition `base`)

> Pick a model in the panel → it is the model used for the next compaction. No restart, no file edits.

## Configuration

| Field | Default | Meaning |
|-------|---------|---------|
| `provider` | `""` | Compaction model provider (e.g. `lmstudio`) |
| `model` | `""` | Compaction model id (e.g. `nvidia/nemotron-3-nano-4b`) |
| `thresholdRatio` | `0.8` | Occupancy fraction (0..1] that engages auto-compaction |
| `keepLastNTurns` | `3` | Recent turns retained verbatim (fallback) |
| `keepLastNMessages` | `10` | Recent messages retained verbatim (**wins over turns**) |
| `summaryMaxTokens` | `1024` | Output cap for the summarization call |
| `autoCompaction` | `false` | Register the pressure-driven `agent/pre-step` hook |

All fields are editable at runtime in **Settings → Compaction**.

## How It Works

```
┌──────────────────────────────────────────────────────────────────┐
│  Session context window                                         │
│  ┌──────────────────────────────────────┐ ┌───────────────────┐  │
│  │  Compress span (older history)       │ │  Keep tail (most  │  │
│  │  → summarized by secondary model     │ │  recent messages) │  │
│  └──────────────────────────────────────┘ └───────────────────┘  │
│                         ↓                                        │
│              Durable checkpoint (replayable, priced)             │
└──────────────────────────────────────────────────────────────────┘
```

1. **Measure** — `tokenMeter.measure` + secondary model's context window
2. **Gate** — skip when occupancy < threshold (unless `force: true`)
3. **Split** — leading compress span + recent keep tail, with a **tool-pairing-safe boundary**: the cut is adjusted so it never splits an assistant message's tool calls from their following result events (the same rule as DSH's built-in compaction). The kept tail may end up slightly larger than requested; if no safe cut exists — or the surface already carries an orphaned result — compaction declines cleanly instead of corrupting the session
4. **Summarize** — call the **secondary** model (`purpose: "compaction"`), KV-cache warm; when a region exceeds that model's input budget (70% of its context window minus `summaryMaxTokens`, or a conservative cap if no capacity is reported) it is split into token-budgeted chunks and folded sequentially, so small local engines are never asked for one oversized request. Transient engine failures (device loss, reset connections, 5xx/timeouts) retry with backoff
5. **Land** — atomic checkpoint: `compaction/start` → `summary` → `user/message (surfaceOp: replace)` → `compaction/end`; a failed landing closes its own marker so it never leaves a stale compaction lock behind

The commit is **atomic**: on any failure the session surface is unchanged — including when history changes underneath a long summarization call (the span is re-verified before landing and compaction declines cleanly instead of committing blind).

## Result Contract

```jsonc
{
  "status": "success" | "skipped" | "cancelled" | "failed",
  "message": "Human-readable explanation",
  "stats": { "tokensBefore": 0, "tokensAfter": 0, "nodesShadowed": 0 },
  "summaryText": "…",
  "secondaryModel": { "provider": "lmstudio", "model": "nvidia/nemotron-3-nano-4b" }
}
```

## Install

```bash
# Official CLI (recommended)
dsh plugin --profile <name> add dsh-compaction-tool@0.5.0

# Or manual
cd <profile-dir>
npm install file:<path-to>/dsh-compaction-tool
```

> **Note:** If DSH's built-in compaction is active, disable it to avoid duplicate `/compact` handlers:
> ```yaml
> # cordis.patch.yml
> - id: compaction-basic
>   disabled: true
> - id: command-compact
>   disabled: true
> ```

## Develop

```bash
npm run build   # transpile src/compaction-tool.ts → lib/index.mjs (Node type-stripping)
npm pack        # build a publishable tarball
```

## Project Structure

```
dsh-compaction-tool/
├── src/compaction-tool.ts    # TypeScript source (single file)
├── lib/
│   ├── index.mjs             # Compiled host plugin (entry point)
│   ├── index.d.ts            # Type declarations
│   └── client.js             # Browser client (settings panel)
├── cordis.patch.yml          # Bundle mount patch
├── build.mjs                 # Build script (Node native type-stripping)
├── SYSTEM_PROMPT.md          # Model-facing tool guidance (EN)
├── SYSTEM_PROMPT.zh.md       # Model-facing tool guidance (ZH)
├── INSTALL.zh.md             # Detailed installation guide (ZH)
├── README.md / README.zh.md  # This file
└── LICENSE                   # MIT
```

## License

[MIT](./LICENSE) © 2025
