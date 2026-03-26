import { isAbsolute, join, resolve } from 'node:path';

import { loadRLMConfig } from '../env.ts';
import { JsonlFileLogger } from '../logger.ts';
import { OpenAIResponsesAdapter } from '../openai_adapter.ts';
import { runOpenAIRLM } from '../rlm_runner.ts';
import type { RunOpenAIRLMOptions } from '../rlm_runner.ts';
import type {
  AssistantTurnEntry,
  CellEntry,
  JournalEntry,
  JsonValue,
  RLMLogger,
  SessionEntry,
  SubqueryEntry,
} from '../types.ts';

/**
 * Captures the required command-line arguments for the standalone runner.
 *
 * @example
 * ```ts
 * const args: ParsedStandaloneCLIArgs = {
 *   inputPath: './book.txt',
 *   query: 'Summarize the chapter.',
 *   systemPromptPath: './prompts/answer.txt',
 * };
 * ```
 */
export interface ParsedStandaloneCLIArgs {
  inputPath: string;
  logPath?: string;
  query: string;
  systemPromptPath: string;
}

/**
 * Describes the absolute paths and derived defaults used by one CLI run.
 *
 * @example
 * ```ts
 * const resolved: ResolvedStandaloneCLIOptions = {
 *   inputPath: '/workspace/book.txt',
 *   logPath: '/workspace/logs/standalone/run.jsonl',
 *   query: 'Summarize the chapter.',
 *   systemPromptPath: '/workspace/prompts/answer.txt',
 * };
 * ```
 */
export interface ResolvedStandaloneCLIOptions {
  inputPath: string;
  logPath: string;
  query: string;
  systemPromptPath: string;
}

/**
 * Describes the dependencies used by the standalone CLI for testability.
 *
 * @example
 * ```ts
 * const deps: StandaloneCLIDependencies = {
 *   clock: () => new Date('2026-03-26T00:00:00.000Z'),
 *   writeLine: console.log,
 * };
 * ```
 */
export interface StandaloneCLIDependencies {
  adapter?: {
    complete(request: {
      input: string;
      model: string;
      systemPrompt: string;
    }): Promise<{ outputText: string }>;
  };
  clock?: () => Date;
  cwd?: string;
  readTextFile?: typeof Deno.readTextFile;
  render?: (input: StandaloneFinalRenderInput) => Promise<string>;
  rootModel?: string;
  run?: (options: RunOpenAIRLMOptions) => Promise<{
    answer: string;
    finalValue?: JsonValue | null;
    session?: {
      close?(): Promise<void> | void;
    };
  }>;
  writeLine?: (line: string) => void;
}

/**
 * Describes the verified inputs used to render the final user-facing standalone answer.
 *
 * @example
 * ```ts
 * const input: StandaloneFinalRenderInput = {
 *   finalValue: '42',
 *   inputFilePath: '/workspace/book.txt',
 *   query: 'What is the answer?',
 *   rlmAnswer: '42',
 *   systemPrompt: 'Answer in concise Korean.',
 * };
 * ```
 */
export interface StandaloneFinalRenderInput {
  finalValue?: JsonValue | null;
  inputFilePath: string;
  query: string;
  rlmAnswer: string;
  systemPrompt: string;
}

function resolveStandaloneReadTextFile(
  readTextFile: StandaloneCLIDependencies['readTextFile'],
): typeof Deno.readTextFile {
  return readTextFile ?? Deno.readTextFile;
}

function resolveStandaloneRun(
  run: StandaloneCLIDependencies['run'],
): NonNullable<StandaloneCLIDependencies['run']> {
  return run ?? runOpenAIRLM;
}

function resolveStandaloneWriteLine(
  writeLine: StandaloneCLIDependencies['writeLine'],
): NonNullable<StandaloneCLIDependencies['writeLine']> {
  return writeLine ?? ((line: string) => console.log(line));
}

function resolveStandaloneRender(
  dependencies: StandaloneCLIDependencies,
): NonNullable<StandaloneCLIDependencies['render']> {
  return dependencies.render ??
    (async (input: StandaloneFinalRenderInput) =>
      await renderStandaloneFinalAnswer(input, {
        adapter: dependencies.adapter,
        rootModel: dependencies.rootModel,
      }));
}

async function closeStandaloneBaseLogger(baseLogger: RLMLogger): Promise<void> {
  if (baseLogger.close === undefined) {
    return;
  }

  await baseLogger.close();
}

/**
 * Formats one UTC timestamp into the standalone journal naming convention.
 */
function formatStandaloneTimestamp(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}-${milliseconds}`;
}

/**
 * Converts a possibly-relative path into an absolute path anchored at the chosen cwd.
 */
function resolveStandalonePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * Narrows an arbitrary journal entry to a session header entry.
 */
function isSessionEntry(entry: JournalEntry): entry is SessionEntry {
  return entry.type === 'session';
}

/**
 * Narrows an arbitrary journal entry to an assistant turn entry.
 */
function isAssistantTurnEntry(entry: JournalEntry): entry is AssistantTurnEntry {
  return entry.type === 'assistant_turn';
}

/**
 * Narrows an arbitrary journal entry to a cell execution entry.
 */
function isCellEntry(entry: JournalEntry): entry is CellEntry {
  return entry.type === 'cell';
}

/**
 * Narrows an arbitrary journal entry to a subquery summary entry.
 */
function isSubqueryEntry(entry: JournalEntry): entry is SubqueryEntry {
  return entry.type === 'subquery';
}

/**
 * Summarizes one captured final answer so long multiline values do not flood progress output.
 */
function formatStandaloneFinalSuffix(finalAnswer: string | null): string {
  if (finalAnswer === null) {
    return '';
  }

  if (finalAnswer.includes('\n') || finalAnswer.length > 120) {
    return ' final=<captured>';
  }

  return ` final=${finalAnswer}`;
}

/**
 * Parses standalone CLI flags into a typed argument object.
 *
 * Supported flags:
 * - `--input <path>`
 * - `--query <text>`
 * - `--system-prompt <path>`
 * - `--log <path>` (optional)
 *
 * @example
 * ```ts
 * const parsed = parseStandaloneCLIArgs([
 *   '--input',
 *   './book.txt',
 *   '--query',
 *   'Summarize the chapter.',
 *   '--system-prompt',
 *   './prompts/answer.txt',
 * ]);
 * ```
 */
export function parseStandaloneCLIArgs(args: string[]): ParsedStandaloneCLIArgs {
  const values: Partial<ParsedStandaloneCLIArgs> = {};

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];

    if (flag === '--input') {
      if (value === undefined) {
        throw new Error('Missing value for --input.');
      }
      values.inputPath = value;
      index += 1;
      continue;
    }

    if (flag === '--query') {
      if (value === undefined) {
        throw new Error('Missing value for --query.');
      }
      values.query = value;
      index += 1;
      continue;
    }

    if (flag === '--system-prompt') {
      if (value === undefined) {
        throw new Error('Missing value for --system-prompt.');
      }
      values.systemPromptPath = value;
      index += 1;
      continue;
    }

    if (flag === '--log') {
      if (value === undefined) {
        throw new Error('Missing value for --log.');
      }
      values.logPath = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown CLI flag: ${flag}`);
  }

  if (
    values.inputPath === undefined || values.query === undefined ||
    values.systemPromptPath === undefined
  ) {
    throw new Error('Missing required CLI flags: --input, --query, --system-prompt.');
  }

  return values as ParsedStandaloneCLIArgs;
}

/**
 * Builds the default standalone JSONL log path using the provided clock and cwd.
 *
 * @example
 * ```ts
 * const logPath = createStandaloneLogPath({
 *   clock: () => new Date('2026-03-26T11:22:33.456Z'),
 *   cwd: '/workspace/rlm',
 * });
 * ```
 */
export function createStandaloneLogPath(
  options: {
    clock?: () => Date;
    cwd?: string;
  } = {},
): string {
  const clock = options.clock ?? (() => new Date());
  const cwd = options.cwd ?? Deno.cwd();
  return join(cwd, 'logs', 'standalone', `${formatStandaloneTimestamp(clock())}.jsonl`);
}

/**
 * Resolves CLI arguments into absolute filesystem paths and a concrete log path.
 *
 * @example
 * ```ts
 * const resolved = resolveStandaloneCLIOptions(
 *   {
 *     inputPath: './book.txt',
 *     query: 'Summarize the chapter.',
 *     systemPromptPath: './prompts/answer.txt',
 *   },
 *   { cwd: '/workspace/rlm' },
 * );
 * ```
 */
export function resolveStandaloneCLIOptions(
  args: ParsedStandaloneCLIArgs,
  options: {
    clock?: () => Date;
    cwd?: string;
  } = {},
): ResolvedStandaloneCLIOptions {
  const cwd = options.cwd ?? Deno.cwd();
  return {
    inputPath: resolveStandalonePath(args.inputPath, cwd),
    logPath: args.logPath === undefined
      ? createStandaloneLogPath({ clock: options.clock, cwd })
      : resolveStandalonePath(args.logPath, cwd),
    query: args.query,
    systemPromptPath: resolveStandalonePath(args.systemPromptPath, cwd),
  };
}

/**
 * Wraps any logger with user-facing progress lines for standalone execution.
 *
 * @example
 * ```ts
 * const logger = createStandaloneProgressLogger({
 *   baseLogger,
 *   writeLine: console.log,
 * });
 * ```
 */
export function createStandaloneProgressLogger(
  options: {
    baseLogger: RLMLogger;
    writeLine?: (line: string) => void;
  },
): RLMLogger & { path?: string } {
  const writeLine = resolveStandaloneWriteLine(options.writeLine);
  let currentStep = 0;
  const path = 'path' in options.baseLogger
    ? (options.baseLogger as { path?: string }).path
    : undefined;

  return {
    path,
    append: async (entry: JournalEntry) => {
      await options.baseLogger.append(entry);

      if (isSessionEntry(entry)) {
        writeLine('[session] started');
        return;
      }

      if (isAssistantTurnEntry(entry)) {
        currentStep = entry.step;
        writeLine(`[step ${entry.step}] assistant turn`);
        return;
      }

      if (isCellEntry(entry)) {
        const finalSuffix = formatStandaloneFinalSuffix(entry.finalAnswer);
        writeLine(`[step ${currentStep}] cell ${entry.status}${finalSuffix}`);
        return;
      }

      if (isSubqueryEntry(entry)) {
        writeLine(`[step ${currentStep}] subquery depth=${entry.depth} steps=${entry.steps}`);
      }
    },
    close: async () => {
      await closeStandaloneBaseLogger(options.baseLogger);
    },
    load: async () => await options.baseLogger.load?.() ?? { cells: [], session: null },
  };
}

/**
 * Renders the final user-facing standalone answer with the external system prompt file.
 *
 * @example
 * ```ts
 * const answer = await renderStandaloneFinalAnswer({
 *   finalValue: '42',
 *   inputFilePath: '/workspace/book.txt',
 *   query: 'What is the answer?',
 *   rlmAnswer: '42',
 *   systemPrompt: 'Answer in concise Korean.',
 * });
 * ```
 */
export async function renderStandaloneFinalAnswer(
  input: StandaloneFinalRenderInput,
  dependencies: Pick<StandaloneCLIDependencies, 'adapter' | 'rootModel'> = {},
): Promise<string> {
  const adapter = dependencies.adapter ?? new OpenAIResponsesAdapter({
    config: loadRLMConfig().openAI,
  });
  const model = dependencies.rootModel ?? loadRLMConfig().openAI.rootModel;
  const response = await adapter.complete({
    input: [
      'User query:',
      input.query,
      '',
      'Verified RLM answer:',
      input.rlmAnswer,
      '',
      'Structured final value:',
      JSON.stringify(input.finalValue ?? null),
      '',
      'Input file path:',
      input.inputFilePath,
      '',
      'Write the final user-facing answer now.',
    ].join('\n'),
    model,
    systemPrompt: input.systemPrompt,
  });

  return response.outputText.trim();
}

/**
 * Runs the standalone CLI workflow by loading one document, one system prompt file,
 * and one user query into the existing OpenAI-backed core runner.
 *
 * @example
 * ```ts
 * await runStandaloneCLI([
 *   '--input',
 *   './book.txt',
 *   '--query',
 *   'Summarize the chapter.',
 *   '--system-prompt',
 *   './prompts/answer.txt',
 * ]);
 * ```
 */
export async function runStandaloneCLI(
  args: string[],
  dependencies: StandaloneCLIDependencies = {},
): Promise<{ answer: string }> {
  const parsed = parseStandaloneCLIArgs(args);
  const resolved = resolveStandaloneCLIOptions(parsed, {
    clock: dependencies.clock,
    cwd: dependencies.cwd,
  });
  const readTextFile = resolveStandaloneReadTextFile(dependencies.readTextFile);
  const run = resolveStandaloneRun(dependencies.run);
  const render = resolveStandaloneRender(dependencies);
  const writeLine = resolveStandaloneWriteLine(dependencies.writeLine);
  const document = await readTextFile(resolved.inputPath);
  const systemPrompt = await readTextFile(resolved.systemPromptPath);
  const baseLogger = new JsonlFileLogger(resolved.logPath);
  const logger = createStandaloneProgressLogger({
    baseLogger,
    writeLine,
  });
  let resultSession:
    | {
      close?(): Promise<void> | void;
    }
    | undefined;

  writeLine(`[standalone] input: ${resolved.inputPath}`);
  writeLine(`[standalone] system prompt: ${resolved.systemPromptPath}`);
  writeLine(`[standalone] log: ${resolved.logPath}`);

  try {
    const result = await run({
      context: {
        document,
        inputFilePath: resolved.inputPath,
      },
      logger,
      prompt: resolved.query,
    });
    resultSession = result.session;
    const renderedAnswer = await render({
      finalValue: result.finalValue,
      inputFilePath: resolved.inputPath,
      query: resolved.query,
      rlmAnswer: result.answer,
      systemPrompt,
    });

    writeLine(`[final] ${renderedAnswer}`);
    return {
      answer: renderedAnswer,
    };
  } finally {
    await resultSession?.close?.();
    await logger.close?.();
  }
}

export const __standaloneCLITestables = {
  closeStandaloneBaseLogger,
  formatStandaloneFinalSuffix,
  formatStandaloneTimestamp,
  resolveStandaloneReadTextFile,
  resolveStandaloneRender,
  resolveStandaloneRun,
  resolveStandalonePath,
  resolveStandaloneWriteLine,
};
