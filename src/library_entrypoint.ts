/**
 * Public client-facing interfaces shared by the packaged RLM entrypoints.
 *
 * @module
 *
 * @example
 * ```ts
 * import type { RLMClientOptions } from './library_entrypoint.ts';
 * ```
 */
import type { LLMAdapter, LLMCaller } from './llm_adapter.ts';
import type { ExecutionBackend, RLMLogger } from './types.ts';
import type { JsonValue } from './types.ts';
import type { RLMRunResult } from './rlm_runner.ts';

/**
 * Groups the model identifiers used by one library-configured RLM client.
 *
 * The root model handles the top-level loop.
 * The sub model is used when the REPL invokes `llm_query(...)`.
 *
 * @example
 * ```ts
 * const models: RLMModels = {
 *   root: 'gpt-5-nano',
 *   sub: 'gpt-5-mini',
 * };
 * ```
 */
export interface RLMModels {
  root: string;
  sub: string;
}

/**
 * Captures client-wide default limits that individual runs may override.
 *
 * These values are fixed when a client is created, but each `run(...)`
 * call may still override them for a specific task.
 *
 * @example
 * ```ts
 * const defaults: RLMDefaults = {
 *   cellTimeoutMs: 8_000,
 *   maxSteps: 12,
 *   maxSubcallDepth: 1,
 *   outputCharLimit: 4_000,
 * };
 * ```
 */
export interface RLMDefaults {
  cellTimeoutMs?: number;
  maxSteps?: number;
  maxSubcallDepth?: number;
  outputCharLimit?: number;
}

/**
 * Configures an optional read-only evaluator that critiques each completed step.
 *
 * The evaluator uses the same injected caller as the main RLM run, but with its own model.
 * Its feedback is attached to the next turn input instead of executing code directly.
 *
 * @example
 * ```ts
 * const evaluator: RLMEvaluatorOptions = {
 *   enabled: true,
 *   model: 'gpt-5-mini',
 *   maxFeedbackChars: 240,
 * };
 * ```
 */
export interface RLMEvaluatorOptions {
  enabled?: boolean;
  maxFeedbackChars?: number;
  model: string;
}

/**
 * Describes the shared dependencies configured once at client construction time.
 *
 * This interface is the main dependency injection point for library consumers.
 * It intentionally separates long-lived dependencies from per-request inputs.
 *
 * @example
 * ```ts
 * const clientOptions: RLMClientOptions = {
 *   llm,
 *   models: {
 *     root: 'gpt-5-nano',
 *     sub: 'gpt-5-mini',
 *   },
 * };
 * ```
 */
export interface RLMClientOptions {
  adapter?: LLMAdapter;
  clock?: () => Date;
  defaults?: RLMDefaults;
  evaluator?: RLMEvaluatorOptions;
  executionBackend?: ExecutionBackend;
  idGenerator?: () => string;
  llm?: LLMCaller;
  logger?: RLMLogger;
  models: RLMModels;
  systemPromptExtension?: string;
  systemPromptMarkdown?: string;
}

/**
 * Describes the per-run inputs passed into the library entry point.
 *
 * A library consumer typically keeps a client alive and changes only this object
 * from call to call.
 *
 * @example
 * ```ts
 * const input: RLMRunInput = {
 *   context: { document: 'Chapter 1\\n...' },
 *   prompt: 'Summarize the main claim.',
 * };
 * ```
 */
export interface RLMRunInput {
  cellTimeoutMs?: number;
  context: JsonValue | null;
  maxSteps?: number;
  maxSubcallDepth?: number;
  outputCharLimit?: number;
  prompt: string;
  systemPromptMarkdown?: string;
  systemPromptExtension?: string;
}

/**
 * Represents the stable library-facing client interface for executing RLM runs.
 *
 * The goal of this surface is to keep library usage simple:
 * create a client once, then call `run(...)` for each task.
 */
export interface RLMClient {
  /**
   * Executes one full root RLM loop with the provided task description and context.
   *
   * @param input Per-run task data and optional limit overrides.
   * @returns The final answer string, execution metadata, and the resulting REPL session.
   *
   * @example
   * ```ts
   * const result = await client.run({
   *   context: { document: 'Chapter 1\\n...' },
   *   prompt: 'Extract the access code.',
   * });
   *
   * console.log(result.answer);
   * ```
   */
  run(input: RLMRunInput): Promise<RLMRunResult>;
}
