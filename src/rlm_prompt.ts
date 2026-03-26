import type { JsonValue, ValueSignal } from './types.ts';

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
  outputCharLimit: number;
  prompt: string;
  role?: RLMControllerRole;
  transcript: RLMTranscriptTurn[];
}

/**
 * Describes the fixed controller mode used to build one system prompt.
 *
 * @example
 * ```ts
 * const options: BuildRLMSystemPromptOptions = { role: 'child' };
 * ```
 */
export interface BuildRLMSystemPromptOptions {
  role?: RLMControllerRole;
}

function hasDelegatedTask(
  context: JsonValue | null,
): context is { payload?: JsonValue; task: string; type?: JsonValue } {
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

function formatExecutionSignals(signals: ValueSignal[] | undefined): string | null {
  if (signals === undefined || signals.length === 0) {
    return null;
  }

  return signals
    .map((signal) => `- ${signal.path} (${signal.kind}): ${clipInlineText(signal.preview, 240)}`)
    .join('\n');
}

function slicePreviewTokens(text: string, tokenLimit: number, fromEnd = false): string {
  const tokens = text.trim().split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return '(empty)';
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
      return `${label}: array (${value.length} items)`;
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

    const summary = `${label}: array (${value.length} items; sample keys: ${
      sampleKeys.join(', ') || '(none)'
    })`;
    if (varyingBooleanFields.length === 0) {
      return summary;
    }

    return `${summary}; varying boolean fields: ${varyingBooleanFields.join(', ')}`;
  }

  const keys = Object.keys(value);
  const objectValues = Object.values(value).filter((entry) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
  ) as Array<Record<string, JsonValue>>;

  if (objectValues.length === 0) {
    return `${label}: object (${keys.length} keys: ${keys.slice(0, 8).join(', ') || '(none)'})`;
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

  return `${label}: object (${keys.length} keys: ${
    keys.slice(0, 8).join(', ')
  }; sample value keys: ${sampleValueKeys.join(', ') || '(none)'})`;
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
    return `- context: array (${context.length} items)`;
  }

  const lines = ['- context: object'];
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
    lines.push(`- context head preview (~500 tokens): ${slicePreviewTokens(context, 500)}`);
    lines.push(`- context tail preview (~120 tokens): ${slicePreviewTokens(context, 120, true)}`);
    return lines.join('\n');
  }

  if (typeof context !== 'object' || Array.isArray(context)) {
    return null;
  }

  for (const [key, value] of Object.entries(context)) {
    if (typeof value !== 'string' || !isLargeContextValue(value)) {
      continue;
    }

    lines.push(`- ${key} head preview (~500 tokens): ${slicePreviewTokens(value, 500)}`);
    lines.push(`- ${key} tail preview (~120 tokens): ${slicePreviewTokens(value, 120, true)}`);

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

function requiresExecutionRecovery(transcript: RLMTranscriptTurn[]): boolean {
  return transcript.some((turn) =>
    turn.executions.some((execution) =>
      execution.status === 'error' ||
      execution.status === 'timeout' ||
      execution.finalAnswer === 'undefined'
    )
  );
}

type FailureKind = 'contract' | 'other' | 'syntax' | 'type';

interface RepeatedFailureSummary {
  count: number;
  kind: FailureKind;
  signature: string;
}

function normalizeExecutionFailure(execution: RLMExecutionFeedback): string | null {
  if (execution.status === 'success') {
    return null;
  }

  const source = execution.stderr.trim().length > 0
    ? execution.stderr
    : execution.status === 'timeout'
    ? 'TimeoutError: Execution timed out'
    : '';
  if (source.length === 0) {
    return null;
  }

  return source.split('\n')[0].trim();
}

function classifyFailureKind(signature: string): FailureKind {
  if (
    signature.startsWith('RLMSubqueryContractError:') ||
    signature.includes('contract mismatch')
  ) {
    return 'contract';
  }

  if (signature.startsWith('SyntaxError:')) {
    return 'syntax';
  }

  if (signature.startsWith('TypeError:')) {
    return 'type';
  }

  return 'other';
}

function summarizeRepeatedFailure(transcript: RLMTranscriptTurn[]): RepeatedFailureSummary | null {
  const failures = transcript
    .flatMap((turn) => turn.executions)
    .map((execution) => normalizeExecutionFailure(execution))
    .filter((signature): signature is string => signature !== null);
  if (failures.length < 1) {
    return null;
  }

  const lastSignature = failures[failures.length - 1];
  return {
    count: failures.filter((signature) => signature === lastSignature).length,
    kind: classifyFailureKind(lastSignature),
    signature: lastSignature,
  };
}

function buildStrategyShiftGuidance(summary: RepeatedFailureSummary): string {
  const lines = [
    'Strategy shift is active.',
    `Repeated failure: ${summary.signature}`,
    'Use one self-contained block for the next attempt.',
    "Move directly toward the user query's return format.",
  ];

  if (summary.kind === 'contract') {
    lines.push(
      'Rewrite the delegated task with a concrete expect contract and keep only the rows or excerpts that still satisfy the full selection rule.',
    );
  } else if (summary.kind === 'type') {
    lines.push('Define and use helper logic in that same block, or inline the logic directly.');
  } else if (summary.kind === 'syntax') {
    lines.push('Use a smaller valid block, run it, then extend it only after it succeeds.');
  } else {
    lines.push('Change the execution shape instead of repeating the same block pattern.');
  }

  return lines.join(' ');
}

/**
 * Builds the fixed system prompt that teaches the model how to use the REPL.
 *
 * @example
 * ```ts
 * const rootPrompt = buildRLMSystemPrompt();
 * const childPrompt = buildRLMSystemPrompt({ role: 'child' });
 * ```
 */
export function buildRLMSystemPrompt(options: BuildRLMSystemPromptOptions = {}): string {
  const role = options.role ?? 'root';
  const commonLines = [
    'You work through a persistent JavaScript/TypeScript REPL rather than answering from prose alone.',
    'The REPL language is JavaScript/TypeScript with top-level await.',
    'Keep the user query as the success condition for every step and for the final answer.',
    'REPL interface: `context`, `history`, `FINAL(value)`, `FINAL_VAR(value)`, `llm_query(prompt)`, `rlm_query(prompt)`, `normalizeTarget(value)`, `findAnchoredValue(text, prefix, suffix)`, and `console.log(...)`.',
    'Every assistant response should contain at least one fenced ```repl block until the answer is verified.',
    'Read the external task from `context` and inspect it in code.',
    '`context` and `history` are read-only inputs.',
    '`normalizeTarget(value)` returns a clean lookup string, returns `""` when a non-null input does not resolve to one, and returns `null` only for nullish input.',
    '`findAnchoredValue(text, prefix, suffix)` returns the substring between exact anchors, returns `""` when a non-null search misses, and returns `null` only for nullish input.',
    'Treat the reserved bindings as fixed interfaces and store derived state in ordinary top-level variables when you want persistence across blocks.',
    'Every executable step must be emitted inside fenced ```repl code blocks.',
    'Start each assistant turn with at least one ```repl block that advances the task.',
    'If you need to orient yourself, begin with a small inspection ```repl block rather than silence.',
    'Within one assistant turn, blocks run sequentially in the same persistent session. If one block fails, later blocks from that same assistant turn are skipped.',
    'When the answer is verified, call `FINAL(...)` or `FINAL_VAR(...)` with the final value inside a repl block.',
    'Finish with a concrete verified value.',
    'If a repl execution fails or times out, inspect `stderr`, repair the code, and continue with another repl block.',
    'Emit compact scalar diagnostics with `console.log(...)` or leave a compact trailing expression as the cell result.',
    'Later turns will receive structured result signals from previous executions. Use those exact signals before repeating the same extraction path.',
    'Use the provided REPL surface directly rather than imports, filesystem access, or network access.',
    'When exact prefix and suffix anchors exist, prefer the built-in helpers directly over broad regex or whole-document scans.',
    'Prefer concise code blocks and short prose only when it helps the next step.',
    'When more work is needed, continue with a repl block.',
  ];

  if (role === 'child') {
    return [
      'You are a focused child controller in a Recursive Language Model loop.',
      'You are solving one narrow delegated task from the parent controller.',
      '`context` may be a plain string or a delegated payload object.',
      'If `context.task` is present, `context.task` is the authoritative delegated task.',
      'If `context.payload` is present, `context.payload` is the complete delegated evidence.',
      'If `context.expect` is present, `context.expect` is a runtime-checked return contract.',
      'If `context.selectionHints.positiveSelectors` is present, treat those source field names as decisive positive selectors while choosing a single matching row.',
      'Return the smallest JavaScript value that satisfies the delegated task or `context.expect`.',
      'Use deterministic parsing, filtering, indexing, and aggregation in code whenever the answer can be extracted exactly.',
      'This child run is terminal for recursion.',
      'When needed, use `llm_query` only if plain model help is necessary for the delegated task.',
      ...commonLines,
    ].join('\n');
  }

  return [
    'You are the root controller in a Recursive Language Model loop.',
    'Focus each step on delivering the exact answer requested by the user query.',
    'The root REPL also exposes `await llm_query(prompt)` and `await rlm_query(prompt)`.',
    '`llm_query(prompt)` performs a plain language-model subcall on the sub-model without creating a new REPL.',
    '`rlm_query(prompt)` launches a focused child RLM with its own REPL over delegated child `context`.',
    'Define or refine a `query_contract` variable in code before broad search.',
    'Prefer direct structured filtering, indexing, and aggregation in root when the data is already explicit and small.',
    'Delegate only narrowed subproblems.',
    'Call `rlm_query` either with a task string or with `{ task, payload, expect }`.',
    'The object form is preferred when the delegated evidence is structured.',
    'Put concrete rows, records, or excerpts into `payload` so the child receives the actual narrowed evidence.',
    'When multiple narrowed candidates still share the main identifier, keep the distinguishing fields in the payload or delegated task.',
    'Preserve the source field names that carry the selection rule when you narrow rows or build delegated payloads.',
    'If narrowed rows still differ on positive selector fields such as active, current, enabled, or primaryDispatch, carry those exact field names and desired truth values into the delegated task.',
    'Keep `expect` concrete and singular when you need a runtime-checked return shape.',
    'Prefer the smallest named value that directly powers the next step: use field-specific scalar expects such as `"vaultKey"` or `"index"` for lookup keys, use generic scalar expects like `"string"` or `"number"` only when no field name exists, and use object expects only when the named fields themselves are needed in root.',
    'When narrowed records already contain the requested answer field, read that existing field instead of inventing a new field name.',
    'Treat child returns as validated JavaScript values or delegated evidence.',
    'Inspect the child return in code before FINAL or the next delegation.',
    'After a dependent lookup returns a record or object, continue to the requested scalar field before FINAL.',
    'When the query asks for digits, code, id, label, or another scalar, finish with that scalar value rather than the enclosing record.',
    'If a child return is insufficient, issue a narrower delegated task instead of reopening the whole search in root.',
    'Keep `rlm_query` calls sequential.',
    ...commonLines,
  ].join('\n');
}

/**
 * Builds the next user-visible turn input from the task prompt and prior execution history.
 *
 * @example
 * ```ts
 * const input = buildRLMTurnInput({
 *   context: { document: 'Chapter 1\\nThe answer is 42.' },
 *   outputCharLimit: 4_000,
 *   prompt: 'Extract the answer.',
 *   transcript: [],
 * });
 * ```
 */
export function buildRLMTurnInput(options: BuildRLMTurnInputOptions): string {
  const role = options.role ?? 'root';
  const largeContextMode = isLargeContext(options.context);
  const recoveryMode = requiresExecutionRecovery(options.transcript);
  const repeatedFailure = summarizeRepeatedFailure(options.transcript);
  const taskText = role === 'child' && hasDelegatedTask(options.context)
    ? options.context.task
    : options.prompt;
  const sections = [
    `Task:\n${taskText}`,
  ];

  if (role === 'root') {
    sections.push(
      `Task summary:\n- ${summarizeString('prompt', options.prompt)}`,
      [
        'Root checklist:',
        '- define or refine a `query_contract` variable in code before broad search.',
        '- turn that contract into a concrete code plan before broad search.',
        '- if `context` includes a question-like field such as `question`, `query`, `prompt`, or `retrievalQuestion`, read that field first and extract the target entity in code before broad scanning.',
        '- solve direct structured filtering, indexing, and aggregation in root before delegating.',
        '- prefer `rlm_query({ task, payload, expect })` once the evidence is narrowed.',
        '- keep distinguishing fields in the payload or delegated task when multiple narrowed candidates still share the main identifier.',
        '- preserve the actual source field names used by the selection rule instead of inventing aliases while narrowing rows.',
        '- if narrowed rows still differ on positive selector fields such as `active`, `current`, `enabled`, or `primaryDispatch`, copy those exact fields and desired truth values into the delegated task.',
        '- if the next step is a dependent lookup by a named key or index field, prefer a field-specific scalar `expect` such as `"vaultKey"` or `"index"`.',
        '- when a narrowed record already exposes the requested scalar field, read that existing field name directly.',
        '- when exact prefix and suffix anchors exist, prefer `findAnchoredValue(...)` before broad regex or whole-document scans.',
        '- for repeated text templates, build a target-specific anchor or filter in code before you scan all matches.',
        '- after a dependent lookup returns a record, continue to the requested scalar field before FINAL.',
        '- treat child returns as validated JavaScript values or delegated evidence and inspect them in code before FINAL or the next delegation.',
      ].join('\n'),
    );
  }

  sections.push(
    'REPL interface reminder: use JavaScript/TypeScript with top-level await inside ```repl blocks. `context` and `history` are read-only inputs, `normalizeTarget(value)` returns a clean string target, `""` when a non-null input stays unresolved, and `null` only for nullish input, and `findAnchoredValue(text, prefix, suffix)` returns the substring between exact anchors, `""` when a non-null search misses, and `null` only for nullish input, so store derived values in top-level variables. Keep the user query as the success condition for each step. If one block fails, later blocks from that same assistant turn are skipped.',
    'The external context is available only through the REPL variable `context`.',
    `Context summary:\n${buildContextSummary(options.context)}`,
  );
  const previews = role === 'root' ? buildContextPreviews(options.context) : null;

  if (previews !== null) {
    sections.push(`Context previews:\n${previews}`);
  }

  if (role === 'root') {
    const questionHints = buildQuestionHints(options.context);
    if (questionHints !== null) {
      sections.push(`Question-like context fields:\n${questionHints}`);
    }
  }

  if (role === 'child') {
    sections.push(
      [
        'Child-mode constraints are active.',
        'This child run is terminal for recursion.',
        'Use the delegated task and excerpt first.',
        'If `context.task` is present, treat it as the delegated task.',
        'If `context.payload` is present, treat it as the narrowed delegated data you must inspect in code.',
        'If `context.payload` is already a structured array or object, inspect that structure directly in code.',
        'If `context.expect` is present, return a JavaScript value that satisfies that runtime-checked contract.',
        'If `context.selectionHints.positiveSelectors` is present, use those source field names as decisive positive selectors when you choose one matching row.',
        'When `context` is a string, treat the text in `context` as the delegated task and evidence itself.',
        'Prefer exact parsing or aggregation in code, and use `llm_query` sparingly.',
      ].join(' '),
    );
  }

  if (largeContextMode) {
    sections.push(
      [
        'Large-context mode is active.',
        'Inspect size and structure before broad search.',
        'Create chunk or candidate boundaries in code before broad reasoning.',
        role === 'root'
          ? 'Narrow by target or candidate subset before reasoning over long text.'
          : 'Stay on the delegated target or candidate subset instead of expanding the search scope.',
        role === 'root'
          ? 'If you delegate, pass a narrowed excerpt or candidate summary.'
          : 'Stay on the narrow excerpt or candidate selected by the parent.',
      ].join(' '),
    );
  }

  if (recoveryMode) {
    sections.push(
      [
        'Execution recovery is active.',
        'Repair the failing code using the recorded stderr and prior outputs.',
        'Finish from a concrete value produced by a successful execution.',
      ].join(' '),
    );
  }

  if (repeatedFailure !== null) {
    sections.push(buildStrategyShiftGuidance(repeatedFailure));
    if (repeatedFailure.kind === 'contract' && role === 'root') {
      sections.push(
        [
          'Delegated contract recovery is active.',
          'Rewrite the next `rlm_query` call with a concrete `expect` contract.',
          'Keep only the evidence that still satisfies the full delegated rule.',
          'If multiple candidates still share the main identifier, carry the remaining distinguishing fields into `payload` or `task` before you delegate again.',
        ].join(' '),
      );
    }
  }

  if (options.transcript.length === 0) {
    sections.push(
      role === 'root'
        ? 'Start by inspecting the REPL state with a ```repl block. If the context is large, first measure or slice the relevant fields and collect candidate evidence. The response should begin with a ```repl block.'
        : 'Start with a ```repl block that checks the provided excerpt, candidate set, or delegated subproblem before returning a final value. The response should begin with a ```repl block.',
    );
    return sections.join('\n\n');
  }

  const transcript = options.transcript.map((turn) => {
    const executions = turn.executions.map((execution, index) =>
      (() => {
        const signalSection = formatExecutionSignals(execution.resultSignals);
        const parts = [
          `Execution ${index + 1}:`,
          `status: ${execution.status}`,
          `code:\n${clipText(execution.code, options.outputCharLimit)}`,
          `stdout:\n${clipText(execution.stdout || '(empty)', options.outputCharLimit)}`,
          `stderr:\n${clipText(execution.stderr || '(empty)', options.outputCharLimit)}`,
          `result: ${clipText(execution.resultPreview, options.outputCharLimit)}`,
          `final: ${execution.finalAnswer ?? '(none)'}`,
        ];

        if (signalSection !== null) {
          parts.splice(parts.length - 1, 0, `signals:\n${signalSection}`);
        }

        return parts.join('\n');
      })()
    ).join('\n\n');

    return [
      `Step ${turn.step}:`,
      `assistant:\n${clipText(turn.assistantText, options.outputCharLimit)}`,
      executions,
    ].join('\n\n');
  }).join('\n\n');

  sections.push(`Previous execution transcript:\n${transcript}`);
  sections.push(
    'Continue with the next ```repl block. If one of the previous executions already exposed the exact requested value, finalize now. Otherwise, emit compact scalar diagnostics with console.log or a trailing expression. If the last attempt produced zero matches, the wrong return shape, or `undefined`, change strategy instead of repeating the same path. When a child return is incomplete, build the next narrower delegated task from that returned value.',
  );
  return sections.join('\n\n');
}

export const __rlmPromptTestables = {
  buildContextPreviews,
  buildContextSummary,
  buildQuestionHints,
  buildStrategyShiftGuidance,
  classifyFailureKind,
  clipInlineText,
  clipText,
  formatExecutionSignals,
  isLargeContext,
  isLargeContextValue,
  normalizeExecutionFailure,
  requiresExecutionRecovery,
  slicePreviewTokens,
  summarizeRepeatedFailure,
  summarizeString,
  summarizeTopLevelValue,
};
