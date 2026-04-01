/**
 * Usage-summary builders and aggregators for provider-neutral token accounting.
 *
 * @module
 *
 * @example
 * ```ts
 * import { createUsageSummary } from './usage_summary.ts';
 * ```
 */
import type { LLMUsage } from './llm_adapter.ts';
import type { ModelUsageSummary, RLMUsageSummary } from './types.ts';

/**
 * Builds an empty usage accumulator for one RLM run.
 *
 * The summary keeps both a global total and a per-model breakdown so callers can
 * later estimate provider cost even when root and sub-models differ.
 *
 * @example
 * ```ts
 * const summary = createUsageSummary();
 * console.log(summary.requests); // 0
 * ```
 */
export function createUsageSummary(): RLMUsageSummary {
  return {
    byModel: [],
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reportedRequests: 0,
    requests: 0,
    totalTokens: 0,
  };
}

/**
 * Records one completion usage payload under the specified model.
 *
 * Requests are counted even when the provider omitted token usage so callers can
 * detect partial reporting through `reportedRequests`.
 *
 * @example
 * ```ts
 * const summary = createUsageSummary();
 * recordUsage(summary, 'gpt-5-nano', {
 *   inputTokens: 120,
 *   outputTokens: 40,
 * });
 * ```
 */
export function recordUsage(
  summary: RLMUsageSummary,
  model: string,
  usage: LLMUsage | undefined,
): void {
  let modelSummary = summary.byModel.find((entry) => entry.model === model);
  if (modelSummary === undefined) {
    modelSummary = {
      cachedInputTokens: 0,
      inputTokens: 0,
      model,
      outputTokens: 0,
      reportedRequests: 0,
      requests: 0,
      totalTokens: 0,
    };
    summary.byModel.push(modelSummary);
  }

  summary.requests += 1;
  modelSummary.requests += 1;

  if (usage === undefined) {
    return;
  }

  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;

  summary.cachedInputTokens += cachedInputTokens;
  summary.inputTokens += inputTokens;
  summary.outputTokens += outputTokens;
  summary.reportedRequests += 1;
  summary.totalTokens += totalTokens;

  modelSummary.cachedInputTokens += cachedInputTokens;
  modelSummary.inputTokens += inputTokens;
  modelSummary.outputTokens += outputTokens;
  modelSummary.reportedRequests += 1;
  modelSummary.totalTokens += totalTokens;
}

/**
 * Merges a completed child run summary into its parent accumulator.
 *
 * @example
 * ```ts
 * const root = createUsageSummary();
 * const child = createUsageSummary();
 * recordUsage(child, 'gpt-5-mini', { inputTokens: 20, outputTokens: 5 });
 * mergeUsageSummaries(root, child);
 * ```
 */
export function mergeUsageSummaries(
  target: RLMUsageSummary,
  source: RLMUsageSummary,
): void {
  for (const entry of source.byModel) {
    let modelSummary = target.byModel.find((candidate) => candidate.model === entry.model);
    if (modelSummary === undefined) {
      modelSummary = {
        cachedInputTokens: 0,
        inputTokens: 0,
        model: entry.model,
        outputTokens: 0,
        reportedRequests: 0,
        requests: 0,
        totalTokens: 0,
      };
      target.byModel.push(modelSummary);
    }

    modelSummary.cachedInputTokens += entry.cachedInputTokens;
    modelSummary.inputTokens += entry.inputTokens;
    modelSummary.outputTokens += entry.outputTokens;
    modelSummary.reportedRequests += entry.reportedRequests;
    modelSummary.requests += entry.requests;
    modelSummary.totalTokens += entry.totalTokens;
  }

  target.cachedInputTokens += source.cachedInputTokens;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.reportedRequests += source.reportedRequests;
  target.requests += source.requests;
  target.totalTokens += source.totalTokens;
}

/**
 * Produces a detached usage summary so callers cannot mutate runner state.
 *
 * @example
 * ```ts
 * const summary = createUsageSummary();
 * const copy = cloneUsageSummary(summary);
 * ```
 */
export function cloneUsageSummary(summary: RLMUsageSummary): RLMUsageSummary {
  return {
    byModel: summary.byModel.map((entry): ModelUsageSummary => ({
      cachedInputTokens: entry.cachedInputTokens,
      inputTokens: entry.inputTokens,
      model: entry.model,
      outputTokens: entry.outputTokens,
      reportedRequests: entry.reportedRequests,
      requests: entry.requests,
      totalTokens: entry.totalTokens,
    })),
    cachedInputTokens: summary.cachedInputTokens,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    reportedRequests: summary.reportedRequests,
    requests: summary.requests,
    totalTokens: summary.totalTokens,
  };
}
