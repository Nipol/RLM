import type { JsonValue, RLMUsageSummary } from '../../../core.ts';
import { createOllamaRLM } from '../../../ollama.ts';
import { createOpenAIRLM } from '../../../openai.ts';

import { buildConversationContext } from './lib/conversation.ts';
import { listModelsForDraft } from './lib/provider_catalog.ts';
import type { ChatTurn, ProviderDraft, ProviderSettings, UsageSummarySnapshot } from './lib/types.ts';
import { WEB_SYSTEM_PROMPT_EXTENSION } from './system_prompt_extension.ts';

const DEFAULT_RUN_LIMITS = {
  cellTimeoutMs: 60_000,
  maxSteps: 15,
  maxSubcallDepth: 1,
  outputCharLimit: 6_000,
};

export interface BrowserRunResult {
  answer: string;
  steps: number;
  usage: UsageSummarySnapshot;
}

export interface BrowserRunInput {
  context: JsonValue;
  prompt: string;
}

export interface BrowserRunLogger {
  groupCollapsed?: (...args: unknown[]) => void;
  groupEnd?: () => void;
  log: (...args: unknown[]) => void;
}

export interface BrowserRunDebugScope {
  __RLM_LAST_RUN_INPUT__?: BrowserRunInput;
}

function toUsageSnapshot(usage: RLMUsageSummary): UsageSummarySnapshot {
  return {
    byModel: usage.byModel.map((entry) => ({
      inputTokens: entry.inputTokens,
      model: entry.model,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens,
    })),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

export async function loadProviderCatalog(draft: ProviderDraft) {
  return await listModelsForDraft(draft);
}

export function buildConversationRunInput(
  settings: ProviderSettings,
  historyTurns: ChatTurn[],
  prompt: string,
): BrowserRunInput {
  return {
    context: buildConversationContext(historyTurns, settings),
    prompt,
  };
}

export function emitBrowserRunDebugLog(
  runInput: BrowserRunInput,
  logger: BrowserRunLogger = console,
  scope: BrowserRunDebugScope = globalThis as BrowserRunDebugScope,
): void {
  scope.__RLM_LAST_RUN_INPUT__ = runInput;

  if (typeof logger.groupCollapsed === 'function') {
    logger.groupCollapsed('[RLM] Browser Run Input');
    logger.log('prompt', runInput.prompt);
    logger.log('context', runInput.context);
    logger.groupEnd?.();
    return;
  }

  logger.log('[RLM] Browser Run Input', {
    context: runInput.context,
    prompt: runInput.prompt,
  });
}

export async function runConversationTurn(
  settings: ProviderSettings,
  historyTurns: ChatTurn[],
  prompt: string,
): Promise<BrowserRunResult> {
  const runInput = buildConversationRunInput(settings, historyTurns, prompt);
  emitBrowserRunDebugLog(runInput);
  const client = settings.kind === 'openai'
    ? createOpenAIRLM({
      defaults: DEFAULT_RUN_LIMITS,
      openAI: {
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        requestTimeoutMs: settings.requestTimeoutMs,
        rootModel: settings.rootModel,
        rootReasoningEffort: settings.rootReasoningEffort,
        subModel: settings.subModel,
        subReasoningEffort: settings.subReasoningEffort,
      },
      systemPromptExtension: WEB_SYSTEM_PROMPT_EXTENSION,
    })
    : createOllamaRLM({
      defaults: DEFAULT_RUN_LIMITS,
      ollama: {
        baseUrl: settings.baseUrl,
        requestTimeoutMs: settings.requestTimeoutMs,
        rootModel: settings.rootModel,
        subModel: settings.subModel,
      },
      systemPromptExtension: WEB_SYSTEM_PROMPT_EXTENSION,
    });

  const result = await client.run(runInput);

  try {
    return {
      answer: result.answer,
      steps: result.steps,
      usage: toUsageSnapshot(result.usage),
    };
  } finally {
    await result.session.close();
  }
}
