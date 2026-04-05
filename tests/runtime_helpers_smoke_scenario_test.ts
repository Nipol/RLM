import assert from 'node:assert/strict';

import { createRLM } from '../mod.ts';
import { runRuntimeHelpersSmokeScenario } from '../smoke/shared/runtime_helpers_scenario.ts';
import type { CreateRLMFn } from '../smoke/shared/runtime_helpers_scenario.ts';
import { createUsageSummary } from '../src/usage_summary.ts';

Deno.test('shared runtime-helper smoke scenario exercises llm_query, llm_query_batched, rlm_query, rlm_query_batched, and grep through the public library interface', async () => {
  const result = await runRuntimeHelpersSmokeScenario(createRLM);

  assert.deepEqual(result.finalValue, {
    delegated: 'PONG',
    delegatedBatch: ['LEFT', 'RIGHT'],
    grepPreview: [
      {
        contextText: 'alpha\nbeta\ngamma',
        line: 'beta',
        lineNumber: 2,
      },
    ],
    plain: 'PONG',
    plainBatch: ['ALPHA', 'BETA'],
  });
  assert.deepEqual(result.kindCounts, {
    child_turn: 3,
    plain_query: 3,
    root_turn: 1,
  });
  assert.equal(result.steps, 1);
});

Deno.test('shared runtime-helper smoke scenario caller surfaces unsupported request kinds and unexpected plain-query input', async () => {
  let capturedLLM: { complete(request: unknown): Promise<unknown> } | null = null;

  const fakeCreateRLM = ((options: Parameters<CreateRLMFn>[0]) => {
    capturedLLM =
      (options.llm as { complete(request: unknown): Promise<unknown> } | undefined) ?? null;

    return {
      async run() {
        return {
          answer: 'stub',
          finalValue: {
            delegated: 'stub',
            delegatedBatch: [],
            grepPreview: [],
            plain: 'stub',
            plainBatch: [],
          },
          session: { close: async () => undefined },
          steps: 0,
          usage: createUsageSummary(),
        };
      },
    };
  }) as unknown as CreateRLMFn;

  await runRuntimeHelpersSmokeScenario(fakeCreateRLM);

  assert.ok(capturedLLM !== null);
  await assert.rejects(
    () => capturedLLM!.complete({ input: 'wrong', kind: 'plain_query' }),
    /Unexpected runtime helper smoke plain_query input: wrong/u,
  );
  await assert.rejects(
    () => capturedLLM!.complete({ kind: 'unknown_kind' }),
    /Unsupported runtime helper smoke request kind: unknown_kind/u,
  );
});
