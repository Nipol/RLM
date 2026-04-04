import assert from 'node:assert/strict';

import { createRLM } from '../mod.ts';
import { createAoTPlugin } from '../plugin/aot/mod.ts';
import { createPingPongPlugin } from '../plugin/pingpong/mod.ts';
import { runPluginSmokeScenario } from '../smoke/shared/plugin_scenario.ts';
import type { CreateRLMFn } from '../smoke/shared/plugin_scenario.ts';
import { createUsageSummary } from '../src/usage_summary.ts';

Deno.test('shared plugin smoke scenario imports repository plugins and executes the ping-pong helper', async () => {
  const result = await runPluginSmokeScenario(createRLM, createPingPongPlugin, createAoTPlugin);

  assert.equal(result.answer, 'PONG');
  assert.equal(result.finalValue, 'PONG');
  assert.equal(result.steps, 1);
  assert.deepEqual(result.pluginNames, ['ping-pong', 'aot']);
  assert.deepEqual(result.helperNames, ['ping_pong', 'aot']);
  assert.equal(result.aotHelperName, 'aot');
});

Deno.test('shared plugin smoke scenario caller surfaces unsupported request kinds', async () => {
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

  await runPluginSmokeScenario(fakeCreateRLM, createPingPongPlugin, createAoTPlugin);

  assert.ok(capturedLLM !== null);
  await assert.rejects(
    () => capturedLLM!.complete({ kind: 'child_turn' }),
    /Unsupported plugin smoke request kind: child_turn/u,
  );
});
