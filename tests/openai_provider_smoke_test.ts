import assert from 'node:assert/strict';

import { createOpenAIRLM } from '../openai.ts';
import { runOpenAIProviderSmokeScenario } from '../smoke/shared/openai_provider_scenario.mjs';

Deno.test('OpenAI provider smoke scenario completes through the public provider entrypoint', async () => {
  const result = await runOpenAIProviderSmokeScenario(createOpenAIRLM);

  assert.equal(result.answer, 'PONG:PONG');
  assert.equal(result.finalValue, 'PONG:PONG');
  assert.equal(result.steps, 1);
  assert.deepEqual(result.requestKinds, ['root_turn', 'child_turn', 'plain_query']);
  assert.deepEqual(result.urls, [
    'https://api.openai.com/v1/responses',
    'https://api.openai.com/v1/responses',
    'https://api.openai.com/v1/responses',
  ]);
});

Deno.test('OpenAI provider smoke scenario fetcher rejects unexpected model ids', async () => {
  let capturedFetcher:
    | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
    | undefined;

  await runOpenAIProviderSmokeScenario((
    options: Parameters<typeof createOpenAIRLM>[0],
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
        'https://api.openai.com/v1/responses',
        {
          body: JSON.stringify({ model: 'unknown-model' }),
          method: 'POST',
        },
      ),
    /Unexpected smoke provider model: unknown-model/u,
  );
});
