import type { OpenAIProviderConfig } from './env.ts';
import type { LLMAdapter, LLMCompletionRequest, LLMCompletionResponse } from './llm_adapter.ts';

type FetchLike = typeof fetch;

interface OpenAIUsagePayload {
  input_tokens_details?: {
    cached_tokens?: number;
  };
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface OpenAIMessageContentPayload {
  text?: string;
  type?: string;
}

interface OpenAIMessagePayload {
  content?: OpenAIMessageContentPayload[];
  type?: string;
}

interface OpenAIResponsePayload {
  error?: {
    message?: string;
  };
  id?: string;
  output?: OpenAIMessagePayload[];
  output_text?: string;
  usage?: OpenAIUsagePayload;
}

/**
 * Describes the constructor options for the OpenAI Responses adapter.
 *
 * @example
 * ```ts
 * const options: OpenAIResponsesAdapterOptions = {
 *   config: {
 *     apiKey: 'sk-test',
 *     baseUrl: 'https://api.openai.com/v1',
 *     requestTimeoutMs: 30_000,
 *     rootModel: 'gpt-5-nano',
 *     subModel: 'gpt-5-mini',
 *   },
 * };
 * ```
 */
export interface OpenAIResponsesAdapterOptions {
  config: OpenAIProviderConfig;
  fetcher?: FetchLike;
}

/**
 * Raised when the OpenAI Responses API returns an HTTP or payload-level failure.
 *
 * @example
 * ```ts
 * throw new OpenAIResponsesError(503, 'model unavailable');
 * ```
 */
export class OpenAIResponsesError extends Error {
  readonly status: number;

  /**
   * Stores the HTTP status alongside a user-readable provider error message.
   *
   * @example
   * ```ts
   * const error = new OpenAIResponsesError(408, 'OpenAI request timed out.');
   * console.log(error.status);
   * ```
   */
  constructor(status: number, message: string) {
    super(message);
    this.name = 'OpenAIResponsesError';
    this.status = status;
  }
}

/**
 * Extracts assistant text from the raw Responses API payload.
 */
function extractOutputText(payload: OpenAIResponsePayload): string {
  if (typeof payload.output_text === 'string') {
    if (payload.output_text.length > 0) {
      return payload.output_text;
    }
  }

  const parts: string[] = [];
  const outputItems = Array.isArray(payload.output) ? payload.output : [];
  for (const item of outputItems) {
    if (item.type !== 'message') {
      continue;
    }

    const contents = Array.isArray(item.content) ? item.content : [];
    for (const content of contents) {
      if (content.type !== 'output_text' && content.type !== 'text') {
        continue;
      }

      if (typeof content.text !== 'string') {
        continue;
      }

      parts.push(content.text);
    }
  }

  if (parts.length === 0) {
    throw new OpenAIResponsesError(502, 'OpenAI response did not contain assistant text.');
  }

  return parts.join('\n');
}

/**
 * Normalizes token accounting from the provider payload.
 */
function normalizeUsage(payload: OpenAIResponsePayload): LLMCompletionResponse['usage'] {
  if (payload.usage === undefined) {
    return undefined;
  }

  return {
    cachedInputTokens: payload.usage.input_tokens_details?.cached_tokens,
    inputTokens: payload.usage.input_tokens,
    outputTokens: payload.usage.output_tokens,
    totalTokens: payload.usage.total_tokens,
  };
}

function detachAbortListener(
  signal: AbortSignal | undefined,
  handleExternalAbort: () => void,
): void {
  if (signal === undefined) {
    return;
  }

  signal.removeEventListener('abort', handleExternalAbort);
}

function attachAbortListener(
  signal: AbortSignal | undefined,
  controller: AbortController,
  handleExternalAbort: () => void,
): void {
  if (signal?.aborted === true) {
    controller.abort();
    return;
  }

  if (signal === undefined) {
    return;
  }

  signal.addEventListener('abort', handleExternalAbort, { once: true });
}

function cleanupCompletionRequest(
  timer: ReturnType<typeof setTimeout>,
  signal: AbortSignal | undefined,
  handleExternalAbort: () => void,
): void {
  clearTimeout(timer);
  detachAbortListener(signal, handleExternalAbort);
}

/**
 * Implements the provider-neutral adapter interface on top of the OpenAI Responses API.
 *
 * @example
 * ```ts
 * const adapter = new OpenAIResponsesAdapter({
 *   config: {
 *     apiKey: 'sk-test',
 *     baseUrl: 'https://api.openai.com/v1',
 *     requestTimeoutMs: 30_000,
 *     rootModel: 'gpt-5-nano',
 *     subModel: 'gpt-5-mini',
 *   },
 * });
 * ```
 */
export class OpenAIResponsesAdapter implements LLMAdapter {
  readonly #config: OpenAIProviderConfig;
  readonly #fetcher: FetchLike;

  /**
   * Captures the provider credentials and optional mocked fetch implementation.
   *
   * @example
   * ```ts
   * const adapter = new OpenAIResponsesAdapter({
   *   config: {
   *     apiKey: 'sk-test',
   *     baseUrl: 'https://api.openai.com/v1',
   *     requestTimeoutMs: 30_000,
   *     rootModel: 'gpt-5-nano',
   *     subModel: 'gpt-5-mini',
   *   },
   *   fetcher: fetch,
   * });
   * ```
   */
  constructor(options: OpenAIResponsesAdapterOptions) {
    this.#config = options.config;
    if (options.fetcher === undefined) {
      this.#fetcher = fetch;
      return;
    }

    this.#fetcher = options.fetcher;
  }

  /**
   * Sends one text-only completion request through the OpenAI Responses API.
   *
   * @example
   * ```ts
   * const response = await adapter.complete({
   *   input: 'Summarize the chapter.',
   *   model: 'gpt-5-nano',
   *   systemPrompt: 'Use concise Korean.',
   * });
   * ```
   */
  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.requestTimeoutMs);
    const handleExternalAbort = () => controller.abort();
    attachAbortListener(request.signal, controller, handleExternalAbort);

    try {
      const requestBody: Record<string, string> = {
        input: request.input,
        instructions: request.systemPrompt,
        model: request.model,
      };
      if (request.previousResponseId !== undefined) {
        requestBody.previous_response_id = request.previousResponseId;
      }

      const response = await this.#fetcher(
        `${this.#config.baseUrl.replace(/\/+$/u, '')}/responses`,
        {
          body: JSON.stringify(requestBody),
          headers: {
            Authorization: `Bearer ${this.#config.apiKey}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
          signal: controller.signal,
        },
      );
      const payload = await response.json() as OpenAIResponsePayload;
      const providerMessage = payload.error?.message;

      if (!response.ok) {
        throw new OpenAIResponsesError(
          response.status,
          typeof providerMessage === 'string'
            ? providerMessage
            : `OpenAI request failed with status ${response.status}.`,
        );
      }

      if (typeof providerMessage === 'string') {
        throw new OpenAIResponsesError(response.status, providerMessage);
      }

      let responseId: string | null = null;
      if (typeof payload.id === 'string') {
        responseId = payload.id;
      }

      const normalizedResponse = {
        outputText: extractOutputText(payload),
        responseId,
        usage: normalizeUsage(payload),
      };

      cleanupCompletionRequest(timer, request.signal, handleExternalAbort);
      return normalizedResponse;
    } catch (error) {
      cleanupCompletionRequest(timer, request.signal, handleExternalAbort);

      if (error instanceof OpenAIResponsesError) {
        throw error;
      }

      if (error instanceof DOMException) {
        if (error.name === 'AbortError') {
          throw new OpenAIResponsesError(
            408,
            `OpenAI request timed out after ${this.#config.requestTimeoutMs}ms.`,
          );
        }
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new OpenAIResponsesError(
        500,
        message,
      );
    }
  }
}

export const __openAIAdapterTestables = {
  attachAbortListener,
  cleanupCompletionRequest,
  detachAbortListener,
};
