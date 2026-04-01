/**
 * OpenAI convenience entrypoints that adapt the provider-neutral core into packaged clients.
 *
 * @module
 *
 * @example
 * ```ts
 * import { createOpenAIRLM } from './openai.ts';
 * ```
 */
import type { RLMClient, RLMDefaults, RLMRunInput } from '../library_entrypoint.ts';
import { resolveRLMLogger } from '../logger.ts';
import { createRLM } from '../rlm_runner.ts';
import type { RLMRunResult } from '../rlm_runner.ts';
import type { ExecutionBackend, RLMLogger } from '../types.ts';
import { OpenAIResponsesProvider } from './openai_adapter.ts';
import type { OpenAIProviderConfig, OpenAIReasoningEffort } from './openai_config.ts';
import {
  estimateOpenAIRunCostUsd,
  estimateOpenAIUsageCostUsd,
  resolveOpenAITextModelPricing,
} from './openai_pricing.ts';

const DEFAULT_CELL_TIMEOUT_MS = 5_000;

/**
 * Describes the provider-specific inputs needed to build an OpenAI-backed RLM client.
 *
 * This is the provider-specific convenience variant of `RLMClientOptions`.
 * It exists so callers do not need to manually assemble an OpenAI-backed caller just to use OpenAI.
 *
 * @example
 * ```ts
 * const options: OpenAIRLMClientOptions = {
 *   openAI: {
 *     apiKey: 'sk-test',
 *     baseUrl: 'https://api.openai.com/v1',
 *     requestTimeoutMs: 30_000,
 *     rootModel: 'gpt-5-nano',
 *     subModel: 'gpt-5-mini',
 *   },
 * };
 * ```
 */
export interface OpenAIRLMClientOptions {
  clock?: () => Date;
  defaults?: RLMDefaults;
  executionBackend?: ExecutionBackend;
  fetcher?: typeof fetch;
  idGenerator?: () => string;
  logger?: RLMLogger;
  openAI: OpenAIProviderConfig;
  systemPromptExtension?: string;
}

/**
 * Describes the convenience wrapper inputs for OpenAI-backed RLM runs.
 *
 * Explicit `openAI` configuration is the preferred library path.
 * `config` or implicit `.env` loading remain available for standalone convenience.
 * In this provider-backed path, `cellTimeoutMs` is interpreted as additional REPL
 * cell budget on top of the provider request timeout.
 *
 * @example
 * ```ts
 * const options: RunOpenAIRLMOptions = {
 *   context: { document: 'Chapter 1\\nThe answer is 42.' },
 *   openAI: {
 *     apiKey: 'sk-test',
 *     baseUrl: 'https://api.openai.com/v1',
 *     requestTimeoutMs: 30_000,
 *     rootModel: 'gpt-5-nano',
 *     subModel: 'gpt-5-mini',
 *   },
 *   prompt: 'Extract the answer.',
 * };
 * ```
 */
export interface RunOpenAIRLMOptions extends RLMRunInput {
  clock?: () => Date;
  defaults?: RLMDefaults;
  executionBackend?: ExecutionBackend;
  fetcher?: typeof fetch;
  idGenerator?: () => string;
  journalPath?: string;
  logger?: RLMLogger;
  openAI: OpenAIProviderConfig;
}

function resolveProviderAwareCellTimeoutMs(
  additionalTimeoutMs: number | undefined,
  providerRequestTimeoutMs: number,
  defaultAdditionalTimeoutMs = DEFAULT_CELL_TIMEOUT_MS,
): number {
  return providerRequestTimeoutMs + (additionalTimeoutMs ?? defaultAdditionalTimeoutMs);
}

function resolveOpenAIRunLogger(
  logger: RLMLogger | undefined,
  journalPath: string | undefined,
): RLMLogger | undefined {
  return logger ?? (journalPath === undefined ? undefined : resolveRLMLogger({
    journalPath,
  }));
}

/**
 * Builds the OpenAI-backed convenience client from explicit provider arguments.
 *
 * This helper is meant for library consumers who want explicit provider configuration
 * without manually constructing a caller.
 * In this provider-backed path, `defaults.cellTimeoutMs` is interpreted as additional
 * REPL cell budget on top of the provider request timeout.
 */
export function createOpenAIRLM(options: OpenAIRLMClientOptions): RLMClient {
  const provider = new OpenAIResponsesProvider({
    fetcher: options.fetcher,
  });
  const defaultAdditionalCellTimeoutMs = options.defaults?.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS;
  const baseClient = createRLM({
    llm: provider.createCaller(options.openAI),
    clock: options.clock,
    defaults: {
      cellTimeoutMs: resolveProviderAwareCellTimeoutMs(
        undefined,
        options.openAI.requestTimeoutMs,
        defaultAdditionalCellTimeoutMs,
      ),
      maxSteps: options.defaults?.maxSteps,
      maxSubcallDepth: options.defaults?.maxSubcallDepth,
      outputCharLimit: options.defaults?.outputCharLimit,
    },
    executionBackend: options.executionBackend,
    idGenerator: options.idGenerator,
    logger: options.logger,
    models: {
      root: options.openAI.rootModel,
      sub: options.openAI.subModel,
    },
    systemPromptExtension: options.systemPromptExtension,
  });

  return {
    run: async (input) =>
      await baseClient.run({
        ...input,
        cellTimeoutMs: input.cellTimeoutMs === undefined
          ? undefined
          : resolveProviderAwareCellTimeoutMs(
            input.cellTimeoutMs,
            options.openAI.requestTimeoutMs,
            defaultAdditionalCellTimeoutMs,
          ),
      }),
  };
}

/**
 * Runs one OpenAI-backed RLM loop while keeping provider config explicit.
 *
 * Standalone `.env` loading belongs to the standalone layer and should pass
 * `openAI` and `defaults` into this helper after loading them.
 */
export async function runOpenAIRLM(options: RunOpenAIRLMOptions): Promise<RLMRunResult> {
  if ((options as Partial<RunOpenAIRLMOptions>).openAI === undefined) {
    throw new Error('runOpenAIRLM requires options.openAI.');
  }

  const client = createOpenAIRLM({
    clock: options.clock,
    defaults: options.defaults,
    executionBackend: options.executionBackend,
    fetcher: options.fetcher,
    idGenerator: options.idGenerator,
    logger: resolveOpenAIRunLogger(options.logger, options.journalPath),
    openAI: options.openAI,
  });

  return await client.run({
    cellTimeoutMs: options.cellTimeoutMs,
    context: options.context,
    maxSteps: options.maxSteps,
    maxSubcallDepth: options.maxSubcallDepth,
    outputCharLimit: options.outputCharLimit,
    prompt: options.prompt,
    systemPromptExtension: options.systemPromptExtension,
  });
}

/**
 * Exposes small provider-only helpers for isolated tests.
 *
 * These helpers are intentionally kept out of the core runner because they only
 * make sense for provider-backed convenience paths.
 */
export const __openAIProviderTestables = {
  resolveOpenAIRunLogger,
  resolveProviderAwareCellTimeoutMs,
};

export {
  OpenAIResponsesAdapter,
  OpenAIResponsesError,
  OpenAIResponsesProvider,
} from './openai_adapter.ts';
export {
  estimateOpenAIRunCostUsd,
  estimateOpenAIUsageCostUsd,
  resolveOpenAITextModelPricing,
} from './openai_pricing.ts';
export type { OpenAIProviderConfig, OpenAIReasoningEffort } from './openai_config.ts';
export type {
  OpenAIResponsesAdapterOptions,
  OpenAIResponsesProviderOptions,
} from './openai_adapter.ts';
export type {
  OpenAIRunCostEstimate,
  OpenAITextModelPricing,
  OpenAIUsageCostEstimate,
} from './openai_pricing.ts';
