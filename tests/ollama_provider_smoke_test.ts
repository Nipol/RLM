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

Deno.test('Ollama provider smoke scenario fetcher rejects unexpected model ids', async () => {
  let capturedFetcher:
    | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
    | undefined;

  await runOllamaProviderSmokeScenario((
    options: Parameters<typeof createOllamaRLM>[0],
  ) => {
    capturedFetcher = options.fetcher;

    return {
      async run() {
        return {
          answer: 'stub',
          finalValue: 'stub',
          session: { close: async () => undefined },
          steps: 0,
        };
      },
    };
  });

  assert.ok(capturedFetcher);
  await assert.rejects(
    () =>
      capturedFetcher!(
        'http://localhost:11434/api/generate',
        {
          body: JSON.stringify({ model: 'unknown-model' }),
          method: 'POST',
        },
      ),
    /Unexpected smoke provider model: unknown-model/u,
  );
});

Deno.test('Ollama provider smoke scenario records defensive defaults for missing request init', async () => {
  const result = await runOllamaProviderSmokeScenario((
    options: Parameters<typeof createOllamaRLM>[0],
  ) => ({
    async run() {
      await assert.rejects(
        () => options.fetcher!('http://localhost:11434/api/generate'),
        /Unexpected smoke provider model:/u,
      );
      return {
        answer: 'stub',
        finalValue: 'stub',
        session: { close: async () => undefined },
        steps: 0,
      };
    },
  }));

  assert.deepEqual(result.requestKinds, ['child_turn']);
  assert.deepEqual(result.urls, ['http://localhost:11434/api/generate']);
});
