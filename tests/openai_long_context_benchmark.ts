import assert from 'node:assert/strict';

import {
  LONG_CONTEXT_SCENARIO_FACTORIES,
  runLongContextScenario,
} from './openai_long_context_benchmark_support.ts';

for (const { createScenario, summaryLabel } of LONG_CONTEXT_SCENARIO_FACTORIES) {
  Deno.test(`live long-context benchmark ${summaryLabel}`, async () => {
    const scenario = await createScenario();
    const outcome = await runLongContextScenario(scenario, { variant: 'baseline' });

    assert.equal(
      outcome.passed,
      true,
      outcome.error ?? `${scenario.summaryLabel} failed without an explicit error.`,
    );
    assert.ok(outcome.contextWords > 0);
    assert.equal(typeof outcome.passed, 'boolean');
  });
}
