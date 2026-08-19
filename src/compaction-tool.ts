/**
 * dsh-compaction-tool
 *
 * A model-facing `compress_context` tool plus a human `/compact` command that
 * condense an older span of the current session's conversation history into a
 * durable checkpoint, using a SEPARATE lightweight "compaction" model.
 *
 * Why a second model: the primary model does the thinking and answering and can
 * be slow (e.g. a local model behind a long prefill). Compaction is pure
 * summarization — it needs only a small, fast model. Routing the summary call to
 * the selected compaction model keeps compaction snappy and independent of how
 * slow the main model is, so it never times out mid-turn.
 *
 * The compaction model and all compaction settings (threshold, tail, tokens,
 * auto) are NOT hardcoded. They live in a single settings namespace
 * (`compaction`, the same mechanism the main-model selector uses via
 * `agent-default-model`) that the user can change at runtime from the
 * Settings panel. The tool reads the LIVE values on every call, so whichever
 * settings are active at call time are the ones used. The deployment config
 * (`secondaryModelProvider` / `secondaryModelName` / etc.) is the composition
 * `base` / default the selection starts from — never a fixed value baked into
 * the call.
 *
 * The plugin follows the official four named-export convention
 * (`name`, `inject`, `Config`, `apply`), exactly like `dsh-tool-todo`:
 *   - `name`     stable loader identity
 *   - `inject`   hard service dependencies the plugin cannot work without
 *   - `Config`   a `@deepseek-ai/schemastery` (zod) schema — every tunable is
 *                config-driven; nothing is hardcoded at call time
 *   - `apply`    registers the tool on `ctx.tools`, the `/compact` command, and
 *                the `compaction` settings namespace
 *
 * It reuses the harness's own durable compaction protocol (the same
 * `session.append("compaction/summary", …)` + `surfaceOp: replace` +
 * `<compacted-summary>` framing that `dsh-compaction-basic` lands), so the
 * replacement is a genuine, replayable, priced checkpoint rather than a
 * transient string.
 *
 * Note on the model call: this harness exposes only a STREAMING model API —
 * `ctx.llm.stream(options)` (see `dsh-llm`). There is no `ctx.llm.generate`.
 * A non-streaming one-shot is therefore implemented by draining the stream
 * through `BlockAssembler` and reading the assembled result once — which is
 * precisely how `dsh-compaction-basic.summarizeWithLlm` does it. This is the
 * faithful stand-in for the "non-streaming" call the task describes.
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  BlockAssembler,
  createUserMessage,
  contentHasImage,
  errorChain,
  type ContentBlock,
  type FinishReason,
  type Message,
} from "@deepseek-ai/dsh-llm";

/* -------------------------------------------------------------------------- */
/* Named exports required by the loader (injection metadata is read from these). */
/* -------------------------------------------------------------------------- */

export const name = "compaction-tool";

/**
 * Hard dependencies: the plugin registers a tool (`tools`), prices and replaces
 * session surface (`tokenMeter`), and issues the auxiliary model call (`llm`).
 * `commands`, `sessions`, and `settings` are OPTIONAL and consumed through
 * `ctx.get(…)` / `ctx.inject(…)` so a deployment that composes none of them
 * still mounts the tool and degrades gracefully (config base, no live selector).
 */
export const inject = ["tools", "tokenMeter", "llm"];

/* -------------------------------------------------------------------------- */
/* Configuration — every tunable, no hardcoded defaults at call time.          */
/* -------------------------------------------------------------------------- */

/** Resolved, validated plugin configuration (defaults filled in). */
export interface Config {
  /** Request-pressure fraction in (0, 1] at which compaction engages (default 0.8). */
  thresholdRatio: number;
  /** Tail retained verbatim, in turns, when the caller does not override it (default 3). */
  keepLastNTurns: number;
  /** Tail retained verbatim, in messages; takes priority over `keepLastNTurns` (default 10). */
  keepLastNMessages: number;
  /**
   * Compaction-model base / default (provider). When the user has not made a
   * live `compaction` selection, compaction falls back to this route.
   * Empty string = inherit the session route.
   */
  secondaryModelProvider: string;
  /**
   * Compaction-model base / default (model id). See {@link Config.secondaryModelProvider}.
   */
  secondaryModelName: string;
  /** Output cap for the summarization call in tokens (default 1024). */
  summaryMaxTokens: number;
  /** Whether to also register the automatic, pressure-driven compaction hook (default false). */
  autoCompaction: boolean;
}

/**
 * Schemastery configuration schema. All fields are optional at the wire so a
 * partial mount is valid; `apply` resolves the documented defaults into a
 * concrete {@link Config} before use (the `dsh-compaction-basic` idiom), which
 * keeps validation, defaults, and the "messages win over turns" rule in one
 * place rather than scattered across the tool body.
 */
export const Config = z.object({
  thresholdRatio: z.number(),
  keepLastNTurns: z.number().step(1).min(1),
  keepLastNMessages: z.number().step(1).min(1),
  secondaryModelProvider: z.string(),
  secondaryModelName: z.string(),
  summaryMaxTokens: z.number().step(1).min(1),
  autoCompaction: z.boolean(),
});

/* -------------------------------------------------------------------------- */
/* Defaults (the only place numeric policy lives; all are overridable above).  */
/* -------------------------------------------------------------------------- */

const DEFAULT_THRESHOLD_RATIO = 0.8;
const DEFAULT_KEEP_LAST_TURNS = 3;
const DEFAULT_KEEP_LAST_MESSAGES = 10;
const DEFAULT_SUMMARY_MAX_TOKENS = 1024;
const DEFAULT_AUTO_COMPACTION = false;

/** Canonical plugin identity stamped into the checkpoint's producer source. */
const PLUGIN_ID = "dsh-compaction-tool";

/**
 * The settings namespace that holds ALL live compaction settings (model +
 * threshold + tail + tokens + auto). This is the same mechanism the
 * main-model selector uses (`agent-default-model`), so every value here is a
 * normal, persisted, UI-editable setting — never a hardcoded value. The id
 * matches the settings namespace pattern.
 */
const COMPACTION_NAMESPACE = "compaction";

/** Schema of the `compaction` settings section (all fields optional at the wire). */
const COMPACTION_SCHEMA = z.object({
  provider: z.string(),
  model: z.string(),
  thresholdRatio: z.number(),
  keepLastNMessages: z.number(),
  keepLastNTurns: z.number(),
  summaryMaxTokens: z.number(),
  autoCompaction: z.boolean(),
});

/** The resolved compaction settings for one call (defaults filled). */
interface CompactionSettings {
  provider: string;
  model: string;
  thresholdRatio: number;
  keepLastNMessages: number;
  keepLastNTurns: number;
  summaryMaxTokens: number;
  autoCompaction: boolean;
}

/** The minimal settings-service surface the plugin uses (read + register + watch). */
interface SettingsScope {
  get(): { provider?: string; model?: string };
  watch(callback: (next: unknown, prev: unknown) => void): () => void;
}
interface SettingsService {
  register(
    ns: string,
    schema: unknown,
    options: { base: { provider: string; model: string } },
  ): SettingsScope;
}

/* -------------------------------------------------------------------------- */
/* Checkpoint framing — identical tags/preamble to dsh-compaction-basic so the */
/* landed node is indistinguishable from the built-in compaction output.        */
/* -------------------------------------------------------------------------- */

const SUMMARY_OPEN_TAG = "<compacted-summary>";
const SUMMARY_CLOSE_TAG = "</compacted-summary>";

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  "This is an automatically generated checkpoint condensing an earlier span of the " +
  "conversation to free up context. Treat the captured context as established background " +
  "and build on it without restating it. Continue the task directly from the messages " +
  "that follow, without acknowledging this checkpoint.";

/**
 * The shared checkpoint specification (structure + rules) required by BOTH
 * summarization directives. Keeping it in one place guarantees the single-pass
 * and the folded (multi-chunk) calls emit the identical structure.
 */
const CHECKPOINT_SPEC = [
  "Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write \"(none)\" for an empty section — never drop a section.",
  "",
  "## Primary Request and Intent",
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  "",
  "## Key Technical Concepts",
  "- [technologies, frameworks, patterns, and conventions in play]",
  "",
  "## Files and Code",
  "- [exact path: why it matters, key changes or snippets]",
  "",
  "## Errors and Fixes",
  "- [error: how it was resolved, plus any related user feedback]",
  "",
  "## Pending Jobs",
  "- [explicitly requested work not yet completed]",
  "",
  "## Current Work",
  "- [precisely what was in progress at this checkpoint]",
  "",
  "## Next Step",
  "- [the single next action, directly in line with the most recent request, or \"(none)\"]",
  "",
  "## Critical Context",
  "- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]",
  "",
  "Rules:",
  "- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.",
  "- Capture user feedback and explicit instructions faithfully, especially corrections.",
  "- Do NOT mention this summarization request or that the context was compacted.",
  "- Output only the checkpoint text: do not call any tool or take any other action.",
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join("\n");

/**
 * The single-pass summarization directive, delivered as the FINAL user message
 * after the replayed conversation prefix (not as a separate system prompt).
 * Keeping the conversation's own prefix in front of it makes the auxiliary call
 * a genuine prefix of the last routed request, so the secondary model's KV
 * cache is reused.
 */
const COMPACTION_INSTRUCTION = [
  "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
  "",
  CHECKPOINT_SPEC,
].join("\n");

/**
 * The fold directive used when the region is split into chunks: each call sees a
 * PRIOR checkpoint (the running summary) followed by the NEXT span, and must
 * merge both into one updated checkpoint. This keeps every individual request
 * small enough for a local engine — the oversized single request is exactly what
 * exhausts VRAM/KV-cache on small local models (e.g. LM Studio Vulkan
 * "ErrorDeviceLost" during decode).
 */
const FOLD_INSTRUCTION = [
  "You are now acting as a compaction engine for this AI coding assistant. The messages ABOVE begin with a PRIOR checkpoint (an earlier condensed span of this same conversation), followed by the NEWER conversation span that comes after it.",
  "",
  "Merge them into ONE updated checkpoint: preserve every still-true fact from the prior checkpoint, drop anything superseded or stale, and fold in everything essential from the newer span.",
  "",
  CHECKPOINT_SPEC,
].join("\n");

/** Preamble that introduces the running summary when folding a chunk. */
const FOLD_PREAMBLE = "PRIOR checkpoint covering the EARLIER span of this conversation (already condensed):";

/* -------------------------------------------------------------------------- */
/* Small, dependency-light helpers.                                            */
/* -------------------------------------------------------------------------- */

/** A resolved provider/model route for a model call. */
interface Route {
  readonly provider: string;
  readonly model: string;
}

/** The canonical shape returned by both the tool body and the `/compact` handler. */
type CompressStatus = "success" | "skipped" | "cancelled" | "failed";

interface CompressResult {
  status: CompressStatus;
  /** Human-facing one-line outcome (used by the command and by `render`). */
  message: string;
  stats: {
    totalTokensBefore: number;
    totalTokensAfter: number | null;
    contextWindow: number | null;
    occupancyRatioBefore: number | null;
    occupancyRatioAfter: number | null;
    nodesShadowed: number;
    tokensShadowed: number | null;
    keepNodes: number;
  };
  /** The condensed checkpoint text (present on success). */
  summaryText: string | null;
  /** The compaction model actually used to summarize (present on success). */
  secondaryModel: Route | null;
}

/** Minimal structural view of the session the plugin needs (kept loose on purpose). */
interface SessionView {
  readonly id: unknown;
  readonly events: readonly { readonly type: string; readonly seq: number; readonly data: unknown }[];
  readonly surface: { readonly nodes: readonly number[] };
  requestHeader(): { config?: { provider?: string; model?: string }; system?: string; tools?: unknown[] } | undefined;
  deriveEventMessage(event: unknown): Message | null;
  append(type: string, data: unknown, opts?: unknown): unknown;
}

/** Minimal structural view of the agent that owns the session. */
interface AgentView {
  readonly session: SessionView;
  readonly options?: { provider?: string; model?: string };
}

/** The token-meter service surface the plugin prices with. */
interface MeterView {
  measure(session: SessionView): { totalTokens: number; nodes: readonly { seq: number; tokens: number }[] };
  estimateMessage(message: Message): number;
}

/** Resolve the effective keep policy for one call. Messages win over turns. */
interface KeepPolicy {
  kind: "messages" | "turns";
  count: number;
}

function resolveKeepPolicy(
  settings: { keepLastNMessages: number; keepLastNTurns: number },
  overrideMessages: number | undefined,
  overrideTurns: number | undefined,
): KeepPolicy {
  // Explicit per-call overrides take priority over the settings.
  if (overrideMessages !== undefined && overrideMessages >= 0) {
    return { kind: "messages", count: Math.max(0, Math.floor(overrideMessages)) };
  }
  if (overrideTurns !== undefined && overrideTurns >= 0) {
    return { kind: "turns", count: Math.max(0, Math.floor(overrideTurns)) };
  }
  // Default: keepLastNMessages takes priority over keepLastNTurns.
  return { kind: "messages", count: settings.keepLastNMessages };
}

/**
 * Choose the head-anchored surface range to compact, retaining a recent tail of
 * the requested size. The compress range is always the LEADING nodes:
 * `[first, nodes[keepFromIdx - 1]]`; the tail `[nodes[keepFromIdx], …]` is kept.
 * Returns `null` when there is nothing safely compactable.
 */
function selectKeepBoundary(
  session: SessionView,
  keep: KeepPolicy,
): { start: number; end: number; keepFromIdx: number } | null {
  const nodes = session.surface.nodes;
  if (nodes.length === 0) return null;

  let keepFromIdx: number;
  if (keep.kind === "messages") {
    keepFromIdx = Math.max(0, nodes.length - keep.count);
  } else {
    // Retain the last `count` turns: a node belongs to the turn group that is
    // open at its log position (turns open with `turn/start`). Walk the log in
    // order, tagging each surface node with the number of `turn/start`s seen so
    // far, then keep every node from the Nth-from-last turn onward.
    const turnOf = new Map<number, number>();
    let opened = 0;
    for (const event of session.events) {
      if (event.type === "turn/start") opened += 1;
      if (isSurfaceEligible(event)) turnOf.set(event.seq, opened);
    }
    // The newest turn group present on the surface (0 = before the first turn).
    let newest = 0;
    for (const seq of nodes) newest = Math.max(newest, turnOf.get(seq) ?? 0);
    const keepFromGroup = Math.max(0, newest - (keep.count - 1));
    keepFromIdx = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      if ((turnOf.get(nodes[i]) ?? 0) >= keepFromGroup) {
        keepFromIdx = i;
        break;
      }
    }
  }

  // Nothing to keep (whole history) means nothing to compress; a single node
  // kept means the compress range would be empty.
  if (keepFromIdx <= 0) return null;
  if (keepFromIdx >= nodes.length) keepFromIdx = nodes.length - 1;
  return { start: nodes[0], end: nodes[keepFromIdx - 1], keepFromIdx };
}

/** Structural check that an event is one of the three message-producing kinds. */
function isSurfaceEligible(event: { type: string }): boolean {
  return (
    event.type === "user/message" ||
    event.type === "assistant/message" ||
    event.type === "tool/message"
  );
}

/**
 * Map a terminal summarization finish to a `cancelled` vs. error classification.
 * Cancellation always wins: if the caller signal aborted, report `cancelled`
 * regardless of the adapter's terminal reason.
 */
function classifyFinish(finish: FinishReason, signal: AbortSignal | undefined): {
  kind: "ok" | "cancelled" | "error";
  message?: string;
} {
  if (signal?.aborted) return { kind: "cancelled", message: "summarization cancelled" };
  switch (finish.kind) {
    case "stop":
    case "tool-calls":
      return { kind: "ok" };
    case "aborted":
      return { kind: "cancelled", message: finish.failure?.message ?? "summarization aborted" };
    case "error":
      return { kind: "error", message: finish.failure?.message ?? "summarization failed" };
    case "max-tokens":
      return { kind: "error", message: "summarization truncated at the token cap (incomplete checkpoint)" };
    default:
      return { kind: "error", message: "unexpected summarization finish" };
  }
}

/* -------------------------------------------------------------------------- */
/* Robustness: transient-failure retry + token-budgeted chunk planning.        */
/* -------------------------------------------------------------------------- */

/** Total summarization attempts per chunk before giving up (initial + 2 retries). */
const SUMMARY_MAX_ATTEMPTS = 3;
/** Backoff before each retry, in ms (index = the failed attempt - 1). */
const SUMMARY_RETRY_DELAYS_MS = [1500, 4500];

/**
 * Engine/connection failures that are typically TRANSIENT — a local engine
 * recovering from a Vulkan device loss, a reset socket, a 5xx from a local
 * server. Deterministic failures (auth, unknown model, bad schema) must NOT be
 * retried. Matched against the flattened error text.
 */
const TRANSIENT_SUMMARIZATION_PATTERN =
  /errordevicelost|device lost|connection (refused|reset)|econnrefused|econnreset|socket hang up|fetch failed|failed to fetch|network|server_error|"code"\s*:\s*5\d\d|overloaded|timed? ?out|idle timeout|internal server error/i;

/** True when a summarization failure looks transient and worth retrying. */
function isTransientSummarizationFailure(message: string | undefined): boolean {
  return message !== undefined && message.length > 0 && TRANSIENT_SUMMARIZATION_PATTERN.test(message);
}

/**
 * Sleep `ms`, resolving `false` early if `signal` aborts (mirrors the
 * `dsh-llm-retry.cancellableDelay` idiom). Uses the Node `setTimeout` global,
 * which host plugins run with (see `dsh-schedule`, `dsh-subprocess-local`).
 */
function cancellableSleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Input budget (in tokens) for ONE summarization request: the compaction model's
 * context window (70% headroom for the model's own bookkeeping) minus the
 * configured output reserve. Without a known window, fall back to a conservative
 * 16k cap. This is what keeps a long session's fold chunks inside a small local
 * model's capacity instead of crashing its engine mid-decode.
 */
function inputBudgetTokens(contextWindow: number | undefined, summaryMaxTokens: number): number {
  const cap = contextWindow && contextWindow > 0 ? Math.floor(contextWindow * 0.7) : 16384;
  return Math.max(2048, cap - summaryMaxTokens);
}

/**
 * Split the shadowed seqs (in order) into consecutive chunks whose measured token
 * total stays within `budget`. A single node larger than the budget becomes its
 * own chunk (a message cannot be split) — the retry layer then carries it, and a
 * genuine overflow surfaces as one clear error instead of a silent crash.
 */
function planChunks(
  seqs: readonly number[],
  tokensOf: (seq: number) => number,
  budget: number,
): number[][] {
  const chunks: number[][] = [];
  let current: number[] = [];
  let currentTokens = 0;
  for (const seq of seqs) {
    const tokens = Math.max(0, tokensOf(seq));
    if (current.length > 0 && currentTokens + tokens > budget) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(seq);
    currentTokens += tokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.length > 0 ? chunks : [[...seqs]];
}

/** Additively merge two usage objects (numeric fields sum; others take `next`). */
function mergeUsage(acc: unknown, next: unknown): unknown {
  const a = (acc ?? {}) as Record<string, unknown>;
  const b = (next ?? {}) as Record<string, unknown>;
  if (Object.keys(a).length === 0) return Object.keys(b).length === 0 ? acc : b;
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (typeof value === "number" && typeof out[key] === "number") {
      out[key] = (out[key] as number) + value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Run the non-streaming summarization call: drain `ctx.llm.stream` into a
 * `BlockAssembler` and read the assembled text once. This is the faithful
 * stand-in for a `ctx.llm.generate` one-shot (which this harness does not expose).
 * Honors `signal` so a cancelled turn aborts the auxiliary call.
 * `input.instruction` overrides the default compaction directive (fold mode).
 */
async function summarizeWithLlm(
  ctx: Context,
  route: Route,
  input: { system?: string; tools?: unknown[]; messages: Message[]; instruction?: string },
  config: { summaryMaxTokens: number },
  sessionId: unknown,
  signal: AbortSignal | undefined,
): Promise<{ blocks: ContentBlock[]; finish: FinishReason; usage?: unknown }> {
  const assembler = new BlockAssembler();
  const messages: Message[] = [
    ...input.messages,
    createUserMessage({
      content: [{ type: "text", text: input.instruction ?? COMPACTION_INSTRUCTION }],
      source: { kind: "plugin", plugin: PLUGIN_ID },
    }),
  ];
  const options = {
    provider: route.provider,
    model: route.model,
    messages,
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.tools === undefined || input.tools.length === 0 ? {} : { tools: input.tools as never[] }),
    maxTokens: config.summaryMaxTokens,
    ...(sessionId === undefined ? {} : { sessionId: sessionId as never }),
    purpose: "compaction" as const,
    ...(signal === undefined ? {} : { signal }),
  };
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
  return {
    blocks: assembler.blocks(),
    finish: assembler.finish,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  };
}

/**
 * Summarize with bounded retry on TRANSIENT engine failures (Vulkan device loss,
 * reset connections, 5xx). Cancellation always wins and is never retried; a
 * non-transient failure fails fast. Rejects with a human-readable reason;
 * resolves only when the terminal finish is `ok`.
 */
async function summarizeWithRetries(
  ctx: Context,
  route: Route,
  input: { system?: string; tools?: unknown[]; messages: Message[]; instruction?: string },
  settings: { summaryMaxTokens: number },
  sessionId: unknown,
  signal: AbortSignal | undefined,
  warn: (msg: string) => void,
): Promise<{ blocks: ContentBlock[]; finish: FinishReason; usage?: unknown }> {
  let lastMessage = "summarization failed";
  for (let attempt = 1; attempt <= SUMMARY_MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new Error("summarization cancelled");
    let outcome: { blocks: ContentBlock[]; finish: FinishReason; usage?: unknown };
    try {
      outcome = await summarizeWithLlm(ctx, route, input, settings, sessionId, signal);
    } catch (error) {
      if (signal?.aborted) throw new Error("summarization cancelled");
      lastMessage = errorChain(error);
      const transient = isTransientSummarizationFailure(lastMessage);
      warn(
        `compaction: summarization attempt ${attempt}/${SUMMARY_MAX_ATTEMPTS} threw: ${lastMessage}` +
          (transient ? " (transient)" : ""),
      );
      if (!transient) throw new Error(lastMessage);
      if (attempt === SUMMARY_MAX_ATTEMPTS) throw new Error(lastMessage);
    }
    // The stream ended; classify the terminal finish (cancellation still wins).
    const finish = classifyFinish(outcome.finish, signal);
    if (finish.kind === "ok") return outcome;
    if (finish.kind === "cancelled") throw new Error("summarization cancelled");
    lastMessage = finish.message ?? "summarization failed";
    // A `max-tokens` finish means the model HIT its output cap — retrying with
    // the same cap is guaranteed to truncate again. Fail fast instead.
    if (outcome.finish.kind === "max-tokens") throw new Error(lastMessage);
    const transient = isTransientSummarizationFailure(lastMessage);
    warn(
      `compaction: summarization attempt ${attempt}/${SUMMARY_MAX_ATTEMPTS} ended with error: ${lastMessage}` +
        (transient ? " (transient)" : ""),
    );
    if (!transient) throw new Error(lastMessage);
    if (attempt === SUMMARY_MAX_ATTEMPTS) throw new Error(lastMessage);
    const delayMs = SUMMARY_RETRY_DELAYS_MS[attempt - 1] ?? SUMMARY_RETRY_DELAYS_MS[SUMMARY_RETRY_DELAYS_MS.length - 1];
    warn(`compaction: retrying summarization in ${delayMs}ms (attempt ${attempt + 1}/${SUMMARY_MAX_ATTEMPTS})`);
    const resumed = await cancellableSleep(delayMs, signal);
    if (!resumed) throw new Error("summarization cancelled");
  }
  throw new Error(lastMessage);
}

/**
 * Resolve the compaction model route for one call. The LIVE `compaction`
 * selection (read from the settings-backed source thunk) wins; the composition
 * base (`secondaryModelProvider` / `secondaryModelName`) is the default when the
 * user has not made a selection; then the session's latest durable route, then
 * the agent's configured route. Nothing here is a fixed, baked-in value.
 */
function resolveSecondaryRoute(
  liveRoute: Route | undefined,
  config: Config,
  session: SessionView,
  agent: AgentView | undefined,
): Route {
  if (liveRoute && liveRoute.provider.length > 0 && liveRoute.model.length > 0) return liveRoute;
  const base: Route = { provider: config.secondaryModelProvider, model: config.secondaryModelName };
  if (base.provider.length > 0 && base.model.length > 0) return base;
  const routed = session.requestHeader()?.config;
  if (routed && routed.provider && routed.model) return { provider: routed.provider, model: routed.model };
  if (agent?.options?.provider && agent?.options?.model) {
    return { provider: agent.options.provider, model: agent.options.model };
  }
  throw new Error(
    "no provider/model available for compaction: select one in the Settings panel (Compaction section), " +
      "set the compaction setting, or set both Config fields (secondaryModelProvider/secondaryModelName)",
  );
}

/* -------------------------------------------------------------------------- */
/* The shared compression pipeline (used by BOTH the tool and the command).     */
/* -------------------------------------------------------------------------- */

interface CompressRequest {
  agent: AgentView;
  signal: AbortSignal | undefined;
  target: "history" | "tool_results";
  force: boolean;
  keepMessages: number | undefined;
  keepTurns: number | undefined;
  /** The live compaction model selection (from the settings-backed source). */
  liveRoute: Route | undefined;
  /** The live compaction settings (threshold/tail/tokens) for this call. */
  liveSettings: CompactionSettings;
}

/**
 * The one compaction transaction: measure pressure, select the head-anchored
 * range to condense, summarize it with the selected compaction model, then land a
 * durable `compaction/summary` + `surfaceOp: replace` checkpoint exactly as the
 * built-in engine does. Pure read-only until the summarization succeeds; on any
 * failure the session surface is left unchanged.
 */
async function runCompression(
  ctx: Context,
  config: Config,
  request: CompressRequest,
): Promise<CompressResult> {
  const session = request.agent.session;
  const log = ctx.logger;
  const info = (msg: string) => {
    try {
      log?.info?.(msg);
    } catch {
      /* logging must never break a tool result */
    }
  };
  const warn = (msg: string) => {
    try {
      log?.warn?.(msg);
    } catch {
      /* logging must never break a tool result */
    }
  };

  if (request.target === "tool_results") {
    return {
      status: "failed",
      message: "target 'tool_results' is not implemented; only 'history' is supported.",
      stats: emptyStats(),
      summaryText: null,
      secondaryModel: null,
    };
  }

  const meter = ctx.tokenMeter as unknown as MeterView;

  // 1) Read current pressure. A meter failure (e.g. a session the meter cannot
  //    fold) must surface as a clean tool failure, never an uncaught throw.
  let before: { totalTokens: number; nodes: readonly { seq: number; tokens: number }[] };
  try {
    before = meter.measure(session);
  } catch (error) {
    warn(`compaction: token-meter measurement failed: ${errorChain(error)}`);
    return failedResult({ totalTokens: 0 }, undefined, `could not measure session pressure: ${errorChain(error)}`);
  }
  let contextWindow: number | undefined;
  let route: Route;
  try {
    route = resolveSecondaryRoute(request.liveRoute, config, session, request.agent);
    const info2 = await ctx.llm.resolveModelInfo(route.provider, route.model, request.signal);
    contextWindow = info2?.context?.contextWindow;
  } catch (error) {
    // Route/context resolution failed — surface as a clean failure (cancellation
    // during the capability lookup is still cancellation, not a summarizer fault).
    if (request.signal?.aborted) {
      return cancelledResult(before);
    }
    warn(`compaction: route resolution failed: ${errorChain(error)}`);
    return {
      status: "failed",
      message: `Could not resolve a model for compaction: ${errorChain(error)}`,
      stats: withWindow(statsFrom(before), contextWindow),
      summaryText: null,
      secondaryModel: null,
    };
  }

  const ratioBefore = contextWindow ? before.totalTokens / contextWindow : null;
  info(
    `compaction: pressure ${before.totalTokens} tokens / ` +
      `${contextWindow ?? "unknown"} window (ratio ${ratioBefore === null ? "?" : ratioBefore.toFixed(3)}); ` +
      `threshold ${request.liveSettings.thresholdRatio}; model ${route.provider}/${route.model}`,
  );

  // 2) Threshold gate — skip unless forced. (When no window is known we cannot
  //    prove pressure, so a non-forced call skips; a forced one proceeds.)
  const engaged = request.force || (ratioBefore !== null && ratioBefore >= request.liveSettings.thresholdRatio);
  if (!engaged) {
    info("compaction: below threshold and not forced — skipping");
    return {
      status: "skipped",
      message: `Context occupancy ${ratioBefore === null ? "unknown" : `${(ratioBefore * 100).toFixed(1)}%`} is below the ${request.liveSettings.thresholdRatio * 100}% threshold; no compaction performed. Use force=true to override.`,
      stats: withWindow(statsFrom(before), contextWindow),
      summaryText: null,
      secondaryModel: null,
    };
  }

  // 3) Select the head-anchored range to condense, retaining the recent tail.
  const keep = resolveKeepPolicy(request.liveSettings, request.keepMessages, request.keepTurns);
  const boundary = selectKeepBoundary(session, keep);
  if (boundary === null) {
    return {
      status: "skipped",
      message: "No compactable history: the retained tail already covers the whole surface.",
      stats: withWindow(statsFrom(before), contextWindow, session.surface.nodes.length),
      summaryText: null,
      secondaryModel: null,
    };
  }
  const { start, end } = boundary;

  // 4) Re-price the selected span and build the replayed prefix to summarize.
  const measurement = meter.measure(session);
  const surfaceSeqs = session.surface.nodes;
  const startIdx = surfaceSeqs.indexOf(start);
  const endIdx = surfaceSeqs.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    return failedResult(before, contextWindow, "the selected history range is no longer valid");
  }
  const shadowedSeqs = surfaceSeqs.slice(startIdx, endIdx + 1);
  const shadowedTokenCount = measurement.nodes
    .filter((node) => shadowedSeqs.includes(node.seq))
    .reduce((sum, node) => sum + node.tokens, 0);

  // The conversation prefix (system + tools) is replayed for EVERY chunk so each
  // auxiliary call is a genuine prefix of the last routed request.
  const header = session.requestHeader();

  // 5) Summarize with the selected compaction model (non-streaming via the
  //    assembler), with transient-failure retry. When the region is larger than
  //    the fast model's input budget, split it into token-budgeted chunks and
  //    FOLD them sequentially (running checkpoint + next span). A single
  //    oversized request to a small local model is exactly what exhausts its
  //    VRAM/KV cache and crashes the engine mid-decode (LM Studio Vulkan
  //    "ErrorDeviceLost"); folding keeps every request small. One chunk = the
  //    exact single-pass behavior of before.
  const budget = inputBudgetTokens(contextWindow, request.liveSettings.summaryMaxTokens);
  const nodeTokens = new Map<number, number>(measurement.nodes.map((node) => [node.seq, node.tokens]));
  const chunks = planChunks(shadowedSeqs, (seq) => nodeTokens.get(seq) ?? 0, budget);
  if (chunks.length > 1) {
    info(`compaction: region exceeds the ${budget} token input budget — summarizing in ${chunks.length} folded chunks`);
  }

  const headerInput = {
    ...(header?.system === undefined ? {} : { system: header.system }),
    ...(header?.tools === undefined || header.tools.length === 0 ? {} : { tools: header.tools }),
  };
  let summaryBlocks: (ContentBlock & { type: "text" })[] = [];
  let summaryText = "";
  let usage: unknown;
  for (let ci = 0; ci < chunks.length; ci += 1) {
    const chunkSeqs = chunks[ci];
    const isLast = ci === chunks.length - 1;
    const chunkMessages = chunkSeqs
      .map((seq) => session.events[seq])
      .map((event) => (event === undefined ? null : session.deriveEventMessage(event)))
      .filter((message): message is Message => message !== null);
    const foldMessages: Message[] = [];
    if (!isLast && ci > 0) {
      foldMessages.push(
        createUserMessage({
          content: [{ type: "text", text: `${FOLD_PREAMBLE}\n\n${summaryText}` }],
          source: { kind: "plugin", plugin: PLUGIN_ID },
        }),
      );
    }
    foldMessages.push(...chunkMessages);
    let outcome: { blocks: ContentBlock[]; finish: FinishReason; usage?: unknown };
    try {
      outcome = await summarizeWithRetries(
        ctx,
        route,
        {
          ...headerInput,
          messages: foldMessages,
          ...(isLast ? {} : { instruction: FOLD_INSTRUCTION }),
        },
        request.liveSettings,
        session.id,
        request.signal,
        warn,
      );
    } catch (error) {
      if (request.signal?.aborted) return cancelledResult(before);
      const detail = errorChain(error);
      warn(`compaction: summarization failed (chunk ${ci + 1}/${chunks.length}): ${detail}`);
      return failedResult(before, contextWindow, `summarization failed: ${detail}`, route);
    }

    // Keep only text blocks; refuse image output.
    if (contentHasImage(outcome.blocks)) {
      return failedResult(before, contextWindow, "the summary contained image output, which cannot be checkpointed", route);
    }
    const textBlocks = outcome.blocks.filter((block): block is ContentBlock & { type: "text" } => block.type === "text");
    const text = textBlocks.map((block) => block.text).join("\n").trim();
    if (text.length === 0) {
      return failedResult(before, contextWindow, "summarization produced no text", route);
    }
    summaryBlocks = textBlocks;
    summaryText = text;
    usage = mergeUsage(usage, outcome.usage);
  }

  // 7) Land the durable checkpoint (same protocol as the built-in engine).
  const checkpointMessage = createUserMessage({
    content: [
      { type: "text", text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
      ...summaryBlocks,
      { type: "text", text: SUMMARY_CLOSE_TAG },
    ],
    source: { kind: "plugin", plugin: PLUGIN_ID },
  });

  try {
    const startEvent = session.append("compaction/start", { plugin: PLUGIN_ID });
    const summaryEvent = session.append("compaction/summary", {
      plugin: PLUGIN_ID,
      summary: summaryBlocks,
      shadowedRange: { start, end },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount,
      provider: route.provider,
      model: route.model,
      maxTokens: request.liveSettings.summaryMaxTokens,
      ...(chunks.length > 1 ? { chunks: chunks.length, inputBudgetTokens: budget } : {}),
      ...(usage === undefined ? {} : { usage }),
    });
    session.append(
      "user/message",
      checkpointMessage,
      {
        surfaceOp: { op: "replace", start, end },
        sourceEventSeqs: [summarySeqsOf(startEvent), summarySeqsOf(summaryEvent), ...shadowedSeqs],
      },
    );
    session.append("compaction/end", { plugin: PLUGIN_ID });
  } catch (error) {
    warn(`compaction: failed to land the checkpoint: ${errorChain(error)}`);
    return failedResult(before, contextWindow, `could not land the checkpoint: ${errorChain(error)}`, route);
  }

  // Optional durability flush, if a session service is composed.
  const sessions = ctx.get?.("sessions") as { flush?: (session: unknown) => Promise<unknown> } | undefined;
  if (sessions?.flush) {
    try {
      await sessions.flush(session);
    } catch (error) {
      warn(`compaction: checkpoint landed but flush failed: ${errorChain(error)}`);
    }
  }

  // 8) Report the new pressure.
  const after = meter.measure(session);
  const ratioAfter = contextWindow ? after.totalTokens / contextWindow : null;
  info(
    `compaction: shadowed ${shadowedSeqs.length} nodes (seqs ${start}-${end}, ~${shadowedTokenCount} tokens); ` +
      `pressure now ${after.totalTokens} tokens (ratio ${ratioAfter === null ? "?" : ratioAfter.toFixed(3)})`,
  );

  return {
    status: "success",
    message:
      `Compacted ${shadowedSeqs.length} history items (~${shadowedTokenCount} tokens) with ${route.provider}/${route.model}.` +
      (chunks.length > 1 ? ` (summarized in ${chunks.length} folded chunks to fit the model)` : ""),
    stats: {
      totalTokensBefore: before.totalTokens,
      totalTokensAfter: after.totalTokens,
      contextWindow,
      occupancyRatioBefore: ratioBefore,
      occupancyRatioAfter: ratioAfter,
      nodesShadowed: shadowedSeqs.length,
      tokensShadowed: shadowedTokenCount,
      keepNodes: session.surface.nodes.length - shadowedSeqs.length,
    },
    summaryText,
    secondaryModel: route,
  };
}

/** Read the assigned `seq` off an appended event (tolerant of the snapshot shape). */
function summarySeqsOf(event: unknown): number {
  return (event as { seq?: number })?.seq ?? (event as { data?: { seq?: number } })?.data?.seq ?? 0;
}

function emptyStats() {
  return {
    totalTokensBefore: 0,
    totalTokensAfter: null,
    contextWindow: null,
    occupancyRatioBefore: null,
    occupancyRatioAfter: null,
    nodesShadowed: 0,
    tokensShadowed: null,
    keepNodes: 0,
  } as CompressResult["stats"];
}

function statsFrom(
  measurement: { totalTokens: number },
): CompressResult["stats"] {
  return {
    totalTokensBefore: measurement.totalTokens,
    totalTokensAfter: null,
    contextWindow: null,
    occupancyRatioBefore: null,
    occupancyRatioAfter: null,
    nodesShadowed: 0,
    tokensShadowed: null,
    keepNodes: 0,
  };
}

function withWindow(stats: CompressResult["stats"], contextWindow: number | undefined, keepNodes?: number): CompressResult["stats"] {
  const ratio = contextWindow && stats.totalTokensBefore ? stats.totalTokensBefore / contextWindow : null;
  return {
    ...stats,
    contextWindow,
    occupancyRatioBefore: ratio,
    keepNodes: keepNodes ?? stats.keepNodes,
  };
}

function cancelledResult(before: { totalTokens: number }): CompressResult {
  return {
    status: "cancelled",
    message: "Compaction was cancelled.",
    stats: statsFrom(before),
    summaryText: null,
    secondaryModel: null,
  };
}

function failedResult(
  before: { totalTokens: number },
  contextWindow: number | undefined,
  message: string,
  route?: Route,
): CompressResult {
  return {
    status: "failed",
    message,
    stats: withWindow(statsFrom(before), contextWindow),
    summaryText: null,
    secondaryModel: route ?? null,
  };
}

/** A well-formed tool result for the "no agent" rejection path. */
function rejectResult(message: string): CompressResult {
  return {
    status: "failed",
    message,
    stats: emptyStats(),
    summaryText: null,
    secondaryModel: null,
  };
}

/* -------------------------------------------------------------------------- */
/* apply() — register the tool and the command, then expose a clean disposer.  */
/* -------------------------------------------------------------------------- */

export function apply(ctx: Context, rawConfig: Partial<Config> = {}): void {
  // Resolve documented defaults into a concrete, validated Config.
  const config: Config = {
    thresholdRatio: rawConfig.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO,
    keepLastNTurns: rawConfig.keepLastNTurns ?? DEFAULT_KEEP_LAST_TURNS,
    keepLastNMessages: rawConfig.keepLastNMessages ?? DEFAULT_KEEP_LAST_MESSAGES,
    secondaryModelProvider: rawConfig.secondaryModelProvider ?? "",
    secondaryModelName: rawConfig.secondaryModelName ?? "",
    summaryMaxTokens: rawConfig.summaryMaxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS,
    autoCompaction: rawConfig.autoCompaction ?? DEFAULT_AUTO_COMPACTION,
  };

  // ---- Compaction settings (settings-backed, runtime-mutable) ----------------
  // The composition entry is the `base` / default. When a settings service is
  // composed, we register the `compaction` namespace (the same mechanism the
  // main-model selector uses via `agent-default-model`) so EVERY field becomes
  // a live, persisted, UI-editable setting. `settingsRef` always returns the
  // CURRENT values, so the tool reads whichever settings are active at call
  // time — never a baked-in value.
  const baseSettings: CompactionSettings = {
    provider: config.secondaryModelProvider,
    model: config.secondaryModelName,
    thresholdRatio: config.thresholdRatio,
    keepLastNMessages: config.keepLastNMessages,
    keepLastNTurns: config.keepLastNTurns,
    summaryMaxTokens: config.summaryMaxTokens,
    autoCompaction: config.autoCompaction,
  };
  let settingsRef = (): CompactionSettings => baseSettings;

  // Try ctx.get first (works if settings is in the same scope), then fall back
  // to ctx.inject (works if settings is a service that needs injection).
  const settingsDirect = ctx.get?.("settings") as SettingsService | undefined;
  if (settingsDirect && typeof settingsDirect.register === "function") {
    try {
      const scope = settingsDirect.register(COMPACTION_NAMESPACE, COMPACTION_SCHEMA, { base: baseSettings });
      settingsRef = () => {
        const current = scope.get();
        return {
          provider: current?.provider ?? baseSettings.provider,
          model: current?.model ?? baseSettings.model,
          thresholdRatio: current?.thresholdRatio ?? baseSettings.thresholdRatio,
          keepLastNMessages: current?.keepLastNMessages ?? baseSettings.keepLastNMessages,
          keepLastNTurns: current?.keepLastNTurns ?? baseSettings.keepLastNTurns,
          summaryMaxTokens: current?.summaryMaxTokens ?? baseSettings.summaryMaxTokens,
          autoCompaction: current?.autoCompaction ?? baseSettings.autoCompaction,
        };
      };
      const stopWatch = scope.watch(() => {
        try { ctx.logger?.info?.("compaction settings changed"); } catch { /* ignore */ }
      });
      ctx.effect(() => stopWatch, "compaction-tool settings watch");
      try { ctx.logger?.info?.("compaction-tool: settings namespace registered via ctx.get"); } catch { /* ignore */ }
    } catch (error) {
      warnLog(ctx, `compaction settings registration via ctx.get failed: ${errorChain(error)}`);
    }
  } else {
    // Fallback: use ctx.inject to get the settings service in a child scope.
    try {
      ctx.inject(["settings"], (settingsCtx) => {
        try {
          const scope = settingsCtx.settings.register(COMPACTION_NAMESPACE, COMPACTION_SCHEMA, { base: baseSettings });
          settingsRef = () => {
            const current = scope.get();
            return {
              provider: current?.provider ?? baseSettings.provider,
              model: current?.model ?? baseSettings.model,
              thresholdRatio: current?.thresholdRatio ?? baseSettings.thresholdRatio,
              keepLastNMessages: current?.keepLastNMessages ?? baseSettings.keepLastNMessages,
              keepLastNTurns: current?.keepLastNTurns ?? baseSettings.keepLastNTurns,
              summaryMaxTokens: current?.summaryMaxTokens ?? baseSettings.summaryMaxTokens,
              autoCompaction: current?.autoCompaction ?? baseSettings.autoCompaction,
            };
          };
          const stopWatch = scope.watch(() => {
            try { ctx.logger?.info?.("compaction settings changed"); } catch { /* ignore */ }
          });
          settingsCtx.effect(() => stopWatch, "compaction-tool settings watch (inject)");
          try { ctx.logger?.info?.("compaction-tool: settings namespace registered via ctx.inject"); } catch { /* ignore */ }
        } catch (error) {
          warnLog(ctx, `compaction settings registration via ctx.inject failed: ${errorChain(error)}`);
        }
      });
    } catch (error) {
      warnLog(ctx, `compaction settings injection failed (no settings service available): ${errorChain(error)}`);
    }
  }

  /** Read the current live compaction settings (defaults filled). */
  const liveSettings = (): CompactionSettings => {
    try {
      return settingsRef();
    } catch {
      return baseSettings;
    }
  };

  // ---- Tool ----------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: "compress_context",
      description:
        "Condense the OLDER history of the current session into a durable checkpoint, freeing context for the rest of the task. " +
        "It summarizes the leading history with the selected compaction model (change it via the Settings panel or the compaction setting) " +
        "while keeping your most recent turns/messages verbatim. " +
        "Call it when the session is approaching its context limit and you want to continue with a smaller, summarized tail. " +
        "Only target 'history' is implemented. Use keep_last_n_turns or keep_last_n_messages to retain more or fewer recent items, " +
        "and force=true to compress even when occupancy is below the threshold. Returns success/skipped/cancelled/failed with stats and the summary text.",
      parameters: {
        target: {
          type: "string",
          required: true,
          enum: ["history", "tool_results"],
          description: "What to condense. Only 'history' is implemented; 'tool_results' is reserved.",
        },
        keep_last_n_turns: {
          type: "integer",
          description: "Optional: retain this many most-recent turns verbatim (overrides the configured default).",
        },
        keep_last_n_messages: {
          type: "integer",
          description: "Optional: retain this many most-recent messages verbatim. Takes priority over keep_last_n_turns when both are given.",
        },
        force: {
          type: "boolean",
          description: "Optional: compress even when context occupancy is below the threshold. Defaults to false.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["success", "skipped", "cancelled", "failed"] },
            message: { type: "string" },
            summaryText: { oneOf: [{ type: "string" }, { type: "null" }] },
            stats: {
              type: "object",
              additionalProperties: false,
              properties: {
                totalTokensBefore: { type: "integer" },
                totalTokensAfter: { oneOf: [{ type: "integer" }, { type: "null" }] },
                contextWindow: { oneOf: [{ type: "integer" }, { type: "null" }] },
                occupancyRatioBefore: { oneOf: [{ type: "number" }, { type: "null" }] },
                occupancyRatioAfter: { oneOf: [{ type: "number" }, { type: "null" }] },
                nodesShadowed: { type: "integer" },
                tokensShadowed: { oneOf: [{ type: "integer" }, { type: "null" }] },
                keepNodes: { oneOf: [{ type: "integer" }, { type: "null" }] },
              },
            },
            secondaryModel: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    provider: { type: "string" },
                    model: { type: "string" },
                  },
                },
                { type: "null" },
              ],
            },
          },
        },
        render: (_args, value) => {
          const v = value as CompressResult;
          const lines = [`${v.status.toUpperCase()}: ${v.message}`];
          if (v.stats.totalTokensAfter !== null && v.stats.totalTokensBefore !== 0) {
            lines.push(
              `Tokens: ${v.stats.totalTokensBefore} → ${v.stats.totalTokensAfter}` +
                (v.stats.contextWindow ? ` (window ${v.stats.contextWindow})` : "") +
                (v.stats.nodesShadowed ? `; shadowed ${v.stats.nodesShadowed} nodes (~${v.stats.tokensShadowed ?? "?"})` : ""),
            );
          }
          if (v.summaryText) lines.push("", "Checkpoint:", v.summaryText);
          return [{ type: "text", text: lines.join("\n") }];
        },
      },
      execute(args, exec) {
        const target = args.target as "history" | "tool_results";
        const force = (args.force as boolean | undefined) ?? false;
        const keepMessages = args.keep_last_n_messages as number | undefined;
        const keepTurns = args.keep_last_n_turns as number | undefined;
        const agent = exec.agent as unknown as AgentView | undefined;
        if (!agent) return Promise.resolve(rejectResult("compress_context requires an owning agent session"));
        const settings = liveSettings();
        return runCompression(ctx, config, {
          agent,
          signal: exec.signal,
          target,
          force,
          keepMessages,
          keepTurns,
          liveRoute: { provider: settings.provider, model: settings.model },
          liveSettings: settings,
        });
      },
      isConcurrencySafe: () => false,
      presentCall: (args) => ({
        card: "generic",
        title: "Compress context",
        kind: "other",
        rawInput: { target: (args as { target?: string }).target, force: (args as { force?: boolean }).force },
      }),
    }),
  );

  // ---- Command (/compact) ---------------------------------------------------
  // Optional: only when a command adapter is composed. Registered through
  // ctx.effect so its disposer runs with the fiber (matching dsh-command-compact).
  const commands = ctx.get?.("commands") as
    | { register?: (def: unknown) => () => void }
    | undefined;
  if (commands && typeof commands.register === "function") {
    ctx.effect(
      function* () {
        yield commands.register!({
          name: "compact",
          description: "Compact older conversation history (selected compaction model summary)",
          handler: async (invocation: { agent: AgentView; signal: AbortSignal }) => {
            // The human command is an explicit "do it now" request, so force
            // past the threshold gate and keep the configured recent tail.
            const settings = liveSettings();
            const result = await runCompression(ctx, config, {
              agent: invocation.agent,
              signal: invocation.signal,
              target: "history",
              force: true,
              keepMessages: undefined,
              keepTurns: undefined,
              liveRoute: { provider: settings.provider, model: settings.model },
              liveSettings: settings,
            });
            return {
              kind: result.status === "success" ? "success" : "error",
              text: result.message,
            } as const;
          },
        });
      },
      "compaction-tool /compact command",
    );
  }

  // ---- llm/stream interception: redirect compaction calls to the fast model --
  // The built-in dsh-compaction-basic resolves the summarization target as
  // configured ?? latest ?? agentTarget. When configured is empty (the default),
  // it falls back to the session's latest routed model — the slow main model.
  // By intercepting the llm/stream waterfall for purpose=compaction and forcing
  // the provider/model to the user-selected compaction model, we ensure ALL
  // compaction paths (/compact command, auto-compaction, context-overflow
  // recovery) use the fast model, regardless of the built-in's config.
  ctx.on?.(
    "llm/stream",
    (options: { purpose?: string; provider: string; model: string }, next: () => AsyncIterable<unknown>) => {
      if (options.purpose === "compaction") {
        const target = liveSettings();
        if (target.provider && target.model) {
          options.provider = target.provider;
          options.model = target.model;
        }
      }
      return next();
    },
  );

  // ---- Optional automatic (pressure-driven) compaction ----------------------
  // ctx.on auto-registers its disposer with the current fiber (see cordis
  // EventsService.register), so no ctx.effect wrapper is needed here.
  // The hook is ALWAYS registered; the live `autoCompaction` setting is checked
  // at call time, so the user can toggle it in the settings UI without restart.
  ctx.on?.(
    "agent/pre-step",
    async (
      payload: { agent: AgentView; signal: AbortSignal },
      next: () => Promise<unknown> | unknown,
    ) => {
      try {
        const settings = liveSettings();
        if (settings.autoCompaction && !payload.signal.aborted) {
          const result = await runCompression(ctx, config, {
            agent: payload.agent,
            signal: payload.signal,
            target: "history",
            force: false,
            keepMessages: undefined,
            keepTurns: undefined,
            liveRoute: { provider: settings.provider, model: settings.model },
            liveSettings: settings,
          });
          if (result.status === "success") {
            ctx.logger?.info?.(`auto-compaction: ${result.message}`);
          }
        }
      } catch (error) {
        ctx.logger?.warn?.(`auto-compaction failed: ${errorChain(error)}; continuing the turn`);
      }
      return next();
    },
  );
}

/** Safe warn logger that never throws (used before a logger may be ready). */
function warnLog(ctx: Context, msg: string): void {
  try {
    ctx.logger?.warn?.(msg);
  } catch {
    /* never break apply on logging */
  }
}
