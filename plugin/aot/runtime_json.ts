/**
 * JSON parsing and DAG normalization helpers for AoT runtime authoring.
 *
 * @module
 *
 * @example
 * ```ts
 * import { normalizeDecomposition } from './runtime_json.ts';
 * ```
 */
import type {
  AoTContraction,
  AoTDecomposition,
  AoTFrontierDecision,
  AoTJudgeDecision,
  AoTSubquestion,
} from './types.ts';
import { isPlainObject, trimText } from './runtime_shared.ts';

/**
 * Removes one optional fenced code block wrapper from model output.
 */
export function stripCodeFence(text: string): string {
  const fence = String.fromCharCode(96).repeat(3);
  const match = text.match(
    new RegExp(`^\\s*${fence}(?:json)?\\s*([\\s\\S]*?)\\s*${fence}\\s*$`, 'i'),
  );
  return match ? match[1].trim() : text.trim();
}

/**
 * Extracts the most likely JSON substring from one model response.
 */
export function extractJsonCandidate(text: string): string {
  const stripped = stripCodeFence(text);
  if (stripped.startsWith('{') || stripped.startsWith('[')) {
    return stripped;
  }

  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return stripped.slice(firstBrace, lastBrace + 1);
  }

  const firstBracket = stripped.indexOf('[');
  const lastBracket = stripped.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    return stripped.slice(firstBracket, lastBracket + 1);
  }

  return stripped;
}

/**
 * Parses one strict JSON response or raises a stage-specific AoT error.
 */
export function parseStrictJson(text: unknown, stage: string): unknown {
  const candidate = extractJsonCandidate(String(text));

  try {
    return JSON.parse(candidate);
  } catch (_error) {
    throw new Error(
      `aot(${stage}) expected strict JSON but received: ${String(text).slice(0, 400)}`,
    );
  }
}

/**
 * Normalizes the raw DAG node list returned by the decomposition step.
 */
export function normalizeSubquestions(rawSubquestions: unknown): AoTSubquestion[] {
  if (!Array.isArray(rawSubquestions)) {
    return [];
  }

  const normalized: AoTSubquestion[] = [];
  const seenIds = new Set<string>();
  for (let index = 0; index < rawSubquestions.length; index += 1) {
    const raw = rawSubquestions[index];
    if (!isPlainObject(raw)) {
      continue;
    }

    const question = trimText(raw.question) || trimText(raw.subquestion) || trimText(raw.text);
    if (question.length === 0) {
      continue;
    }

    let id = trimText(raw.id);
    if (id.length === 0 || seenIds.has(id)) {
      id = `q${String(normalized.length + 1)}`;
    }

    const rawDeps = Array.isArray(raw.deps)
      ? raw.deps
      : Array.isArray(raw.dependencies)
      ? raw.dependencies
      : [];
    const deps: string[] = [];
    for (const dep of rawDeps) {
      const depId = trimText(dep);
      if (depId.length === 0 || depId === id || deps.includes(depId)) {
        continue;
      }

      deps.push(depId);
    }

    normalized.push({ id, question, deps });
    seenIds.add(id);
  }

  const knownIds = new Set(normalized.map((entry) => entry.id));
  return normalized.map((entry) => ({
    ...entry,
    deps: entry.deps.filter((dep) => knownIds.has(dep)),
  }));
}

/**
 * Normalizes one decomposition JSON payload.
 */
export function normalizeDecomposition(value: unknown): AoTDecomposition {
  const objectValue = isPlainObject(value) ? value as Record<string, unknown> : null;
  const subquestions = objectValue ? normalizeSubquestions(objectValue.subquestions) : [];
  const reason = objectValue ? trimText(objectValue.reason) : '';

  return {
    atomic: (objectValue !== null && Boolean(objectValue.atomic)) || subquestions.length === 0,
    reason,
    subquestions,
  };
}

/**
 * Normalizes one contraction JSON payload.
 */
export function normalizeContraction(value: unknown): AoTContraction {
  if (!isPlainObject(value)) {
    throw new Error('aot(contraction) must return a JSON object.');
  }

  const objectValue = value as Record<string, unknown>;
  const nextQuestion = trimText(objectValue.next_question) ||
    trimText(objectValue.nextQuestion) ||
    trimText(objectValue.contracted_question) ||
    trimText(objectValue.contractedQuestion);
  if (nextQuestion.length === 0) {
    throw new Error('aot(contraction) must provide next_question.');
  }

  return {
    nextQuestion,
    ready: Boolean(objectValue.ready),
    reason: trimText(objectValue.reason),
  };
}

/**
 * Normalizes one judge JSON payload.
 */
export function normalizeJudgeDecision(value: unknown): AoTJudgeDecision {
  if (!isPlainObject(value)) {
    throw new Error('aot(judge) must return a JSON object.');
  }

  const objectValue = value as Record<string, unknown>;
  const rawSelected = trimText(objectValue.selected).toLowerCase();
  const selected = rawSelected === 'current' || rawSelected === 'graph' || rawSelected === 'next'
    ? rawSelected
    : 'current';
  const answer = trimText(objectValue.answer) || null;

  return {
    acceptNextState: Boolean(objectValue.accept_next_state ?? objectValue.acceptNextState),
    answer,
    reason: trimText(objectValue.reason),
    refineNextState: Boolean(objectValue.refine_next_state ?? objectValue.refineNextState),
    selected,
  };
}

/**
 * Normalizes one frontier-pruning JSON payload.
 */
export function normalizeFrontierDecision(value: unknown): AoTFrontierDecision {
  if (!isPlainObject(value)) {
    throw new Error('aot(frontier) must return a JSON object.');
  }

  const objectValue = value as Record<string, unknown>;
  const rawIds = Array.isArray(objectValue.selected_ids)
    ? objectValue.selected_ids
    : Array.isArray(objectValue.selectedIds)
    ? objectValue.selectedIds
    : [];
  const selectedIds: string[] = [];

  for (const rawId of rawIds) {
    const id = trimText(rawId);
    if (id.length === 0 || selectedIds.includes(id)) {
      continue;
    }

    selectedIds.push(id);
  }

  return {
    reason: trimText(objectValue.reason),
    selectedIds,
  };
}
