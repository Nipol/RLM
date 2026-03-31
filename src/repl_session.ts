import { assertCodeIsRunnable } from './code_guard.ts';
import { createDefaultExecutionBackend } from './execution_backend.ts';
import { resolveRLMLogger } from './logger.ts';
import { PersistentSandboxRuntime, SandboxTimeoutError } from './worker_runtime.ts';
import type {
  CellEntry,
  ExecuteOptions,
  ExecuteResult,
  ExecutionBackend,
  ExecutionErrorSnapshot,
  PersistentRuntimeLike,
  ReplSessionOptions,
  RLMLogger,
  SessionEntry,
  ValueSnapshot,
} from './types.ts';

/**
 * Produces the default result placeholder for cells that do not yield a value.
 *
 * @returns A snapshot representing `undefined`, which is used when a cell
 * ends without a trailing expression.
 */
function createUndefinedSnapshot(): ValueSnapshot {
  return { kind: 'undefined', preview: 'undefined' };
}

/**
 * Normalizes thrown values into a journal-safe error snapshot.
 *
 * @param error The thrown value captured during validation or execution.
 * @returns A serializable error snapshot suitable for journal storage.
 */
function createErrorSnapshot(error: unknown): ExecutionErrorSnapshot {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
    name: 'Error',
  };
}

/**
 * Merges a captured error into stderr while preserving any console output.
 *
 * @param stderr The stderr text captured directly from the runtime.
 * @param error The normalized execution error, if one exists.
 * @returns A stderr string that always includes the surfaced error message.
 */
function appendErrorToStderr(stderr: string, error: ExecutionErrorSnapshot | null): string {
  if (error === null) {
    return stderr;
  }

  const suffix = `${error.name}: ${error.message}`;
  if (stderr.length === 0) {
    return suffix;
  }

  return stderr.endsWith('\n') ? `${stderr}${suffix}` : `${stderr}\n${suffix}`;
}

/**
 * Enforces a single timeout contract for both session defaults and per-call overrides.
 *
 * @param timeoutMs The raw timeout value provided by the caller, if any.
 * @returns A validated positive integer timeout.
 * @throws When the timeout is missing, non-integer, or non-positive.
 */
function normalizeTimeout(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? 5_000;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error('Timeout must be a positive integer.');
  }

  return resolved;
}

export const __replSessionTestables = {
  appendErrorToStderr,
  createErrorSnapshot,
  normalizeTimeout,
};

/**
 * Manages one append-only REPL journal and runs cells against its reconstructed state.
 *
 * @example
 * ```ts
 * const session = await ReplSession.open({
 *   context: { document: 'Chapter 1\\nThe answer is 42.' },
 * });
 *
 * const result = await session.execute('const answer = 6 * 7; answer');
 * console.log(result.result.preview);
 * await session.close();
 * ```
 */
export class ReplSession {
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #logger: RLMLogger;
  readonly #runtime: PersistentRuntimeLike;
  readonly #session: SessionEntry;
  readonly #cells: CellEntry[];

  /**
   * Creates an in-memory session wrapper around already-loaded journal entries.
   *
   * Callers should use `ReplSession.open(...)` instead of constructing sessions directly.
   */
  private constructor(
    logger: RLMLogger,
    session: SessionEntry,
    cells: CellEntry[],
    clock: () => Date,
    idGenerator: () => string,
    runtime: PersistentRuntimeLike,
  ) {
    this.#logger = logger;
    this.#session = session;
    this.#cells = cells;
    this.#clock = clock;
    this.#idGenerator = idGenerator;
    this.#runtime = runtime;
  }

  /**
   * Opens an existing journal or bootstraps a new one when no prior session exists.
   *
   * The caller may provide either a logger or a compatibility `journalPath`.
   * If neither is provided, an in-memory logger is created automatically.
   *
   * @param options Session configuration, persistence configuration, and optional host hooks.
   * @returns A live REPL session bound to the resolved logger and execution backend.
   * @throws When a stored session context conflicts with the requested context, or
   * when timeout configuration is invalid.
   *
   * @example
   * ```ts
   * const session = await ReplSession.open({
   *   context: { document: 'Chapter 1\\nThe answer is 42.' },
   *   journalPath: './logs/session.jsonl',
   * });
   * ```
   */
  static async open(options: ReplSessionOptions): Promise<ReplSession> {
    const clock = options.clock ?? (() => new Date());
    const idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    const logger = resolveRLMLogger({
      journalPath: options.journalPath,
      logger: options.logger,
    });
    const backend = options.executionBackend ?? createDefaultExecutionBackend();
    const loaded = await logger.load?.() ?? {
      cells: [],
      session: null,
    };
    const { cells, session } = loaded;

    if (session !== null) {
      if (
        options.context !== undefined &&
        JSON.stringify(options.context) !== JSON.stringify(session.context)
      ) {
        throw new Error('Existing journal context does not match the requested context.');
      }

      return new ReplSession(
        logger,
        session,
        cells,
        clock,
        idGenerator,
        backend.createRuntime({
          context: session.context,
          llmQueryHandler: options.llmQueryHandler,
          rlmQueryHandler: options.rlmQueryHandler,
        }),
      );
    }

    const newSession: SessionEntry = {
      context: options.context ?? null,
      createdAt: clock().toISOString(),
      defaultTimeoutMs: normalizeTimeout(options.defaultTimeoutMs),
      sessionId: idGenerator(),
      type: 'session',
    };

    await logger.append(newSession);
    return new ReplSession(
      logger,
      newSession,
      cells,
      clock,
      idGenerator,
      backend.createRuntime({
        context: newSession.context,
        llmQueryHandler: options.llmQueryHandler,
        rlmQueryHandler: options.rlmQueryHandler,
      }),
    );
  }

  /**
   * Returns the immutable root context stored for this session.
   *
   * @returns A structured clone of the session context so callers cannot mutate internal state.
   *
   * @example
   * ```ts
   * console.log(session.context);
   * ```
   */
  get context(): SessionEntry['context'] {
    return structuredClone(this.#session.context);
  }

  /**
   * Returns the full append-only execution history recorded so far.
   *
   * @returns A structured clone of the current cell history.
   *
   * @example
   * ```ts
   * console.log(session.history.length);
   * ```
   */
  get history(): CellEntry[] {
    return this.#cells.map((cell) => structuredClone(cell));
  }

  /**
   * Returns the persisted session header metadata.
   *
   * @returns The stored session header as an immutable clone.
   *
   * @example
   * ```ts
   * console.log(session.session.sessionId);
   * ```
   */
  get session(): SessionEntry {
    return structuredClone(this.#session);
  }

  /**
   * Closes the live runtime and any logger resources owned by this session.
   *
   * Long-lived library callers may keep a session open, but one-shot standalone
   * workflows should call this once they no longer need the interpreter state.
   *
   * @example
   * ```ts
   * await session.close();
   * ```
   */
  async close(): Promise<void> {
    await this.#runtime.close?.();
    await this.#logger.close?.();
  }

  /**
   * Validates, executes, and journals one cell against the current reconstructed state.
   *
   * Successful cells become part of future interpreter state.
   * Failed or timed out cells are recorded and excluded from replay if the
   * interpreter is rebuilt, but a live session still keeps any mutations that
   * happened before the throw, just like a normal REPL.
   *
   * @param code The JavaScript/TypeScript source to execute in the REPL.
   * @param options Optional per-call overrides such as timeout.
   * @returns The persisted cell entry plus the resulting history length.
   *
   * @example
   * ```ts
   * await session.execute('const subtotal = 40 + 2;');
   * const next = await session.execute('subtotal + 8');
   * console.log(next.result.preview); // "50"
   * ```
   */
  async execute(code: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    const timeoutMs = options.timeoutMs ?? this.#session.defaultTimeoutMs;
    const replayedCells = this.#cells.filter((cell) => cell.status === 'success');
    const startedAt = this.#clock().toISOString();
    const startedAtMs = performance.now();

    let status: CellEntry['status'] = 'success';
    let stdout = '';
    let stderr = '';
    let result = createUndefinedSnapshot();
    let finalAnswer: string | null = null;
    let finalResult: ValueSnapshot | null = null;
    let error: ExecutionErrorSnapshot | null = null;

    try {
      assertCodeIsRunnable(code);
      const execution = await this.#runtime.execute({
        code,
        history: this.#cells,
        timeoutMs,
      });

      status = execution.status;
      stdout = execution.stdout;
      stderr = execution.stderr;
      result = execution.result;
      finalAnswer = execution.finalAnswer;
      finalResult = execution.finalResult ?? null;
      error = execution.error;
    } catch (caught) {
      if (caught instanceof SandboxTimeoutError) {
        status = 'timeout';
      } else {
        status = 'error';
      }

      error = createErrorSnapshot(caught);
    }

    stderr = appendErrorToStderr(stderr, error);

    const entry: CellEntry = {
      cellId: this.#idGenerator(),
      code,
      durationMs: Math.round(performance.now() - startedAtMs),
      endedAt: this.#clock().toISOString(),
      error,
      finalAnswer,
      finalResult,
      replayedCellIds: replayedCells.map((cell) => cell.cellId),
      result,
      startedAt,
      status,
      stderr,
      stdout,
      type: 'cell',
    };

    await this.#logger.append(entry);
    this.#cells.push(entry);

    return {
      ...structuredClone(entry),
      historyLength: this.#cells.length,
    };
  }
}
