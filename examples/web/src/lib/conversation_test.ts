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
