/**
 * Standalone CLI parsing, progress logging, login, and run orchestration helpers.
 *
 * @module
 *
 * @example
 * ```ts
 * import { runStandaloneCLI } from './cli.ts';
 * ```
 */
import {
  loadPreferredStandaloneModelConfig,
  loadProviderRequestTimeoutMs,
  loadRLMConfig,
  loadRLMRuntimeConfig,
} from './env.ts';
import type { LLMCaller } from '../../src/llm_adapter.ts';
import { JsonlFileLogger } from '../../src/logger.ts';
import { OpenAIResponsesProvider } from '../../src/providers/openai_adapter.ts';
import { estimateOpenAIRunCostUsd } from '../../src/providers/openai_pricing.ts';
import {
  importNodeBuiltin,
  joinFilePath,
  type ReadTextFile,
  resolveCurrentWorkingDirectory,
  resolveFilePath,
} from '../../src/platform.ts';
import {
  type CodexOAuthAuthorizationCodeResult,
  type CodexOAuthAuthorizationReceiver,
  type CodexOAuthAuthorizationSession,
  CodexOAuthProvider,
  extractAuthorizationCodeFromCallbackUrl,
} from '../../src/providers/codex_oauth.ts';
import { runOpenAIRLM } from '../../src/providers/openai.ts';
import type { RunOpenAIRLMOptions } from '../../src/providers/openai.ts';
import type { RLMPlugin } from '../../src/plugin.ts';
import { runRLM } from '../../src/rlm_runner.ts';
import type { RLMRunOptions } from '../../src/rlm_runner.ts';
import type {
  AssistantTurnEntry,
  CellEntry,
  JournalEntry,
  JsonValue,
  QueryTraceEntry,
  RLMLogger,
  RLMUsageSummary,
  SessionEntry,
  StandaloneErrorEntry,
  SubqueryEntry,
} from '../../src/types.ts';

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
  aotDebug?: boolean;
  aotMode?: 'hard' | 'lite';
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
  aotDebug?: boolean;
  aotMode?: 'hard' | 'lite';
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

interface StandaloneModelCostEstimate {
  cachedInputCostUsd?: number;
  inputCostUsd?: number;
  model: string;
  outputCostUsd?: number;
  totalCostUsd?: number;
}

interface StandaloneRunCostEstimate {
  byModel: StandaloneModelCostEstimate[];
  missingPricingModels?: string[];
  totalCostUsd?: number;
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
  createAOTPlugin?: () => Promise<RLMPlugin> | RLMPlugin;
  createCodexOAuthProvider?: () => StandaloneCodexOAuthProviderLike;
  cwd?: string;
  /**
   * @deprecated Use `llm`.
   */
  adapter?: Pick<LLMCaller, 'complete'>;
  estimateRunCost?: (usage: RLMUsageSummary) => StandaloneRunCostEstimate | null;
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
 *   query: 'What is the answer?',
 *   rlmAnswer: '42',
 *   systemPrompt: 'Answer in concise Korean.',
 * };
 * ```
 */
export interface StandaloneFinalRenderInput {
  finalValue?: JsonValue | null;
  inputFilePath?: string;
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

async function loadStandaloneAOTPlugin(
  loadPluginModule: () => Promise<{ createAoTPlugin: () => RLMPlugin }> = async () =>
    await import('../../plugin/aot/mod.ts'),
): Promise<RLMPlugin> {
  try {
    const { createAoTPlugin } = await loadPluginModule();
    return createAoTPlugin();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        'Standalone AoT mode requires plugin/aot/mod.ts to be available.',
        `Failed to load the default AoT plugin: ${message}`,
      ].join(' '),
    );
  }
}

async function resolveStandalonePlugins(
  options: Pick<ResolvedStandaloneCLIOptions, 'aotMode'>,
  dependencies: Pick<StandaloneCLIDependencies, 'createAOTPlugin'>,
): Promise<RLMPlugin[] | undefined> {
  if (options.aotMode === undefined) {
    return undefined;
  }

  const plugin = await (dependencies.createAOTPlugin?.() ?? loadStandaloneAOTPlugin());
  return [plugin];
}

function resolveStandaloneSystemPromptExtension(
  options: Pick<ResolvedStandaloneCLIOptions, 'aotMode'>,
): string | undefined {
  if (options.aotMode === undefined) {
    return undefined;
  }

  if (options.aotMode === 'lite') {
    return [
      'AoT-lite mode is enabled for this run.',
      'If `context.document` is empty, missing, or insufficient for a direct grounded answer, you must call `aot(...)` before `FINAL(...)` or `FINAL_VAR(...)`.',
      'For multipart, explanatory, comparative, synthetic, or teach-back questions, prefer `aot(...)` even if you think you can answer directly.',
      'Do not manually imitate AoT by writing the decomposition yourself in the first cell. Call `aot(...)` and then use its returned result.',
      'For the first AoT attempt in standalone mode, prefer one lightweight object-form call instead of `aot("question")`.',
      'Start with: `await aot({ question, maxIterations: 1, maxIndependentSubquestions: 2, maxRefinements: 0, includeTrace: false })`.',
      'AoT-lite should keep a single decomposition-contraction path and avoid judge/frontier-heavy search by default.',
      'If AoT-lite times out or raises a runtime error, reduce the question scope or answer without AoT.',
      'Only escalate to AoT-hard when a completed AoT-lite attempt clearly needs judge, refinement, or frontier search.',
      'Only skip `aot(...)` when the answer is a short, direct extraction from `context.document` and no decomposition or synthesis is needed.',
    ].join('\n');
  }

  return [
    'AOT-hard mode is enabled for this run.',
    'If `context.document` is empty, missing, or insufficient for a direct grounded answer, you must call `aot(...)` before `FINAL(...)` or `FINAL_VAR(...)`.',
    'For multipart, explanatory, comparative, synthetic, or teach-back questions, prefer `aot(...)` even if you think you can answer directly.',
    'Do not manually imitate AoT by writing the decomposition yourself in the first cell. Call `aot(...)` and then use its returned result.',
    'For the first AoT-hard attempt in standalone mode, prefer one conservative object-form call instead of `aot("question")`.',
    'Start with: `await aot({ question, maxIterations: 3, maxIndependentSubquestions: 4, transitionSamples: 2, beamWidth: 2, maxRefinements: 1, includeTrace: false })`.',
    'Only widen AoT search after a completed, non-timeout attempt that clearly needed more decomposition. Increase one knob at a time.',
    'Do not widen AoT search after a timeout or runtime error. In that case, keep `transitionSamples: 1`, `beamWidth: 1`, reduce the question scope, or answer without AoT.',
    'Only skip `aot(...)` when the answer is a short, direct extraction from `context.document` and no decomposition or synthesis is needed.',
  ].join('\n');
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
  preferredModels: {
    rootModel?: string;
    subModel?: string;
  } = {},
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

  const pickPreferredExactModel = (requestedModel: string | undefined): string | undefined => {
    if (requestedModel === undefined) {
      return undefined;
    }

    return availableModels.includes(requestedModel) ? requestedModel : undefined;
  };

  const rootModel = ensureExactModel(overrides.rootModel) ??
    pickPreferredExactModel(preferredModels.rootModel) ??
    pickPreferredModel(
      availableModels,
      ['gpt-5-4-t-mini', 'gpt-5-mini', 'gpt-5-4-thinking', 'gpt-5', 'gpt-5-3'],
    );
  if (rootModel === undefined) {
    throw new Error('Codex OAuth provider did not return any usable models.');
  }

  const subModel = (ensureExactModel(overrides.subModel) ??
    pickPreferredExactModel(preferredModels.subModel) ??
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

function isQueryTraceEntry(entry: JournalEntry): entry is QueryTraceEntry {
  return entry.type === 'query_trace';
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

function parseStandaloneTimeMs(timestamp: string | undefined): number | null {
  if (timestamp === undefined) {
    return null;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatStandaloneDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return 'unknown';
  }

  if (durationMs < 1_000) {
    return `${Math.round(durationMs)}ms`;
  }

  if (durationMs < 60_000) {
    const seconds = durationMs / 1_000;
    return seconds >= 10 ? `${seconds.toFixed(0)}s` : `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(durationMs / 60_000);
  const seconds = (durationMs % 60_000) / 1_000;
  if (seconds < 10) {
    return `${minutes}m ${seconds.toFixed(1)}s`;
  }

  return `${minutes}m ${seconds.toFixed(0)}s`;
}

function formatStandaloneElapsedSuffix(durationMs: number | null): string {
  if (durationMs === null) {
    return '';
  }

  return ` elapsed=${formatStandaloneDurationMs(durationMs)}`;
}

function formatStandaloneQueryTraceMaxSteps(
  maxSteps: QueryTraceEntry['maxSteps'],
): string | null {
  if (maxSteps === undefined) {
    return null;
  }

  return `maxSteps=${String(maxSteps)}`;
}

function formatStandaloneStepGapSuffix(
  previousAssistantCreatedAtMs: number | null,
  nextAssistantCreatedAt: string,
): string {
  if (previousAssistantCreatedAtMs === null) {
    return '';
  }

  const nextAssistantCreatedAtMs = parseStandaloneTimeMs(nextAssistantCreatedAt);
  if (nextAssistantCreatedAtMs === null || nextAssistantCreatedAtMs < previousAssistantCreatedAtMs) {
    return '';
  }

  return ` after=${formatStandaloneDurationMs(nextAssistantCreatedAtMs - previousAssistantCreatedAtMs)}`;
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
 * - `--aot` or `--aot-hard` (optional)
 * - `--aot-debug` (optional, requires `--aot` or `--aot-hard`)
 * - `--login` (Codex OAuth only)
 * - `--list-models` (Codex OAuth only)
 * - `--input <path>` (optional)
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

    if (flag === '--aot') {
      if (values.aotMode !== undefined) {
        throw new Error('Choose either --aot or --aot-hard, not both.');
      }
      values.aotMode = 'lite';
      continue;
    }

    if (flag === '--aot-hard') {
      if (values.aotMode !== undefined) {
        throw new Error('Choose either --aot or --aot-hard, not both.');
      }
      values.aotMode = 'hard';
      continue;
    }

    if (flag === '--aot-debug') {
      values.aotDebug = true;
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
    const missingRequiredFlags = [
      values.query === undefined ? '--query' : null,
      values.systemPromptPath === undefined ? '--system-prompt' : null,
    ].filter((flag): flag is string => flag !== null);

    if (missingRequiredFlags.length > 0) {
      throw new Error(`Missing required CLI flags: ${missingRequiredFlags.join(', ')}.`);
    }
  }

  if (values.aotDebug === true && values.aotMode === undefined) {
    throw new Error('--aot-debug requires --aot or --aot-hard.');
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
    aotDebug: args.aotDebug,
    aotMode: args.aotMode,
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
    showQueryTrace?: boolean;
    writeLine?: (line: string) => void;
  },
): RLMLogger & { path?: string } {
  const writeLine = resolveStandaloneWriteLine(options.writeLine);
  let currentStep = 0;
  let previousAssistantCreatedAtMs: number | null = null;
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
        writeLine(
          `[step ${entry.step}] assistant turn${
            formatStandaloneStepGapSuffix(previousAssistantCreatedAtMs, entry.createdAt)
          }`,
        );
        previousAssistantCreatedAtMs = parseStandaloneTimeMs(entry.createdAt);
        return;
      }

      if (isCellEntry(entry)) {
        const finalSuffix = formatStandaloneFinalSuffix(entry.finalAnswer);
        writeLine(
          `[step ${currentStep}] cell ${entry.status}${
            formatStandaloneElapsedSuffix(entry.durationMs)
          }${finalSuffix}`,
        );
        return;
      }

      if (isSubqueryEntry(entry)) {
        writeLine(`[step ${currentStep}] subquery depth=${entry.depth} steps=${entry.steps}`);
        return;
      }

      if (isQueryTraceEntry(entry) && options.showQueryTrace === true) {
        const detailParts = [
          `query=${String(entry.queryIndex)}`,
          `depth=${String(entry.depth)}`,
          `elapsed=${formatStandaloneDurationMs(entry.durationMs)}`,
          `status=${entry.status}`,
          `model=${entry.model}`,
          formatStandaloneQueryTraceMaxSteps(entry.maxSteps),
          typeof entry.maxSubcallDepth === 'number'
            ? `maxSubcallDepth=${String(entry.maxSubcallDepth)}`
            : null,
          typeof entry.steps === 'number' ? `steps=${String(entry.steps)}` : null,
        ].filter((value): value is string => value !== null);
        writeLine(
          `[aot-debug] ${entry.kind} tag=${entry.promptTag ?? '(none)'} ${detailParts.join(' ')}`,
        );
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
  const promptSections = [
    'User query:',
    input.query,
    '',
    'Verified RLM answer:',
    input.rlmAnswer,
    '',
    'Structured final value:',
    JSON.stringify(input.finalValue ?? null),
  ];

  if (input.inputFilePath !== undefined) {
    promptSections.push(
      '',
      'Input file path:',
      input.inputFilePath,
    );
  }

  promptSections.push(
    '',
    'Write the final user-facing answer now.',
  );

  const response = await llm.complete({
    input: promptSections.join('\n'),
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

function buildStandaloneUsageLines(
  usage: RLMUsageSummary | undefined,
  estimateRunCost?: (usage: RLMUsageSummary) => StandaloneRunCostEstimate | null,
): string[] {
  if (usage === undefined) {
    return [];
  }

  const lines = [
    `[usage] input_tokens=${usage.inputTokens} output_tokens=${usage.outputTokens} total_tokens=${usage.totalTokens}`,
  ];
  const estimate = estimateRunCost?.(usage) ?? null;
  if (estimate === null) {
    lines.push('[cost] input_usd= output_usd= total_usd=');
    return lines;
  }

  const inputCostUsd = estimate.byModel.reduce(
    (sum, entry) => sum + (entry.cachedInputCostUsd ?? 0) + (entry.inputCostUsd ?? 0),
    0,
  );
  const outputCostUsd = estimate.byModel.reduce(
    (sum, entry) => sum + (entry.outputCostUsd ?? 0),
    0,
  );
  const missingPricingModels = estimate.missingPricingModels ?? [];

  if (missingPricingModels.length > 0 || estimate.totalCostUsd === undefined) {
    lines.push(
      `[cost] input_usd= output_usd= total_usd=${
        missingPricingModels.length > 0 || estimate.totalCostUsd === undefined
          ? ''
          : formatUsd(estimate.totalCostUsd)
      }${
        missingPricingModels.length === 0
          ? ''
          : ` missing_pricing_models=${missingPricingModels.join(', ')}`
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
  const estimateRunCost = resolved.provider === 'openai'
    ? dependencies.estimateRunCost ?? estimateOpenAIRunCostUsd
    : dependencies.estimateRunCost;

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

  const inputPath = resolved.inputPath;
  const query = resolved.query!;
  const systemPromptPath = resolved.systemPromptPath!;
  const document = inputPath === undefined ? '' : await readTextFile(inputPath);
  const systemPrompt = await readTextFile(systemPromptPath);
  const baseLogger = new JsonlFileLogger(resolved.logPath);
  const logger = createStandaloneProgressLogger({
    baseLogger,
    showQueryTrace: resolved.aotDebug === true,
    writeLine,
  });
  const plugins = await resolveStandalonePlugins(resolved, dependencies);
  const systemPromptExtension = resolveStandaloneSystemPromptExtension(resolved);
  let resultSession:
    | {
      close?(): Promise<void> | void;
    }
    | undefined;

  writeLine(`[standalone] provider: ${resolved.provider}`);
  if (resolved.aotMode !== undefined) {
    writeLine(`[standalone] aot: ${resolved.aotMode}`);
  }
  if (resolved.aotDebug === true) {
    writeLine('[standalone] aot debug: enabled');
  }
  writeLine(`[standalone] input: ${inputPath ?? '(none)'}`);
  writeLine(`[standalone] system prompt: ${systemPromptPath}`);
  writeLine(`[standalone] log: ${resolved.logPath}`);

  try {
    const context = {
      document,
      inputFilePath: inputPath ?? null,
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
        const preferredModels = loadPreferredStandaloneModelConfig({ path: envPath });
        const models = resolveCodexOAuthModels(availableModels, {
          rootModel: resolved.rootModel,
          subModel: resolved.subModel,
        }, preferredModels);
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
          plugins,
          prompt: query,
          rootModel: models.rootModel,
          subModel: models.subModel,
          systemPromptExtension,
          ...(resolved.aotDebug === true ? { queryTrace: true } : {}),
        });

        return { render, runResult };
      })()
      : await (async () => {
        const config = loadRLMConfig({ path: envPath });
        const requestTimeoutMs = resolved.requestTimeoutMs ?? config.openAI.requestTimeoutMs;
        const effectiveConfig = {
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
              }).createCaller(effectiveConfig.openAI),
              rootModel: effectiveConfig.openAI.rootModel,
            }));
        const runResult = await runOpenAI({
          cellTimeoutMs: resolved.cellTimeoutMs,
          context,
          defaults: effectiveConfig.runtime,
          fetcher,
          logger,
          openAI: effectiveConfig.openAI,
          plugins,
          prompt: query,
          systemPromptExtension,
          ...(resolved.aotDebug === true ? { queryTrace: true } : {}),
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
    for (const usageLine of buildStandaloneUsageLines(result.runResult.usage, estimateRunCost)) {
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

/**
 * Exposes standalone CLI helpers for isolated tests.
 */
export const __standaloneCLITestables = {
  buildStandaloneUsageLines,
  createStandaloneCodexOAuthAuthorizationReceiver,
  closeStandaloneBaseLogger,
  formatStandaloneDurationMs,
  formatStandaloneElapsedSuffix,
  formatStandaloneFinalSuffix,
  formatStandaloneQueryTraceMaxSteps,
  formatStandaloneStepGapSuffix,
  formatStandaloneTimestamp,
  loadStandaloneAOTPlugin,
  parseStandaloneTimeMs,
  readStandaloneLoginLine,
  receiveStandaloneLoopbackAuthorizationCode,
  resolveCodexOAuthModels,
  resolveCodexOAuthProvider,
  resolveStandaloneGenericRun,
  resolveStandalonePlugins,
  resolveStandaloneSystemPromptExtension,
  createStandaloneFetchLogger,
  resolveStandaloneReadLoginLine,
  resolveStandaloneReadTextFile,
  resolveStandaloneRender,
  resolveStandaloneRun,
  resolveStandalonePath,
  resolveStandaloneWriteLine,
};
