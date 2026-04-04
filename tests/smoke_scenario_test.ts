import assert from 'node:assert/strict';

import { createRLM } from '../mod.ts';
import { runSmokeScenario } from '../smoke/shared/scenario.ts';
import type { CreateRLMFn } from '../smoke/shared/scenario.ts';
import { createUsageSummary } from '../src/usage_summary.ts';

Deno.test('shared smoke scenario completes through the public library interface', async () => {
  const result = await runSmokeScenario(createRLM);

  assert.equal(result.answer, 'PONG:PONG');
  assert.equal(result.finalValue, 'PONG:PONG');
  assert.equal(result.steps, 1);
  assert.deepEqual(result.kinds, ['root_turn', 'child_turn', 'plain_query']);
});

Deno.test('shared smoke scenario caller surfaces unsupported request kinds and unexpected plain-query input', async () => {
  let capturedLLM: { complete(request: unknown): Promise<unknown> } | null = null;

  const fakeCreateRLM = ((options: Parameters<CreateRLMFn>[0]) => {
    capturedLLM =
      (options.llm as { complete(request: unknown): Promise<unknown> } | undefined) ?? null;

    return {
      async run() {
        return {
          answer: 'stub',
          finalValue: 'stub',
          session: { close: async () => undefined },
          steps: 0,
          usage: createUsageSummary(),
        };
      },
    };
  }) as unknown as CreateRLMFn;

  await runSmokeScenario(fakeCreateRLM);

  assert.ok(capturedLLM !== null);
  await assert.rejects(
    () => capturedLLM!.complete({ input: 'wrong', kind: 'plain_query' }),
    /Unexpected smoke plain_query input: wrong/u,
  );
  await assert.rejects(
    () => capturedLLM!.complete({ kind: 'unknown_kind' }),
    /Unsupported smoke request kind: unknown_kind/u,
  );
});
