/**
 * OpenAI Responses API adapters that satisfy the provider-neutral caller contract.
 *
 * @module
 *
 * @example
 * ```ts
 * import { OpenAIResponsesProvider } from './openai_adapter.ts';
 * ```
 */
import type {
  LLMCaller,
  LLMCallerRequest,
  LLMCallerResponse,
  LLMProvider,
} from '../llm_adapter.ts';
import type { OpenAIProviderConfig, OpenAIReasoningEffort } from './openai_config.ts';

type FetchLike = typeof fetch;

function resolveFetcher(fetcher: FetchLike | undefined): FetchLike {
  if (fetcher !== undefined) {
    return fetcher;
  }

  return globalThis.fetch.bind(globalThis);
}

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

interface OpenAIReasoningRequestPayload {
  effort?: OpenAIReasoningEffort;
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
 * Describes the constructor options for the OpenAI provider factory.
 *
 * @example
 * ```ts
 * const provider = new OpenAIResponsesProvider({
 *   fetcher: fetch,
 * });
 * ```
 */
export interface OpenAIResponsesProviderOptions {
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
function normalizeUsage(payload: OpenAIResponsePayload): LLMCallerResponse['usage'] {
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

function resolveReasoningEffortForRequest(
  config: OpenAIProviderConfig,
  request: LLMCallerRequest,
): OpenAIReasoningEffort | undefined {
  if (request.kind === 'root_turn') {
    return config.rootReasoningEffort;
  }

  return config.subReasoningEffort;
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
export class OpenAIResponsesAdapter implements LLMCaller {
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
    this.#fetcher = resolveFetcher(options.fetcher);
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
  async complete(request: LLMCallerRequest): Promise<LLMCallerResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.requestTimeoutMs);
    const handleExternalAbort = () => controller.abort();
    attachAbortListener(request.signal, controller, handleExternalAbort);

    try {
      const requestBody: Record<string, unknown> = {
        input: request.input,
        instructions: request.systemPrompt,
        model: request.model,
      };
      const reasoningEffort = resolveReasoningEffortForRequest(this.#config, request);
      if (reasoningEffort !== undefined) {
        requestBody.reasoning = {
          effort: reasoningEffort,
        } satisfies OpenAIReasoningRequestPayload;
      }
      if (typeof request.turnState === 'string' && request.turnState.length > 0) {
        requestBody.previous_response_id = request.turnState;
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

      let turnState: unknown = undefined;
      if (typeof payload.id === 'string') {
        turnState = payload.id;
      }

      const normalizedResponse = {
        outputText: extractOutputText(payload),
        turnState,
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

/**
 * Builds provider-neutral callers backed by the OpenAI Responses API.
 *
 * This keeps authentication and transport concerns outside the RLM core while still
 * allowing provider-specific convenience wiring.
 *
 * @example
 * ```ts
 * const provider = new OpenAIResponsesProvider();
 * const llm = provider.createCaller({
 *   apiKey: 'sk-test',
 *   baseUrl: 'https://api.openai.com/v1',
 *   requestTimeoutMs: 30_000,
 *   rootModel: 'gpt-5-nano',
 *   subModel: 'gpt-5-mini',
 * });
 * ```
 */
export class OpenAIResponsesProvider implements LLMProvider<OpenAIProviderConfig> {
  readonly #fetcher?: FetchLike;

  /**
   * Stores shared transport dependencies used when creating callers.
   *
   * @example
   * ```ts
   * const provider = new OpenAIResponsesProvider({
   *   fetcher: fetch,
   * });
   * ```
   */
  constructor(options: OpenAIResponsesProviderOptions = {}) {
    this.#fetcher = options.fetcher;
  }

  /**
   * Creates one provider-neutral caller bound to the supplied OpenAI configuration.
   *
   * @param config Provider credentials and model defaults.
   * @returns A caller ready to inject into `createRLM(...)`.
   */
  createCaller(config: OpenAIProviderConfig): LLMCaller {
    return new OpenAIResponsesAdapter({
      config,
      fetcher: this.#fetcher,
    });
  }
}

/**
 * Exposes OpenAI adapter internals for focused unit tests.
 */
export const __openAIAdapterTestables = {
  attachAbortListener,
  cleanupCompletionRequest,
  detachAbortListener,
  resolveFetcher,
  resolveReasoningEffortForRequest,
};
