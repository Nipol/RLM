/**
 * Describes one model completion request consumed by the orchestration layer.
 */
export interface LLMCompletionRequest {
  input: string;
  model: string;
  previousResponseId?: string;
  signal?: AbortSignal;
  systemPrompt: string;
}

/**
 * Describes the normalized completion payload returned to the orchestration layer.
 */
export interface LLMUsage {
  cachedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * Describes the normalized completion payload returned to the orchestration layer.
 */
export interface LLMCompletionResponse {
  outputText: string;
  responseId: string | null;
  usage?: LLMUsage;
}

/**
 * Describes the minimal text-generation surface needed by the current RLM runner.
 */
export interface LLMAdapter {
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;
}
