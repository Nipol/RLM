import assert from 'node:assert/strict';

import { createOllamaRLM } from '../ollama.ts';
import { runOllamaProviderSmokeScenario } from '../smoke/shared/ollama_provider_scenario.mjs';

Deno.test('Ollama provider smoke scenario completes through the public provider entrypoint', async () => {
  const result = await runOllamaProviderSmokeScenario(createOllamaRLM);

  assert.equal(result.answer, 'PONG:PONG');
  assert.equal(result.finalValue, 'PONG:PONG');
  assert.equal(result.steps, 1);
  assert.deepEqual(result.requestKinds, ['root_turn', 'child_turn', 'plain_query']);
  assert.deepEqual(result.urls, [
    'http://localhost:11434/api/generate',
    'http://localhost:11434/api/generate',
    'http://localhost:11434/api/generate',
  ]);
});
