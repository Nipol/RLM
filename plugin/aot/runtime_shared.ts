/**
 * Pure helper functions used while authoring the AoT runtime helper source.
 *
 * @module
 *
 * @example
 * ```ts
 * import { normalizeInput } from './runtime_shared.ts';
 * ```
 */
import type { AoTNormalizedInput } from './types.ts';

/**
 * Returns true when the given value is a non-array object.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Trims string inputs and normalizes all other values to an empty string.
 */
export function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Clamps one numeric value to an integer range or falls back when invalid.
 */
export function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Safely stringifies one JSON-like value for prompt rendering.
 */
export function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value);
  }
}

/**
 * Renders optional shared context into a prompt-friendly string.
 */
export function renderSharedContext(context: unknown): string | null {
  if (context === undefined || context === null) {
    return null;
  }

  if (typeof context === 'string') {
    const trimmed = context.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  return stringifyJson(context);
}

/**
 * Renders the current AoT state into a compact text block.
 */
export function renderState(question: string, config: {
  context: unknown;
  goal: string | null;
}): string {
  const lines = [
    'Current question:',
    question,
  ];

  if (config.goal !== null) {
    lines.push('', 'Target answer shape:', config.goal);
  }

  const sharedContext = renderSharedContext(config.context);
  if (sharedContext !== null) {
    lines.push('', 'Shared context:', sharedContext);
  }

  return lines.join('\n');
}

/**
 * Normalizes one runtime answer into a prompt-safe string.
 */
export function normalizeAnswerText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'object') {
    return stringifyJson(value);
  }

  return String(value);
}

/**
 * Extracts the first non-empty question field from one object input.
 */
export function extractQuestionFromObject(value: Record<string, unknown>): string {
  for (const key of ['question', 'task', 'prompt', 'query']) {
    const candidate = trimText(value[key]);
    if (candidate.length > 0) {
      return candidate;
    }
  }

  return '';
}

/**
 * Returns true when the normalized AoT settings stay on the single-path
 * lightweight execution path instead of enabling frontier-heavy search.
 */
export function usesLiteAoTSettings(config: {
  beamWidth: number;
  maxRefinements: number;
  transitionSamples: number;
}): boolean {
  return config.transitionSamples === 1 &&
    config.beamWidth === 1 &&
    config.maxRefinements === 0;
}

/**
 * Normalizes the user-facing AoT helper input into one internal state object.
 */
export function normalizeInput(rawInput: unknown): AoTNormalizedInput {
  if (typeof rawInput === 'string') {
    const question = rawInput.trim();
    if (question.length === 0) {
      throw new Error('aot(input) requires a non-empty question string.');
    }

    return {
      beamWidth: 1,
      context: null,
      goal: null,
      includeTrace: true,
      maxIndependentSubquestions: 4,
      maxIterations: 3,
      maxRefinements: 1,
      question,
      transitionSamples: 1,
    };
  }

  if (!isPlainObject(rawInput)) {
    throw new Error(
      'aot(input) expects either a non-empty question string or an object with a question field.',
    );
  }

  const objectInput = rawInput as Record<string, unknown>;
  const question = extractQuestionFromObject(objectInput);
  if (question.length === 0) {
    throw new Error(
      'aot(input) object inputs require a non-empty question, task, prompt, or query field.',
    );
  }

  return {
    beamWidth: clampInteger(objectInput.beamWidth, 1, 1, 2),
    context: Object.prototype.hasOwnProperty.call(objectInput, 'context')
      ? objectInput.context
      : null,
    goal: trimText(objectInput.goal) || null,
    includeTrace: objectInput.includeTrace !== false,
    maxIndependentSubquestions: clampInteger(objectInput.maxIndependentSubquestions, 4, 1, 4),
    maxIterations: clampInteger(objectInput.maxIterations, 3, 1, 4),
    maxRefinements: clampInteger(objectInput.maxRefinements, 1, 0, 2),
    question,
    transitionSamples: clampInteger(objectInput.transitionSamples, 1, 1, 3),
  };
}
