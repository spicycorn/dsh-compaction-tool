/**
 * dsh-compaction-tool — public surface.
 *
 * Four named exports required by the Cordis plugin loader (injection metadata is
 * read from these). `Config` is a schemastery / Standard-Schema object; the
 * loader validates the row's `config` against `Config['~standard']`.
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

/** Stable loader identity. */
export declare const name: string;

/** Hard service dependencies (optional ones are read through `ctx.get`). */
export declare const inject: readonly string[];

/** Resolved, validated plugin configuration (defaults filled in). */
export interface Config {
  /** Request-pressure fraction in (0, 1] at which compaction engages (default 0.8). */
  thresholdRatio: number;
  /** Tail retained verbatim, in turns, when the caller does not override it (default 3). */
  keepLastNTurns: number;
  /** Tail retained verbatim, in messages; takes priority over `keepLastNTurns` (default 10). */
  keepLastNMessages: number;
  /** Secondary summarizer provider; empty string = inherit the session route. */
  secondaryModelProvider: string;
  /** Secondary summarizer model id; empty string = inherit the session route. */
  secondaryModelName: string;
  /** Output cap for the summarization call in tokens (default 1024). */
  summaryMaxTokens: number;
  /** Also register the automatic pressure-driven `agent/pre-step` hook (default false). */
  autoCompaction: boolean;
}

/** Schemastery configuration schema (all fields optional at the wire). */
export declare const Config: z<Config>;

/**
 * Register the `compress_context` tool and the `/compact` command, and (when
 * `autoCompaction` is set) the automatic `agent/pre-step` hook.
 * @param ctx - the plugin context.
 * @param config - raw row config; documented defaults are resolved here.
 */
export declare function apply(ctx: Context, config?: Partial<Config>): void;
