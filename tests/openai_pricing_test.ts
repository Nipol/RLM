import assert from 'node:assert/strict';

import {
  estimateOpenAIRunCostUsd,
  estimateOpenAIUsageCostUsd,
  resolveOpenAITextModelPricing,
} from '../src/providers/openai_pricing.ts';

Deno.test('OpenAI pricing exposes the current GPT-5 nano context and token rates', () => {
  const pricing = resolveOpenAITextModelPricing('gpt-5-nano');

  assert.deepEqual(pricing, {
    cachedInputUsdPerMillionTokens: 0.005,
    contextWindowTokens: 400_000,
    inputUsdPerMillionTokens: 0.05,
    maxOutputTokens: 128_000,
    model: 'gpt-5-nano',
    outputUsdPerMillionTokens: 0.4,
  });
});

Deno.test('OpenAI pricing normalizes common dated and dashed GPT-5.4 aliases before lookup', () => {
  assert.equal(resolveOpenAITextModelPricing('   '), null);
  assert.deepEqual(
    resolveOpenAITextModelPricing('gpt-5-4-mini'),
    resolveOpenAITextModelPricing('gpt-5.4-mini'),
  );
  assert.deepEqual(
    resolveOpenAITextModelPricing('gpt-5-4-mini-2026-03-17'),
    resolveOpenAITextModelPricing('gpt-5.4-mini'),
  );
  assert.deepEqual(
    resolveOpenAITextModelPricing('gpt-5-4-pro'),
    resolveOpenAITextModelPricing('gpt-5.4-pro'),
  );
});

Deno.test('OpenAI pricing estimates per-model and aggregate cost from usage summaries', () => {
  const rootEstimate = estimateOpenAIUsageCostUsd({
    model: 'gpt-5-nano',
    usage: {
      cachedInputTokens: 200_000,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    },
  });

  assert.deepEqual(rootEstimate, {
    cachedInputCostUsd: 0.001,
    inputCostUsd: 0.04,
    model: 'gpt-5-nano',
    outputCostUsd: 0.04,
    totalCostUsd: 0.081,
  });

  const runEstimate = estimateOpenAIRunCostUsd({
    byModel: [
      {
        cachedInputTokens: 200_000,
        inputTokens: 1_000_000,
        model: 'gpt-5-nano',
        outputTokens: 100_000,
        reportedRequests: 1,
        requests: 1,
        totalTokens: 1_100_000,
      },
      {
        cachedInputTokens: 0,
        inputTokens: 300_000,
        model: 'gpt-5-mini',
        outputTokens: 50_000,
        reportedRequests: 1,
        requests: 1,
        totalTokens: 350_000,
      },
    ],
    cachedInputTokens: 200_000,
    inputTokens: 1_300_000,
    outputTokens: 150_000,
    reportedRequests: 2,
    requests: 2,
    totalTokens: 1_450_000,
  });

  assert.deepEqual(runEstimate, {
    byModel: [
      {
        cachedInputCostUsd: 0.001,
        inputCostUsd: 0.04,
        model: 'gpt-5-nano',
        outputCostUsd: 0.04,
        totalCostUsd: 0.081,
      },
      {
        cachedInputCostUsd: 0,
        inputCostUsd: 0.075,
        model: 'gpt-5-mini',
        outputCostUsd: 0.1,
        totalCostUsd: 0.175,
      },
    ],
    missingPricingModels: [],
    totalCostUsd: 0.256,
  });
});

Deno.test('OpenAI pricing returns null for unknown models and reports missing pricing entries in aggregate estimates', () => {
  assert.equal(resolveOpenAITextModelPricing('unknown-model'), null);
  assert.equal(
    estimateOpenAIUsageCostUsd({
      model: 'unknown-model',
      usage: {
        cachedInputTokens: 0,
        inputTokens: 1_000,
        outputTokens: 200,
      },
    }),
    null,
  );

  const runEstimate = estimateOpenAIRunCostUsd({
    byModel: [
      {
        cachedInputTokens: 0,
        inputTokens: 1_000,
        model: 'unknown-model',
        outputTokens: 200,
        reportedRequests: 1,
        requests: 1,
        totalTokens: 1_200,
      },
    ],
    cachedInputTokens: 0,
    inputTokens: 1_000,
    outputTokens: 200,
    reportedRequests: 1,
    requests: 1,
    totalTokens: 1_200,
  });

  assert.deepEqual(runEstimate, {
    byModel: [],
    missingPricingModels: ['unknown-model'],
    totalCostUsd: 0,
  });
});
