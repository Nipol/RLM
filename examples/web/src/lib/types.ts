import type { OpenAIReasoningEffort } from '../../../../openai.ts';

export type ProviderKind = 'ollama-cloud' | 'ollama-local' | 'openai';

export interface UsageSummarySnapshot {
  byModel?: Array<{
    inputTokens: number;
    model: string;
    outputTokens: number;
    totalTokens: number;
  }>;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ChatTurn {
  content: string;
  createdAt: string;
  error?: string;
  id: string;
  role: 'assistant' | 'user';
  steps?: number;
  usage?: UsageSummarySnapshot;
}

export interface ProviderDraft {
  apiKey: string;
  availableModels: string[];
  baseUrl: string;
  kind: ProviderKind;
  requestTimeoutMs?: number;
  rootModel: string;
  rootReasoningEffort?: OpenAIReasoningEffort;
  subModel: string;
  subReasoningEffort?: OpenAIReasoningEffort;
}

export interface ProviderSettings extends Omit<ProviderDraft, 'requestTimeoutMs'> {
  requestTimeoutMs: number;
  updatedAt: string;
}

export interface AppSnapshot {
  settings: ProviderSettings | null;
  turns: ChatTurn[];
}
