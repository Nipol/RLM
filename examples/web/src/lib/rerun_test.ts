import assert from 'node:assert/strict';

import { prepareLastUserPromptRerun } from './rerun.ts';
import { createProviderSettings } from './provider_config.ts';
import type { AppSnapshot } from './types.ts';

const settings = createProviderSettings({
  apiKey: 'sk-test',
  availableModels: ['gpt-5', 'gpt-5-mini'],
  baseUrl: 'https://api.openai.com/v1',
  kind: 'openai',
  rootModel: 'gpt-5',
  rootReasoningEffort: 'high',
  subModel: 'gpt-5-mini',
  subReasoningEffort: 'minimal',
}, new Date('2026-03-31T00:00:00.000Z'));

function createSnapshot(turns: AppSnapshot['turns']): AppSnapshot {
  return {
    settings,
    turns,
  };
}

Deno.test('prepareLastUserPromptRerun truncates turns after the latest user prompt and keeps the prompt turn', () => {
  const prepared = prepareLastUserPromptRerun(createSnapshot([
    {
      content: '첫 질문',
      createdAt: '2026-03-31T12:00:00.000Z',
      id: 'u1',
      role: 'user',
    },
    {
      content: '첫 답변',
      createdAt: '2026-03-31T12:00:02.000Z',
      id: 'a1',
      role: 'assistant',
    },
    {
      content: '두 번째 질문',
      createdAt: '2026-03-31T12:01:00.000Z',
      id: 'u2',
      role: 'user',
    },
    {
      content: '오류: upstream timeout',
      createdAt: '2026-03-31T12:01:05.000Z',
      error: 'upstream timeout',
      id: 'a2',
      role: 'assistant',
    },
  ]));

  assert.deepEqual(prepared, {
    historyBeforePrompt: [
      {
        content: '첫 질문',
        createdAt: '2026-03-31T12:00:00.000Z',
        id: 'u1',
        role: 'user',
      },
      {
        content: '첫 답변',
        createdAt: '2026-03-31T12:00:02.000Z',
        id: 'a1',
        role: 'assistant',
      },
    ],
    prompt: '두 번째 질문',
    promptTurn: {
      content: '두 번째 질문',
      createdAt: '2026-03-31T12:01:00.000Z',
      id: 'u2',
      role: 'user',
    },
    truncatedSnapshot: {
      settings,
      turns: [
        {
          content: '첫 질문',
          createdAt: '2026-03-31T12:00:00.000Z',
          id: 'u1',
          role: 'user',
        },
        {
          content: '첫 답변',
          createdAt: '2026-03-31T12:00:02.000Z',
          id: 'a1',
          role: 'assistant',
        },
        {
          content: '두 번째 질문',
          createdAt: '2026-03-31T12:01:00.000Z',
          id: 'u2',
          role: 'user',
        },
      ],
    },
  });
});

Deno.test('prepareLastUserPromptRerun returns null when there is no stored user prompt', () => {
  assert.equal(
    prepareLastUserPromptRerun({
      settings,
      turns: [
        {
          content: 'assistant only',
          createdAt: '2026-03-31T12:00:00.000Z',
          id: 'a1',
          role: 'assistant',
        },
      ],
    }),
    null,
  );
});

Deno.test('prepareLastUserPromptRerun returns null when provider settings are missing', () => {
  assert.equal(
    prepareLastUserPromptRerun({
      settings: null,
      turns: [
        {
          content: '질문',
          createdAt: '2026-03-31T12:00:00.000Z',
          id: 'u1',
          role: 'user',
        },
      ],
    }),
    null,
  );
});
