import assert from 'node:assert/strict';

import { buildConversationContext, buildConversationTranscript } from './conversation.ts';
import { createProviderSettings } from './provider_config.ts';

const settings = createProviderSettings({
  apiKey: 'sk-test',
  availableModels: ['gpt-5', 'gpt-5-mini'],
  baseUrl: '',
  kind: 'openai',
  rootModel: 'gpt-5',
  rootReasoningEffort: 'high',
  subModel: 'gpt-5-mini',
  subReasoningEffort: 'minimal',
}, new Date('2026-03-31T00:00:00.000Z'));

Deno.test('buildConversationTranscript keeps the turn order and role labels', () => {
  assert.equal(
    buildConversationTranscript([
      {
        content: '첫 질문',
        createdAt: '2026-03-31T10:00:00.000Z',
        id: 'u1',
        role: 'user',
      },
      {
        content: '첫 답변',
        createdAt: '2026-03-31T10:00:01.000Z',
        id: 'a1',
        role: 'assistant',
      },
    ]),
    '1. 사용자: 첫 질문\n2. RLM: 첫 답변',
  );
});

Deno.test('buildConversationContext serializes turns and provider metadata for the next run', () => {
  const context = buildConversationContext([
    {
      content: '이전 대화',
      createdAt: '2026-03-31T10:00:00.000Z',
      id: 'u1',
      role: 'user',
    },
    {
      content: '이전 답변',
      createdAt: '2026-03-31T10:00:02.000Z',
      id: 'a1',
      role: 'assistant',
      steps: 2,
    },
  ], settings);

  assert.deepEqual(context, {
    app: 'examples/web',
    conversation: [
      {
        content: '이전 대화',
        createdAt: '2026-03-31T10:00:00.000Z',
        error: null,
        id: 'u1',
        role: 'user',
        steps: null,
        usage: null,
      },
      {
        content: '이전 답변',
        createdAt: '2026-03-31T10:00:02.000Z',
        error: null,
        id: 'a1',
        role: 'assistant',
        steps: 2,
        usage: null,
      },
    ],
    document: '1. 사용자: 이전 대화\n2. RLM: 이전 답변',
    conversationTranscript: '1. 사용자: 이전 대화\n2. RLM: 이전 답변',
    provider: {
      kind: 'openai',
      label: 'OpenAI',
      requestTimeoutMs: 30000,
      rootModel: 'gpt-5',
      rootReasoningEffort: 'high',
      subModel: 'gpt-5-mini',
      subReasoningEffort: 'minimal',
    },
    storedTurnCount: 2,
  });
});

Deno.test('buildConversationContext covers usage snapshots and ollama provider labels', () => {
  const localSettings = createProviderSettings({
    apiKey: '',
    availableModels: ['llama3.2:3b'],
    baseUrl: 'localhost:11434',
    kind: 'ollama-local',
    rootModel: 'llama3.2:3b',
    subModel: 'llama3.2:3b',
  }, new Date('2026-03-31T00:00:00.000Z'));

  const context = buildConversationContext([
    {
      content: '로컬 질문',
      createdAt: '2026-03-31T10:05:00.000Z',
      id: 'u2',
      role: 'user',
      usage: {
        byModel: [{
          inputTokens: 10,
          model: 'llama3.2:3b',
          outputTokens: 4,
          totalTokens: 14,
        }],
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
    },
  ], localSettings);

  assert.deepEqual(context, {
    app: 'examples/web',
    conversation: [
      {
        content: '로컬 질문',
        createdAt: '2026-03-31T10:05:00.000Z',
        error: null,
        id: 'u2',
        role: 'user',
        steps: null,
        usage: {
          byModel: [{
            inputTokens: 10,
            model: 'llama3.2:3b',
            outputTokens: 4,
            totalTokens: 14,
          }],
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
        },
      },
    ],
    conversationTranscript: '1. 사용자: 로컬 질문',
    document: '1. 사용자: 로컬 질문',
    provider: {
      kind: 'ollama-local',
      label: 'Ollama Local',
      requestTimeoutMs: 30000,
      rootModel: 'llama3.2:3b',
      rootReasoningEffort: null,
      subModel: 'llama3.2:3b',
      subReasoningEffort: null,
    },
    storedTurnCount: 1,
  });
});

Deno.test('buildConversationContext normalizes usage snapshots without model breakdowns', () => {
  const context = buildConversationContext([
    {
      content: '토큰 사용량만 있는 답변',
      createdAt: '2026-03-31T10:06:00.000Z',
      id: 'a2',
      role: 'assistant',
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
      },
    },
  ], settings) as { conversation: Array<{ usage: unknown }> };

  assert.deepEqual(context.conversation[0]?.usage, {
    byModel: null,
    inputTokens: 12,
    outputTokens: 8,
    totalTokens: 20,
  });
});

Deno.test('buildConversationContext covers the Ollama Cloud provider label', () => {
  const cloudSettings = createProviderSettings({
    apiKey: 'ollama-cloud-key',
    availableModels: ['gpt-oss:20b'],
    baseUrl: '',
    kind: 'ollama-cloud',
    rootModel: 'gpt-oss:20b',
    subModel: 'gpt-oss:20b',
  }, new Date('2026-03-31T00:00:00.000Z'));

  const context = buildConversationContext([], cloudSettings) as {
    provider: { label: string };
  };

  assert.equal(context.provider.label, 'Ollama Cloud');
});
