/**
 * OpenAI pricing metadata and cost-estimation helpers used by standalone reporting.
 *
 * @module
 *
 * @example
 * ```ts
 * import { estimateOpenAIRunCostUsd } from './openai_pricing.ts';
 * ```
 */
import type { ModelUsageSummary, RLMUsageSummary } from '../types.ts';

/**
 * Describes the static text-token pricing metadata used for current OpenAI models.
 *
 * The values are intended for transparent cost estimation in tests and benchmarks.
 */
export interface OpenAITextModelPricing {
  cachedInputUsdPerMillionTokens: number;
  contextWindowTokens: number;
  inputUsdPerMillionTokens: number;
  maxOutputTokens: number;
  model: string;
  outputUsdPerMillionTokens: number;
}

/**
 * Summarizes estimated token costs for one model within a run.
 */
export interface OpenAIUsageCostEstimate {
  cachedInputCostUsd: number;
  inputCostUsd: number;
  model: string;
  outputCostUsd: number;
  totalCostUsd: number;
}

/**
 * Summarizes estimated token costs across all models involved in one RLM run.
 */
export interface OpenAIRunCostEstimate {
  byModel: OpenAIUsageCostEstimate[];
  missingPricingModels: string[];
  totalCostUsd: number;
}

const OPENAI_TEXT_MODEL_PRICING = new Map<string, OpenAITextModelPricing>([
  [
    'gpt-5',
    {
      cachedInputUsdPerMillionTokens: 0.125,
      contextWindowTokens: 400_000,
      inputUsdPerMillionTokens: 1.25,
      maxOutputTokens: 128_000,
      model: 'gpt-5',
      outputUsdPerMillionTokens: 10,
    },
  ],
  [
    'gpt-5-mini',
    {
      cachedInputUsdPerMillionTokens: 0.025,
      contextWindowTokens: 400_000,
      inputUsdPerMillionTokens: 0.25,
      maxOutputTokens: 128_000,
      model: 'gpt-5-mini',
      outputUsdPerMillionTokens: 2,
    },
  ],
  [
    'gpt-5-nano',
    {
      cachedInputUsdPerMillionTokens: 0.005,
      contextWindowTokens: 400_000,
      inputUsdPerMillionTokens: 0.05,
      maxOutputTokens: 128_000,
      model: 'gpt-5-nano',
      outputUsdPerMillionTokens: 0.4,
    },
  ],
  [
    'gpt-5.4',
    {
      cachedInputUsdPerMillionTokens: 0.25,
      contextWindowTokens: 1_050_000,
      inputUsdPerMillionTokens: 2.5,
      maxOutputTokens: 128_000,
      model: 'gpt-5.4',
      outputUsdPerMillionTokens: 15,
    },
  ],
  [
    'gpt-5.4-pro',
    {
      cachedInputUsdPerMillionTokens: 3,
      contextWindowTokens: 1_050_000,
      inputUsdPerMillionTokens: 30,
      maxOutputTokens: 128_000,
      model: 'gpt-5.4-pro',
      outputUsdPerMillionTokens: 180,
    },
  ],
  [
    'gpt-5.4-mini',
    {
      cachedInputUsdPerMillionTokens: 0.08,
      contextWindowTokens: 450_000,
      inputUsdPerMillionTokens: 0.75,
      maxOutputTokens: 128_000,
      model: 'gpt-5.4-mini',
      outputUsdPerMillionTokens: 4.5,
    },
  ],
  [
    'gpt-5.4-nano',
    {
      cachedInputUsdPerMillionTokens: 0.02,
      contextWindowTokens: 400_000,
      inputUsdPerMillionTokens: 0.2,
      maxOutputTokens: 128_000,
      model: 'gpt-5.4-nano',
      outputUsdPerMillionTokens: 1.25,
    },
  ],
]);

function normalizePricingModelId(model: string): string {
  const trimmed = model.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  const withoutDateSuffix = trimmed.replace(/-\d{4}-\d{2}-\d{2}$/u, '');
  if (OPENAI_TEXT_MODEL_PRICING.has(withoutDateSuffix)) {
    return withoutDateSuffix;
  }

  const dottedGpt54 = withoutDateSuffix.replace(/^gpt-5-4(?=$|-)/u, 'gpt-5.4');
  if (OPENAI_TEXT_MODEL_PRICING.has(dottedGpt54)) {
    return dottedGpt54;
  }

  return withoutDateSuffix;
}

/**
 * Looks up the static pricing metadata for one supported OpenAI text model.
 */
export function resolveOpenAITextModelPricing(model: string): OpenAITextModelPricing | null {
  return OPENAI_TEXT_MODEL_PRICING.get(normalizePricingModelId(model)) ?? null;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Converts one model's usage record into an estimated USD cost.
 *
 * Cached input tokens are billed at the cached-input rate and excluded from the
 * ordinary input rate to avoid double counting.
 */
export function estimateOpenAIUsageCostUsd(
  options: {
    model: string;
    usage: Pick<ModelUsageSummary, 'cachedInputTokens' | 'inputTokens' | 'outputTokens'>;
  },
): OpenAIUsageCostEstimate | null {
  const pricing = resolveOpenAITextModelPricing(options.model);
  if (pricing === null) {
    return null;
  }

  const cachedInputTokens = Math.max(0, options.usage.cachedInputTokens);
  const inputTokens = Math.max(0, options.usage.inputTokens);
  const outputTokens = Math.max(0, options.usage.outputTokens);
  const billableInputTokens = Math.max(0, inputTokens - cachedInputTokens);

  const cachedInputCostUsd = (cachedInputTokens / 1_000_000) *
    pricing.cachedInputUsdPerMillionTokens;
  const inputCostUsd = (billableInputTokens / 1_000_000) * pricing.inputUsdPerMillionTokens;
  const outputCostUsd = (outputTokens / 1_000_000) * pricing.outputUsdPerMillionTokens;

  return {
    cachedInputCostUsd: roundUsd(cachedInputCostUsd),
    inputCostUsd: roundUsd(inputCostUsd),
    model: pricing.model,
    outputCostUsd: roundUsd(outputCostUsd),
    totalCostUsd: roundUsd(cachedInputCostUsd + inputCostUsd + outputCostUsd),
  };
}

/**
 * Estimates the total USD cost of one completed RLM run from its usage summary.
 */
export function estimateOpenAIRunCostUsd(summary: RLMUsageSummary): OpenAIRunCostEstimate {
  const byModel: OpenAIUsageCostEstimate[] = [];
  const missingPricingModels: string[] = [];

  for (const modelUsage of summary.byModel) {
    const estimate = estimateOpenAIUsageCostUsd({
      model: modelUsage.model,
      usage: modelUsage,
    });

    if (estimate === null) {
      missingPricingModels.push(modelUsage.model);
      continue;
    }

    byModel.push(estimate);
  }

  const totalCostUsd = roundUsd(
    byModel.reduce((sum, entry) => sum + entry.totalCostUsd, 0),
  );

  return {
    byModel,
    missingPricingModels,
    totalCostUsd,
  };
}
