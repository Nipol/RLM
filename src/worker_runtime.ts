/**
 * Worker-backed sandbox runtime used to execute REPL cells safely and persistently.
 *
 * @module
 *
 * @example
 * ```ts
 * import { executeCellInSandbox } from './worker_runtime.ts';
 * ```
 */
import { splitTrailingExpression } from './code_guard.ts';
import { assertRuntimeHelperDefinition } from './plugin.ts';
import { buildPreferredWorkerSourceHandle } from './worker_source.ts';
import type {
  CellEntry,
  ExecutionErrorSnapshot,
  JsonValue,
  LLMQueryHandler,
  RLMQueryHandler,
  RLMQueryInput,
  RLMRuntimeHelper,
  ValueSnapshot,
} from './types.ts';

interface SandboxExecutionInput {
  context: JsonValue | null;
  currentCode: string;
  history: CellEntry[];
  replayCells: CellEntry[];
  timeoutMs: number;
}

interface SandboxExecutionOutput {
  error: ExecutionErrorSnapshot | null;
  finalAnswer: string | null;
  finalResult?: ValueSnapshot | null;
  result: ValueSnapshot;
  status: 'error' | 'success';
  stderr: string;
  stdout: string;
}

interface WorkerLike {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<SandboxExecutionOutput>) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage?(message: unknown): void;
  terminate(): void;
}

type WorkerFactory = (
  source: string,
  options: WorkerOptions,
) => WorkerLike | Promise<WorkerLike>;

interface PersistentRuntimeOptions {
  context: JsonValue | null;
  llmQueryHandler?: LLMQueryHandler;
  rlmQueryHandler?: RLMQueryHandler;
  runtimeHelpers?: RLMRuntimeHelper[];
}

interface PersistentExecuteInput {
  captureFinals?: boolean;
  code: string;
  history: CellEntry[];
  timeoutMs: number;
}

interface PersistentWorkerLike {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<PersistentWorkerHostMessage>) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: PersistentWorkerMessage): void;
  terminate(): void;
}

type PersistentWorkerFactory = (
  source: string,
  options: WorkerOptions,
) => PersistentWorkerLike | Promise<PersistentWorkerLike>;

type WorkerBridgeLike = {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
};

interface PersistentWorkerExecuteMessage {
  captureFinals: boolean;
  code: string;
  historyDelta: CellEntry[];
  requestId: number;
  type: 'execute';
}

interface PersistentWorkerExecuteResultMessage extends SandboxExecutionOutput {
  requestId: number;
  type: 'execute_result';
}

interface PersistentWorkerInitMessage {
  context: JsonValue | null;
  type: 'init';
}

interface PersistentWorkerQueryRequestMessage {
  prompt: string;
  queryId: number;
  type: 'llm_query_request';
}

interface PersistentWorkerRecursiveQueryRequestMessage {
  maxSteps?: number;
  maxSubcallDepth?: number;
  prompt: RLMQueryInput;
  queryId: number;
  type: 'rlm_query_request';
}

interface PersistentWorkerQueryResponseMessage {
  queryId: number;
  stdout?: string;
  type: 'llm_query_response';
  value: JsonValue;
}

interface PersistentWorkerQueryErrorMessage {
  error: ExecutionErrorSnapshot;
  queryId: number;
  type: 'llm_query_error';
}

type PersistentWorkerHostMessage =
  | PersistentWorkerExecuteResultMessage
  | PersistentWorkerQueryRequestMessage
  | PersistentWorkerRecursiveQueryRequestMessage;

type PersistentWorkerMessage =
  | PersistentWorkerExecuteMessage
  | PersistentWorkerInitMessage
  | PersistentWorkerQueryErrorMessage
  | PersistentWorkerQueryResponseMessage;

interface PendingExecution {
  reject: (error: Error) => void;
  requestId: number;
  resolve: (output: SandboxExecutionOutput) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingQueryController {
  controller: AbortController;
  worker: PersistentWorkerLike;
}

interface InternalRLMQueryResultEnvelope {
  __rlmQueryResultEnvelope: true;
  stdout?: string;
  value: JsonValue;
}

/**
 * Returns whether one query response belongs to a worker that is no longer active.
 */
function isStalePersistentWorker(
  activeWorker: PersistentWorkerLike | null,
  worker: PersistentWorkerLike,
): boolean {
  return activeWorker !== worker;
}

/**
 * Returns whether one pending query controller should be aborted while tearing down a worker.
 */
function shouldAbortPendingQueryController(
  activeWorker: PersistentWorkerLike | null,
  pendingWorker: PersistentWorkerLike,
): boolean {
  return activeWorker === null || pendingWorker === activeWorker;
}

/**
 * Aborts and clears all pending query controllers that belong to the worker being torn down.
 */
function abortPendingQueryControllers(
  pendingControllers: Map<number, PendingQueryController>,
  activeWorker: PersistentWorkerLike | null,
): void {
  for (const [queryId, pending] of pendingControllers.entries()) {
    if (!shouldAbortPendingQueryController(activeWorker, pending.worker)) {
      continue;
    }

    pending.controller.abort();
    pendingControllers.delete(queryId);
  }
}

function isInternalRLMQueryResultEnvelope(value: unknown): value is InternalRLMQueryResultEnvelope {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    '__rlmQueryResultEnvelope' in value &&
    value.__rlmQueryResultEnvelope === true &&
    'value' in value;
}

type WorkerFailureOutput = SandboxExecutionOutput & {
  error: ExecutionErrorSnapshot;
  status: 'error';
};

const PERSISTENT_RESTORE_TIMEOUT_MS = 30_000;
const SANDBOX_TIMEOUT_GRACE_MS = 15;

/**
 * Carries a worker bootstrap failure back into the active execute() call as a normal REPL result.
 */
class PersistentWorkerStartupError extends Error {
  readonly output: WorkerFailureOutput;

  /**
   * Stores the infrastructure failure that happened before any execute request was in flight.
   */
  constructor(output: WorkerFailureOutput) {
    super(output.error.message);
    this.name = 'PersistentWorkerStartupError';
    this.output = output;
  }
}

/**
 * Raised when a sandboxed execution does not respond before its configured deadline.
 */
export class SandboxTimeoutError extends Error {
  /**
   * Formats a timeout error with the offending deadline in milliseconds.
   */
  constructor(timeoutMs: number) {
    super(`Execution timed out after ${timeoutMs}ms.`);
    this.name = 'TimeoutError';
  }
}

/**
 * Indents multi-line source so generated worker modules remain readable and valid.
 */
function indentBlock(code: string, spaces = 4): string {
  const prefix = ' '.repeat(spaces);
  return code
    .split('\n')
    .map((line) => (line.length === 0 ? '' : `${prefix}${line}`))
    .join('\n');
}

/**
 * Rewrites the current cell into a snippet that stores the cell's visible result.
 */
function buildCurrentCellCode(source: string): string {
  const { body, expression } = splitTrailingExpression(source);
  const bodyBlock = body.trim().length === 0 ? '' : `${body}\n`;

  if (expression === null) {
    return `${bodyBlock}__resultSnapshot = __snapshotValue(undefined);`;
  }

  return `${bodyBlock}__resultSnapshot = __snapshotValue(${expression});`;
}

/**
 * Concatenates previously successful cells into replayable source code.
 */
function buildReplayCode(cells: CellEntry[]): string {
  return cells
    .map((cell) => `// replay:${cell.cellId}\n${cell.code}`)
    .join('\n\n');
}

/**
 * Generates the shared worker-side sandbox guards that block filesystem access explicitly.
 */
function buildSandboxGuardSource(): string {
  return `
const __blockedSandboxError = (kind) => {
  const error = new Error(kind + ' access is disabled in the RLM sandbox.');
  error.name = 'SandboxAccessError';
  return error;
};

const __throwBlockedAccess = (kind) => {
  throw __blockedSandboxError(kind);
};

const __blockedFileSystem = (..._args) => __throwBlockedAccess('File system');
const __blockedEnvironment = (..._args) => __throwBlockedAccess('Environment');

const __sandboxDeno = Object.freeze({
  chmod: __blockedFileSystem,
  chmodSync: __blockedFileSystem,
  chown: __blockedFileSystem,
  chownSync: __blockedFileSystem,
  copyFile: __blockedFileSystem,
  copyFileSync: __blockedFileSystem,
  create: __blockedFileSystem,
  createSync: __blockedFileSystem,
  cwd: __blockedFileSystem,
  env: Object.freeze({
    delete: __blockedEnvironment,
    get: __blockedEnvironment,
    set: __blockedEnvironment,
    toObject: __blockedEnvironment,
  }),
  lstat: __blockedFileSystem,
  lstatSync: __blockedFileSystem,
  makeTempDir: __blockedFileSystem,
  makeTempDirSync: __blockedFileSystem,
  makeTempFile: __blockedFileSystem,
  makeTempFileSync: __blockedFileSystem,
  mkdir: __blockedFileSystem,
  mkdirSync: __blockedFileSystem,
  open: __blockedFileSystem,
  openSync: __blockedFileSystem,
  readDir: __blockedFileSystem,
  readDirSync: __blockedFileSystem,
  readFile: __blockedFileSystem,
  readFileSync: __blockedFileSystem,
  readLink: __blockedFileSystem,
  readLinkSync: __blockedFileSystem,
  readTextFile: __blockedFileSystem,
  readTextFileSync: __blockedFileSystem,
  realPath: __blockedFileSystem,
  realPathSync: __blockedFileSystem,
  remove: __blockedFileSystem,
  removeSync: __blockedFileSystem,
  rename: __blockedFileSystem,
  renameSync: __blockedFileSystem,
  stat: __blockedFileSystem,
  statSync: __blockedFileSystem,
  symlink: __blockedFileSystem,
  symlinkSync: __blockedFileSystem,
  truncate: __blockedFileSystem,
  truncateSync: __blockedFileSystem,
  writeFile: __blockedFileSystem,
  writeFileSync: __blockedFileSystem,
  writeTextFile: __blockedFileSystem,
  writeTextFileSync: __blockedFileSystem,
});

try {
  Object.defineProperty(globalThis, 'Deno', {
    configurable: false,
    value: __sandboxDeno,
    writable: false,
  });
} catch (_) {
  globalThis.Deno = __sandboxDeno;
}
`;
}

/**
 * Generates a shared worker-side helper that collects repeated line-oriented matches.
 */
function buildGrepSource(): string {
  return `
const grep = (text, pattern, options = {}) => {
  if (text === undefined || text === null || pattern === undefined || pattern === null) {
    return null;
  }

  if (typeof text !== 'string') {
    return [];
  }

  const safeOptions = options && typeof options === 'object' && !Array.isArray(options)
    ? options
    : {};
  const before = Number.isInteger(safeOptions.before) && safeOptions.before > 0 ? safeOptions.before : 0;
  const after = Number.isInteger(safeOptions.after) && safeOptions.after > 0 ? safeOptions.after : 0;
  const limit = Number.isInteger(safeOptions.limit) && safeOptions.limit > 0 ? safeOptions.limit : 20;
  const mode = safeOptions.mode === 'regex' ? 'regex' : 'plain';
  const caseSensitive = safeOptions.caseSensitive === true;

  let matcher;
  if (pattern instanceof RegExp) {
    const flags = pattern.flags.replace(/[gy]/gu, '');
    matcher = (line) => new RegExp(pattern.source, flags).test(line);
  } else if (typeof pattern === 'string') {
    if (pattern.length === 0) {
      return [];
    }

    if (mode === 'regex') {
      let regex;
      try {
        regex = new RegExp(pattern, caseSensitive ? '' : 'i');
      } catch (_) {
        return [];
      }
      matcher = (line) => regex.test(line);
    } else {
      const needle = caseSensitive ? pattern : pattern.toLowerCase();
      matcher = (line) => {
        const haystack = caseSensitive ? line : line.toLowerCase();
        return haystack.includes(needle);
      };
    }
  } else {
    return [];
  }

  const lines = text.split(/\\r?\\n/u);
  const matches = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!matcher(line)) {
      continue;
    }

    const start = Math.max(0, index - before);
    const end = Math.min(lines.length, index + after + 1);
    matches.push({
      contextText: lines.slice(start, end).join('\\n'),
      endLine: end,
      line,
      lineNumber: index + 1,
      startLine: start + 1,
    });

    if (matches.length >= limit) {
      break;
    }
  }

  return matches;
};
`;
}

/**
 * Generates the full worker module that bootstraps the sandbox and executes one cell.
 */
function buildWorkerSource(input: SandboxExecutionInput): string {
  const replayCode = buildReplayCode(input.replayCells);
  const currentCode = buildCurrentCellCode(input.currentCode);

  return `
// @ts-nocheck
const __postResult = globalThis.postMessage.bind(globalThis);
const __stdoutParts = [];
const __stderrParts = [];

const __disableGlobal = (name) => {
  try {
    Object.defineProperty(globalThis, name, {
      configurable: false,
      value: undefined,
      writable: false,
    });
    return;
  } catch (_) {
    // Fall through to direct assignment.
  }

  try {
    globalThis[name] = undefined;
  } catch (_) {
    // Ignore best-effort lockdown failures.
  }
};

const __stableStringify = (value, depth = 0) => {
  if (value === null) {
    return null;
  }

  if (depth > 3) {
    return '[MaxDepth]';
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((entry) => __stableStringify(entry, depth + 1));
  }

  const valueType = typeof value;
  if (valueType === 'boolean' || valueType === 'number' || valueType === 'string') {
    return value;
  }

  if (valueType === 'bigint') {
    return value.toString();
  }

  if (valueType !== 'object') {
    return undefined;
  }

  const entries = Object.entries(value).slice(0, 10);
  const snapshot = {};

  for (const [key, nested] of entries) {
    const serialized = __stableStringify(nested, depth + 1);
    if (serialized !== undefined) {
      snapshot[key] = serialized;
    }
  }

  return snapshot;
};

const __previewValue = (value) => {
  if (value === null) {
    return 'null';
  }

  if (value === undefined) {
    return 'undefined';
  }

  const valueType = typeof value;

  if (valueType === 'string') {
    return value;
  }

  if (valueType === 'number' || valueType === 'boolean' || valueType === 'bigint') {
    return String(value);
  }

  if (valueType === 'function') {
    return '[Function]';
  }

  if (valueType === 'symbol') {
    return value.toString();
  }

  try {
    const stable = __stableStringify(value);
    if (stable !== undefined) {
      return JSON.stringify(stable);
    }
  } catch (_) {
    // Fall through to Object.prototype.
  }

  return Object.prototype.toString.call(value);
};

const __createSignal = (path, value) => {
  if (value === undefined && path === '$') {
    return null;
  }

  if (value === null) {
    return { kind: 'null', path, preview: 'null' };
  }

  const valueType = typeof value;
  if (
    valueType === 'bigint' ||
    valueType === 'boolean' ||
    valueType === 'number' ||
    valueType === 'string' ||
    valueType === 'undefined'
  ) {
    return {
      kind: valueType,
      path,
      preview: __previewValue(value),
    };
  }

  return null;
};

const __signalPathSegment = (key) =>
  /^[A-Za-z_$][\\w$]*$/.test(key) ? '.' + key : '[' + JSON.stringify(key) + ']';

const __collectSignals = (value, path = '$', depth = 0, signals = []) => {
  if (signals.length >= 16 || depth > 4) {
    return signals;
  }

  const signal = __createSignal(path, value);
  if (signal !== null) {
    signals.push(signal);
    return signals;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, 8); index += 1) {
      if (signals.length >= 16) {
        break;
      }

      __collectSignals(value[index], path + '[' + index + ']', depth + 1, signals);
    }

    return signals;
  }

  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value).slice(0, 8)) {
      if (signals.length >= 16) {
        break;
      }

      __collectSignals(nested, path + __signalPathSegment(key), depth + 1, signals);
    }
  }

  return signals;
};

const __snapshotValue = (value) => {
  const json = __stableStringify(value);
  const signals = __collectSignals(value);
  const base = {
    kind: value === null
      ? 'null'
      : Array.isArray(value)
      ? 'array'
      : typeof value,
    preview: __previewValue(value),
  };

  if (signals.length > 0) {
    base.signals = signals;
  }

  if (json === undefined) {
    return base;
  }

  return { ...base, json };
};

const __write = (parts, values) => {
  parts.push(values.map((value) => __previewValue(value)).join(' ') + '\\n');
};

const __console = {
  debug: (...values) => __write(__stdoutParts, values),
  error: (...values) => __write(__stderrParts, values),
  info: (...values) => __write(__stdoutParts, values),
  log: (...values) => __write(__stdoutParts, values),
  warn: (...values) => __write(__stderrParts, values),
};

globalThis.console = __console;

for (const __globalName of [
  'BroadcastChannel',
  'EventSource',
  'SharedWorker',
  'WebSocket',
  'Worker',
  'caches',
  'close',
  'fetch',
  'indexedDB',
  'localStorage',
  'navigator',
  'onmessage',
  'postMessage',
  'sessionStorage',
]) {
  __disableGlobal(__globalName);
}

${buildSandboxGuardSource()}
${buildGrepSource()}

const __deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);

    for (const nested of Object.values(value)) {
      __deepFreeze(nested);
    }
  }

  return value;
};

const context = __deepFreeze(structuredClone(${JSON.stringify(input.context ?? null)}));
const history = __deepFreeze(structuredClone(${JSON.stringify(input.history)}));

let __captureFinals = false;
let __finalAnswer = null;
let __finalResult = null;
let __resultSnapshot = __snapshotValue(undefined);

const FINAL = (value) => {
  if (__captureFinals) {
    __finalAnswer = __previewValue(value);
    __finalResult = __snapshotValue(value);
  }

  return value;
};

const FINAL_VAR = (value) => FINAL(value);

try {
  await (async () => {
${indentBlock(replayCode)}
    __captureFinals = true;
${indentBlock(currentCode)}
  })();

  __postResult({
    error: null,
    finalAnswer: __finalAnswer,
    finalResult: __finalResult,
    result: __resultSnapshot,
    status: 'success',
    stderr: __stderrParts.join(''),
    stdout: __stdoutParts.join(''),
  });
} catch (error) {
  const __error = error instanceof Error
    ? { message: error.message, name: error.name, stack: error.stack }
    : { message: String(error), name: 'Error' };

  __postResult({
    error: __error,
    finalAnswer: __finalAnswer,
    finalResult: __finalResult,
    result: __resultSnapshot,
    status: 'error',
    stderr: __stderrParts.join(''),
    stdout: __stdoutParts.join(''),
  });
}
`;
}

/**
 * Produces the default result placeholder for worker failures before user code runs.
 */
function createUndefinedSnapshot(): ValueSnapshot {
  return { kind: 'undefined', preview: 'undefined' };
}

/**
 * Normalizes arbitrary thrown values into a serializable error payload.
 */
function createErrorSnapshot(error: unknown, fallbackName = 'Error'): ExecutionErrorSnapshot {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
    name: fallbackName,
  };
}

function wrapWorkerWithCleanup(
  worker: WorkerBridgeLike,
  cleanup: () => void,
): WorkerBridgeLike {
  return {
    get onerror() {
      return worker.onerror;
    },
    set onerror(value) {
      worker.onerror = value;
    },
    get onmessage() {
      return worker.onmessage;
    },
    set onmessage(value) {
      worker.onmessage = value;
    },
    get onmessageerror() {
      return worker.onmessageerror;
    },
    set onmessageerror(value) {
      worker.onmessageerror = value;
    },
    postMessage(message: unknown): void {
      worker.postMessage(message);
    },
    terminate(): void {
      try {
        worker.terminate();
      } finally {
        cleanup();
      }
    },
  };
}

/**
 * Executes one cell in the default Deno worker sandbox.
 */
export async function executeCellInSandbox(
  input: SandboxExecutionInput,
): Promise<SandboxExecutionOutput> {
  if (typeof Worker !== 'function') {
    throw new Error('No global Worker constructor is available in this runtime.');
  }

  return await executeCellInSandboxWithFactory(input, (source, options) => {
    const handle = buildPreferredWorkerSourceHandle(source);
    try {
      const worker = new Worker(handle.url, options) as unknown as WorkerBridgeLike;
      return wrapWorkerWithCleanup(worker, handle.revoke);
    } catch (error) {
      handle.revoke();
      throw error;
    }
  });
}

/**
 * Executes one cell with an injected worker factory so runtime edge cases can be tested.
 */
export async function executeCellInSandboxWithFactory(
  input: SandboxExecutionInput,
  workerFactory: WorkerFactory,
): Promise<SandboxExecutionOutput> {
  const worker = await workerFactory(buildWorkerSource(input), {
    type: 'module',
  });

  return await new Promise<SandboxExecutionOutput>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new SandboxTimeoutError(input.timeoutMs));
    }, input.timeoutMs + SANDBOX_TIMEOUT_GRACE_MS);

    /**
     * Completes the pending execution once the worker reaches a terminal state.
     */
    const finish = (value: SandboxExecutionOutput): void => {
      clearTimeout(timer);
      worker.terminate();
      resolve(value);
    };

    worker.onmessage = (event: MessageEvent<SandboxExecutionOutput>) => {
      finish(event.data);
    };

    worker.onerror = (event: ErrorEvent) => {
      finish(
        {
          error: {
            message: event.message,
            name: 'WorkerError',
          },
          finalAnswer: null,
          finalResult: null,
          result: createUndefinedSnapshot(),
          status: 'error',
          stderr: '',
          stdout: '',
        },
      );
    };

    worker.onmessageerror = () => {
      finish(
        {
          error: {
            message: 'Sandbox worker failed to serialize its response.',
            name: 'MessageError',
          },
          finalAnswer: null,
          finalResult: null,
          result: createUndefinedSnapshot(),
          status: 'error',
          stderr: '',
          stdout: '',
        },
      );
    };
  });
}

/**
 * Tests whether a character can appear inside a JavaScript identifier.
 */
function isIdentifierCharacter(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_$]/u.test(char);
}

/**
 * Skips over contiguous whitespace from the provided cursor.
 */
function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/u.test(source[index])) {
    index += 1;
  }

  return index;
}

/**
 * Checks whether a keyword match is isolated from adjacent identifier characters.
 */
function hasKeywordBoundary(source: string, start: number, length: number): boolean {
  return !isIdentifierCharacter(source[start - 1]) &&
    !isIdentifierCharacter(source[start + length]);
}

/**
 * Tracks whether the current scanner position is nested inside non-top-level syntax.
 */
function createScannerState() {
  return {
    braces: 0,
    brackets: 0,
    canStartStatement: true,
    parens: 0,
    regexCharClass: false,
    state: 'code' as
      | 'block-comment'
      | 'code'
      | 'double'
      | 'line-comment'
      | 'regex'
      | 'single'
      | 'template',
  };
}

/**
 * Finds the previous non-whitespace character index before one scanner position.
 */
function findPreviousSignificantIndex(source: string, start: number): number {
  let index = start - 1;
  while (index >= 0 && /\s/u.test(source[index])) {
    index -= 1;
  }

  return index;
}

/**
 * Heuristically decides whether one slash starts a regex literal instead of division.
 */
function startsRegexLiteral(source: string, index: number): boolean {
  const next = source[index + 1];
  if (next === '/' || next === '*') {
    return false;
  }

  const previousIndex = findPreviousSignificantIndex(source, index);
  if (previousIndex < 0) {
    return true;
  }

  const previousChar = source[previousIndex];
  if ('([{:,;=!?&|+-*%^~<>'.includes(previousChar)) {
    return true;
  }

  if (
    previousChar === ')' || previousChar === ']' || previousChar === '}' || previousChar === '.'
  ) {
    return false;
  }

  const prefix = source.slice(Math.max(0, previousIndex - 16), previousIndex + 1);
  return /\b(?:return|case|throw|typeof|instanceof|in|of|delete|void|new|await|yield)$/
    .test(prefix);
}

/**
 * Advances a lightweight JavaScript scanner by one character.
 */
function advanceScanner(
  source: string,
  index: number,
  scanner = createScannerState(),
): {
  nextIndex: number;
  scanner: ReturnType<typeof createScannerState>;
} {
  const char = source[index];
  const next = source[index + 1];

  if (scanner.state === 'code') {
    if (char === "'" || char === '"' || char === '`') {
      scanner.state = char === "'" ? 'single' : char === '"' ? 'double' : 'template';
      scanner.canStartStatement = false;
      return { nextIndex: index + 1, scanner };
    }

    if (char === '/' && next === '/') {
      scanner.state = 'line-comment';
      return { nextIndex: index + 2, scanner };
    }

    if (char === '/' && next === '*') {
      scanner.state = 'block-comment';
      return { nextIndex: index + 2, scanner };
    }

    if (char === '/' && startsRegexLiteral(source, index)) {
      scanner.state = 'regex';
      scanner.regexCharClass = false;
      scanner.canStartStatement = false;
      return { nextIndex: index + 1, scanner };
    }

    if (char === '{') {
      scanner.braces += 1;
      scanner.canStartStatement = false;
      return { nextIndex: index + 1, scanner };
    }

    if (char === '}') {
      scanner.braces = Math.max(0, scanner.braces - 1);
      scanner.canStartStatement = scanner.braces === 0 &&
        scanner.brackets === 0 &&
        scanner.parens === 0;
      return { nextIndex: index + 1, scanner };
    }

    if (char === '(') {
      scanner.parens += 1;
      scanner.canStartStatement = false;
      return { nextIndex: index + 1, scanner };
    }

    if (char === ')') {
      scanner.parens = Math.max(0, scanner.parens - 1);
      return { nextIndex: index + 1, scanner };
    }

    if (char === '[') {
      scanner.brackets += 1;
      scanner.canStartStatement = false;
      return { nextIndex: index + 1, scanner };
    }

    if (char === ']') {
      scanner.brackets = Math.max(0, scanner.brackets - 1);
      return { nextIndex: index + 1, scanner };
    }

    if (scanner.braces === 0 && scanner.brackets === 0 && scanner.parens === 0) {
      if (char === ';' || char === '\n') {
        scanner.canStartStatement = true;
        return { nextIndex: index + 1, scanner };
      }

      if (!/\s/u.test(char)) {
        scanner.canStartStatement = false;
      }
    }

    return { nextIndex: index + 1, scanner };
  }

  if (scanner.state === 'regex') {
    if (char === '\\') {
      return {
        nextIndex: Math.min(source.length, index + 2),
        scanner,
      };
    }

    if (char === '[') {
      scanner.regexCharClass = true;
      return { nextIndex: index + 1, scanner };
    }

    if (char === ']' && scanner.regexCharClass) {
      scanner.regexCharClass = false;
      return { nextIndex: index + 1, scanner };
    }

    if (char === '/' && !scanner.regexCharClass) {
      scanner.state = 'code';
      let nextIndex = index + 1;
      while (/[A-Za-z]/u.test(source[nextIndex] ?? '')) {
        nextIndex += 1;
      }

      return { nextIndex, scanner };
    }

    return { nextIndex: index + 1, scanner };
  }

  if (scanner.state === 'line-comment') {
    if (char === '\n') {
      scanner.state = 'code';
      scanner.canStartStatement = scanner.braces === 0 &&
        scanner.brackets === 0 &&
        scanner.parens === 0;
    }

    return { nextIndex: index + 1, scanner };
  }

  if (scanner.state === 'block-comment') {
    if (char === '*' && next === '/') {
      scanner.state = 'code';
      return { nextIndex: index + 2, scanner };
    }

    return { nextIndex: index + 1, scanner };
  }

  if (char === '\\') {
    return {
      nextIndex: Math.min(source.length, index + 2),
      scanner,
    };
  }

  const quote = scanner.state === 'single' ? "'" : scanner.state === 'double' ? '"' : '`';
  if (char === quote) {
    scanner.state = 'code';
  }

  return { nextIndex: index + 1, scanner };
}

/**
 * Finds the end index of a top-level statement.
 */
function findStatementEnd(source: string, start: number): number {
  const scanner = createScannerState();
  let index = start;

  while (index < source.length) {
    const char = source[index];
    if (
      scanner.state === 'code' &&
      scanner.braces === 0 &&
      scanner.brackets === 0 &&
      scanner.parens === 0 &&
      char === ';'
    ) {
      return index + 1;
    }

    const advanced = advanceScanner(source, index, scanner);
    index = advanced.nextIndex;
  }

  return source.length;
}

/**
 * Finds the end index of a braced block starting at the provided opening brace.
 */
function findBracedBlockEnd(source: string, openingBrace: number): number {
  const scanner = createScannerState();
  scanner.braces = 1;
  let index = openingBrace + 1;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (scanner.state === 'code') {
      if (char === "'" || char === '"' || char === '`') {
        scanner.state = char === "'" ? 'single' : char === '"' ? 'double' : 'template';
        index += 1;
        continue;
      }

      if (char === '/' && next === '/') {
        scanner.state = 'line-comment';
        index += 2;
        continue;
      }

      if (char === '/' && next === '*') {
        scanner.state = 'block-comment';
        index += 2;
        continue;
      }

      if (char === '{') {
        scanner.braces += 1;
        index += 1;
        continue;
      }

      if (char === '}') {
        scanner.braces -= 1;
        index += 1;
        if (scanner.braces === 0) {
          return index;
        }

        continue;
      }

      index += 1;
      continue;
    }

    if (scanner.state === 'line-comment') {
      if (char === '\n') {
        scanner.state = 'code';
      }

      index += 1;
      continue;
    }

    if (scanner.state === 'block-comment') {
      if (char === '*' && next === '/') {
        scanner.state = 'code';
        index += 2;
        continue;
      }

      index += 1;
      continue;
    }

    if (char === '\\') {
      index += 2;
      continue;
    }

    const quote = scanner.state === 'single' ? "'" : scanner.state === 'double' ? '"' : '`';
    if (char === quote) {
      scanner.state = 'code';
    }

    index += 1;
  }

  return source.length;
}

/**
 * Splits a string on top-level delimiters while ignoring nested structures.
 */
function splitTopLevel(source: string, delimiter: string): string[] {
  const parts: string[] = [];
  const scanner = createScannerState();
  let cursor = 0;
  let index = 0;

  while (index < source.length) {
    if (
      scanner.state === 'code' &&
      scanner.braces === 0 &&
      scanner.brackets === 0 &&
      scanner.parens === 0 &&
      source[index] === delimiter
    ) {
      parts.push(source.slice(cursor, index));
      cursor = index + 1;
      index += 1;
      continue;
    }

    const advanced = advanceScanner(source, index, scanner);
    index = advanced.nextIndex;
  }

  parts.push(source.slice(cursor));
  return parts;
}

/**
 * Finds the initializer operator for one variable declarator.
 */
function findDeclaratorAssignment(source: string): number | null {
  const scanner = createScannerState();
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    const previous = source[index - 1];

    if (
      scanner.state === 'code' &&
      scanner.braces === 0 &&
      scanner.brackets === 0 &&
      scanner.parens === 0 &&
      char === '=' &&
      previous !== '=' &&
      previous !== '!' &&
      previous !== '<' &&
      previous !== '>' &&
      next !== '=' &&
      next !== '>'
    ) {
      return index;
    }

    const advanced = advanceScanner(source, index, scanner);
    index = advanced.nextIndex;
  }

  return null;
}

/**
 * Converts a top-level declarator into an assignment that persists inside the proxy scope.
 */
function rewriteDeclarator(source: string): string {
  const declarator = source.trim();
  if (declarator.length === 0) {
    return '';
  }

  const assignmentIndex = findDeclaratorAssignment(declarator);
  const left = (assignmentIndex === null ? declarator : declarator.slice(0, assignmentIndex))
    .trim();
  const right = assignmentIndex === null
    ? 'undefined'
    : declarator.slice(assignmentIndex + 1).trim();
  const assignment = `${left} = ${right}`;

  if (left.startsWith('{') || left.startsWith('[')) {
    return `(${assignment})`;
  }

  return assignment;
}

/**
 * Rewrites one top-level variable declaration statement.
 */
function rewriteVariableDeclaration(
  source: string,
  start: number,
  keywordLength: number,
): { end: number; replacement: string } {
  const end = findStatementEnd(source, start);
  const trailingSemicolon = source[end - 1] === ';';
  const bodyEnd = trailingSemicolon ? end - 1 : end;
  const declarators = source.slice(start + keywordLength, bodyEnd);
  const rewritten = splitTopLevel(declarators, ',')
    .map((declarator) => rewriteDeclarator(declarator))
    .filter((declarator) => declarator.length > 0)
    .join(';\n');

  return {
    end,
    replacement: rewritten.length === 0 ? '' : `${rewritten};`,
  };
}

/**
 * Rewrites one top-level function declaration into an assignment expression.
 */
function rewriteFunctionDeclaration(
  source: string,
  start: number,
): { end: number; replacement: string } {
  let cursor = start;

  if (source.startsWith('async', cursor)) {
    cursor += 'async'.length;
    cursor = skipWhitespace(source, cursor);
  }

  cursor += 'function'.length;
  cursor = skipWhitespace(source, cursor);

  if (source[cursor] === '*') {
    cursor += 1;
    cursor = skipWhitespace(source, cursor);
  }

  const nameStart = cursor;
  while (isIdentifierCharacter(source[cursor])) {
    cursor += 1;
  }

  const name = source.slice(nameStart, cursor);
  let braceIndex = cursor;
  while (braceIndex < source.length && source[braceIndex] !== '{') {
    braceIndex += 1;
  }

  const bodyEnd = findBracedBlockEnd(source, braceIndex);
  const end = source[bodyEnd] === ';' ? bodyEnd + 1 : bodyEnd;
  const declaration = source.slice(start, end).trim().replace(/;$/u, '');

  return {
    end,
    replacement: `${name} = ${declaration};`,
  };
}

/**
 * Rewrites one top-level class declaration into an assignment expression.
 */
function rewriteClassDeclaration(
  source: string,
  start: number,
): { end: number; replacement: string } {
  let cursor = start + 'class'.length;
  cursor = skipWhitespace(source, cursor);

  const nameStart = cursor;
  while (isIdentifierCharacter(source[cursor])) {
    cursor += 1;
  }

  const name = source.slice(nameStart, cursor);
  let braceIndex = cursor;
  while (braceIndex < source.length && source[braceIndex] !== '{') {
    braceIndex += 1;
  }

  const bodyEnd = findBracedBlockEnd(source, braceIndex);
  const end = source[bodyEnd] === ';' ? bodyEnd + 1 : bodyEnd;
  const declaration = source.slice(start, end).trim().replace(/;$/u, '');

  return {
    end,
    replacement: `${name} = ${declaration};`,
  };
}

/**
 * Rewrites persistent top-level bindings so later cells can reuse them from the proxy scope.
 */
function rewriteTopLevelBindings(source: string): string {
  const scanner = createScannerState();
  let cursor = 0;
  let output = '';
  let segmentStart = 0;

  while (cursor < source.length) {
    const topLevel = scanner.state === 'code' &&
      scanner.braces === 0 &&
      scanner.brackets === 0 &&
      scanner.parens === 0 &&
      scanner.canStartStatement;

    if (topLevel) {
      const isAsyncFunction = source.startsWith('async', cursor) &&
        hasKeywordBoundary(source, cursor, 'async'.length) &&
        /^\s*function\b/u.test(source.slice(cursor + 'async'.length));
      const isFunction = source.startsWith('function', cursor) &&
        hasKeywordBoundary(source, cursor, 'function'.length);
      const isClass = source.startsWith('class', cursor) &&
        hasKeywordBoundary(source, cursor, 'class'.length);
      const isConst = source.startsWith('const', cursor) &&
        hasKeywordBoundary(source, cursor, 'const'.length);
      const isLet = source.startsWith('let', cursor) &&
        hasKeywordBoundary(source, cursor, 'let'.length);
      const isVar = source.startsWith('var', cursor) &&
        hasKeywordBoundary(source, cursor, 'var'.length);

      let rewritten: { end: number; replacement: string } | null = null;
      if (isAsyncFunction || isFunction) {
        rewritten = rewriteFunctionDeclaration(source, cursor);
      } else if (isClass) {
        rewritten = rewriteClassDeclaration(source, cursor);
      } else if (isConst) {
        rewritten = rewriteVariableDeclaration(source, cursor, 'const'.length);
      } else if (isLet) {
        rewritten = rewriteVariableDeclaration(source, cursor, 'let'.length);
      } else if (isVar) {
        rewritten = rewriteVariableDeclaration(source, cursor, 'var'.length);
      }

      if (rewritten !== null) {
        output += source.slice(segmentStart, cursor);
        output += rewritten.replacement;
        cursor = rewritten.end;
        segmentStart = rewritten.end;
        scanner.canStartStatement = true;
        continue;
      }
    }

    const advanced = advanceScanner(source, cursor, scanner);
    cursor = advanced.nextIndex;
  }

  output += source.slice(segmentStart);
  return output;
}

/**
 * Converts one cell into a persistent-runtime program that writes its visible result explicitly.
 */
function buildPersistentCellCode(source: string): string {
  const { body, expression } = splitTrailingExpression(source);
  const rewrittenBody = rewriteTopLevelBindings(body);
  const bodyBlock = rewrittenBody.trim().length === 0 ? '' : `${rewrittenBody}\n`;

  if (expression === null) {
    return `${bodyBlock}__setResult(undefined);`;
  }

  return `${bodyBlock}__setResult(${expression});`;
}

function buildRuntimeHelperReservedBindingsSource(runtimeHelpers: RLMRuntimeHelper[]): string {
  return runtimeHelpers.map((helper) => `  ${JSON.stringify(helper.name)},`).join('\n');
}

function buildRuntimeHelperExecutionCode(source: string): string {
  const { body, expression } = splitTrailingExpression(source);
  const rewrittenBody = rewriteTopLevelBindings(body);
  const bodyBlock = rewrittenBody.trim().length === 0 ? '' : `${rewrittenBody}\n`;

  if (expression === null) {
    return bodyBlock;
  }

  return `${bodyBlock}return (${expression});`;
}

function buildRuntimeHelperAllowedInputKinds(helper: RLMRuntimeHelper): ReadonlyArray<string> {
  return helper.inputKinds ?? ['text'];
}

function buildRuntimeHelperInputKindsLabel(helper: RLMRuntimeHelper): string {
  const inputKinds = buildRuntimeHelperAllowedInputKinds(helper);
  if (inputKinds.length === 1) {
    return inputKinds[0];
  }

  return inputKinds.join(' or ');
}

function buildRuntimeHelperDefinitionsSource(runtimeHelpers: RLMRuntimeHelper[]): string {
  return runtimeHelpers.map((helper) => {
    const executionCode = buildRuntimeHelperExecutionCode(helper.source);
    const allowedKinds = buildRuntimeHelperAllowedInputKinds(helper);
    const inputKindsLabel = buildRuntimeHelperInputKindsLabel(helper);
    const helperRLMQueryMaxSteps = helper.rlmQueryMaxSteps ?? Number.POSITIVE_INFINITY;
    const helperRLMQueryMaxSubcallDepth = helper.rlmQueryMaxSubcallDepth ?? 1;
    const helperRLMQueryMaxStepsLiteral = helperRLMQueryMaxSteps === Number.POSITIVE_INFINITY
      ? 'Number.POSITIVE_INFINITY'
      : String(helperRLMQueryMaxSteps);
    const acceptsString = allowedKinds.includes('text') ||
      allowedKinds.includes('source') ||
      allowedKinds.includes('repl_code');
    const acceptsObject = allowedKinds.includes('object');
    const acceptsArray = allowedKinds.includes('array');
    const timeoutGuardSource = helper.timeoutMs === undefined ? 'return await __run();' : [
      'let __timeoutId = null;',
      'try {',
      '  return await new Promise((resolve, reject) => {',
      `    __timeoutId = setTimeout(() => reject(new Error(${
        JSON.stringify(`Runtime helper ${helper.name} timed out after ${helper.timeoutMs}ms.`)
      })), ${helper.timeoutMs});`,
      '    Promise.resolve(__run()).then(',
      '      (value) => {',
      '        if (__timeoutId !== null) {',
      '          clearTimeout(__timeoutId);',
      '        }',
      '        resolve(value);',
      '      },',
      '      (error) => {',
      '        if (__timeoutId !== null) {',
      '          clearTimeout(__timeoutId);',
      '        }',
      '        reject(error);',
      '      },',
      '    );',
      '  });',
      '} finally {',
      '  if (__timeoutId !== null) {',
      '    clearTimeout(__timeoutId);',
      '  }',
      '}',
    ].join('\n');

    return `const ${helper.name} = async (input) => {
  if (input === undefined || input === null) {
    throw new Error(${
      JSON.stringify(`Runtime helper ${helper.name} requires a non-null ${inputKindsLabel} input.`)
    });
  }

  let __matchesInputType = false;
  if (${acceptsString}) {
    if (typeof input === 'string') {
      if (input.trim().length === 0) {
        throw new Error(${
      JSON.stringify(
        `Runtime helper ${helper.name} expects ${inputKindsLabel} input, and string inputs must be non-empty.`,
      )
    });
      }

      __matchesInputType = true;
    }
  }

  if (${acceptsObject} && typeof input === 'object' && input !== null && !Array.isArray(input)) {
    __matchesInputType = true;
  }

  if (${acceptsArray} && Array.isArray(input)) {
    __matchesInputType = true;
  }

  if (!__matchesInputType) {
    throw new Error(${
      JSON.stringify(`Runtime helper ${helper.name} expects ${inputKindsLabel} input.`)
    });
  }

  const __helperHasExplicitRLMQueryDepth = (prompt) =>
    typeof prompt === 'object' &&
    prompt !== null &&
    !Array.isArray(prompt) &&
    Object.prototype.hasOwnProperty.call(prompt, 'maxSubcallDepth');
  const __helperHasExplicitRLMQueryMaxSteps = (prompt) =>
    typeof prompt === 'object' &&
    prompt !== null &&
    !Array.isArray(prompt) &&
    Object.prototype.hasOwnProperty.call(prompt, 'maxSteps');
  const __helperBuildRLMQueryOptions = (prompt, options) => {
    if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
      return options;
    }

    const __mergedOptions = options === undefined ? {} : { ...options };

    if (
      !__helperHasExplicitRLMQueryDepth(prompt) &&
      !Object.prototype.hasOwnProperty.call(__mergedOptions, 'maxSubcallDepth')
    ) {
      __mergedOptions.maxSubcallDepth = ${helperRLMQueryMaxSubcallDepth};
    }

    if (
      !__helperHasExplicitRLMQueryMaxSteps(prompt) &&
      !Object.prototype.hasOwnProperty.call(__mergedOptions, 'maxSteps')
    ) {
      __mergedOptions.maxSteps = ${helperRLMQueryMaxStepsLiteral};
    }

    return Object.keys(__mergedOptions).length === 0 ? undefined : __mergedOptions;
  };
  const __helperRLMQuery = (prompt, options) => {
    const __mergedOptions = __helperBuildRLMQueryOptions(prompt, options);
    return __mergedOptions === undefined ? rlm_query(prompt) : rlm_query(prompt, __mergedOptions);
  };
  const __helperRLMQueryBatched = (prompts, options) => {
    if (!Array.isArray(prompts) || prompts.length === 0) {
      return rlm_query_batched(prompts);
    }

    return Promise.all(prompts.map((prompt) => __helperRLMQuery(prompt, options)));
  };

  const __helperState = Object.create(null);
  const __helperScope = new Proxy(__helperState, {
    deleteProperty(target, key) {
      if (typeof key === 'string' && (key === 'input' || __reservedBindings.has(key))) {
        return false;
      }

      return Reflect.deleteProperty(target, key);
    },
    get(target, key) {
      if (key === Symbol.unscopables) {
        return undefined;
      }

      if (key === 'input') {
        return input;
      }

      if (typeof key === 'string' && key in __runtimeHelpers) {
        return __runtimeHelpers[key];
      }

      if (key === 'context') {
        return __context;
      }

      if (key === 'history') {
        return __history;
      }

      if (key === 'grep') {
        return grep;
      }

      if (key === 'llm_query') {
        return llm_query;
      }

      if (key === 'llm_query_batched') {
        return llm_query_batched;
      }

      if (key === 'rlm_query') {
        return __helperRLMQuery;
      }

      if (key === 'rlm_query_batched') {
        return __helperRLMQueryBatched;
      }

      if (Reflect.has(target, key)) {
        return Reflect.get(target, key);
      }

      return globalThis[key];
    },
    has(_target, key) {
      if (key === Symbol.unscopables) {
        return false;
      }

      return typeof key !== 'string' || !__excludedBindings.has(key);
    },
    set(target, key, value) {
      if (typeof key === 'string' && (key === 'input' || __reservedBindings.has(key))) {
        throw new Error('Reserved REPL identifiers cannot be reassigned or redeclared.');
      }

      Reflect.set(target, key, value);
      return true;
    },
  });

  const __AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const __runner = new __AsyncFunction(
    '__scope',
    'input',
    ${JSON.stringify(`with (__scope) {\n${executionCode}\n}`)},
  );
  const __run = () => __runner(__helperScope, input);
  ${timeoutGuardSource}
};`;
  }).join('\n\n');
}

function buildRuntimeHelperRegistrySource(runtimeHelpers: RLMRuntimeHelper[]): string {
  if (runtimeHelpers.length === 0) {
    return 'const __runtimeHelpers = Object.freeze({});';
  }

  return [
    'const __runtimeHelpers = Object.freeze({',
    ...runtimeHelpers.map((helper) => `  ${JSON.stringify(helper.name)}: ${helper.name},`),
    '});',
  ].join('\n');
}

/**
 * Builds the worker module used by the long-lived persistent interpreter.
 */
function buildPersistentWorkerSource(runtimeHelpers: RLMRuntimeHelper[] = []): string {
  return `
// @ts-nocheck
const __hostPost = globalThis.postMessage.bind(globalThis);
const __addEventListener = globalThis.addEventListener.bind(globalThis);
const __stdoutParts = [];
const __stderrParts = [];
const __stateStore = Object.create(null);
const __pendingQueries = new Map();
const __reservedBindings = new Set([
  'FINAL',
  'FINAL_VAR',
  'SHOW_VARS',
  'context',
  'grep',
  'history',
  'llm_query',
  'llm_query_batched',
  'rlm_query',
  'rlm_query_batched',
${buildRuntimeHelperReservedBindingsSource(runtimeHelpers)}
]);
const __excludedBindings = new Set(['__scope', '__setResult']);

let __context = null;
let __history = Object.freeze([]);
let __captureFinals = false;
let __finalAnswer = null;
let __finalResult = null;
let __nextQueryId = 0;
let __resultSnapshot = { kind: 'undefined', preview: 'undefined' };

const __disableGlobal = (name) => {
  try {
    Object.defineProperty(globalThis, name, {
      configurable: false,
      value: undefined,
      writable: false,
    });
    return;
  } catch (_) {
    // Fall through to direct assignment.
  }

  try {
    globalThis[name] = undefined;
  } catch (_) {
    // Ignore best-effort lockdown failures.
  }
};

const __stableStringify = (value, depth = 0) => {
  if (value === null) {
    return null;
  }

  if (depth > 3) {
    return '[MaxDepth]';
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((entry) => __stableStringify(entry, depth + 1));
  }

  const valueType = typeof value;
  if (valueType === 'boolean' || valueType === 'number' || valueType === 'string') {
    return value;
  }

  if (valueType === 'bigint') {
    return value.toString();
  }

  if (valueType !== 'object') {
    return undefined;
  }

  const entries = Object.entries(value).slice(0, 10);
  const snapshot = {};

  for (const [key, nested] of entries) {
    const serialized = __stableStringify(nested, depth + 1);
    if (serialized !== undefined) {
      snapshot[key] = serialized;
    }
  }

  return snapshot;
};

const __previewValue = (value) => {
  if (value === null) {
    return 'null';
  }

  if (value === undefined) {
    return 'undefined';
  }

  const valueType = typeof value;

  if (valueType === 'string') {
    return value;
  }

  if (valueType === 'number' || valueType === 'boolean' || valueType === 'bigint') {
    return String(value);
  }

  if (valueType === 'function') {
    return '[Function]';
  }

  if (valueType === 'symbol') {
    return value.toString();
  }

  try {
    const stable = __stableStringify(value);
    if (stable !== undefined) {
      return JSON.stringify(stable);
    }
  } catch (_) {
    // Fall through to Object.prototype.
  }

  return Object.prototype.toString.call(value);
};

const __createSignal = (path, value) => {
  if (value === undefined && path === '$') {
    return null;
  }

  if (value === null) {
    return { kind: 'null', path, preview: 'null' };
  }

  const valueType = typeof value;
  if (
    valueType === 'bigint' ||
    valueType === 'boolean' ||
    valueType === 'number' ||
    valueType === 'string' ||
    valueType === 'undefined'
  ) {
    return {
      kind: valueType,
      path,
      preview: __previewValue(value),
    };
  }

  return null;
};

const __signalPathSegment = (key) =>
  /^[A-Za-z_$][\\w$]*$/.test(key) ? '.' + key : '[' + JSON.stringify(key) + ']';

const __collectSignals = (value, path = '$', depth = 0, signals = []) => {
  if (signals.length >= 16 || depth > 4) {
    return signals;
  }

  const signal = __createSignal(path, value);
  if (signal !== null) {
    signals.push(signal);
    return signals;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, 8); index += 1) {
      if (signals.length >= 16) {
        break;
      }

      __collectSignals(value[index], path + '[' + index + ']', depth + 1, signals);
    }

    return signals;
  }

  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value).slice(0, 8)) {
      if (signals.length >= 16) {
        break;
      }

      __collectSignals(nested, path + __signalPathSegment(key), depth + 1, signals);
    }
  }

  return signals;
};

const __snapshotValue = (value) => {
  const json = __stableStringify(value);
  const signals = __collectSignals(value);
  const base = {
    kind: value === null
      ? 'null'
      : Array.isArray(value)
      ? 'array'
      : typeof value,
    preview: __previewValue(value),
  };

  if (signals.length > 0) {
    base.signals = signals;
  }

  if (json === undefined) {
    return base;
  }

  return { ...base, json };
};

const __deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);

    for (const nested of Object.values(value)) {
      __deepFreeze(nested);
    }
  }

  return value;
};

const __appendHistory = (entries) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return;
  }

  const frozenEntries = entries.map((entry) => __deepFreeze(structuredClone(entry)));
  __history = Object.freeze(__history.concat(frozenEntries));
};

const __write = (parts, values) => {
  parts.push(values.map((value) => __previewValue(value)).join(' ') + '\\n');
};

const __toError = (snapshot) => {
  const error = new Error(snapshot.message);
  error.name = snapshot.name;
  if (snapshot.stack) {
    error.stack = snapshot.stack;
  }

  return error;
};

const __console = {
  debug: (...values) => __write(__stdoutParts, values),
  error: (...values) => __write(__stderrParts, values),
  info: (...values) => __write(__stdoutParts, values),
  log: (...values) => __write(__stdoutParts, values),
  warn: (...values) => __write(__stderrParts, values),
};

globalThis.console = __console;

for (const __globalName of [
  'BroadcastChannel',
  'EventSource',
  'SharedWorker',
  'WebSocket',
  'Worker',
  'caches',
  'close',
  'fetch',
  'indexedDB',
  'localStorage',
  'navigator',
  'onmessage',
  'postMessage',
  'sessionStorage',
]) {
  __disableGlobal(__globalName);
}

${buildSandboxGuardSource()}
${buildGrepSource()}

const FINAL = (value) => {
  if (__captureFinals) {
    __finalAnswer = __previewValue(value);
    __finalResult = __snapshotValue(value);
  }

  return value;
};

const FINAL_VAR = (value) => FINAL(value);

const SHOW_VARS = () => Object.keys(__stateStore)
  .filter((key) => !__reservedBindings.has(key) && !__excludedBindings.has(key))
  .sort();

const llm_query = (prompt) => new Promise((resolve, reject) => {
  if (prompt === undefined || prompt === null) {
    reject(new Error('llm_query requires a concrete prompt.'));
    return;
  }

  const promptText = String(prompt);
  if (promptText.trim().length === 0) {
    reject(new Error('llm_query requires a non-empty prompt.'));
    return;
  }

  const queryId = __nextQueryId++;
  __pendingQueries.set(queryId, { reject, resolve });
  __hostPost({
    prompt: promptText,
    queryId,
    type: 'llm_query_request',
  });
});

const llm_query_batched = (prompts) => {
  if (!Array.isArray(prompts) || prompts.length === 0) {
    return Promise.reject(new Error('llm_query_batched requires a non-empty prompt array.'));
  }

  const normalized = [];
  for (const prompt of prompts) {
    if (prompt === undefined || prompt === null) {
      return Promise.reject(new Error('llm_query_batched requires each prompt to be concrete and non-empty.'));
    }

    const promptText = String(prompt);
    if (promptText.trim().length === 0) {
      return Promise.reject(new Error('llm_query_batched requires each prompt to be concrete and non-empty.'));
    }

    normalized.push(promptText);
  }

  return Promise.all(normalized.map((prompt) => llm_query(prompt)));
};

const __normalizeRLMQueryInvocationOptions = (options) => {
  if (options === undefined) {
    return {};
  }

  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('rlm_query invocation options must be an object.');
  }

  const normalized = {};
  if (Object.prototype.hasOwnProperty.call(options, 'maxSubcallDepth')) {
    const maxSubcallDepth = options.maxSubcallDepth;
    if (!Number.isInteger(maxSubcallDepth) || maxSubcallDepth < 1) {
      throw new Error('rlm_query maxSubcallDepth must be a positive integer.');
    }

    normalized.maxSubcallDepth = maxSubcallDepth;
  }

  if (Object.prototype.hasOwnProperty.call(options, 'maxSteps')) {
    const maxSteps = options.maxSteps;
    if (maxSteps !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxSteps) || maxSteps < 1)) {
      throw new Error(
        'rlm_query maxSteps must be a positive integer or Number.POSITIVE_INFINITY.',
      );
    }

    normalized.maxSteps = maxSteps;
  }

  return normalized;
};

const rlm_query = (prompt, options) => new Promise((resolve, reject) => {
  if (prompt === undefined || prompt === null) {
    reject(new Error('rlm_query requires a concrete prompt.'));
    return;
  }

  let queryOptions;
  try {
    queryOptions = __normalizeRLMQueryInvocationOptions(options);
  } catch (error) {
    reject(error);
    return;
  }

  let delegatedRequest;
  if (typeof prompt === 'string') {
    const promptText = String(prompt);
    if (promptText.trim().length === 0) {
      reject(new Error('rlm_query requires a non-empty prompt.'));
      return;
    }
    delegatedRequest = promptText;
  } else if (typeof prompt === 'object' && prompt !== null && !Array.isArray(prompt)) {
    const task = prompt.task;
    if (typeof task !== 'string') {
      reject(new Error('rlm_query object requests require a string task.'));
      return;
    }
    if (task.trim().length === 0) {
      reject(new Error('rlm_query requires a non-empty task.'));
      return;
    }
    delegatedRequest = prompt;
  } else {
    reject(new Error('rlm_query expects either a task string or an object with a task field.'));
    return;
  }

  const queryId = __nextQueryId++;
  __pendingQueries.set(queryId, { reject, resolve });
  __hostPost({
    maxSteps: queryOptions.maxSteps,
    maxSubcallDepth: queryOptions.maxSubcallDepth,
    prompt: delegatedRequest,
    queryId,
    type: 'rlm_query_request',
  });
});

const rlm_query_batched = (prompts) => {
  if (!Array.isArray(prompts) || prompts.length === 0) {
    return Promise.reject(new Error('rlm_query_batched requires a non-empty prompt array.'));
  }

  const normalized = [];
  for (const prompt of prompts) {
    if (typeof prompt === 'string') {
      if (prompt.trim().length === 0) {
        return Promise.reject(
          new Error('rlm_query_batched expects each entry to be either a non-empty task string or an object with a non-empty task field.'),
        );
      }
      normalized.push(prompt);
      continue;
    }

    if (typeof prompt === 'object' && prompt !== null && !Array.isArray(prompt)) {
      if (typeof prompt.task !== 'string' || prompt.task.trim().length === 0) {
        return Promise.reject(
          new Error('rlm_query_batched expects each entry to be either a non-empty task string or an object with a non-empty task field.'),
        );
      }
      normalized.push(prompt);
      continue;
    }

    return Promise.reject(
      new Error('rlm_query_batched expects each entry to be either a non-empty task string or an object with a non-empty task field.'),
    );
  }

  return Promise.all(normalized.map((prompt) => rlm_query(prompt)));
};

${buildRuntimeHelperDefinitionsSource(runtimeHelpers)}

${buildRuntimeHelperRegistrySource(runtimeHelpers)}

const __scope = new Proxy(__stateStore, {
  deleteProperty(target, key) {
    if (typeof key === 'string' && __reservedBindings.has(key)) {
      return false;
    }

    return Reflect.deleteProperty(target, key);
  },
  get(target, key) {
    if (key === Symbol.unscopables) {
      return undefined;
    }

    if (key === 'context') {
      return __context;
    }

    if (key === 'history') {
      return __history;
    }

    if (key === 'FINAL') {
      return FINAL;
    }

    if (key === 'FINAL_VAR') {
      return FINAL_VAR;
    }

    if (key === 'SHOW_VARS') {
      return SHOW_VARS;
    }

    if (key === 'llm_query') {
      return llm_query;
    }

    if (key === 'llm_query_batched') {
      return llm_query_batched;
    }

    if (key === 'grep') {
      return grep;
    }

    if (key === 'rlm_query') {
      return rlm_query;
    }

    if (key === 'rlm_query_batched') {
      return rlm_query_batched;
    }

    if (typeof key === 'string' && key in __runtimeHelpers) {
      return __runtimeHelpers[key];
    }

    if (Reflect.has(target, key)) {
      return Reflect.get(target, key);
    }

    return globalThis[key];
  },
  has(_target, key) {
    if (key === Symbol.unscopables) {
      return false;
    }

    return typeof key !== 'string' || !__excludedBindings.has(key);
  },
  set(target, key, value) {
    if (typeof key === 'string' && __reservedBindings.has(key)) {
      throw new Error('Reserved REPL identifiers cannot be reassigned or redeclared.');
    }

    Reflect.set(target, key, value);
    return true;
  },
});

const __execute = async (message) => {
  __stdoutParts.length = 0;
  __stderrParts.length = 0;
  __captureFinals = message.captureFinals;
  __finalAnswer = null;
  __finalResult = null;
  __appendHistory(message.historyDelta);
  __resultSnapshot = __snapshotValue(undefined);

  try {
    const __AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const __runner = new __AsyncFunction(
      '__scope',
      '__setResult',
      "with (__scope) {\\n" + message.code + "\\n}",
    );

    await __runner(__scope, (value) => {
      __resultSnapshot = __snapshotValue(value);
    });

    __hostPost({
      error: null,
      finalAnswer: __finalAnswer,
      finalResult: __finalResult,
      requestId: message.requestId,
      result: __resultSnapshot,
      status: 'success',
      stderr: __stderrParts.join(''),
      stdout: __stdoutParts.join(''),
      type: 'execute_result',
    });
  } catch (error) {
    const __error = error instanceof Error
      ? { message: error.message, name: error.name, stack: error.stack }
      : { message: String(error), name: 'Error' };

    __hostPost({
      error: __error,
      finalAnswer: __finalAnswer,
      finalResult: __finalResult,
      requestId: message.requestId,
      result: __resultSnapshot,
      status: 'error',
      stderr: __stderrParts.join(''),
      stdout: __stdoutParts.join(''),
      type: 'execute_result',
    });
  }
};

const __handleMessage = async (message) => {
  if (message.type === 'init') {
    __context = __deepFreeze(structuredClone(message.context));
    return;
  }

  if (message.type === 'llm_query_response') {
    const pending = __pendingQueries.get(message.queryId);
    if (pending) {
      __pendingQueries.delete(message.queryId);
      if (typeof message.stdout === 'string' && message.stdout.length > 0) {
        __stdoutParts.push(
          message.stdout.endsWith('\\n') ? message.stdout : message.stdout + '\\n',
        );
      }
      pending.resolve(message.value);
    }

    return;
  }

  if (message.type === 'llm_query_error') {
    const pending = __pendingQueries.get(message.queryId);
    if (pending) {
      __pendingQueries.delete(message.queryId);
      pending.reject(__toError(message.error));
    }

    return;
  }

  if (message.type === 'execute') {
    await __execute(message);
  }
};

__addEventListener('message', (event) => {
  void __handleMessage(event.data);
});
`;
}

/**
 * Manages a single long-lived worker that preserves successful interpreter state.
 */
export class PersistentSandboxRuntime {
  readonly #context: JsonValue | null;
  readonly #llmQueryHandler?: LLMQueryHandler;
  readonly #rlmQueryHandler?: RLMQueryHandler;
  readonly #runtimeHelpers: ReadonlyArray<RLMRuntimeHelper>;
  readonly #workerFactory: PersistentWorkerFactory;
  #isExecuting = false;
  #nextRequestId = 0;
  #pendingExecution: PendingExecution | null = null;
  #pendingQueryControllers = new Map<number, PendingQueryController>();
  #syncedHistoryLength = 0;
  #startupFailure: WorkerFailureOutput | null = null;
  #worker: PersistentWorkerLike | null = null;

  /**
   * Captures the runtime configuration used for every worker lifecycle.
   */
  constructor(
    options: PersistentRuntimeOptions,
    workerFactory: PersistentWorkerFactory = (source, workerOptions) => {
      const handle = buildPreferredWorkerSourceHandle(source);
      try {
        const worker = new Worker(handle.url, workerOptions) as unknown as WorkerBridgeLike;
        return wrapWorkerWithCleanup(worker, handle.revoke) as unknown as PersistentWorkerLike;
      } catch (error) {
        handle.revoke();
        throw error;
      }
    },
  ) {
    this.#context = structuredClone(options.context ?? null);
    this.#llmQueryHandler = options.llmQueryHandler;
    this.#rlmQueryHandler = options.rlmQueryHandler;
    const helperNames = (options.runtimeHelpers ?? []).map((helper) => helper.name);
    const seenHelperNames = new Set<string>();
    this.#runtimeHelpers = (options.runtimeHelpers ?? []).map((helper) => {
      if (seenHelperNames.has(helper.name)) {
        throw new Error(`Duplicate runtime helper name: ${helper.name}`);
      }

      seenHelperNames.add(helper.name);
      assertRuntimeHelperDefinition(helper, {
        additionalReservedIdentifiers: helperNames,
      });
      return {
        ...helper,
        source: helper.source.trim(),
      };
    });
    this.#workerFactory = workerFactory;
  }

  /**
   * Executes one cell against the current persistent interpreter, recreating it when needed.
   */
  async execute(input: PersistentExecuteInput): Promise<SandboxExecutionOutput> {
    if (this.#isExecuting) {
      throw new Error('Concurrent REPL executions are not supported.');
    }

    this.#isExecuting = true;
    let failure: unknown = null;
    let output: SandboxExecutionOutput | null = null;

    try {
      const worker = await this.#ensureWorker(input.history);
      const startupFailure = this.#takeStartupFailure();
      if (startupFailure !== null) {
        output = startupFailure;
      } else {
        output = await this.#dispatchExecution(worker, {
          captureFinals: input.captureFinals ?? true,
          code: buildPersistentCellCode(input.code),
          historyDelta: input.history.slice(this.#syncedHistoryLength),
          requestId: this.#nextRequestId++,
          timeoutMs: input.timeoutMs,
        });
        this.#syncedHistoryLength = input.history.length;
      }
    } catch (error) {
      if (error instanceof PersistentWorkerStartupError) {
        output = error.output;
      } else {
        failure = error;
      }
    }

    this.#isExecuting = false;
    if (failure !== null) {
      throw failure;
    }

    return output as SandboxExecutionOutput;
  }

  /**
   * Terminates the current worker so the next execution will rebuild from journal state.
   */
  close(): void {
    this.#destroyWorker();
  }

  /**
   * Creates and restores a worker when no live interpreter is available.
   */
  async #ensureWorker(history: CellEntry[]): Promise<PersistentWorkerLike> {
    if (this.#worker !== null) {
      return this.#worker;
    }

    this.#syncedHistoryLength = 0;
    this.#startupFailure = null;
    const worker = await this.#workerFactory(
      buildPersistentWorkerSource([...this.#runtimeHelpers]),
      {
        type: 'module',
      },
    );
    this.#worker = worker;
    this.#attachWorkerHandlers(worker);
    worker.postMessage({
      context: structuredClone(this.#context),
      type: 'init',
    });

    try {
      await this.#restoreWorkerState(worker, history);
    } catch (error) {
      this.#destroyWorker();
      throw error;
    }

    const startupFailure = this.#takeStartupFailure();
    if (startupFailure !== null) {
      throw new PersistentWorkerStartupError(startupFailure);
    }

    return worker;
  }

  /**
   * Replays successful historical cells into a freshly created persistent worker.
   */
  async #restoreWorkerState(worker: PersistentWorkerLike, history: CellEntry[]): Promise<void> {
    for (let index = 0; index < history.length; index += 1) {
      const cell = history[index];
      if (cell.status !== 'success') {
        continue;
      }

      const output = await this.#dispatchExecution(worker, {
        captureFinals: false,
        code: buildPersistentCellCode(cell.code),
        historyDelta: history.slice(this.#syncedHistoryLength, index),
        requestId: this.#nextRequestId++,
        timeoutMs: PERSISTENT_RESTORE_TIMEOUT_MS,
      });
      this.#syncedHistoryLength = index;

      if (output.status !== 'success') {
        throw new Error(
          `Failed to restore persistent interpreter state from cell ${cell.cellId}.`,
        );
      }
    }
  }

  /**
   * Sends one execute request into the active worker and waits for its terminal response.
   */
  #dispatchExecution(
    worker: PersistentWorkerLike,
    input: Omit<PersistentWorkerExecuteMessage, 'type'> & { timeoutMs: number },
  ): Promise<SandboxExecutionOutput> {
    return new Promise<SandboxExecutionOutput>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingExecution = null;
        this.#destroyWorker();
        reject(new SandboxTimeoutError(input.timeoutMs));
      }, input.timeoutMs + SANDBOX_TIMEOUT_GRACE_MS);

      this.#pendingExecution = {
        reject,
        requestId: input.requestId,
        resolve,
        timer,
      };

      worker.postMessage({
        captureFinals: input.captureFinals,
        code: input.code,
        historyDelta: structuredClone(input.historyDelta),
        requestId: input.requestId,
        type: 'execute',
      });
    });
  }

  /**
   * Hooks worker lifecycle events into the currently pending host-side execution.
   */
  #attachWorkerHandlers(worker: PersistentWorkerLike): void {
    worker.onmessage = (event: MessageEvent<PersistentWorkerHostMessage>) => {
      if (this.#worker !== worker) {
        return;
      }

      const message = event.data;
      if (message.type === 'llm_query_request' || message.type === 'rlm_query_request') {
        void this.#respondToQuery(worker, message);
        return;
      }

      const pending = this.#pendingExecution;
      if (pending === null || pending.requestId !== message.requestId) {
        return;
      }

      clearTimeout(pending.timer);
      this.#pendingExecution = null;
      pending.resolve({
        error: message.error,
        finalAnswer: message.finalAnswer,
        finalResult: message.finalResult ?? null,
        result: message.result,
        status: message.status,
        stderr: message.stderr,
        stdout: message.stdout,
      });
    };

    worker.onerror = (event: ErrorEvent) => {
      if (this.#worker !== worker) {
        return;
      }

      this.#finishWorkerFailure(
        {
          error: {
            message: event.message,
            name: 'WorkerError',
          },
          finalAnswer: null,
          finalResult: null,
          result: createUndefinedSnapshot(),
          status: 'error',
          stderr: '',
          stdout: '',
        },
      );
    };

    worker.onmessageerror = () => {
      if (this.#worker !== worker) {
        return;
      }

      this.#finishWorkerFailure(
        {
          error: {
            message: 'Persistent sandbox worker failed to serialize its response.',
            name: 'MessageError',
          },
          finalAnswer: null,
          finalResult: null,
          result: createUndefinedSnapshot(),
          status: 'error',
          stderr: '',
          stdout: '',
        },
      );
    };
  }

  /**
   * Routes one worker-originated llm_query request to the configured host handler.
   */
  async #respondToQuery(
    worker: PersistentWorkerLike,
    message: PersistentWorkerQueryRequestMessage | PersistentWorkerRecursiveQueryRequestMessage,
  ): Promise<void> {
    if (message.type === 'rlm_query_request') {
      const handler = this.#rlmQueryHandler;
      if (handler === undefined) {
        worker.postMessage({
          error: {
            message: 'rlm_query is not configured for this REPL session.',
            name: 'LLMQueryError',
          },
          queryId: message.queryId,
          type: 'llm_query_error',
        });
        return;
      }

      const controller = new AbortController();
      this.#pendingQueryControllers.set(message.queryId, { controller, worker });

      try {
        const value = await handler(message.prompt, {
          maxSteps: message.maxSteps,
          maxSubcallDepth: message.maxSubcallDepth,
          signal: controller.signal,
        });
        if (isStalePersistentWorker(this.#worker, worker)) {
          return;
        }

        const envelope = isInternalRLMQueryResultEnvelope(value) ? value : null;

        worker.postMessage({
          queryId: message.queryId,
          stdout: envelope?.stdout,
          type: 'llm_query_response',
          value: structuredClone(envelope?.value ?? value),
        });
      } catch (error) {
        if (isStalePersistentWorker(this.#worker, worker)) {
          return;
        }

        worker.postMessage({
          error: createErrorSnapshot(error, 'LLMQueryError'),
          queryId: message.queryId,
          type: 'llm_query_error',
        });
      } finally {
        this.#pendingQueryControllers.delete(message.queryId);
      }
      return;
    }

    const handler = this.#llmQueryHandler;

    if (handler === undefined) {
      worker.postMessage({
        error: {
          message: 'llm_query is not configured for this REPL session.',
          name: 'LLMQueryError',
        },
        queryId: message.queryId,
        type: 'llm_query_error',
      });
      return;
    }

    const controller = new AbortController();
    this.#pendingQueryControllers.set(message.queryId, { controller, worker });

    try {
      const value = await handler(message.prompt, { signal: controller.signal });
      if (this.#worker !== worker) {
        return;
      }

      worker.postMessage({
        queryId: message.queryId,
        type: 'llm_query_response',
        value: structuredClone(value),
      });
    } catch (error) {
      if (this.#worker !== worker) {
        return;
      }

      worker.postMessage({
        error: createErrorSnapshot(error, 'LLMQueryError'),
        queryId: message.queryId,
        type: 'llm_query_error',
      });
    } finally {
      this.#pendingQueryControllers.delete(message.queryId);
    }
  }

  /**
   * Resolves the current execution with an infrastructure error and tears down the worker.
   */
  #finishWorkerFailure(output: WorkerFailureOutput): void {
    const pending = this.#pendingExecution;
    this.#destroyWorker();

    if (pending === null) {
      this.#startupFailure = output;
      return;
    }

    clearTimeout(pending.timer);
    this.#pendingExecution = null;
    pending.resolve(output);
  }

  /**
   * Terminates the active worker without mutating journal state.
   */
  #destroyWorker(): void {
    const worker = this.#worker;
    this.#worker = null;
    this.#syncedHistoryLength = 0;
    abortPendingQueryControllers(this.#pendingQueryControllers, worker);

    if (worker !== null) {
      worker.onerror = null;
      worker.onmessage = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
  }

  /**
   * Reads and clears a worker failure that happened before execute dispatch began.
   */
  #takeStartupFailure(): WorkerFailureOutput | null {
    const failure = this.#startupFailure;
    this.#startupFailure = null;
    return failure;
  }
}

/**
 * Exposes worker-runtime internals for focused tests.
 */
export const __workerRuntimeTestables = {
  abortPendingQueryControllers,
  buildRuntimeHelperAllowedInputKinds,
  buildCurrentCellCode,
  buildPersistentCellCode,
  buildReplayCode,
  buildWorkerSource,
  createUndefinedSnapshot,
  executeCellInSandboxWithFactory,
  isStalePersistentWorker,
  rewriteTopLevelBindings,
  startsRegexLiteral,
  shouldAbortPendingQueryController,
  wrapWorkerWithCleanup,
};
