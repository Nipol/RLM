import assert from 'node:assert/strict';

import {
  buildLongContextEvaluatorOptions,
  LONG_CONTEXT_SCENARIO_FACTORIES,
  runLongContextScenario,
} from './openai_long_context_benchmark_support.ts';
import type { CodexLiveHarness } from './openai_live_scenario_support.ts';

function countWords(text: string): number {
  return text.trim().split(/\s+/u).length;
}

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

Deno.test('all long-context scenario factories build populated scenarios with large documents and stable labels', async () => {
  for (const entry of LONG_CONTEXT_SCENARIO_FACTORIES) {
    const scenario = await entry.createScenario({ rootModel: 'gpt-5-mini' });
    const context = scenario.context as { document?: unknown };

    assert.equal(scenario.summaryLabel, entry.summaryLabel);
    assert.match(scenario.prompt, /FINAL_VAR/u);
    assert.equal(typeof context.document, 'string');
    assert.ok((context.document as string).length > 0);
    assert.ok(countWords(context.document as string) >= scenario.expectedMinDocumentWords);
  }
});

Deno.test('runLongContextScenario records a passed benchmark outcome for a successful local harness', async () => {
  const harness: CodexLiveHarness = {
    provider: {
      createCaller() {
        return {
          async complete(request) {
            assert.equal(request.kind, 'root_turn');
            return {
              outputText: '```repl\nFINAL_VAR("42");\n```',
              usage: {
                inputTokens: 100,
                outputTokens: 20,
                totalTokens: 120,
              },
            };
          },
        };
      },
      async listModels() {
        return ['gpt-5-mini'];
      },
      async loadAuth() {
        return null;
      },
    },
    runOptions: {
      cellTimeoutMs: 5_000,
      maxSteps: 1,
      maxSubcallDepth: 1,
      outputCharLimit: 1_200,
      requestTimeoutMs: 5_000,
      rootModel: 'gpt-5-mini',
      subModel: 'gpt-5-mini',
    },
  };

  const outcome = await runLongContextScenario(
    {
      context: { document: 'Needle answer 42.' },
      expectedAnswer: '42',
      expectedMinDocumentWords: 3,
      journalPathName: 'unit-success',
      prompt: 'Return only the exact answer through FINAL_VAR.',
      summaryLabel: 'unit-success',
    },
    harness,
  );

  assert.deepEqual(
    {
      actualAnswer: outcome.actualAnswer,
      passed: outcome.passed,
      scenario: outcome.scenario,
      steps: outcome.steps,
      variant: outcome.variant,
    },
    {
      actualAnswer: '42',
      passed: true,
      scenario: 'unit-success',
      steps: 1,
      variant: 'baseline',
    },
  );
  assert.equal(outcome.error, null);
  assert.ok(outcome.contextWords >= 3);
  assert.ok(outcome.totalCostUsd !== null && outcome.totalCostUsd > 0);
  assert.ok(outcome.journalPath?.endsWith('/unit-success/session.jsonl'));
});

Deno.test('runLongContextScenario reports a failed benchmark outcome when the harness caller throws before a result exists', async () => {
  const harness: CodexLiveHarness = {
    provider: {
      createCaller() {
        return {
          async complete() {
            throw new Error('synthetic failure');
          },
        };
      },
      async listModels() {
        return ['gpt-5-mini'];
      },
      async loadAuth() {
        return null;
      },
    },
    runOptions: {
      cellTimeoutMs: 5_000,
      maxSteps: 1,
      maxSubcallDepth: 1,
      outputCharLimit: 1_200,
      requestTimeoutMs: 5_000,
      rootModel: 'gpt-5-mini',
      subModel: 'gpt-5-mini',
    },
  };

  const outcome = await runLongContextScenario(
    {
      context: { document: 'Needle answer 42.' },
      expectedAnswer: '42',
      expectedMinDocumentWords: 3,
      journalPathName: 'unit-failure',
      prompt: 'Return only the exact answer through FINAL_VAR.',
      summaryLabel: 'unit-failure',
    },
    harness,
    { variant: 'evaluator' },
  );

  assert.deepEqual(
    {
      actualAnswer: outcome.actualAnswer,
      passed: outcome.passed,
      steps: outcome.steps,
      totalCostUsd: outcome.totalCostUsd,
      variant: outcome.variant,
    },
    {
      actualAnswer: null,
      passed: false,
      steps: null,
      totalCostUsd: null,
      variant: 'evaluator',
    },
  );
  assert.match(outcome.error ?? '', /synthetic failure/u);
  assert.equal(outcome.providerInputTokens, 0);
  assert.equal(outcome.providerOutputTokens, 0);
  assert.equal(outcome.providerTotalTokens, 0);
  assert.equal(outcome.reportedRequests, 0);
  assert.equal(outcome.requests, 0);
});
