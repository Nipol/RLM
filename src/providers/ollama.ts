import type { RLMClient, RLMDefaults, RLMRunInput } from '../library_entrypoint.ts';
import { resolveRLMLogger } from '../logger.ts';
import { OllamaGenerateProvider } from '../ollama_adapter.ts';
import type { OllamaProviderConfig } from '../ollama_adapter.ts';
import { createRLM } from '../rlm_runner.ts';
import type { RLMRunResult } from '../rlm_runner.ts';
import type { ExecutionBackend, RLMLogger } from '../types.ts';

const DEFAULT_CELL_TIMEOUT_MS = 5_000;

export interface OllamaRLMClientOptions {
  clock?: () => Date;
  defaults?: RLMDefaults;
  executionBackend?: ExecutionBackend;
  fetcher?: typeof fetch;
  idGenerator?: () => string;
  logger?: RLMLogger;
  ollama: OllamaProviderConfig;
}

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

export const __ollamaProviderTestables = {
  resolveOllamaRunLogger,
  resolveProviderAwareCellTimeoutMs,
};

export {
  OllamaGenerateAdapter,
  OllamaGenerateError,
  OllamaGenerateProvider,
} from '../ollama_adapter.ts';
export type {
  OllamaGenerateAdapterOptions,
  OllamaGenerateProviderOptions,
  OllamaProviderConfig,
} from '../ollama_adapter.ts';
