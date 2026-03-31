import type {
  RLMClient,
  RLMClientOptions,
  RLMDefaults,
  RLMEvaluatorOptions,
  RLMRunInput,
} from './library_entrypoint.ts';
import { createDefaultExecutionBackend } from './execution_backend.ts';
import { createSubqueryLogger, getLoggerJournalPath, resolveRLMLogger } from './logger.ts';
import { createLLMQueryHandler, createRLMQueryHandler } from './llm_query.ts';
import type { LLMAdapter, LLMCaller, LLMCallerResponse } from './llm_adapter.ts';
import { buildRLMSystemPrompt, buildRLMTurnInput } from './rlm_prompt.ts';
import { extractFinalSignal, extractReplCodeBlocks } from './repl_protocol.ts';
import type { FinalSignal, ReplCodeBlock } from './repl_protocol.ts';
import { ReplSession } from './repl_session.ts';
import {
  cloneUsageSummary,
  createUsageSummary,
  mergeUsageSummaries,
  recordUsage,
} from './usage_summary.ts';
import type {
  AssistantTurnEntry,
  EvaluatorFeedbackEntry,
  ExecutionBackend,
  JsonValue,
  RLMLogger,
  RLMUsageSummary,
  SubqueryEntry,
  ValueSnapshot,
} from './types.ts';

const DEFAULT_CELL_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_STEPS = 12;
const DEFAULT_MAX_SUBCALL_DEPTH = 3;
const DEFAULT_OUTPUT_CHAR_LIMIT = 4_000;

interface InternalRLMRunOptions extends
  Omit<
    RLMRunOptions,
    'depth' | 'journalPath' | 'logger' | 'maxSteps' | 'maxSubcallDepth' | 'outputCharLimit'
  > {
  depth: number;
  executionBackend: ExecutionBackend;
  logger: RLMLogger;
  maxSteps: number;
  maxSubcallDepth: number;
  outputCharLimit: number;
  signal?: AbortSignal;
}

/**
 * Describes the inputs required to execute one complete RLM loop.
 *
 * This is the low-level one-shot runner interface.
 * Library consumers normally reach the same behavior through `createRLM(...)`.
 *
 * @example
 * ```ts
 * const options: RLMRunOptions = {
 *   llm,
 *   context: { document: 'Chapter 1\\nThe answer is 42.' },
 *   prompt: 'Extract the answer.',
 *   rootModel: 'gpt-5-nano',
 *   subModel: 'gpt-5-mini',
 * };
 * ```
 */
export interface RLMRunOptions extends RLMRunInput {
  adapter?: LLMAdapter;
  clock?: () => Date;
  depth?: number;
  evaluator?: RLMEvaluatorOptions;
  executionBackend?: ExecutionBackend;
  idGenerator?: () => string;
  journalPath?: string;
  llm?: LLMCaller;
  logger?: RLMLogger;
  rootModel: string;
  subModel: string;
}

/**
 * Describes the terminal result of a completed RLM loop.
 *
 * The returned session is kept so callers can inspect execution history
 * or continue working with the resulting REPL state.
 *
 * @example
 * ```ts
 * const result: RLMRunResult = await runRLM(options);
 * console.log(result.answer);
 * console.log(result.usage.totalInputTokens);
 * ```
 */
export interface RLMRunResult {
  answer: string;
  finalValue: JsonValue | null;
  session: ReplSession;
  steps: number;
  usage: RLMUsageSummary;
}

/**
 * Raised when the assistant fails to follow the REPL control protocol.
 *
 * @example
 * ```ts
 * throw new RLMProtocolError('Assistant response did not contain a repl block.');
 * ```
 */
export class RLMProtocolError extends Error {
  /**
   * Formats a protocol-level failure with a user-readable explanation.
   */
  constructor(message: string) {
    super(message);
    this.name = 'RLMProtocolError';
  }
}

/**
 * Raised when an RLM loop exhausts its turn budget before producing a final answer.
 *
 * @example
 * ```ts
 * throw new RLMMaxStepsError(12);
 * ```
 */
export class RLMMaxStepsError extends Error {
  /**
   * Formats a max-step failure using the configured turn cap.
   */
  constructor(maxSteps: number) {
    super(`RLM run exceeded the configured max steps (${maxSteps}) without FINAL.`);
    this.name = 'RLMMaxStepsError';
  }
}

/**
 * Resolves one integer limit by preferring an explicit override and otherwise falling back.
 *
 * @param value The per-call override value.
 * @param fallback The default value to use when no override is present.
 * @returns The resolved integer limit.
 */
function resolveRunLimit(value: number | undefined, fallback: number): number {
  return value ?? fallback;
}

function resolveRLMCaller(
  llm: LLMCaller | undefined,
  adapter: LLMAdapter | undefined,
): LLMCaller {
  const resolved = llm ?? adapter;
  if (resolved !== undefined) {
    return resolved;
  }

  throw new Error('RLM requires an llm caller or legacy adapter.');
}

function resolveControllerRole(depth: number | undefined): 'child' | 'root' {
  return (depth ?? 0) > 0 ? 'child' : 'root';
}

function resolveSubqueryAnswerValue(
  nested: Pick<RLMRunResult, 'answer' | 'finalValue'>,
): JsonValue {
  return nested.finalValue ?? nested.answer;
}

function readLatestAcceptedFinalStdout(
  history: Array<{
    finalAnswer: string | null;
    finalResult?: ValueSnapshot | null;
    status: 'error' | 'success' | 'timeout';
    stdout: string;
  }>,
): string {
  const latest = [...history].reverse().find((cell) =>
    shouldAcceptExecutionFinalAnswer(cell.status, cell.finalAnswer, cell.finalResult)
  );
  return latest?.stdout ?? '';
}

/**
 * Accepts only terminal values that represent a successful, usable final answer.
 *
 * A cell that errored after calling `FINAL(...)` must not terminate the run, and
 * `FINAL_VAR(undefined)` should be treated as an unfinished attempt rather than a
 * valid answer.
 */
function shouldAcceptExecutionFinalAnswer(
  status: 'error' | 'success' | 'timeout',
  finalAnswer: string | null,
  finalResult?: ValueSnapshot | null,
): boolean {
  if (status !== 'success') {
    return false;
  }

  if (finalAnswer === null) {
    return false;
  }

  if (finalResult?.kind === 'null') {
    return false;
  }

  return finalAnswer !== 'undefined';
}

function shouldAcceptExplicitFinalSignalValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== 'null' && trimmed !== 'undefined';
}

function extractFinalJsonValue(result: ValueSnapshot | null | undefined): JsonValue | null {
  if (result === undefined || result === null) {
    return null;
  }

  return result.json ?? null;
}

interface WeakFinalizationSummary {
  message: string;
  reason:
    | 'ambiguous_projection'
    | 'candidate_fallback'
    | 'empty'
    | 'multiple_choice'
    | 'placeholder'
    | 'truncated_scalar';
}

function isLikelyMultipleChoiceAnswer(answer: string): boolean {
  return /^[A-Z]$/u.test(answer.trim());
}

function readContextOptions(context: JsonValue | null): Record<string, string> | null {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    return null;
  }

  if (
    !('options' in context) || typeof context.options !== 'object' || context.options === null ||
    Array.isArray(context.options)
  ) {
    return null;
  }

  const entries = Object.entries(context.options)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  if (entries.length === 0) {
    return null;
  }

  return Object.fromEntries(entries);
}

function readContextDocument(context: JsonValue | null): string | null {
  if (typeof context === 'string') {
    return context;
  }

  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    return null;
  }

  return typeof context.document === 'string' ? context.document : null;
}

function readQuestionLikeText(context: JsonValue | null): string | null {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    return null;
  }

  const preferredKeys = ['question', 'retrievalQuestion', 'query', 'task'] as const;
  for (const key of preferredKeys) {
    const value = context[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

function inferRequestedEntityLabel(prompt: string, context: JsonValue | null): string | null {
  const candidates = [readQuestionLikeText(context), prompt]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const source of candidates) {
    const match = source.match(
      /\bwhich\s+([a-z][a-z0-9 -]{0,40}?)(?:\s+(?:is|are|contains?|gives?|maps?|seals?|does|do|for|from|assigned|matches?)\b|\?)/iu,
    );
    if (match?.[1] !== undefined) {
      return match[1].replace(/\s+/gu, ' ').trim().toLowerCase();
    }
  }

  return null;
}

const TARGET_LABEL_LEADING_MODIFIERS = new Set([
  'exact',
  'correct',
  'final',
  'requested',
  'resolved',
  'matching',
  'single',
  'uppercase',
  'lowercase',
]);

const TARGET_LABEL_TRAILING_GENERIC_WORDS = new Set([
  'answer',
  'code',
  'id',
  'identifier',
  'key',
  'label',
  'letter',
  'name',
  'number',
  'value',
]);

function stripLeadingTargetModifiers(label: string): string {
  const parts = label.trim().toLowerCase().split(/\s+/u).filter((part) => part.length > 0);
  while (parts.length > 1 && TARGET_LABEL_LEADING_MODIFIERS.has(parts[0]!)) {
    parts.shift();
  }

  return parts.join(' ');
}

function stripTrailingTargetSuffixes(label: string): string {
  const parts = label.trim().toLowerCase().split(/\s+/u).filter((part) => part.length > 0);
  while (parts.length > 1 && TARGET_LABEL_TRAILING_GENERIC_WORDS.has(parts.at(-1)!)) {
    parts.pop();
  }

  return parts.join(' ');
}

function collectRequestedEntityLabels(prompt: string, context: JsonValue | null): string[] {
  const base = inferRequestedEntityLabel(prompt, context);
  if (base === null) {
    return [];
  }

  const labels = new Set<string>();
  const normalized = base.replace(/\s+/gu, ' ').trim().toLowerCase();
  const withoutLeading = stripLeadingTargetModifiers(normalized);
  const withoutTrailing = stripTrailingTargetSuffixes(withoutLeading);

  for (const candidate of [normalized, withoutLeading, withoutTrailing]) {
    if (candidate.length > 0) {
      labels.add(candidate);
    }
  }

  return [...labels];
}

function normalizeCandidateValue(value: string): string {
  return value
    .replace(/^[`"'([{]+/gu, '')
    .replace(/[`"')\].,;:!?-]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function extractTargetCandidatesFromEvidence(targetLabel: string, evidence: string): string[] {
  if (targetLabel.trim().length === 0 || evidence.trim().length === 0) {
    return [];
  }

  const escapedLabel = targetLabel
    .split(/\s+/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('\\s+');
  const pattern = new RegExp(
    `${escapedLabel}\\s*(?:is|are|=|:)?\\s*([^\\n.;,:]+)`,
    'giu',
  );
  const values = new Map<string, string>();
  for (const match of evidence.matchAll(pattern)) {
    const raw = match[1];
    if (raw === undefined) {
      continue;
    }

    const normalized = normalizeCandidateValue(raw);
    if (normalized.length === 0) {
      continue;
    }

    if (
      /\b(which|question|assigned to|contains|gives|maps|seals)\b/iu.test(normalized) ||
      normalized.split(/\s+/u).length > 6
    ) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (!values.has(key)) {
      values.set(key, normalized);
    }
  }

  return [...values.values()];
}

function buildCombinedEvidenceText(input: {
  execution: {
    resultPreview: string;
    resultSignals?: Array<{ preview: string }>;
    stdout: string;
  };
  transcript: Array<{
    executions: Array<{
      resultPreview: string;
      resultSignals?: Array<{ preview: string }>;
      stdout: string;
    }>;
  }>;
}): string {
  return `${buildExecutionOutputEvidenceText(input.execution)}\n${buildTranscriptEvidenceText(input.transcript)}`;
}

function readCompetingTargetCandidates(input: {
  context: JsonValue | null;
  execution: {
    resultPreview: string;
    resultSignals?: Array<{ preview: string }>;
    stdout: string;
  };
  prompt: string;
  transcript: Array<{
    executions: Array<{
      resultPreview: string;
      resultSignals?: Array<{ preview: string }>;
      stdout: string;
    }>;
  }>;
}): { candidates: string[]; labels: string[] } | null {
  if (isLikelyMultipleChoiceTask(input.prompt, input.context)) {
    return null;
  }

  const labels = collectRequestedEntityLabels(input.prompt, input.context);
  if (labels.length === 0) {
    return null;
  }

  const evidence = buildCombinedEvidenceText({
    execution: input.execution,
    transcript: input.transcript,
  });
  const candidates = new Map<string, string>();
  for (const label of labels) {
    for (const candidate of extractTargetCandidatesFromEvidence(label, evidence)) {
      const key = candidate.toLowerCase();
      if (!candidates.has(key)) {
        candidates.set(key, candidate);
      }
    }
  }

  const values = [...candidates.values()];
  if (values.length < 2) {
    return null;
  }

  return {
    candidates: values,
    labels,
  };
}

function readEmbeddedDocumentOptions(context: JsonValue | null): Record<string, string> | null {
  const document = readContextDocument(context);
  if (document === null) {
    return null;
  }

  const matches = [
    ...document.matchAll(/\b([A-Z])\s*[=:]\s*(.+?)(?=(?:\s+\b[A-Z]\s*[=:])|[.\n]|$)/gs),
  ];
  if (matches.length === 0) {
    return null;
  }

  const options = new Map<string, string>();
  for (const match of matches) {
    const label = match[1]?.trim();
    const text = match[2]?.replace(/[,\s]+$/gu, '').trim();
    if (label === undefined || text === undefined || label.length !== 1 || text.length === 0) {
      continue;
    }

    options.set(label, text);
  }

  if (options.size === 0) {
    return null;
  }

  return Object.fromEntries(options);
}

function readAvailableOptions(context: JsonValue | null): Record<string, string> | null {
  return readContextOptions(context) ?? readEmbeddedDocumentOptions(context);
}

function isLikelyMultipleChoiceTask(prompt: string, context: JsonValue | null): boolean {
  if (readContextOptions(context) !== null) {
    return true;
  }

  return /multiple-choice|option letter|option\b/i.test(prompt);
}

function buildExecutionOutputEvidenceText(
  execution: {
    code?: string;
    resultSignals?: Array<{ preview: string }>;
    resultPreview: string;
    stdout: string;
  },
): string {
  const signalText = execution.resultSignals?.map((signal) => signal.preview).join('\n') ?? '';
  return [
    execution.stdout,
    execution.resultPreview,
    signalText,
  ].join('\n');
}

function buildTranscriptEvidenceText(
  transcript: Array<{
    executions: Array<{
      resultPreview: string;
      resultSignals?: Array<{ preview: string }>;
      stdout: string;
    }>;
  }>,
): string {
  return transcript
    .flatMap((turn) => turn.executions)
    .map((execution) =>
      buildExecutionOutputEvidenceText({
        resultPreview: execution.resultPreview,
        resultSignals: execution.resultSignals,
        stdout: execution.stdout,
      })
    )
    .join('\n');
}

function normalizeEvidenceText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

function matchOptionFromEvidence(
  prompt: string,
  context: JsonValue | null,
  execution: {
    code?: string;
    resultSignals?: Array<{ preview: string }>;
    resultPreview: string;
    stdout: string;
  },
): { label: string; text: string } | null {
  const options = readAvailableOptions(context);
  if (options === null) {
    return null;
  }

  const evidence = normalizeEvidenceText(buildExecutionOutputEvidenceText(execution));
  if (evidence.length === 0) {
    return null;
  }

  const matches = Object.entries(options)
    .filter(([, optionText]) => {
      const normalizedOption = normalizeEvidenceText(optionText);
      return normalizedOption.length > 0 && evidence.includes(normalizedOption);
    })
    .map(([label, text]) => ({ label, text }));

  if (matches.length === 1) {
    return matches[0]!;
  }

  if (matches.length > 1 && /multiple-choice|option\b/i.test(prompt)) {
    return null;
  }

  return null;
}

function matchOptionFromTranscriptEvidence(
  prompt: string,
  context: JsonValue | null,
  transcript: Array<{
    executions: Array<{
      resultPreview: string;
      resultSignals?: Array<{ preview: string }>;
      stdout: string;
    }>;
  }>,
): { label: string; text: string } | null {
  const options = readAvailableOptions(context);
  if (options === null) {
    return null;
  }

  const evidence = normalizeEvidenceText(buildTranscriptEvidenceText(transcript));
  if (evidence.length === 0) {
    return null;
  }

  const matches = Object.entries(options)
    .filter(([, optionText]) => {
      const normalizedOption = normalizeEvidenceText(optionText);
      return normalizedOption.length > 0 && evidence.includes(normalizedOption);
    })
    .map(([label, text]) => ({ label, text }));

  return matches.length === 1 ? matches[0]! : null;
}

function hasSelectedOptionEvidence(
  answer: string,
  prompt: string,
  context: JsonValue | null,
  execution: {
    code?: string;
    resultSignals?: Array<{ preview: string }>;
    resultPreview: string;
    stdout: string;
  },
): boolean {
  const evidence = buildExecutionOutputEvidenceText(execution);
  const labelPattern = new RegExp(`(^|[^\\w\\[])${answer}\\s*[=)\\].:\\-]`, 'imu');
  if (labelPattern.test(evidence)) {
    return true;
  }

  const matchedOption = matchOptionFromEvidence(prompt, context, execution);
  if (matchedOption?.label === answer) {
    return true;
  }

  const options = readAvailableOptions(context);
  const optionText = options?.[answer];
  if (optionText !== undefined && evidence.toLowerCase().includes(optionText.toLowerCase())) {
    return true;
  }

  if (options === null && /multiple-choice|option\b/i.test(prompt)) {
    return /question options|optionMatchCount|optCount/u.test(evidence);
  }

  return false;
}

function usesLiteralFinalChoice(code: string, answer: string): boolean {
  const escaped = answer.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`FINAL(?:_VAR)?\\(\\s*["']${escaped}["']\\s*\\)`, 'u').test(code);
}

function isPlaceholderLikeFinalAnswer(answer: string): boolean {
  return /^(?:unknown|pending|none|n\/a|n\\.a\\.|tbd|unset)$/iu.test(answer.trim());
}

function usesFirstCandidateFinalWithoutUniquenessGuard(code: string): boolean {
  const hasFirstCandidateSelection =
    /FINAL(?:_VAR)?\([\s\S]{0,240}(?:\[\s*0\s*\]|\.at\(\s*0\s*\))[\s\S]{0,240}\)/u.test(code) ||
    /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*[\s\S]{0,240}\.find\([\s\S]{0,240}\)\s*(?:\|\||\?\?)\s*[A-Za-z_$][\w$]*\s*\[\s*0\s*\]/u
      .test(code) && /FINAL(?:_VAR)?\(\s*[A-Za-z_$][\w$]*\s*\)/u.test(code);
  if (!hasFirstCandidateSelection) {
    return false;
  }

  const hasUniquenessGuard =
    /length\s*===\s*1|length\s*<=\s*1|\.size\s*===\s*1|candidateCount\s*===\s*1|unique(?:Count)?\s*===\s*1/u
      .test(code);
  return !hasUniquenessGuard;
}

function usesMergedWorkingSetProjectionWithoutUniquenessGuard(code: string): boolean {
  const hasMergedWorkingSet = /\.join\(\s*["'`]/u.test(code) || /join\(\s*["'`][\s\S]{0,8}["'`]\s*\)/u.test(code);
  if (!hasMergedWorkingSet || !/FINAL(?:_VAR)?\(/u.test(code)) {
    return false;
  }

  const hasProjection =
    /\.match\(/u.test(code);
  if (!hasProjection) {
    return false;
  }

  const hasUniquenessGuard =
    /length\s*===\s*1|length\s*<=\s*1|\.size\s*===\s*1|candidateCount\s*===\s*1|unique(?:Count)?\s*===\s*1/u
      .test(code);
  return !hasUniquenessGuard;
}

function finalAnswerRepeatsTargetLabel(
  finalAnswer: string,
  labels: readonly string[],
): boolean {
  const normalizedAnswer = finalAnswer.trim().toLowerCase();
  return labels.some((label) =>
    normalizedAnswer === label ||
    normalizedAnswer.startsWith(`${label} `) ||
    normalizedAnswer.startsWith(`${label}:`) ||
    normalizedAnswer.startsWith(`${label}=`)
  );
}

function readTruncatedScalarPrefixFromEvidence(
  finalAnswer: string,
  evidence: string,
): string | null {
  const normalizedAnswer = normalizeCandidateValue(finalAnswer);
  if (normalizedAnswer.length < 4 || /\s/u.test(normalizedAnswer)) {
    return null;
  }

  const tokens = evidence.match(/[A-Za-z0-9-]{4,}/gu) ?? [];
  let longestMatch: string | null = null;
  for (const token of tokens) {
    const normalizedToken = normalizeCandidateValue(token);
    if (normalizedToken.length <= normalizedAnswer.length) {
      continue;
    }

    if (!normalizedToken.startsWith(normalizedAnswer)) {
      continue;
    }

    if (longestMatch === null || normalizedToken.length > longestMatch.length) {
      longestMatch = normalizedToken;
    }
  }

  return longestMatch;
}

function isScalarLikeTask(prompt: string, context: JsonValue | null): boolean {
  if (isLikelyMultipleChoiceTask(prompt, context)) {
    return true;
  }

  const question = readQuestionLikeText(context) ?? '';
  const combined = `${prompt}\n${question}`.toLowerCase();
  return /\breturn only\b|\bexact\b|\bidentifier\b|\bname\b|\bcode\b|\bdigits?\b|\bscalar\b|\bwhich\b/u
    .test(combined);
}

function hasPositiveSurfacedCandidateEvidence(input: {
  execution: {
    resultPreview: string;
    resultSignals?: Array<{ preview: string }>;
    stdout: string;
  };
  transcript: Array<{
    executions: Array<{
      resultPreview: string;
      resultSignals?: Array<{ preview: string }>;
      stdout: string;
    }>;
  }>;
}): boolean {
  const evidence = `${buildExecutionOutputEvidenceText(input.execution)}\n${
    buildTranscriptEvidenceText(input.transcript)
  }`;

  return /(hitCount|matchCount|candidateCount|rowCount)\s*["=:]\s*[1-9]\d*/iu.test(evidence) ||
    /"sample"\s*:\s*\[/u.test(evidence) ||
    /"candidates"\s*:\s*\[[^\]]+/u.test(evidence) ||
    /\brows?\b/u.test(evidence) && /\[[^\]]+\]/u.test(evidence);
}

function readLatestTranscriptFinalAnswer(
  transcript: Array<{
    executions: Array<{
      finalAnswer?: string | null;
    }>;
  }>,
): string | null {
  const latestTurn = transcript.at(-1);
  if (latestTurn === undefined) {
    return null;
  }

  const latestExecution = [...latestTurn.executions]
    .reverse()
    .find((execution) => execution.finalAnswer !== null && execution.finalAnswer !== undefined);
  if (latestExecution?.finalAnswer === undefined || latestExecution.finalAnswer === null) {
    return null;
  }

  return latestExecution.finalAnswer.trim();
}

function summarizeWeakFinalization(input: {
  context: JsonValue | null;
  execution: {
    code: string;
    finalAnswer: string | null;
    resultPreview: string;
    resultSignals?: Array<{ preview: string }>;
    stdout: string;
  };
  prompt: string;
  role: 'child' | 'root';
  transcript: Array<{
    executions: Array<{
      finalAnswer?: string | null;
      resultPreview: string;
      resultSignals?: Array<{ preview: string }>;
      stdout: string;
    }>;
  }>;
}): WeakFinalizationSummary | null {
  void input;
  return null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }

  const error = new Error('RLM execution was aborted.');
  error.name = 'AbortError';
  throw error;
}

function shouldRunEvaluator(
  evaluator: RLMEvaluatorOptions | undefined,
): evaluator is RLMEvaluatorOptions {
  return evaluator?.enabled !== false && evaluator?.model.trim().length !== 0;
}

function clipEvaluatorFeedback(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars)).trimEnd()}...`;
}

function buildEvaluatorSystemPrompt(maxFeedbackChars: number): string {
  return [
    '당신은 완료된 RLM 한 단계만 읽는 읽기 전용 평가자입니다.',
    '작업을 직접 해결하지 마십시오.',
    'repl 코드, JSON 래퍼, markdown fence를 출력하지 마십시오.',
    '간결한 평문 피드백만 반환하십시오.',
    '누락된 증거, 파싱 실수, 수상한 0 또는 빈 결과, 너무 이른 최종화, 선택지 매핑 실수에 집중하십시오.',
    `피드백은 ${maxFeedbackChars}자 이내로 유지하십시오.`,
  ].join(' ');
}

function buildEvaluatorObservedValuesText(execution: {
  resultSignals?: Array<{ kind?: string; path?: string; preview: string }>;
}): string {
  const lines = execution.resultSignals
    ?.map((signal) => {
      const path = signal.path ?? '$';
      return `${path} (${signal.kind ?? '알 수 없음'}): ${signal.preview}`;
    })
    .filter((line) => line.trim().length > 0) ?? [];

  return lines.length === 0 ? '(none)' : lines.join('\n');
}

function buildEvaluatorInput(input: {
  assistantText: string;
  executions: Array<{
    code: string;
    finalAnswer: string | null;
    resultPreview: string;
    resultSignals?: Array<{ kind?: string; path?: string; preview: string }>;
    status: 'error' | 'success' | 'timeout';
    stderr: string;
    stdout: string;
  }>;
  prompt: string;
  step: number;
  totalSteps: number;
}): string {
  const executionSections = input.executions.map((execution, index) =>
    [
      `실행 ${index + 1}:`,
      `상태: ${execution.status}`,
      `코드:\n${execution.code}`,
      `표준 출력:\n${execution.stdout.trim().length === 0 ? '(비어 있음)' : execution.stdout.trim()}`,
      `표준 에러:\n${execution.stderr.trim().length === 0 ? '(비어 있음)' : execution.stderr.trim()}`,
      `관찰된 값:\n${buildEvaluatorObservedValuesText(execution)}`,
      `결과: ${execution.resultPreview}`,
      `최종값: ${execution.finalAnswer ?? '(없음)'}`,
    ].join('\n')
  );

  return [
    `작업 프롬프트:\n${input.prompt}`,
    `어시스턴트 텍스트:\n${input.assistantText}`,
    executionSections.join('\n\n'),
  ].join('\n\n');
}

async function generateEvaluatorFeedback(input: {
  assistantText: string;
  depth: number;
  evaluator: RLMEvaluatorOptions | undefined;
  executions: Array<{
    code: string;
    finalAnswer: string | null;
    resultPreview: string;
    resultSignals?: Array<{ preview: string }>;
    status: 'error' | 'success' | 'timeout';
    stderr: string;
    stdout: string;
  }>;
  llm: LLMCaller;
  onComplete: (response: LLMCallerResponse, model: string) => void;
  prompt: string;
  signal?: AbortSignal;
  step: number;
  totalSteps: number;
}): Promise<string | undefined> {
  if (!shouldRunEvaluator(input.evaluator) || input.executions.length === 0) {
    return undefined;
  }

  try {
    const response = await input.llm.complete({
      input: buildEvaluatorInput({
        assistantText: input.assistantText,
        executions: input.executions,
        prompt: input.prompt,
        step: input.step,
        totalSteps: input.totalSteps,
      }),
      kind: 'plain_query',
      metadata: {
        depth: input.depth,
        step: input.step,
      },
      model: input.evaluator.model,
      signal: input.signal,
      systemPrompt: buildEvaluatorSystemPrompt(input.evaluator.maxFeedbackChars ?? 240),
    });
    input.onComplete(response, input.evaluator.model);

    const feedback = clipEvaluatorFeedback(
      response.outputText,
      input.evaluator.maxFeedbackChars ?? 240,
    );
    return feedback.length === 0 ? undefined : feedback;
  } catch {
    return undefined;
  }
}

/**
 * Appends one assistant turn entry to the configured logger.
 *
 * @param logger The logger that owns the current root session.
 * @param entry The assistant turn summary to append.
 */
async function appendAssistantTurnEntry(
  logger: RLMLogger,
  entry: AssistantTurnEntry,
): Promise<void> {
  await logger.append(entry);
}

async function appendEvaluatorFeedbackEntry(
  logger: RLMLogger,
  entry: EvaluatorFeedbackEntry,
): Promise<void> {
  await logger.append(entry);
}

/**
 * Appends one nested subquery summary entry to the parent logger.
 *
 * @param logger The parent logger that should receive the summary.
 * @param entry The derived subquery summary entry.
 */
async function appendSubqueryEntry(
  logger: RLMLogger,
  entry: SubqueryEntry,
): Promise<void> {
  await logger.append(entry);
}

/**
 * Builds the reusable client-style library entry point.
 *
 * The resulting client captures long-lived dependencies once and exposes
 * a small `run(...)` method for task-specific inputs.
 *
 * @param options The shared caller, model, logger, backend, and default limits.
 * @returns A stable library client that can execute many RLM runs over time.
 *
 * @example
 * ```ts
 * const client = createRLM({
 *   llm,
 *   models: { root: 'gpt-5-nano', sub: 'gpt-5-mini' },
 * });
 *
 * const result = await client.run({
 *   context: { document: 'Chapter 1\\nThe answer is 42.' },
 *   prompt: 'Extract the answer.',
 * });
 * ```
 */
export function createRLM(options: RLMClientOptions): RLMClient {
  const defaults: RLMDefaults = {
    cellTimeoutMs: options.defaults?.cellTimeoutMs,
    maxSteps: options.defaults?.maxSteps ?? DEFAULT_MAX_STEPS,
    maxSubcallDepth: options.defaults?.maxSubcallDepth ?? DEFAULT_MAX_SUBCALL_DEPTH,
    outputCharLimit: options.defaults?.outputCharLimit ?? DEFAULT_OUTPUT_CHAR_LIMIT,
  };

  return {
    run: async (input: RLMRunInput) =>
      await runRLM({
        adapter: options.adapter,
        cellTimeoutMs: input.cellTimeoutMs ?? defaults.cellTimeoutMs,
        clock: options.clock,
        context: input.context,
        evaluator: options.evaluator,
        executionBackend: options.executionBackend,
        idGenerator: options.idGenerator,
        llm: options.llm,
        logger: options.logger,
        maxSteps: resolveRunLimit(input.maxSteps, defaults.maxSteps!),
        maxSubcallDepth: resolveRunLimit(input.maxSubcallDepth, defaults.maxSubcallDepth!),
        outputCharLimit: resolveRunLimit(input.outputCharLimit, defaults.outputCharLimit!),
        prompt: input.prompt,
        rootModel: options.models.root,
        subModel: options.models.sub,
        systemPromptMarkdown: input.systemPromptMarkdown ?? options.systemPromptMarkdown,
        systemPromptExtension: input.systemPromptExtension,
      }),
  };
}

/**
 * Executes one RLM loop, including nested `llm_query(...)` runs.
 *
 * This is the low-level one-shot helper that powers `createRLM(...).run(...)`.
 *
 * @param options One-shot execution inputs, models, limits, and optional persistence hooks.
 * @returns The final answer and resulting REPL session.
 *
 * @example
 * ```ts
 * const result = await runRLM({
 *   llm,
 *   context: { document: 'Chapter 1\\nThe answer is 42.' },
 *   prompt: 'Extract the answer.',
 *   rootModel: 'gpt-5-nano',
 *   subModel: 'gpt-5-mini',
 * });
 * ```
 */
export async function runRLM(options: RLMRunOptions): Promise<RLMRunResult> {
  return await runRLMInternal({
    ...options,
    depth: options.depth ?? 0,
    executionBackend: options.executionBackend ?? createDefaultExecutionBackend(),
    logger: resolveRLMLogger({
      journalPath: options.journalPath,
      logger: options.logger,
    }),
    maxSteps: resolveRunLimit(options.maxSteps, DEFAULT_MAX_STEPS),
    maxSubcallDepth: resolveRunLimit(options.maxSubcallDepth, DEFAULT_MAX_SUBCALL_DEPTH),
    outputCharLimit: resolveRunLimit(options.outputCharLimit, DEFAULT_OUTPUT_CHAR_LIMIT),
  });
}

/**
 * Executes one loop instance with explicit depth so subqueries can recurse safely.
 *
 * This function owns the actual controller loop:
 * request a completion, extract `repl` blocks, execute them, append transcript
 * feedback, and finish when either `FINAL(...)` or `FINAL_VAR(...)` is reached.
 *
 * @param options A fully resolved internal run configuration with concrete defaults.
 * @returns The final answer and resulting REPL session for this loop instance.
 */
async function runRLMInternal(options: InternalRLMRunOptions): Promise<RLMRunResult> {
  throwIfAborted(options.signal);
  const llm = resolveRLMCaller(options.llm, options.adapter);
  const clock = options.clock ?? (() => new Date());
  const transcript: Parameters<typeof buildRLMTurnInput>[0]['transcript'] = [];
  const role = resolveControllerRole(options.depth);
  const baseSystemPrompt = await buildRLMSystemPrompt({
    markdown: options.systemPromptMarkdown,
    maxSteps: options.maxSteps,
    role,
  });
  const systemPrompt = options.systemPromptExtension === undefined ||
      options.systemPromptExtension.trim().length === 0
    ? baseSystemPrompt
    : `${baseSystemPrompt}\n\n${options.systemPromptExtension.trim()}`;
  const usageSummary = createUsageSummary();

  const session = await ReplSession.open({
    clock,
    context: options.context,
    defaultTimeoutMs: options.cellTimeoutMs,
    executionBackend: options.executionBackend,
    idGenerator: options.idGenerator,
    logger: options.logger,
    llmQueryHandler: createLLMQueryHandler({
      currentDepth: options.depth,
      llm,
      onComplete: ({ usage }) => {
        recordUsage(usageSummary, options.subModel, usage);
      },
      subModel: options.subModel,
    }),
    rlmQueryHandler: createRLMQueryHandler({
      createChildLogger: (depth, queryIndex) =>
        createSubqueryLogger(options.logger, depth, queryIndex),
      currentDepth: options.depth,
      maxSteps: options.maxSteps,
      maxSubcallDepth: options.maxSubcallDepth,
      outputCharLimit: options.outputCharLimit,
      runNestedRLM: async (request) => {
        const nested = await runRLMInternal({
          ...options,
          context: request.context,
          depth: request.depth,
          logger: request.logger,
          prompt: request.prompt,
          rootModel: request.rootModel,
          signal: request.signal,
          subModel: request.subModel,
        });
        try {
          mergeUsageSummaries(usageSummary, nested.usage);
          const nestedStdout = readLatestAcceptedFinalStdout(nested.session.history);

          await appendSubqueryEntry(options.logger, {
            answer: resolveSubqueryAnswerValue(nested),
            createdAt: clock().toISOString(),
            depth: request.depth,
            journalPath: getLoggerJournalPath(request.logger),
            model: request.rootModel,
            prompt: request.prompt,
            steps: nested.steps,
            type: 'subquery',
          });

          return {
            answer: nested.answer,
            steps: nested.steps,
            stdout: nestedStdout,
            usage: nested.usage,
            value: nested.finalValue,
          };
        } finally {
          await nested.session.close();
        }
      },
      subModel: options.subModel,
    }),
  });
  let turnState: unknown = undefined;

  for (let index = 0; index < options.maxSteps; index += 1) {
    throwIfAborted(options.signal);
    const step = index + 1;
    const baseInput = buildRLMTurnInput({
      context: options.context,
      currentStep: step,
      outputCharLimit: options.outputCharLimit,
      prompt: options.prompt,
      role,
      totalSteps: options.maxSteps,
      transcript,
    });
    let completion: LLMCallerResponse | null = null;
    let codeBlocks: ReplCodeBlock[] = [];
    let finalSignal: FinalSignal | null = null;
    let appendedTranscriptTurn = false;

    completion = await llm.complete({
      input: baseInput,
      kind: role === 'root' ? 'root_turn' : 'child_turn',
      metadata: {
        depth: options.depth,
        step,
      },
      model: options.rootModel,
      signal: options.signal,
      systemPrompt,
      turnState,
    });
    throwIfAborted(options.signal);
    recordUsage(usageSummary, options.rootModel, completion.usage);
    turnState = completion.turnState;

    await appendAssistantTurnEntry(options.logger, {
      assistantText: completion.outputText,
      createdAt: clock().toISOString(),
      model: options.rootModel,
      step,
      type: 'assistant_turn',
    });

    codeBlocks = extractReplCodeBlocks(completion.outputText);
    if (codeBlocks.length === 0) {
      finalSignal = extractFinalSignal(completion.outputText);
      if (finalSignal !== null && shouldAcceptExplicitFinalSignalValue(finalSignal.value)) {
        return {
          answer: finalSignal.value,
          finalValue: finalSignal.value,
          session,
          steps: step,
          usage: cloneUsageSummary(usageSummary),
        };
      }
    }

    if (completion === null || codeBlocks.length === 0) {
      throw new RLMProtocolError(
        'Assistant turn did not contain a ```repl``` block or an explicit FINAL signal.',
      );
    }

    const executions = [];
    for (const block of codeBlocks) {
      throwIfAborted(options.signal);
      const execution = await session.execute(block.code);
      executions.push({
        code: block.code,
        finalAnswer: execution.finalAnswer,
        resultPreview: execution.result.preview,
        resultSignals: execution.result.signals,
        status: execution.status,
        stderr: execution.stderr,
        stdout: execution.stdout,
      });

      if (execution.finalAnswer !== null) {
        if (
          !shouldAcceptExecutionFinalAnswer(
            execution.status,
            execution.finalAnswer,
            execution.finalResult,
          )
        ) {
          continue;
        }

        const weakFinalization = summarizeWeakFinalization({
          context: options.context,
          execution: {
            code: block.code,
            finalAnswer: execution.finalAnswer,
            resultPreview: execution.result.preview,
            resultSignals: execution.result.signals,
            stdout: execution.stdout,
          },
          prompt: options.prompt,
          role,
          transcript,
        });

        if (weakFinalization !== null) {
          const evaluatorFeedback = await generateEvaluatorFeedback({
            assistantText: completion.outputText,
            depth: options.depth,
            evaluator: options.evaluator,
            executions,
            llm,
            onComplete: (response, model) => {
              recordUsage(usageSummary, model, response.usage);
            },
            prompt: options.prompt,
            signal: options.signal,
            step,
            totalSteps: options.maxSteps,
          });
          if (evaluatorFeedback !== undefined && shouldRunEvaluator(options.evaluator)) {
            await appendEvaluatorFeedbackEntry(options.logger, {
              createdAt: clock().toISOString(),
              feedback: evaluatorFeedback,
              model: options.evaluator.model,
              step,
              type: 'evaluator_feedback',
            });
          }

          transcript.push({
            assistantText: completion.outputText,
            evaluatorFeedback,
            executions,
            step,
          });
          appendedTranscriptTurn = true;
          break;
        }

        return {
          answer: execution.finalAnswer,
          finalValue: extractFinalJsonValue(execution.finalResult),
          session,
          steps: step,
          usage: cloneUsageSummary(usageSummary),
        };
      }

    }

    if (!appendedTranscriptTurn) {
      const evaluatorFeedback = await generateEvaluatorFeedback({
        assistantText: completion.outputText,
        depth: options.depth,
        evaluator: options.evaluator,
        executions,
        llm,
        onComplete: (response, model) => {
          recordUsage(usageSummary, model, response.usage);
        },
        prompt: options.prompt,
        signal: options.signal,
        step,
        totalSteps: options.maxSteps,
      });
      if (evaluatorFeedback !== undefined && shouldRunEvaluator(options.evaluator)) {
        await appendEvaluatorFeedbackEntry(options.logger, {
          createdAt: clock().toISOString(),
          feedback: evaluatorFeedback,
          model: options.evaluator.model,
          step,
          type: 'evaluator_feedback',
        });
      }

      transcript.push({
        assistantText: completion.outputText,
        evaluatorFeedback,
        executions,
        step,
      });
    }
  }

  throw new RLMMaxStepsError(options.maxSteps);
}

export const __rlmRunnerTestables = {
  buildEvaluatorInput,
  collectRequestedEntityLabels,
  extractFinalJsonValue,
  extractTargetCandidatesFromEvidence,
  hasSelectedOptionEvidence,
  isLikelyMultipleChoiceAnswer,
  isLikelyMultipleChoiceTask,
  matchOptionFromEvidence,
  matchOptionFromTranscriptEvidence,
  readLatestAcceptedFinalStdout,
  readAvailableOptions,
  readContextOptions,
  resolveControllerRole,
  resolveRLMCaller,
  resolveRunLimit,
  resolveSubqueryAnswerValue,
  readCompetingTargetCandidates,
  readLatestTranscriptFinalAnswer,
  readTruncatedScalarPrefixFromEvidence,
  summarizeWeakFinalization,
  shouldAcceptExecutionFinalAnswer,
  throwIfAborted,
  hasPositiveSurfacedCandidateEvidence,
  isPlaceholderLikeFinalAnswer,
  usesLiteralFinalChoice,
  usesFirstCandidateFinalWithoutUniquenessGuard,
  usesMergedWorkingSetProjectionWithoutUniquenessGuard,
};
