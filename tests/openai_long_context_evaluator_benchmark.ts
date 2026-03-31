import assert from 'node:assert/strict';

import {
  buildLongContextEvaluatorOptions,
  LONG_CONTEXT_SCENARIO_FACTORIES,
  runLongContextScenario,
} from './openai_long_context_benchmark_support.ts';
import { buildCodexLiveRunOptions } from './openai_live_scenario_support.ts';
import { CodexOAuthProvider } from '../src/providers/codex_oauth.ts';

let cachedEvaluatorModel: string | null = null;

async function loadEvaluatorModel(): Promise<string> {
  if (cachedEvaluatorModel !== null) {
    return cachedEvaluatorModel;
  }

  const provider = new CodexOAuthProvider();
  const availableModels = await provider.listModels();
  const config = buildCodexLiveRunOptions({
    availableModels,
    maxStepsCap: 12,
    maxSubcallDepthCap: 1,
    minimumRequestTimeoutMs: 180_000,
    outputCharLimitCap: 1_200,
  });
  cachedEvaluatorModel = config.subModel;
  return cachedEvaluatorModel;
}

for (const { createScenario, summaryLabel } of LONG_CONTEXT_SCENARIO_FACTORIES) {
  Deno.test(`live long-context benchmark with evaluator ${summaryLabel}`, async () => {
    const scenario = await createScenario();
    const evaluatorModel = await loadEvaluatorModel();
    const outcome = await runLongContextScenario(scenario, {
      evaluator: buildLongContextEvaluatorOptions({
        subModel: evaluatorModel,
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
  });
}
