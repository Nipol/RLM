/**
 * Ollama convenience entrypoints that adapt the provider-neutral core into packaged clients.
 *
 * @module
 *
 * @example
 * ```ts
 * import { createOllamaRLM } from './ollama.ts';
 * ```
 */
import type { RLMClient, RLMDefaults, RLMRunInput } from '../library_entrypoint.ts';
import { resolveRLMLogger } from '../logger.ts';
import type { RLMPlugin } from '../plugin.ts';
import { OllamaGenerateProvider } from './ollama_adapter.ts';
import type { OllamaProviderConfig } from './ollama_adapter.ts';
import { createRLM } from '../rlm_runner.ts';
import type { RLMRunResult } from '../rlm_runner.ts';
import type { ExecutionBackend, RLMLogger, RLMRuntimeHelper } from '../types.ts';

const DEFAULT_CELL_TIMEOUT_MS = 5_000;

/**
 * Configures a packaged Ollama-backed RLM client.
 */
export interface OllamaRLMClientOptions {
  clock?: () => Date;
  defaults?: RLMDefaults;
  executionBackend?: ExecutionBackend;
  fetcher?: typeof fetch;
  idGenerator?: () => string;
  logger?: RLMLogger;
  ollama: OllamaProviderConfig;
  plugins?: RLMPlugin[];
  runtimeHelpers?: RLMRuntimeHelper[];
  runtimeHelperPromptBlocks?: string[];
  systemPromptExtension?: string;
}

/**
 * Configures a one-shot Ollama-backed RLM execution.
 */
export interface RunOllamaRLMOptions extends RLMRunInput {
  clock?: () => Date;
  executionBackend?: ExecutionBackend;
  fetcher?: typeof fetch;
  idGenerator?: () => string;
  journalPath?: string;
  logger?: RLMLogger;
  ollama: OllamaProviderConfig;
}

function resolveProviderAwareCellTimeoutMs(
  additionalTimeoutMs: number | undefined,
  providerRequestTimeoutMs: number,
  defaultAdditionalTimeoutMs = DEFAULT_CELL_TIMEOUT_MS,
): number {
  return providerRequestTimeoutMs + (additionalTimeoutMs ?? defaultAdditionalTimeoutMs);
}

function resolveOllamaRunLogger(
  logger: RLMLogger | undefined,
  journalPath: string | undefined,
): RLMLogger | undefined {
  return logger ?? (journalPath === undefined ? undefined : resolveRLMLogger({
    journalPath,
  }));
}

/**
 * Creates an RLM client backed by the Ollama generate API.
 */
export function createOllamaRLM(options: OllamaRLMClientOptions): RLMClient {
  const provider = new OllamaGenerateProvider({
    fetcher: options.fetcher,
  });
  const defaultAdditionalCellTimeoutMs = options.defaults?.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS;
  const baseClient = createRLM({
    llm: provider.createCaller(options.ollama),
    clock: options.clock,
    defaults: {
      cellTimeoutMs: resolveProviderAwareCellTimeoutMs(
        undefined,
        options.ollama.requestTimeoutMs,
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
      root: options.ollama.rootModel,
      sub: options.ollama.subModel,
    },
    plugins: options.plugins,
    runtimeHelpers: options.runtimeHelpers,
    runtimeHelperPromptBlocks: options.runtimeHelperPromptBlocks,
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
            options.ollama.requestTimeoutMs,
            defaultAdditionalCellTimeoutMs,
          ),
      }),
  };
}

/**
 * Runs a single Ollama-backed RLM invocation without manually constructing a client.
 */
export async function runOllamaRLM(options: RunOllamaRLMOptions): Promise<RLMRunResult> {
  const client = createOllamaRLM({
    clock: options.clock,
    defaults: {
      cellTimeoutMs: DEFAULT_CELL_TIMEOUT_MS,
      maxSteps: options.maxSteps,
      maxSubcallDepth: options.maxSubcallDepth,
      outputCharLimit: options.outputCharLimit,
    },
    executionBackend: options.executionBackend,
    fetcher: options.fetcher,
    idGenerator: options.idGenerator,
    logger: resolveOllamaRunLogger(options.logger, options.journalPath),
    ollama: options.ollama,
    plugins: options.plugins,
    runtimeHelpers: options.runtimeHelpers,
    runtimeHelperPromptBlocks: options.runtimeHelperPromptBlocks,
  });

  return await client.run({
    cellTimeoutMs: options.cellTimeoutMs,
    context: options.context,
    maxSteps: options.maxSteps,
    maxSubcallDepth: options.maxSubcallDepth,
    outputCharLimit: options.outputCharLimit,
    plugins: options.plugins,
    prompt: options.prompt,
    queryTrace: options.queryTrace,
    runtimeHelpers: options.runtimeHelpers,
    runtimeHelperPromptBlocks: options.runtimeHelperPromptBlocks,
    systemPromptExtension: options.systemPromptExtension,
  });
}

/**
 * Exposes Ollama convenience-layer helpers for isolated tests.
 */
export const __ollamaProviderTestables = {
  resolveOllamaRunLogger,
  resolveProviderAwareCellTimeoutMs,
};

export {
  OllamaGenerateAdapter,
  OllamaGenerateError,
  OllamaGenerateProvider,
} from './ollama_adapter.ts';
export type {
  OllamaGenerateAdapterOptions,
  OllamaGenerateProviderOptions,
  OllamaProviderConfig,
} from './ollama_adapter.ts';
