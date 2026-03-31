import assert from 'node:assert/strict';

import * as core from '../core.ts';

Deno.test('core entrypoint exposes browser-safe core exports without standalone or provider helpers', () => {
  assert.equal(typeof core.createRLM, 'function');
  assert.equal(typeof core.runRLM, 'function');
  assert.equal(typeof core.WorkerExecutionBackend, 'function');
  assert.equal(typeof core.InMemoryRLMLogger, 'function');
  assert.equal(typeof core.NullRLMLogger, 'function');
  assert.equal('createOpenAIRLM' in core, false);
  assert.equal('createOllamaRLM' in core, false);
  assert.equal('OpenAIResponsesProvider' in core, false);
  assert.equal('OllamaGenerateProvider' in core, false);
  assert.equal('CodexOAuthProvider' in core, false);
  assert.equal('runStandaloneCLI' in core, false);
});
