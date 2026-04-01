/**
 * Provider-neutral caller contracts consumed by the RLM runtime.
 *
 * @module
 *
 * @example
 * ```ts
 * import type { LLMCaller } from './llm_adapter.ts';
 * ```
 */
/**
 * Describes the provider-neutral usage payload consumed by the orchestration layer.
 */
export interface LLMUsage {
  cachedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * Distinguishes root turns, child turns, and plain `llm_query(...)` completions.
 *
 * @example
 * ```ts
 * const kind: LLMCallKind = 'root_turn';
 * ```
 */
export type LLMCallKind = 'child_turn' | 'plain_query' | 'root_turn';

/**
 * Carries execution metadata that the caller may use for logging, routing, or billing.
 *
 * @example
 * ```ts
 * const metadata: LLMCallMetadata = {
 *   depth: 1,
 *   queryIndex: 0,
 *   step: 2,
 * };
 * ```
 */
export interface LLMCallMetadata {
  depth: number;
  queryIndex?: number;
  step?: number;
}

/**
 * Describes one provider-neutral model invocation emitted by the RLM core.
 *
 * `turnState` is opaque provider state. The core forwards it but does not inspect it.
 *
 * @example
 * ```ts
 * const request: LLMCallerRequest = {
 *   input: 'Summarize the chapter.',
 *   kind: 'root_turn',
 *   metadata: { depth: 0, step: 1 },
 *   model: 'gpt-5-nano',
 *   systemPrompt: 'Use concise Korean.',
 * };
 * ```
 */
export interface LLMCallerRequest {
  input: string;
  kind: LLMCallKind;
  metadata?: LLMCallMetadata;
  model: string;
  signal?: AbortSignal;
  systemPrompt: string;
  turnState?: unknown;
}

/**
 * Describes the provider-neutral completion payload returned to the orchestration layer.
 *
 * @example
 * ```ts
 * const response: LLMCallerResponse = {
 *   outputText: '```repl\\nFINAL_VAR(\"ok\")\\n```',
 *   turnState: { cursor: 'opaque-provider-state' },
 * };
 * ```
 */
export interface LLMCallerResponse {
  outputText: string;
  turnState?: unknown;
  usage?: LLMUsage;
}

/**
 * Describes the minimal caller surface required by the RLM core.
 *
 * @example
 * ```ts
 * const llm: LLMCaller = {
 *   async complete(request) {
 *     return {
 *       outputText: '```repl\\nFINAL_VAR(\"ok\")\\n```',
 *     };
 *   },
 * };
 * ```
 */
export interface LLMCaller {
  complete(request: LLMCallerRequest): Promise<LLMCallerResponse>;
}

/**
 * Describes a factory that builds provider-specific callers for the provider-neutral core.
 *
 * Providers own authentication, SDK wiring, retries, and transport details.
 * The core only consumes the resulting `LLMCaller`.
 *
 * @example
 * ```ts
 * const provider: LLMProvider<{ token: string }> = {
 *   createCaller(config) {
 *     return {
 *       async complete(request) {
 *         return {
 *           outputText: `echo:${config.token}:${request.input}`,
 *         };
 *       },
 *     };
 *   },
 * };
 * ```
 */
export interface LLMProvider<Config = unknown> {
  createCaller(config: Config): LLMCaller;
}

/**
 * @deprecated Use `LLMCallerRequest`.
 */
export type LLMCompletionRequest = LLMCallerRequest;

/**
 * @deprecated Use `LLMCallerResponse`.
 */
export type LLMCompletionResponse = LLMCallerResponse;

/**
 * @deprecated Use `LLMCaller`.
 */
export type LLMAdapter = LLMCaller;
