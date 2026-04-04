/**
 * Prompt-construction helpers for system instructions and iterative RLM turn inputs.
 *
 * @module
 *
 * @example
 * ```ts
 * import { buildRLMSystemPrompt } from './rlm_prompt.ts';
 * ```
 */
import type { JsonValue, ValueSignal } from './types.ts';
import { DEFAULT_RLM_SYSTEM_PROMPT_MARKDOWN } from '../prompts/rlm_system.ts';

type RLMControllerRole = 'child' | 'root';

/**
 * Describes one execution record fed back into the next assistant turn.
 *
 * @example
 * ```ts
 * const feedback: RLMExecutionFeedback = {
 *   code: 'const answer = 42; answer',
 *   finalAnswer: null,
 *   resultPreview: '42',
 *   status: 'success',
 *   stderr: '',
 *   stdout: '',
 * };
 * ```
 */
export interface RLMExecutionFeedback {
  code: string;
  finalAnswer: string | null;
  resultPreview: string;
  resultSignals?: ValueSignal[];
  status: string;
  stderr: string;
  stdout: string;
}

/**
 * Describes one assistant turn and the REPL executions it produced.
 *
 * @example
 * ```ts
 * const turn: RLMTranscriptTurn = {
 *   assistantText: '```repl\\nconst answer = 42;\\n```',
 *   executions: [],
 *   step: 1,
 * };
 * ```
 */
export interface RLMTranscriptTurn {
  assistantText: string;
  evaluatorFeedback?: string;
  executions: RLMExecutionFeedback[];
  step: number;
}

/**
 * Describes the input needed to build the next model-turn prompt.
 *
 * @example
 * ```ts
 * const options: BuildRLMTurnInputOptions = {
 *   context: { document: 'Chapter 1\\nThe answer is 42.' },
 *   outputCharLimit: 4_000,
 *   prompt: 'Extract the answer.',
 *   transcript: [],
 * };
 * ```
 */
export interface BuildRLMTurnInputOptions {
  context: JsonValue | null;
  currentStep?: number;
  outputCharLimit: number;
  prompt: string;
  role?: RLMControllerRole;
  totalSteps?: number;
  transcript: RLMTranscriptTurn[];
}

/**
 * Describes the fixed controller mode used to build one system prompt.
 *
 * @example
 * ```ts
 * const options: BuildRLMSystemPromptOptions = { maxSteps: 12, role: 'child' };
 * ```
 */
export interface BuildRLMSystemPromptOptions {
  markdown?: string;
  maxSteps?: number;
  role?: RLMControllerRole;
  runtimeHelperPromptBlocks?: string[];
}

function hasDelegatedTask(
  context: JsonValue | null,
): context is { expect?: JsonValue; payload?: JsonValue; task: string; type?: JsonValue } {
  return typeof context === 'object' &&
    context !== null &&
    !Array.isArray(context) &&
    typeof context.task === 'string';
}

/**
 * Truncates long feedback so the loop stays compact and predictable.
 */
function clipText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  const clipped = text.slice(0, Math.max(0, limit));
  return `${clipped}\n...[truncated ${text.length - clipped.length} chars]`;
}

function summarizeString(label: string, value: string): string {
  const words = value.trim().length === 0 ? 0 : value.trim().split(/\s+/u).length;
  return `${label}: string (${value.length} chars, ${words} words)`;
}

function clipInlineText(text: string, limit: number): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, limit)).trimEnd()}...`;
}

function formatPromptSections(
  sections: ReadonlyArray<{ lines: ReadonlyArray<string>; title?: string }>,
): string {
  return sections
    .map(({ lines, title }) =>
      title === undefined || title.length === 0 ? lines.join('\n') : `${title}\n${lines.join('\n')}`
    )
    .join('\n\n');
}

function renderMarkdownTemplate(
  template: string,
  replacements: Readonly<Record<string, string>>,
): string {
  return template
    .replace(/\{\{([A-Z0-9_]+)\}\}/gu, (_match, key: string) => replacements[key] ?? '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function buildRuntimeHelperPromptBlocks(blocks: string[] | undefined): string {
  if (blocks === undefined || blocks.length === 0) {
    return '';
  }

  return blocks
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .join('\n\n');
}

function formatPromptTextBlock(text: string): string {
  return `\`\`\`text\n${text}\n\`\`\``;
}

function stringifyPromptValue(value: JsonValue | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? String(value);
}

function formatExecutionSignals(signals: ValueSignal[] | undefined): string | null {
  if (signals === undefined || signals.length === 0) {
    return null;
  }

  return signals
    .map((signal) => `- ${signal.path} (${signal.kind}): ${clipInlineText(signal.preview, 240)}`)
    .join('\n');
}

function buildExecutionFeedbackText(
  step: number,
  executionIndex: number,
  execution: RLMExecutionFeedback,
  outputCharLimit: number,
): string {
  const signals = formatExecutionSignals(execution.resultSignals) ?? '- (없음)';

  return [
    `현재 단계: ${step}`,
    `실행: ${executionIndex}`,
    `상태: ${execution.status}`,
    'REPL 코드:',
    formatPromptTextBlock(clipText(execution.code, outputCharLimit)),
    'REPL 표준 출력:',
    formatPromptTextBlock(clipText(execution.stdout || '(비어 있음)', outputCharLimit)),
    'REPL 표준 에러:',
    formatPromptTextBlock(clipText(execution.stderr || '(비어 있음)', outputCharLimit)),
    'REPL 결과:',
    formatPromptTextBlock(clipText(execution.resultPreview || '(비어 있음)', outputCharLimit)),
    '노출된 값:',
    signals,
    `채택된 최종 답: ${
      execution.finalAnswer === null
        ? '(없음)'
        : clipInlineText(execution.finalAnswer, outputCharLimit)
    }`,
  ].join('\n\n');
}

function slicePreviewTokens(text: string, tokenLimit: number, fromEnd = false): string {
  const tokens = text.trim().split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return '(비어 있음)';
  }

  const preview = fromEnd ? tokens.slice(-tokenLimit) : tokens.slice(0, tokenLimit);
  return clipInlineText(preview.join(' '), 1_800);
}

function summarizeTopLevelValue(label: string, value: JsonValue): string {
  if (value === null) {
    return `${label}: null`;
  }

  if (typeof value === 'string') {
    return summarizeString(label, value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${label}: ${typeof value}`;
  }

  if (Array.isArray(value)) {
    const objectEntries = value.filter((entry) =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ) as Array<Record<string, JsonValue>>;
    if (objectEntries.length === 0) {
      return `${label}: 배열 (${value.length}개 항목)`;
    }

    const sampleKeys: string[] = [];
    const seenKeys = new Set<string>();
    for (const entry of objectEntries.slice(0, 4)) {
      for (const key of Object.keys(entry)) {
        if (seenKeys.has(key)) {
          continue;
        }

        seenKeys.add(key);
        sampleKeys.push(key);
        if (sampleKeys.length >= 8) {
          break;
        }
      }

      if (sampleKeys.length >= 8) {
        break;
      }
    }

    const varyingBooleanFields: string[] = [];
    for (const key of sampleKeys) {
      const values = new Set<string>();
      for (const entry of objectEntries.slice(0, 8)) {
        const nested = entry[key];
        if (typeof nested === 'boolean') {
          values.add(String(nested));
        }
      }

      if (values.size >= 2) {
        varyingBooleanFields.push(key);
      }
    }

    const summary = `${label}: 배열 (${value.length}개 항목; 예시 키: ${
      sampleKeys.join(', ') || '(없음)'
    })`;
    if (varyingBooleanFields.length === 0) {
      return summary;
    }

    return `${summary}; 값이 달라지는 불리언 필드: ${varyingBooleanFields.join(', ')}`;
  }

  const keys = Object.keys(value);
  const objectValues = Object.values(value).filter((entry) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
  ) as Array<Record<string, JsonValue>>;

  if (objectValues.length === 0) {
    return `${label}: 객체 (${keys.length}개 키: ${keys.slice(0, 8).join(', ') || '(없음)'})`;
  }

  const sampleValueKeys: string[] = [];
  const seenValueKeys = new Set<string>();
  for (const entry of objectValues.slice(0, 4)) {
    for (const key of Object.keys(entry)) {
      if (seenValueKeys.has(key)) {
        continue;
      }

      seenValueKeys.add(key);
      sampleValueKeys.push(key);
      if (sampleValueKeys.length >= 8) {
        break;
      }
    }

    if (sampleValueKeys.length >= 8) {
      break;
    }
  }

  return `${label}: 객체 (${keys.length}개 키: ${keys.slice(0, 8).join(', ')}; 예시 값 키: ${
    sampleValueKeys.join(', ') || '(없음)'
  })`;
}

/**
 * Builds a compact prompt-side summary of the external `context` variable.
 */
function buildContextSummary(context: JsonValue | null): string {
  if (context === null) {
    return '- context: null';
  }

  if (typeof context === 'string') {
    return `- ${summarizeString('context', context)}`;
  }

  if (typeof context === 'number' || typeof context === 'boolean') {
    return `- context: ${typeof context}`;
  }

  if (Array.isArray(context)) {
    return `- context: 배열 (${context.length}개 항목)`;
  }

  const lines = ['- context: 객체'];
  const entries = Object.entries(context).slice(0, 12);
  for (const [key, value] of entries) {
    lines.push(`- ${summarizeTopLevelValue(key, value)}`);
  }

  return lines.join('\n');
}

function buildContextPreviews(context: JsonValue | null): string | null {
  const lines: string[] = [];

  if (context === null) {
    return null;
  }

  if (typeof context === 'string' && isLargeContextValue(context)) {
    lines.push(`- context 앞부분 미리보기 (~500 토큰): ${slicePreviewTokens(context, 500)}`);
    lines.push(`- context 뒷부분 미리보기 (~120 토큰): ${slicePreviewTokens(context, 120, true)}`);
    return lines.join('\n');
  }

  if (typeof context !== 'object' || Array.isArray(context)) {
    return null;
  }

  for (const [key, value] of Object.entries(context)) {
    if (typeof value !== 'string' || !isLargeContextValue(value)) {
      continue;
    }

    lines.push(`- ${key} 앞부분 미리보기 (~500 토큰): ${slicePreviewTokens(value, 500)}`);
    lines.push(`- ${key} 뒷부분 미리보기 (~120 토큰): ${slicePreviewTokens(value, 120, true)}`);

    if (lines.length >= 4) {
      break;
    }
  }

  return lines.length === 0 ? null : lines.join('\n');
}

function buildQuestionHints(context: JsonValue | null): string | null {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    return null;
  }

  const lines: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (typeof value !== 'string') {
      continue;
    }

    if (!/(^|_)(prompt|query|question)$/iu.test(key) && key !== 'retrievalQuestion') {
      continue;
    }

    lines.push(`- ${key}: ${clipInlineText(value, 240)}`);
    if (lines.length >= 4) {
      break;
    }
  }

  return lines.length === 0 ? null : lines.join('\n');
}

function isLargeContextValue(value: JsonValue): boolean {
  if (typeof value === 'string') {
    return value.length >= 20_000;
  }

  if (Array.isArray(value)) {
    return value.length >= 2_000;
  }

  return false;
}

function isLargeContext(context: JsonValue | null): boolean {
  if (context === null) {
    return false;
  }

  if (typeof context === 'string' || Array.isArray(context)) {
    return isLargeContextValue(context);
  }

  if (typeof context !== 'object') {
    return false;
  }

  return Object.values(context).some((value) => isLargeContextValue(value));
}

/**
 * Loads the packaged default system prompt markdown used by the runtime.
 */
export async function loadDefaultRLMSystemPromptMarkdown(): Promise<string> {
  return DEFAULT_RLM_SYSTEM_PROMPT_MARKDOWN;
}

/**
 * Builds the fixed system prompt that teaches the model how to use the REPL.
 *
 * @example
 * ```ts
 * const rootPrompt = await buildRLMSystemPrompt();
 * const childPrompt = await buildRLMSystemPrompt({ role: 'child' });
 * ```
 */
export async function buildRLMSystemPrompt(
  options: BuildRLMSystemPromptOptions = {},
): Promise<string> {
  const markdown = options.markdown ?? await loadDefaultRLMSystemPromptMarkdown();
  const maxStepsSentence = options.maxSteps === undefined
    ? ''
    : `사용할 수 있는 최대 단계 예산은 ${options.maxSteps}입니다.`;
  return renderMarkdownTemplate(markdown, {
    MAX_STEPS_SENTENCE: maxStepsSentence,
    RUNTIME_HELPER_PROMPT_BLOCKS: buildRuntimeHelperPromptBlocks(options.runtimeHelperPromptBlocks),
  });
}

/**
 * Builds the next user-visible turn input from the task prompt and prior execution history.
 *
 * @example
 * ```ts
 * const input = buildRLMTurnInput({
 *   context: { document: 'Chapter 1\\nThe answer is 42.' },
 *   currentStep: 1,
 *   outputCharLimit: 4_000,
 *   prompt: 'Extract the answer.',
 *   totalSteps: 6,
 *   transcript: [],
 * });
 * ```
 */
export function buildRLMTurnInput(options: BuildRLMTurnInputOptions): string {
  const role = options.role ?? 'root';
  const delegatedContext = hasDelegatedTask(options.context) ? options.context : null;
  const taskText = delegatedContext?.task ?? options.prompt;
  // delegatedContext가 있으면 이번 turn은 상위 rlm_query가 만든 위임 실행입니다.
  const delegatedPayloadText = delegatedContext === null
    ? null
    : stringifyPromptValue(delegatedContext.payload);
  // delegatedContext가 expect 계약을 포함할 때만 문자열 형태로 노출합니다.
  const delegatedExpectText = delegatedContext === null
    ? null
    : stringifyPromptValue(delegatedContext.expect);
  // // 현재 단계와 총 단계가 모두 주어질 때만 단계 예산을 보여줍니다.
  // if (options.currentStep !== undefined && options.totalSteps !== undefined) {
  //   sections.push(`단계 예산: ${options.currentStep} / ${options.totalSteps}`);
  // }
  const sections = [
    `단계 예산: ${options.currentStep} / ${options.totalSteps}\n\n`,
    `## REPL 목표 :\n${taskText}\n`,
  ];

  // 위임 실행일 때만 payload/expect를 상단에 직접 보여줍니다.
  if (delegatedContext) {
    // payload가 실제로 있을 때만 별도 블록을 추가합니다.
    if (delegatedPayloadText !== null) {
      sections.push(
        `context.payload :\n${
          formatPromptTextBlock(clipText(delegatedPayloadText, options.outputCharLimit))
        }`,
      );
    }

    // expect 계약이 있을 때만 별도 블록을 추가합니다.
    if (delegatedExpectText !== null) {
      sections.push(
        [
          `context.expect :\n${
            formatPromptTextBlock(clipText(delegatedExpectText, options.outputCharLimit))
          }`,
          '이를 통해 그 런타임 실행을 만족하는 JavaScript 값을 반환해야 합니다.',
        ].join(' '),
      );
    }
  }

  // 위임 실행일 때만 payload-first 사용 규칙을 추가합니다.
  if (delegatedContext) {
    sections.push(
      [
        '## 위임된 증거 안내',
        '`context.selectionHints.positiveSelectors`가 있으면, 좁힌 row를 고르거나 넘길 때 그 원본 필드 이름을 유지하십시오.',
        '검색을 넓히기 전에 위임된 payload를 현재 working set으로 사용하십시오.',
      ].join(' '),
    );
  }

  // root turn일 때만 question-like top-level field를 추가로 요약합니다.
  if (role === 'root') {
    const questionHints = buildQuestionHints(options.context);
    // question/prompt/query 계열 필드가 실제로 있을 때만 이 섹션을 추가합니다.
    if (questionHints !== null) {
      sections.push(`질문형 문맥 필드:\n${questionHints}`);
    }
  }
  return sections.join('\n\n');
}

/**
 * Exposes prompt-construction helpers for focused tests.
 */
export const __rlmPromptTestables = {
  buildRuntimeHelperPromptBlocks,
  buildContextPreviews,
  buildContextSummary,
  buildExecutionFeedbackText,
  buildQuestionHints,
  clipInlineText,
  clipText,
  formatExecutionSignals,
  formatPromptSections,
  isLargeContext,
  isLargeContextValue,
  slicePreviewTokens,
  summarizeString,
  summarizeTopLevelValue,
};
