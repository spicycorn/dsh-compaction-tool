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

                                                   
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  BlockAssembler,
  createUserMessage,
  contentHasImage,
  errorChain,
                    
                    
               
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
                              
                   
                
                         
                            
                         
                           
                          
 

/** The minimal settings-service surface the plugin uses (read + register + watch). */
                         
                                               
                                                                      
 
                           
           
               
                    
                                                           
                   
 

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
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation prefix (not as a separate system prompt). Keeping the
 * conversation's own prefix in front of it makes the auxiliary call a genuine
 * prefix of the last routed request, so the secondary model's KV cache is reused.
 */
const COMPACTION_INSTRUCTION = [
  "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
  "",
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

/* -------------------------------------------------------------------------- */
/* Small, dependency-light helpers.                                            */
/* -------------------------------------------------------------------------- */

/** A resolved provider/model route for a model call. */
                 
                            
                         
 

/** The canonical shape returned by both the tool body and the `/compact` handler. */
                                                                     

                          
                         
                                                                             
                  
          
                              
                                    
                                 
                                        
                                       
                          
                                  
                      
    
                                                            
                             
                                                                              
                               
 

/** Minimal structural view of the session the plugin needs (kept loose on purpose). */
                       
                       
                                                                                                      
                                                          
                                                                                                                      
                                                     
                                                               
 

/** Minimal structural view of the agent that owns the session. */
                     
                                
                                                           
 

/** The token-meter service surface the plugin prices with. */
                     
                                                                                                            
                                            
 

/** Resolve the effective keep policy for one call. Messages win over turns. */
                      
                             
                
 

function resolveKeepPolicy(
  settings                                                       ,
  overrideMessages                    ,
  overrideTurns                    ,
)             {
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
  session             ,
  keep            ,
)                                                             {
  const nodes = session.surface.nodes;
  if (nodes.length === 0) return null;

  let keepFromIdx        ;
  if (keep.kind === "messages") {
    keepFromIdx = Math.max(0, nodes.length - keep.count);
  } else {
    // Retain the last `count` turns: a node belongs to the turn group that is
    // open at its log position (turns open with `turn/start`). Walk the log in
    // order, tagging each surface node with the number of `turn/start`s seen so
    // far, then keep every node from the Nth-from-last turn onward.
    const turnOf = new Map                ();
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
function isSurfaceEligible(event                  )          {
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
function classifyFinish(finish              , signal                         )   
                                     
                   
  {
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

/**
 * Run the non-streaming summarization call: drain `ctx.llm.stream` into a
 * `BlockAssembler` and read the assembled text once. This is the faithful
 * stand-in for a `ctx.llm.generate` one-shot (which this harness does not expose).
 * Honors `signal` so a cancelled turn aborts the auxiliary call.
 */
async function summarizeWithLlm(
  ctx         ,
  route       ,
  input                                                             ,
  config        ,
  sessionId         ,
  signal                         ,
)                                                                             {
  const assembler = new BlockAssembler();
  const messages            = [
    ...input.messages,
    createUserMessage({
      content: [{ type: "text", text: COMPACTION_INSTRUCTION }],
      source: { kind: "plugin", plugin: PLUGIN_ID },
    }),
  ];
  const options = {
    provider: route.provider,
    model: route.model,
    messages,
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.tools === undefined || input.tools.length === 0 ? {} : { tools: input.tools            }),
    maxTokens: config.summaryMaxTokens,
    ...(sessionId === undefined ? {} : { sessionId: sessionId          }),
    purpose: "compaction"         ,
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
 * Resolve the compaction model route for one call. The LIVE `compaction`
 * selection (read from the settings-backed source thunk) wins; the composition
 * base (`secondaryModelProvider` / `secondaryModelName`) is the default when the
 * user has not made a selection; then the session's latest durable route, then
 * the agent's configured route. Nothing here is a fixed, baked-in value.
 */
function resolveSecondaryRoute(
  liveRoute                   ,
  config        ,
  session             ,
  agent                       ,
)        {
  if (liveRoute && liveRoute.provider.length > 0 && liveRoute.model.length > 0) return liveRoute;
  const base        = { provider: config.secondaryModelProvider, model: config.secondaryModelName };
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

                           
                   
                                  
                                     
                 
                                   
                                
                                                                               
                               
                                                                            
                                   
 

/**
 * The one compaction transaction: measure pressure, select the head-anchored
 * range to condense, summarize it with the selected compaction model, then land a
 * durable `compaction/summary` + `surfaceOp: replace` checkpoint exactly as the
 * built-in engine does. Pure read-only until the summarization succeeds; on any
 * failure the session surface is left unchanged.
 */
async function runCompression(
  ctx         ,
  config        ,
  request                 ,
)                          {
  const session = request.agent.session;
  const log = ctx.logger;
  const info = (msg        ) => {
    try {
      log?.info?.(msg);
    } catch {
      /* logging must never break a tool result */
    }
  };
  const warn = (msg        ) => {
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

  const meter = ctx.tokenMeter                        ;

  // 1) Read current pressure. A meter failure (e.g. a session the meter cannot
  //    fold) must surface as a clean tool failure, never an uncaught throw.
  let before                                                                            ;
  try {
    before = meter.measure(session);
  } catch (error) {
    warn(`compaction: token-meter measurement failed: ${errorChain(error)}`);
    return failedResult({ totalTokens: 0 }, undefined, `could not measure session pressure: ${errorChain(error)}`);
  }
  let contextWindow                    ;
  let route       ;
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

  // Replay the conversation prefix (system + tools + the region's own messages)
  // so the auxiliary call is a genuine prefix of the last routed request.
  const header = session.requestHeader();
  const regionMessages = shadowedSeqs
    .map((seq) => session.events[seq])
    .map((event) => (event === undefined ? null : session.deriveEventMessage(event)))
    .filter((message)                     => message !== null);

  // 5) Summarize with the selected compaction model (non-streaming via the assembler).
  let summarized;
  try {
    summarized = await summarizeWithLlm(
      ctx,
      route,
      {
        ...(header?.system === undefined ? {} : { system: header.system }),
        ...(header?.tools === undefined || header.tools.length === 0 ? {} : { tools: header.tools }),
        messages: regionMessages,
      },
      request.liveSettings,
      session.id,
      request.signal,
    );
  } catch (error) {
    if (request.signal?.aborted) return cancelledResult(before);
    const detail = errorChain(error);
    warn(`compaction: summarization threw: ${detail}`);
    return failedResult(before, contextWindow, `summarization failed: ${detail}`, route);
  }

  // classifyFinish gives cancellation precedence over the adapter's reason.
  const finish = classifyFinish(summarized.finish, request.signal);
  if (finish.kind === "cancelled") return cancelledResult(before);
  if (finish.kind === "error") {
    warn(`compaction: ${finish.message}`);
    return failedResult(before, contextWindow, finish.message ?? "summarization failed", route);
  }

  // 6) Keep only text blocks; refuse image output.
  if (contentHasImage(summarized.blocks)) {
    return failedResult(before, contextWindow, "the summary contained image output, which cannot be checkpointed", route);
  }
  const summaryBlocks = summarized.blocks.filter((block)                                           => block.type === "text");
  const summaryText = summaryBlocks.map((block) => block.text).join("\n").trim();
  if (summaryText.length === 0) {
    return failedResult(before, contextWindow, "summarization produced no text", route);
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
      ...(summarized.usage === undefined ? {} : { usage: summarized.usage }),
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
  const sessions = ctx.get?.("sessions")                                                                  ;
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
    message: `Compacted ${shadowedSeqs.length} history items (~${shadowedTokenCount} tokens) with ${route.provider}/${route.model}.`,
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
function summarySeqsOf(event         )         {
  return (event                    )?.seq ?? (event                               )?.data?.seq ?? 0;
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
  }                           ;
}

function statsFrom(
  measurement                         ,
)                          {
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

function withWindow(stats                         , contextWindow                    , keepNodes         )                          {
  const ratio = contextWindow && stats.totalTokensBefore ? stats.totalTokensBefore / contextWindow : null;
  return {
    ...stats,
    contextWindow,
    occupancyRatioBefore: ratio,
    keepNodes: keepNodes ?? stats.keepNodes,
  };
}

function cancelledResult(before                         )                 {
  return {
    status: "cancelled",
    message: "Compaction was cancelled.",
    stats: statsFrom(before),
    summaryText: null,
    secondaryModel: null,
  };
}

function failedResult(
  before                         ,
  contextWindow                    ,
  message        ,
  route        ,
)                 {
  return {
    status: "failed",
    message,
    stats: withWindow(statsFrom(before), contextWindow),
    summaryText: null,
    secondaryModel: route ?? null,
  };
}

/** A well-formed tool result for the "no agent" rejection path. */
function rejectResult(message        )                 {
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

export function apply(ctx         , rawConfig                  = {})       {
  // Resolve documented defaults into a concrete, validated Config.
  const config         = {
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
  const baseSettings                     = {
    provider: config.secondaryModelProvider,
    model: config.secondaryModelName,
    thresholdRatio: config.thresholdRatio,
    keepLastNMessages: config.keepLastNMessages,
    keepLastNTurns: config.keepLastNTurns,
    summaryMaxTokens: config.summaryMaxTokens,
    autoCompaction: config.autoCompaction,
  };
  let settingsRef = ()                     => baseSettings;

  // Try ctx.get first (works if settings is in the same scope), then fall back
  // to ctx.inject (works if settings is a service that needs injection).
  const settingsDirect = ctx.get?.("settings")                               ;
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
  const liveSettings = ()                     => {
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
          const v = value                  ;
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
        const target = args.target                              ;
        const force = (args.force                       ) ?? false;
        const keepMessages = args.keep_last_n_messages                      ;
        const keepTurns = args.keep_last_n_turns                      ;
        const agent = exec.agent                                    ;
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
        rawInput: { target: (args                       ).target, force: (args                       ).force },
      }),
    }),
  );

  // ---- Command (/compact) ---------------------------------------------------
  // Optional: only when a command adapter is composed. Registered through
  // ctx.effect so its disposer runs with the fiber (matching dsh-command-compact).
  const commands = ctx.get?.("commands")   
                                                 
               ;
  if (commands && typeof commands.register === "function") {
    ctx.effect(
      function* () {
        yield commands.register ({
          name: "compact",
          description: "Compact older conversation history (selected compaction model summary)",
          handler: async (invocation                                           ) => {
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
            }         ;
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
    (options                                                       , next                              ) => {
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
      payload                                           ,
      next                                  ,
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
function warnLog(ctx         , msg        )       {
  try {
    ctx.logger?.warn?.(msg);
  } catch {
    /* never break apply on logging */
  }
}
