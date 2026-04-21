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
 * `messages` carries the provider-neutral append-only conversation form when
 * one caller can consume structured turns. `input` remains the flattened
 * fallback for callers that only support a single prompt string.
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
  messages?: LLMCallerMessage[];
  metadata?: LLMCallMetadata;
  model: string;
  signal?: AbortSignal;
  systemPrompt: string;
  /**
   * @deprecated Stateful provider continuation is no longer used by the core.
   * Prefer explicit append-only `messages` so every provider sees the same
   * conversation state.
   */
  turnState?: unknown;
}

/**
 * Describes the provider-neutral completion payload returned to the orchestration layer.
 *
 * @example
 * ```ts
 * const response: LLMCallerResponse = {
 *   outputText: '```repl\\nFINAL_VAR(\"ok\")\\n```',
 * };
 * ```
 */
export interface LLMCallerResponse {
  outputText: string;
  /**
   * @deprecated Stateful provider continuation is ignored by the core.
   */
  turnState?: unknown;
  usage?: LLMUsage;
}

/**
 * Describes one provider-neutral conversational message.
 *
 * @example
 * ```ts
 * const message: LLMCallerMessage = {
 *   role: 'user',
 *   content: 'Run the next REPL step.',
 * };
 * ```
 */
export interface LLMCallerMessage {
  content: string;
  role: 'assistant' | 'user';
}

/**
 * Renders structured messages into the legacy single-string caller input.
 *
 * @example
 * ```ts
 * const input = formatLLMCallerMessagesAsText([
 *   { role: 'user', content: 'Question' },
 *   { role: 'assistant', content: '```repl\\n1 + 1\\n```' },
 * ]);
 * ```
 */
export function formatLLMCallerMessagesAsText(
  messages: readonly LLMCallerMessage[],
): string {
  return messages
    .map((message) => `${message.role}:\n${message.content}`)
    .join('\n\n');
}

/**
 * Returns the best prompt string available for callers that do not support
 * structured messages.
 */
export function resolveLLMCallerInputText(request: LLMCallerRequest): string {
  if (request.messages !== undefined && request.messages.length > 0) {
    return formatLLMCallerMessagesAsText(request.messages);
  }

  return request.input;
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
 * Backward-compatible alias for the provider-neutral request shape.
 *
 * @deprecated Use `LLMCallerRequest`.
 *
 * @example
 * ```ts
 * const request: LLMCompletionRequest = {
 *   input: 'Summarize the chapter.',
 *   kind: 'root_turn',
 *   model: 'demo-root',
 *   systemPrompt: 'Use concise Korean.',
 * };
 * ```
 */
export type LLMCompletionRequest = LLMCallerRequest;

/**
 * Backward-compatible alias for the provider-neutral completion payload.
 *
 * @deprecated Use `LLMCallerResponse`.
 *
 * @example
 * ```ts
 * const response: LLMCompletionResponse = {
 *   outputText: '```repl\\nFINAL_VAR(\"ok\")\\n```',
 * };
 * ```
 */
export type LLMCompletionResponse = LLMCallerResponse;

/**
 * Backward-compatible alias for the provider-neutral caller interface.
 *
 * @deprecated Use `LLMCaller`.
 *
 * @example
 * ```ts
 * const adapter: LLMAdapter = {
 *   async complete() {
 *     return {
 *       outputText: '```repl\\nFINAL_VAR(\"ok\")\\n```',
 *     };
 *   },
 * };
 * ```
 */
export type LLMAdapter = LLMCaller;
