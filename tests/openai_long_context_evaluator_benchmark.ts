import assert from 'node:assert/strict';

import { CodexOAuthProvider } from '../src/providers/codex_oauth.ts';
import {
  buildLongContextEvaluatorOptions,
  LONG_CONTEXT_BENCHMARK_CAPS,
  LONG_CONTEXT_SCENARIO_FACTORIES,
  runLongContextScenario,
} from './openai_long_context_benchmark_support.ts';
import {
  loadCodexLiveHarness,
  probeCodexLiveProvider,
} from './openai_live_scenario_support.ts';

const evaluatorProvider = new CodexOAuthProvider();
const evaluatorAvailability = await probeCodexLiveProvider({
  provider: evaluatorProvider,
});
let cachedEvaluatorHarnessPromise:
  | ReturnType<typeof loadCodexLiveHarness>
  | null = null;

function loadEvaluatorHarness() {
  cachedEvaluatorHarnessPromise ??= loadCodexLiveHarness({
    ...LONG_CONTEXT_BENCHMARK_CAPS,
    provider: evaluatorProvider,
  });
  return cachedEvaluatorHarnessPromise;
}

for (const { createScenario, summaryLabel } of LONG_CONTEXT_SCENARIO_FACTORIES) {
  Deno.test({
    name: `live long-context benchmark with evaluator ${summaryLabel}`,
    ignore: !evaluatorAvailability.enabled,
    fn: async () => {
      const harness = await loadEvaluatorHarness();
      const scenario = await createScenario({ rootModel: harness.runOptions.rootModel });
      const outcome = await runLongContextScenario(scenario, harness, {
        evaluator: buildLongContextEvaluatorOptions({
          subModel: harness.runOptions.subModel,
        }),
        variant: 'evaluator',
      });

      assert.equal(
        outcome.passed,
        true,
        outcome.error ?? `${scenario.summaryLabel} failed without an explicit error.`,
      );
      assert.ok(outcome.contextWords > 0);
      assert.equal(outcome.variant, 'evaluator');
    },
  });
}
