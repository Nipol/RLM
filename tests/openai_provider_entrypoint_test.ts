import assert from 'node:assert/strict';

import * as openaiProvider from '../openai.ts';

Deno.test('OpenAI provider subpath entrypoint exposes provider-specific convenience helpers', () => {
  assert.equal(typeof openaiProvider.createOpenAIRLM, 'function');
  assert.equal(typeof openaiProvider.runOpenAIRLM, 'function');
  assert.equal(typeof openaiProvider.OpenAIResponsesProvider, 'function');
});
