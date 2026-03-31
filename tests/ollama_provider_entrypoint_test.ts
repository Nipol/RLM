import assert from 'node:assert/strict';

import * as ollamaProvider from '../ollama.ts';

Deno.test('Ollama provider subpath entrypoint exposes provider-specific convenience helpers', () => {
  assert.equal(typeof ollamaProvider.createOllamaRLM, 'function');
  assert.equal(typeof ollamaProvider.runOllamaRLM, 'function');
  assert.equal(typeof ollamaProvider.OllamaGenerateProvider, 'function');
});
