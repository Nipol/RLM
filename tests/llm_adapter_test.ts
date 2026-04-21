import assert from 'node:assert/strict';

import { formatLLMCallerMessagesAsText, resolveLLMCallerInputText } from '../src/llm_adapter.ts';
import type { LLMCallerRequest } from '../src/llm_adapter.ts';

function createRequest(overrides: Partial<LLMCallerRequest> = {}): LLMCallerRequest {
  return {
    input: 'legacy input',
    kind: 'root_turn',
    model: 'gpt-5-nano',
    systemPrompt: 'Use the REPL.',
    ...overrides,
  };
}

Deno.test('LLM caller message formatting preserves append-only roles and content order', () => {
  const formatted = formatLLMCallerMessagesAsText([
    { content: 'Initial task.', role: 'user' },
    { content: '```repl\nconst answer = 42;\n```', role: 'assistant' },
    { content: 'Runtime result: 42', role: 'user' },
  ]);

  assert.equal(
    formatted,
    [
      'user:',
      'Initial task.',
      '',
      'assistant:',
      '```repl\nconst answer = 42;\n```',
      '',
      'user:',
      'Runtime result: 42',
    ].join('\n'),
  );
});

Deno.test('LLM caller input resolution falls back to legacy input when messages are absent or empty', () => {
  assert.equal(resolveLLMCallerInputText(createRequest()), 'legacy input');
  assert.equal(resolveLLMCallerInputText(createRequest({ messages: [] })), 'legacy input');
  assert.equal(
    resolveLLMCallerInputText(createRequest({
      input: 'fallback should not win',
      messages: [
        { content: 'Task.', role: 'user' },
        { content: 'Result.', role: 'assistant' },
      ],
    })),
    ['user:', 'Task.', '', 'assistant:', 'Result.'].join('\n'),
  );
});
