import assert from 'node:assert/strict';

import {
  cloneUsageSummary,
  createUsageSummary,
  mergeUsageSummaries,
  recordUsage,
} from '../src/usage_summary.ts';

Deno.test('usage summary helpers cover undefined counters, explicit totals, and model merges', () => {
  const summary = createUsageSummary();

  recordUsage(summary, 'gpt-5-nano', undefined);
  recordUsage(summary, 'gpt-5-nano', {});
  recordUsage(summary, 'gpt-5-nano', {
    cachedInputTokens: 1,
    inputTokens: 2,
    outputTokens: 3,
  });
  recordUsage(summary, 'gpt-5-mini', {
    cachedInputTokens: 0,
    inputTokens: 4,
    outputTokens: 5,
    totalTokens: 99,
  });

  assert.deepEqual(summary, {
    byModel: [
      {
        cachedInputTokens: 1,
        inputTokens: 2,
        model: 'gpt-5-nano',
        outputTokens: 3,
        reportedRequests: 2,
        requests: 3,
        totalTokens: 5,
      },
      {
        cachedInputTokens: 0,
        inputTokens: 4,
        model: 'gpt-5-mini',
        outputTokens: 5,
        reportedRequests: 1,
        requests: 1,
        totalTokens: 99,
      },
    ],
    cachedInputTokens: 1,
    inputTokens: 6,
    outputTokens: 8,
    reportedRequests: 3,
    requests: 4,
    totalTokens: 104,
  });

  const nested = createUsageSummary();
  recordUsage(nested, 'gpt-5-nano', {
    cachedInputTokens: 2,
    inputTokens: 3,
    outputTokens: 4,
    totalTokens: 7,
  });
  recordUsage(nested, 'gpt-5.4-mini', {
    cachedInputTokens: 5,
    inputTokens: 6,
    outputTokens: 7,
    totalTokens: 8,
  });

  mergeUsageSummaries(summary, nested);

  assert.equal(summary.byModel.length, 3);
  assert.equal(summary.byModel.find((entry) => entry.model === 'gpt-5-nano')?.totalTokens, 12);
  assert.equal(summary.byModel.find((entry) => entry.model === 'gpt-5.4-mini')?.requests, 1);

  const cloned = cloneUsageSummary(summary);
  cloned.byModel[0]!.requests += 100;
  cloned.requests += 100;

  assert.notEqual(cloned.byModel[0]!.requests, summary.byModel[0]!.requests);
  assert.notEqual(cloned.requests, summary.requests);
});
