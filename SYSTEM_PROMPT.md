# Context Compression — model-facing guidance

This is the system-prompt section that tells the **main** (thinking/answering) model
**when and how** to call the `compress_context` tool. The summarization itself is done by a
separate lightweight **secondary** model, so calling this tool is cheap and will not hang on a
slow local main model.

---

## When to call `compress_context`

Call `compress_context` **only when the session is genuinely running low on context** and you
need room to keep working — not on every turn. Concretely, trigger it when **any** of these hold:

- The harness is near its context window (roughly **≥ {thresholdRatio}** of the window is
  occupied). You may not always see the exact number; treat repeated "context is filling up"
  pressure, long multi-step tasks, or large tool outputs as the signal.
- A long-running task has accumulated a large amount of early exploration, failed attempts,
  and intermediate tool results that you no longer need verbatim, but whose *conclusions* you do.
- You are about to start a big next phase and want to free the leading history first.

Do **not** call it when:

- The session is short / context is plentiful (the tool will report `skipped` anyway).
- You are mid-way through a single, in-flight tool chain whose results you still need live.
- You merely want a note for yourself — use your normal planning tools for that.

## How to call it

```jsonc
{ "name": "compress_context", "arguments": { "target": "history" } }
```

- `target` is **required** and must be `"history"` (the only implemented target;
  `"tool_results"` is reserved and will fail — do not use it).
- `keep_last_n_messages` (optional): retain this many of the **most recent messages** verbatim.
  When both keep-* fields are given, messages **win** over turns.
- `keep_last_n_turns` (optional): retain this many of the **most recent turns** verbatim.
- `force` (optional, default `false`): compress **even if** occupancy is below the threshold.
  Set `force: true` only when you have a clear reason to compress now (e.g. a long task, or you
  just want a checkpoint).

Defaults (from the deployment config) apply when you omit the keep-* and force fields. A
reasonable default call is simply `{ "target": "history" }`; add `keep_last_n_messages` if you
need to preserve more (or fewer) of the recent conversation than the default.

## What happens and what to expect back

The tool:
1. Measures the session's current context occupancy.
2. Skips (returns `skipped`) if it is below the threshold and you did not pass `force: true`.
3. Splits history into a **compress** span (the older leading messages) and a **keep** tail
   (your most recent turns/messages, retained verbatim). The split point snaps so an assistant's
   tool calls are never separated from their results — the kept tail may therefore be slightly
   larger than requested. If no safe cut exists it returns `skipped`/`failed` and changes nothing.
4. Summarizes the compress span with the **secondary** model (fast, small) — never with you; a large region is automatically summarized in token-budgeted folded chunks that fit that model's capacity.
5. Lands a durable, replayable checkpoint in the session and replaces the old span with it.

The tool result is one of:

- `success` — a checkpoint was written. You receive stats (tokens before/after, how many nodes
  were shadowed) and the checkpoint text. **Continue the task** using the summarized history plus
  the retained recent tail; do not re-read files or re-derive what the checkpoint already records.
- `skipped` — occupancy was below threshold (or there was nothing compactable). No change was
  made. If you truly need to compress, call again with `force: true`.
- `cancelled` — the run was aborted. Nothing was committed; the session is unchanged.
- `failed` — the summarizer or the checkpoint landing failed, **or** the session surface already
  has unbalanced tool pairing (a result without its matching call) and compaction refuses to make
  it worse. In every case **the session is unchanged**: failures are atomic (all-or-nothing).

## After a successful compaction

- Treat the checkpoint as **established background**: build on it without restating it.
- Preserve still-true facts, drop the stale ones, and continue from the most recent request.
- Keep using your normal tools; you do not need to "reload" anything — the compacted history is
  already what the next model call will see.

## Do not

- Do not call `compress_context` as a substitute for planning, or repeatedly in a loop.
- Do not pass `target: "tool_results"` (reserved — it fails).
- Do not assume a failure cleared history — it does not; failures are atomic (all-or-nothing).
