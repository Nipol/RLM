import assert from 'node:assert/strict';

import {
  buildLongContextEvaluatorOptions,
  LONG_CONTEXT_SCENARIO_FACTORIES,
} from './openai_long_context_benchmark_support.ts';

Deno.test('buildLongContextEvaluatorOptions defaults to the sub-model with evaluator enabled', () => {
  const evaluator = buildLongContextEvaluatorOptions({
    subModel: 'gpt-5-3-instant',
  });

  assert.deepEqual(evaluator, {
    enabled: true,
    maxFeedbackChars: 240,
    model: 'gpt-5-3-instant',
  });
});

Deno.test('buildLongContextEvaluatorOptions allows explicit overrides', () => {
  const evaluator = buildLongContextEvaluatorOptions(
    { subModel: 'gpt-5-3-instant' },
    {
      enabled: false,
      maxFeedbackChars: 120,
      model: 'gpt-5-mini',
    },
  );

  assert.deepEqual(evaluator, {
    enabled: false,
    maxFeedbackChars: 120,
    model: 'gpt-5-mini',
  });
});

Deno.test('long-context benchmark catalog includes the integrated stable and public-benchmark-inspired scenario set without duplicate labels', () => {
  const labels = LONG_CONTEXT_SCENARIO_FACTORIES.map((entry) => entry.summaryLabel);

  assert.deepEqual(labels, [
    'longbench-inspired-single-doc-qa',
    'zeroscrolls-inspired-aggregation',
    'leval-inspired-closed-ended',
    'babilong-inspired-distributed-facts',
    'nolima-inspired-latent-needle',
    'repoqa-inspired-code-search',
    'ruler-inspired-near-max-needle',
  ]);
  assert.equal(new Set(labels).size, labels.length);
});

Deno.test('longbench scenario normalizes option-letter case before comparison', async () => {
  const scenarioFactory = LONG_CONTEXT_SCENARIO_FACTORIES.find((entry) =>
    entry.summaryLabel === 'longbench-inspired-single-doc-qa'
  );

  assert.ok(scenarioFactory);

  const scenario = await scenarioFactory.createScenario();

  assert.equal(scenario.expectedAnswer, 'C');
  assert.equal(scenario.normalizeAnswer?.('c'), 'C');
  assert.equal(scenario.normalizeAnswer?.(' C '), 'C');
});
