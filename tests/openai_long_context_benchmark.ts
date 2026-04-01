import assert from 'node:assert/strict';

import { CodexOAuthProvider } from '../src/providers/codex_oauth.ts';
import {
  LONG_CONTEXT_BENCHMARK_CAPS,
  LONG_CONTEXT_SCENARIO_FACTORIES,
  runLongContextScenario,
} from './openai_long_context_benchmark_support.ts';
import {
  loadCodexLiveHarness,
  probeCodexLiveProvider,
} from './openai_live_scenario_support.ts';

const longContextProvider = new CodexOAuthProvider();
const longContextAvailability = await probeCodexLiveProvider({
  provider: longContextProvider,
});
let cachedLongContextHarnessPromise:
  | ReturnType<typeof loadCodexLiveHarness>
  | null = null;

function loadLongContextHarness() {
  cachedLongContextHarnessPromise ??= loadCodexLiveHarness({
    ...LONG_CONTEXT_BENCHMARK_CAPS,
    provider: longContextProvider,
  });
  return cachedLongContextHarnessPromise;
}

for (const { createScenario, summaryLabel } of LONG_CONTEXT_SCENARIO_FACTORIES) {
  Deno.test({
    name: `live long-context benchmark ${summaryLabel}`,
    ignore: !longContextAvailability.enabled,
    fn: async () => {
      const harness = await loadLongContextHarness();
      const scenario = await createScenario({ rootModel: harness.runOptions.rootModel });
      const outcome = await runLongContextScenario(scenario, harness, { variant: 'baseline' });

      assert.equal(
        outcome.passed,
        true,
        outcome.error ?? `${scenario.summaryLabel} failed without an explicit error.`,
      );
      assert.ok(outcome.contextWords > 0);
      assert.equal(typeof outcome.passed, 'boolean');
    },
  });
}
