/**
 * Ollama generate-endpoint adapters that satisfy the provider-neutral caller contract.
 *
 * @module
 *
 * @example
 * ```ts
 * import { OllamaGenerateProvider } from './ollama_adapter.ts';
 * ```
 */
import type {
  LLMCaller,
  LLMCallerRequest,
  LLMCallerResponse,
  LLMProvider,
} from '../llm_adapter.ts';

type FetchLike = typeof fetch;

function resolveFetcher(fetcher: FetchLike | undefined): FetchLike {
  if (fetcher !== undefined) {
    return fetcher;
  }

  return globalThis.fetch.bind(globalThis);
}

interface OllamaUsagePayload {
  eval_count?: number;
  prompt_eval_count?: number;
}

interface OllamaGeneratePayload extends OllamaUsagePayload {
  error?: string;
  response?: string;
}

/**
 * Describes the Ollama endpoint and model ids used to create callers.
 */
export interface OllamaProviderConfig {
  baseUrl: string;
  keepAlive?: number | string;
  requestTimeoutMs: number;
  rootModel: string;
  subModel: string;
}

/**
 * Configures a low-level Ollama caller adapter.
 */
export interface OllamaGenerateAdapterOptions {
  config: OllamaProviderConfig;
  fetcher?: FetchLike;
}

/**
 * Configures the reusable provider that manufactures Ollama callers.
 */
export interface OllamaGenerateProviderOptions {
  fetcher?: FetchLike;
}

/**
 * Represents a transport or provider error returned by the Ollama generate API.
 */
export class OllamaGenerateError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'OllamaGenerateError';
    this.status = status;
  }
}

function extractOutputText(payload: OllamaGeneratePayload): string {
  if (typeof payload.response === 'string') {
    return payload.response;
  }

  throw new OllamaGenerateError(502, 'Ollama response did not contain generated text.');
}

function normalizeUsage(payload: OllamaGeneratePayload): LLMCallerResponse['usage'] {
  const inputTokens = payload.prompt_eval_count;
  const outputTokens = payload.eval_count;

  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }

  return {
    cachedInputTokens: undefined,
    inputTokens,
    outputTokens,
    totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
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
 * Implements the provider-neutral caller contract on top of Ollama's generate endpoint.
 */
export class OllamaGenerateAdapter implements LLMCaller {
  readonly #config: OllamaProviderConfig;
  readonly #fetcher: FetchLike;

  constructor(options: OllamaGenerateAdapterOptions) {
    this.#config = options.config;
    this.#fetcher = resolveFetcher(options.fetcher);
  }

  async complete(request: LLMCallerRequest): Promise<LLMCallerResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.requestTimeoutMs);
    const handleExternalAbort = () => controller.abort();
    attachAbortListener(request.signal, controller, handleExternalAbort);

    try {
      const requestBody: Record<string, unknown> = {
        model: request.model,
        prompt: request.input,
        stream: false,
        system: request.systemPrompt,
      };
      if (this.#config.keepAlive !== undefined) {
        requestBody.keep_alive = this.#config.keepAlive;
      }

      const response = await this.#fetcher(
        `${this.#config.baseUrl.replace(/\/+$/u, '')}/generate`,
        {
          body: JSON.stringify(requestBody),
          headers: {
            'Content-Type': 'application/json',
          },
          method: 'POST',
          signal: controller.signal,
        },
      );
      const payload = await response.json() as OllamaGeneratePayload;

      if (!response.ok) {
        throw new OllamaGenerateError(
          response.status,
          typeof payload.error === 'string'
            ? payload.error
            : `Ollama request failed with status ${response.status}.`,
        );
      }

      if (typeof payload.error === 'string') {
        throw new OllamaGenerateError(response.status, payload.error);
      }

      cleanupCompletionRequest(timer, request.signal, handleExternalAbort);
      return {
        outputText: extractOutputText(payload),
        usage: normalizeUsage(payload),
      };
    } catch (error) {
      cleanupCompletionRequest(timer, request.signal, handleExternalAbort);

      if (error instanceof OllamaGenerateError) {
        throw error;
      }

      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new OllamaGenerateError(
          408,
          `Ollama request timed out after ${this.#config.requestTimeoutMs}ms.`,
        );
      }

      throw new OllamaGenerateError(
        500,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/**
 * Manufactures Ollama callers from provider config objects.
 */
export class OllamaGenerateProvider implements LLMProvider<OllamaProviderConfig> {
  readonly #fetcher?: FetchLike;

  constructor(options: OllamaGenerateProviderOptions = {}) {
    this.#fetcher = options.fetcher;
  }

  createCaller(config: OllamaProviderConfig): LLMCaller {
    return new OllamaGenerateAdapter({
      config,
      fetcher: this.#fetcher,
    });
  }
}
