import { loadProviderRequestTimeoutMs, loadRLMConfig, loadRLMRuntimeConfig } from '../env.ts';
import type { LLMCaller } from '../llm_adapter.ts';
import { JsonlFileLogger } from '../logger.ts';
import { OpenAIResponsesProvider } from '../openai_adapter.ts';
import { estimateOpenAIRunCostUsd } from '../openai_pricing.ts';
import {
  importNodeBuiltin,
  joinFilePath,
  type ReadTextFile,
  resolveCurrentWorkingDirectory,
  resolveFilePath,
} from '../platform.ts';
import {
  type CodexOAuthAuthorizationCodeResult,
  type CodexOAuthAuthorizationReceiver,
  type CodexOAuthAuthorizationSession,
  CodexOAuthProvider,
  extractAuthorizationCodeFromCallbackUrl,
} from '../providers/codex_oauth.ts';
import { createOpenAIRLM, runOpenAIRLM } from '../providers/openai.ts';
import type { RunOpenAIRLMOptions } from '../providers/openai.ts';
import { runRLM } from '../rlm_runner.ts';
import type { RLMRunOptions } from '../rlm_runner.ts';
import type {
  AssistantTurnEntry,
  CellEntry,
  JournalEntry,
  JsonValue,
  RLMLogger,
  RLMUsageSummary,
  SessionEntry,
  StandaloneErrorEntry,
  SubqueryEntry,
} from '../types.ts';

/**
 * Identifies which standalone provider bootstrap path should be used.
 */
export type StandaloneProviderName = 'codex-oauth' | 'openai';

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
  cellTimeoutMs?: number;
  inputPath?: string;
  listModels?: boolean;
  login?: boolean;
  logPath?: string;
  provider: StandaloneProviderName;
  query?: string;
  requestTimeoutMs?: number;
  rootModel?: string;
  subModel?: string;
  systemPromptPath?: string;
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
  cellTimeoutMs?: number;
  inputPath?: string;
  listModels?: boolean;
  login?: boolean;
  logPath: string;
  provider: StandaloneProviderName;
  query?: string;
  requestTimeoutMs?: number;
  rootModel?: string;
  subModel?: string;
  systemPromptPath?: string;
}

interface StandaloneRunResult {
  answer: string;
  finalValue?: JsonValue | null;
  session?: {
    close?(): Promise<void> | void;
  };
  usage?: RLMUsageSummary;
}

interface StandaloneCodexOAuthProviderLike {
  createCaller(config?: { requestTimeoutMs?: number }): Pick<LLMCaller, 'complete'>;
  listModels(): Promise<string[]>;
  login(
    options?: {
      force?: boolean;
      onAuthUrl?: (url: string) => void | Promise<void>;
      receiveAuthorizationCode?: CodexOAuthAuthorizationReceiver;
    },
  ): Promise<unknown>;
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
  clock?: () => Date;
  createCodexOAuthProvider?: () => StandaloneCodexOAuthProviderLike;
  cwd?: string;
  /**
   * @deprecated Use `llm`.
   */
  adapter?: Pick<LLMCaller, 'complete'>;
  fetcher?: typeof fetch;
  llm?: Pick<LLMCaller, 'complete'>;
  readLoginLine?: (signal?: AbortSignal) => Promise<string | null>;
  readTextFile?: ReadTextFile;
  receiveLoopbackAuthorizationCode?: (
    session: CodexOAuthAuthorizationSession,
    signal?: AbortSignal,
  ) => Promise<CodexOAuthAuthorizationCodeResult>;
  render?: (input: StandaloneFinalRenderInput) => Promise<string>;
  rootModel?: string;
  run?: (options: RunOpenAIRLMOptions) => Promise<StandaloneRunResult>;
  runGeneric?: (options: RLMRunOptions) => Promise<StandaloneRunResult>;
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
): ReadTextFile {
  const defaultReadTextFile = (globalThis as typeof globalThis & {
    Deno?: {
      readTextFile?: ReadTextFile;
    };
  }).Deno?.readTextFile;

  if (readTextFile !== undefined) {
    return readTextFile;
  }

  if (defaultReadTextFile !== undefined) {
    return defaultReadTextFile;
  }

  throw new Error('No default readTextFile implementation is available in this runtime.');
}

function resolveStandaloneReadLoginLine(
  readLoginLine: StandaloneCLIDependencies['readLoginLine'],
): NonNullable<StandaloneCLIDependencies['readLoginLine']> {
  return readLoginLine ?? readStandaloneLoginLine;
}

async function readStandaloneLoginLine(signal?: AbortSignal): Promise<string | null> {
  const reader = Deno.stdin.readable
    .pipeThrough(new TextDecoderStream())
    .getReader();
  const abortHandler = () => {
    void reader.cancel(new DOMException('Aborted', 'AbortError'));
  };
  signal?.addEventListener('abort', abortHandler, { once: true });

  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const finalValue = buffer.replace(/\r$/u, '');
        return finalValue.length > 0 ? finalValue : null;
      }

      buffer += value;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex >= 0) {
        return buffer.slice(0, newlineIndex).replace(/\r$/u, '');
      }
    }
  } finally {
    signal?.removeEventListener('abort', abortHandler);
    reader.releaseLock();
  }
}

interface LoopbackSocketLike {
  destroy(): void;
  once(event: 'close', listener: () => void): void;
}

interface LoopbackRequestLike {
  headers: {
    host?: string;
  };
  url?: string;
}

interface LoopbackResponseLike {
  end(text?: string, callback?: () => void): void;
  writeHead(statusCode: number, headers: Record<string, string>): void;
}

interface LoopbackServerLike {
  close(callback: () => void): void;
  listen(port: number, hostname: string): void;
  on(event: 'connection', listener: (socket: LoopbackSocketLike) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

type LoopbackServerFactory = (
  handler: (request: LoopbackRequestLike, response: LoopbackResponseLike) => void,
) => LoopbackServerLike;

async function loadNodeLoopbackServerFactory(): Promise<LoopbackServerFactory> {
  const nodeHttp = await importNodeBuiltin<{ createServer: LoopbackServerFactory }>('http');
  return nodeHttp.createServer as LoopbackServerFactory;
}

async function receiveStandaloneLoopbackAuthorizationCode(
  session: CodexOAuthAuthorizationSession,
  signal?: AbortSignal,
  serverFactory?: LoopbackServerFactory,
): Promise<CodexOAuthAuthorizationCodeResult> {
  const resolvedServerFactory = serverFactory ?? await loadNodeLoopbackServerFactory();
  return await new Promise<CodexOAuthAuthorizationCodeResult>((resolve, reject) => {
    let settled = false;
    const sockets = new Set<{
      destroy(): void;
      once(event: 'close', listener: () => void): void;
    }>();

    const finish = (
      action: 'reject' | 'resolve',
      value: CodexOAuthAuthorizationCodeResult | Error | DOMException,
    ) => {
      if (settled) {
        return;
      }

      settled = true;
      signal?.removeEventListener('abort', abortHandler);

      for (const socket of sockets) {
        socket.destroy();
      }

      server.close(() => {
        if (action === 'resolve') {
          resolve(value as CodexOAuthAuthorizationCodeResult);
          return;
        }

        reject(value);
      });
    };

    const server = resolvedServerFactory((request, response) => {
      const fullUrl = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? `127.0.0.1:${session.callbackPort}`}`,
      );
      const callback = extractAuthorizationCodeFromCallbackUrl(fullUrl.toString());

      if (callback === null) {
        response.writeHead(202, {
          'Content-Type': 'text/plain; charset=utf-8',
        });
        response.end(
          'Codex OAuth callback is waiting for the final code and state. Return to the browser login and try again, or paste the full callback URL into the CLI.',
        );
        return;
      }

      response.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end(
        'Codex OAuth login complete. You can close this tab and return to the CLI.',
        () => finish('resolve', callback),
      );
    });

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => {
        sockets.delete(socket);
      });
    });

    const abortHandler = () => {
      finish('reject', new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abortHandler, { once: true });

    server.on('error', (error) => {
      signal?.removeEventListener('abort', abortHandler);
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
    server.listen(session.callbackPort, '127.0.0.1');
  });
}

function createStandaloneCodexOAuthAuthorizationReceiver(
  options: {
    readLoginLine?: StandaloneCLIDependencies['readLoginLine'];
    receiveLoopbackAuthorizationCode?:
      StandaloneCLIDependencies['receiveLoopbackAuthorizationCode'];
    writeLine?: (line: string) => void;
  } = {},
): CodexOAuthAuthorizationReceiver {
  const writeLine = resolveStandaloneWriteLine(options.writeLine);
  const readLoginLine = resolveStandaloneReadLoginLine(options.readLoginLine);
  const receiveLoopbackAuthorizationCode = options.receiveLoopbackAuthorizationCode ??
    receiveStandaloneLoopbackAuthorizationCode;

  return async (session) => {
    writeLine(`[login] waiting for callback: ${session.redirectUri}`);
    writeLine(
      '[login] 브라우저가 자동으로 완료되지 않으면 최종 callback URL 전체를 이 터미널에 붙여넣고 Enter를 누르세요.',
    );

    const controller = new AbortController();
    const readPastedCallback = async (): Promise<CodexOAuthAuthorizationCodeResult> => {
      while (true) {
        const pastedValue = await readLoginLine(controller.signal);
        if (pastedValue === null) {
          throw new DOMException('Aborted', 'AbortError');
        }

        const callback = extractAuthorizationCodeFromCallbackUrl(pastedValue.trim());
        if (callback !== null) {
          return callback;
        }

        writeLine(
          '[login] 붙여넣은 값에 code 와 state 가 없습니다. 브라우저가 연 최종 callback URL 전체를 붙여넣어 주세요.',
        );
      }
    };

    const swallowAbortError = async <T>(promise: Promise<T>): Promise<void> => {
      try {
        await promise;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
      }
    };

    const loopbackPromise = receiveLoopbackAuthorizationCode(session, controller.signal);
    const pastedPromise = readPastedCallback();

    try {
      const result = await Promise.race([loopbackPromise, pastedPromise]);
      controller.abort();
      await Promise.all([
        swallowAbortError(loopbackPromise),
        swallowAbortError(pastedPromise),
      ]);
      return result;
    } finally {
      controller.abort();
    }
  };
}

function resolveStandaloneRun(
  run: StandaloneCLIDependencies['run'],
): NonNullable<StandaloneCLIDependencies['run']> {
  return run ?? runOpenAIRLM;
}

function resolveStandaloneGenericRun(
  run: StandaloneCLIDependencies['runGeneric'],
): NonNullable<StandaloneCLIDependencies['runGeneric']> {
  return run ?? runRLM;
}

function resolveCodexOAuthProvider(
  createProvider: StandaloneCLIDependencies['createCodexOAuthProvider'],
): StandaloneCodexOAuthProviderLike {
  return createProvider?.() ?? new CodexOAuthProvider();
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
        llm: dependencies.llm,
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
  return resolveFilePath(cwd, path);
}

function pickPreferredModel(
  models: string[],
  preferred: string[],
): string | undefined {
  for (const candidate of preferred) {
    if (models.includes(candidate)) {
      return candidate;
    }
  }

  return models[0];
}

function resolveCodexOAuthModels(
  availableModels: string[],
  overrides: {
    rootModel?: string;
    subModel?: string;
  },
): { rootModel: string; subModel: string } {
  const ensureExactModel = (requestedModel: string | undefined): string | undefined => {
    if (requestedModel === undefined) {
      return undefined;
    }

    if (availableModels.includes(requestedModel)) {
      return requestedModel;
    }

    throw new Error(
      [
        `Requested Codex model is unavailable: ${requestedModel}.`,
        'Configure an exact model id from the current profile catalog.',
        `Available models: ${[...availableModels].sort().join(', ')}`,
      ].join(' '),
    );
  };

  const rootModel = ensureExactModel(overrides.rootModel) ??
    pickPreferredModel(
      availableModels,
      ['gpt-5-4-t-mini', 'gpt-5-mini', 'gpt-5-4-thinking', 'gpt-5', 'gpt-5-3'],
    );
  if (rootModel === undefined) {
    throw new Error('Codex OAuth provider did not return any usable models.');
  }

  const subModel = (ensureExactModel(overrides.subModel) ??
    pickPreferredModel(
      availableModels,
      ['gpt-5-3-instant', 'gpt-5-t-mini', rootModel, 'gpt-5-mini', 'gpt-5-2-instant'],
    ))!;

  return {
    rootModel,
    subModel,
  };
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

function isStandaloneErrorEntry(entry: JournalEntry): entry is StandaloneErrorEntry {
  return entry.type === 'standalone_error';
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
 * Combines the provider request timeout with extra REPL cell slack for standalone runs.
 *
 * The CLI treats `--cell-timeout-ms` as additional time beyond the provider request timeout
 * so cells that await one model call do not timeout before the provider request itself.
 *
 * @example
 * ```ts
 * const totalCellTimeoutMs = resolveStandaloneCellTimeoutMs(15_000, 30_000, 5_000);
 * // 45_000
 * ```
 */
function resolveStandaloneCellTimeoutMs(
  additionalTimeoutMs: number | undefined,
  providerRequestTimeoutMs: number,
  defaultAdditionalTimeoutMs: number,
): number {
  return providerRequestTimeoutMs + (additionalTimeoutMs ?? defaultAdditionalTimeoutMs);
}

/**
 * Parses standalone CLI flags into a typed argument object.
 *
 * Supported flags:
 * - `--provider <openai|codex-oauth>` (optional)
 * - `--login` (Codex OAuth only)
 * - `--list-models` (Codex OAuth only)
 * - `--input <path>`
 * - `--query <text>`
 * - `--system-prompt <path>`
 * - `--root-model <model>` (optional)
 * - `--sub-model <model>` (optional)
 * - `--request-timeout-ms <milliseconds>` (optional)
 * - `--cell-timeout-ms <milliseconds>` (optional)
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
  const values: Partial<ParsedStandaloneCLIArgs> = {
    provider: 'openai',
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];

    if (flag === '--provider') {
      if (value === undefined) {
        throw new Error('Missing value for --provider.');
      }

      if (value !== 'openai' && value !== 'codex-oauth') {
        throw new Error(`Unknown provider: ${value}`);
      }

      values.provider = value;
      index += 1;
      continue;
    }

    if (flag === '--login') {
      values.login = true;
      continue;
    }

    if (flag === '--list-models') {
      values.listModels = true;
      continue;
    }

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

    if (flag === '--cell-timeout-ms') {
      if (value === undefined) {
        throw new Error('Missing value for --cell-timeout-ms.');
      }

      if (!/^[0-9]+$/u.test(value)) {
        throw new Error('--cell-timeout-ms must be a positive integer.');
      }

      const parsedTimeout = Number.parseInt(value, 10);
      if (parsedTimeout <= 0) {
        throw new Error('--cell-timeout-ms must be a positive integer.');
      }

      values.cellTimeoutMs = parsedTimeout;
      index += 1;
      continue;
    }

    if (flag === '--request-timeout-ms') {
      if (value === undefined) {
        throw new Error('Missing value for --request-timeout-ms.');
      }

      if (!/^[0-9]+$/u.test(value)) {
        throw new Error('--request-timeout-ms must be a positive integer.');
      }

      const parsedTimeout = Number.parseInt(value, 10);
      if (parsedTimeout <= 0) {
        throw new Error('--request-timeout-ms must be a positive integer.');
      }

      values.requestTimeoutMs = parsedTimeout;
      index += 1;
      continue;
    }

    if (flag === '--root-model') {
      if (value === undefined) {
        throw new Error('Missing value for --root-model.');
      }
      values.rootModel = value;
      index += 1;
      continue;
    }

    if (flag === '--sub-model') {
      if (value === undefined) {
        throw new Error('Missing value for --sub-model.');
      }
      values.subModel = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown CLI flag: ${flag}`);
  }

  if (values.login !== true && values.listModels !== true) {
    if (
      values.inputPath === undefined || values.query === undefined ||
      values.systemPromptPath === undefined
    ) {
      throw new Error('Missing required CLI flags: --input, --query, --system-prompt.');
    }
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
  const cwd = options.cwd ?? resolveCurrentWorkingDirectory();
  return joinFilePath(cwd, 'logs', 'standalone', `${formatStandaloneTimestamp(clock())}.jsonl`);
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
  const cwd = options.cwd ?? resolveCurrentWorkingDirectory();
  return {
    cellTimeoutMs: args.cellTimeoutMs,
    inputPath: args.inputPath === undefined
      ? undefined
      : resolveStandalonePath(args.inputPath, cwd),
    listModels: args.listModels,
    login: args.login,
    logPath: args.logPath === undefined
      ? createStandaloneLogPath({ clock: options.clock, cwd })
      : resolveStandalonePath(args.logPath, cwd),
    provider: args.provider,
    query: args.query,
    requestTimeoutMs: args.requestTimeoutMs,
    rootModel: args.rootModel,
    subModel: args.subModel,
    systemPromptPath: args.systemPromptPath === undefined
      ? undefined
      : resolveStandalonePath(args.systemPromptPath, cwd),
  };
}

/**
 * Wraps any logger with user-facing progress lines for standalone execution.
 *
 * The returned logger preserves journal persistence while also emitting concise
 * session, step, subquery, and standalone error lines for the terminal UI.
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
        return;
      }

      if (isStandaloneErrorEntry(entry)) {
        writeLine(`[error] ${entry.stage}: ${entry.message}`);
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
 * When no `llm` or `adapter` dependency is supplied, this helper boots the
 * default OpenAI Responses caller from the local `.env`-backed config.
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
  dependencies: Pick<StandaloneCLIDependencies, 'adapter' | 'fetcher' | 'llm' | 'rootModel'> = {},
): Promise<string> {
  const llm = dependencies.llm ?? dependencies.adapter ??
    new OpenAIResponsesProvider({
      fetcher: dependencies.fetcher,
    }).createCaller(loadRLMConfig().openAI);
  const model = dependencies.rootModel ?? loadRLMConfig().openAI.rootModel;
  const response = await llm.complete({
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
    kind: 'plain_query',
    metadata: {
      depth: 0,
    },
    model,
    systemPrompt: input.systemPrompt,
  });

  return response.outputText.trim();
}

function createStandaloneFetchLogger(
  writeLine: (line: string) => void,
  fetcher: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const requestInit = init as RequestInit | undefined;
    const method = String(requestInit?.method ?? 'GET').toUpperCase();
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    writeLine(`[https] ${method} ${url}`);
    const body = requestInit?.body;
    if (body !== undefined && body !== null) {
      if (typeof body === 'string') {
        writeLine(`[https-body] ${body}`);
      } else {
        writeLine('[https-body] <non-text body>');
      }
    }
    return await fetcher(input, init);
  };
}

function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

function buildStandaloneUsageLines(usage: RLMUsageSummary | undefined): string[] {
  if (usage === undefined) {
    return [];
  }

  const lines = [
    `[usage] input_tokens=${usage.inputTokens} output_tokens=${usage.outputTokens} total_tokens=${usage.totalTokens}`,
  ];
  const estimate = estimateOpenAIRunCostUsd(usage);
  const inputCostUsd = estimate.byModel.reduce(
    (sum, entry) => sum + entry.cachedInputCostUsd + entry.inputCostUsd,
    0,
  );
  const outputCostUsd = estimate.byModel.reduce((sum, entry) => sum + entry.outputCostUsd, 0);

  if (estimate.missingPricingModels.length > 0) {
    lines.push(
      `[cost] input_usd=n/a output_usd=n/a total_usd=n/a missing_pricing_models=${
        estimate.missingPricingModels.join(', ')
      }`,
    );
    return lines;
  }

  lines.push(
    `[cost] input_usd=${formatUsd(inputCostUsd)} output_usd=${formatUsd(outputCostUsd)} total_usd=${
      formatUsd(estimate.totalCostUsd)
    }`,
  );
  return lines;
}

/**
 * Runs the standalone CLI workflow for document QA, provider login, or model listing.
 *
 * Run mode loads one document, one system prompt file, and one user query, then
 * delegates execution to the provider-neutral core runner. `openai` uses the
 * OpenAI convenience path, while `codex-oauth` resolves exact catalog model ids
 * and runs through a generic injected caller.
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
 *
 * await runStandaloneCLI([
 *   '--provider',
 *   'codex-oauth',
 *   '--login',
 * ]);
 * ```
 */
export async function runStandaloneCLI(
  args: string[],
  dependencies: StandaloneCLIDependencies = {},
): Promise<{ answer: string }> {
  const cwd = dependencies.cwd ?? resolveCurrentWorkingDirectory();
  const envPath = joinFilePath(cwd, '.env');
  const parsed = parseStandaloneCLIArgs(args);
  const resolved = resolveStandaloneCLIOptions(parsed, {
    clock: dependencies.clock,
    cwd,
  });
  const readTextFile = resolveStandaloneReadTextFile(dependencies.readTextFile);
  const writeLine = resolveStandaloneWriteLine(dependencies.writeLine);
  const runOpenAI = resolveStandaloneRun(dependencies.run);
  const runGeneric = resolveStandaloneGenericRun(dependencies.runGeneric);
  const fetcher = dependencies.fetcher ?? fetch;

  if (resolved.provider === 'codex-oauth' && resolved.login === true) {
    const provider = dependencies.createCodexOAuthProvider?.() ??
      new CodexOAuthProvider({
        fetcher,
      });
    writeLine('[login] provider: codex-oauth');
    await provider.login({
      onAuthUrl: async (url) => {
        writeLine(`[login] open: ${url}`);
      },
      receiveAuthorizationCode: createStandaloneCodexOAuthAuthorizationReceiver({
        readLoginLine: dependencies.readLoginLine,
        receiveLoopbackAuthorizationCode: dependencies.receiveLoopbackAuthorizationCode,
        writeLine,
      }),
    });
    writeLine('[login] success');

    const models = await provider.listModels();
    for (const model of models) {
      writeLine(`[model] ${model}`);
    }

    return { answer: '' };
  }

  if (resolved.provider === 'codex-oauth' && resolved.listModels === true) {
    const provider = dependencies.createCodexOAuthProvider?.() ??
      new CodexOAuthProvider({
        fetcher,
      });
    writeLine('[models] provider: codex-oauth');
    const models = await provider.listModels();
    for (const model of models) {
      writeLine(`[model] ${model}`);
    }
    return { answer: '' };
  }

  const inputPath = resolved.inputPath!;
  const query = resolved.query!;
  const systemPromptPath = resolved.systemPromptPath!;
  const document = await readTextFile(inputPath);
  const systemPrompt = await readTextFile(systemPromptPath);
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

  writeLine(`[standalone] provider: ${resolved.provider}`);
  writeLine(`[standalone] input: ${inputPath}`);
  writeLine(`[standalone] system prompt: ${systemPromptPath}`);
  writeLine(`[standalone] log: ${resolved.logPath}`);

  try {
    const context = {
      document,
      inputFilePath: inputPath,
    };
    const result = resolved.provider === 'codex-oauth'
      ? await (async () => {
        const runtime = loadRLMRuntimeConfig({ path: envPath });
        const requestTimeoutMs = resolved.requestTimeoutMs ??
          loadProviderRequestTimeoutMs({ path: envPath });
        const provider = dependencies.createCodexOAuthProvider?.() ??
          new CodexOAuthProvider({
            fetcher,
          });
        const availableModels = await provider.listModels();
        const models = resolveCodexOAuthModels(availableModels, {
          rootModel: resolved.rootModel,
          subModel: resolved.subModel,
        });
        const llm = provider.createCaller({
          requestTimeoutMs,
        });
        const cellTimeoutMs = resolveStandaloneCellTimeoutMs(
          resolved.cellTimeoutMs,
          requestTimeoutMs,
          runtime.cellTimeoutMs,
        );
        const render = dependencies.render ??
          (async (input: StandaloneFinalRenderInput) =>
            await renderStandaloneFinalAnswer(input, {
              fetcher,
              llm,
              rootModel: models.rootModel,
            }));

        const runResult = await runGeneric({
          cellTimeoutMs,
          context,
          llm,
          logger,
          prompt: query,
          rootModel: models.rootModel,
          subModel: models.subModel,
        });

        return { render, runResult };
      })()
      : await (async () => {
        const needsProviderConfig = dependencies.run === undefined ||
          dependencies.render === undefined ||
          resolved.requestTimeoutMs !== undefined;
        const config = needsProviderConfig ? loadRLMConfig({ path: envPath }) : undefined;
        const requestTimeoutMs = resolved.requestTimeoutMs ?? config?.openAI.requestTimeoutMs;
        const effectiveConfig = config === undefined ? undefined : {
          ...config,
          openAI: {
            ...config.openAI,
            requestTimeoutMs: requestTimeoutMs as number,
          },
        };
        const render = dependencies.render ??
          (async (input: StandaloneFinalRenderInput) =>
            await renderStandaloneFinalAnswer(input, {
              fetcher,
              llm: new OpenAIResponsesProvider({
                fetcher,
              }).createCaller(effectiveConfig!.openAI),
              rootModel: effectiveConfig!.openAI.rootModel,
            }));
        const runResult = await runOpenAI({
          cellTimeoutMs: resolved.cellTimeoutMs,
          config: effectiveConfig,
          context,
          fetcher,
          logger,
          prompt: query,
        });
        return { render, runResult };
      })();
    resultSession = result.runResult.session;
    const renderedAnswer = await result.render({
      finalValue: result.runResult.finalValue,
      inputFilePath: inputPath,
      query,
      rlmAnswer: result.runResult.answer,
      systemPrompt,
    });

    writeLine(`[final] ${renderedAnswer}`);
    for (const usageLine of buildStandaloneUsageLines(result.runResult.usage)) {
      writeLine(usageLine);
    }
    return {
      answer: renderedAnswer,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logger.append({
      createdAt: (dependencies.clock ?? (() => new Date()))().toISOString(),
      message,
      stage: 'run',
      type: 'standalone_error',
    });
    throw error;
  } finally {
    await resultSession?.close?.();
    await logger.close?.();
  }
}

export const __standaloneCLITestables = {
  buildStandaloneUsageLines,
  createStandaloneCodexOAuthAuthorizationReceiver,
  closeStandaloneBaseLogger,
  formatStandaloneFinalSuffix,
  formatStandaloneTimestamp,
  readStandaloneLoginLine,
  receiveStandaloneLoopbackAuthorizationCode,
  resolveCodexOAuthModels,
  resolveCodexOAuthProvider,
  resolveStandaloneGenericRun,
  createStandaloneFetchLogger,
  resolveStandaloneReadLoginLine,
  resolveStandaloneReadTextFile,
  resolveStandaloneRender,
  resolveStandaloneRun,
  resolveStandalonePath,
  resolveStandaloneWriteLine,
};
