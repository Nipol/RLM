import type { JsonValue } from '../../../../core.ts';

import type { ChatTurn, ProviderSettings, UsageSummarySnapshot } from './types.ts';

export function buildConversationTranscript(turns: ChatTurn[]): string {
  return turns
    .map((turn, index) => `${index + 1}. ${turn.role === 'user' ? '사용자' : 'RLM'}: ${turn.content}`)
    .join('\n');
}

function toJsonUsageSummary(usage: UsageSummarySnapshot | undefined): JsonValue {
  if (usage === undefined) {
    return null;
  }

  return {
    byModel: usage.byModel?.map((entry) => ({
      inputTokens: entry.inputTokens,
      model: entry.model,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens,
    })) ?? null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

export function buildConversationContext(
  turns: ChatTurn[],
  settings: ProviderSettings,
): JsonValue {
  const transcript = buildConversationTranscript(turns);

  return {
    app: 'examples/web',
    conversation: turns.map((turn) => ({
      content: turn.content,
      createdAt: turn.createdAt,
      error: turn.error ?? null,
      id: turn.id,
      role: turn.role,
      steps: turn.steps ?? null,
      usage: toJsonUsageSummary(turn.usage),
    })),
    conversationTranscript: transcript,
    document: transcript,
    provider: {
      kind: settings.kind,
      label: settings.kind === 'openai'
        ? 'OpenAI'
        : settings.kind === 'ollama-local'
        ? 'Ollama Local'
        : 'Ollama Cloud',
      requestTimeoutMs: settings.requestTimeoutMs,
      rootModel: settings.rootModel,
      rootReasoningEffort: settings.rootReasoningEffort ?? null,
      subModel: settings.subModel,
      subReasoningEffort: settings.subReasoningEffort ?? null,
    },
    storedTurnCount: turns.length,
  };
}
