/**
 * Journal logger implementations used by in-memory, null, and JSONL-backed RLM runs.
 *
 * @module
 *
 * @example
 * ```ts
 * import { InMemoryRLMLogger } from './logger.ts';
 * ```
 */
import { appendJournalEntry, loadJournal } from './jsonl_journal.ts';
import { createSubqueryJournalPath } from './subquery_path.ts';
import type { CellEntry, JournalEntry, LoadedJournal, RLMLogger, SessionEntry } from './types.ts';

/**
 * Narrows an arbitrary journal entry into a persisted session header.
 *
 * @param entry One append-only journal record.
 * @returns `true` only when the record is the session header entry.
 */
function isSessionEntry(entry: JournalEntry): entry is SessionEntry {
  return entry.type === 'session';
}

/**
 * Narrows an arbitrary journal entry into an executable cell record.
 *
 * @param entry One append-only journal record.
 * @returns `true` only when the record is a replayable cell entry.
 */
function isCellEntry(entry: JournalEntry): entry is CellEntry {
  return entry.type === 'cell';
}

/**
 * Rebuilds the session header and executable cells from a generic journal stream.
 *
 * Assistant turns and subquery summaries are intentionally ignored here because
 * reopening a REPL session only depends on the session header plus cell history.
 *
 * @param entries The full append-only journal stream.
 * @returns The minimal session payload required to reopen a `ReplSession`.
 */
function buildLoadedJournal(entries: JournalEntry[]): LoadedJournal {
  let session: SessionEntry | null = null;
  const cells: CellEntry[] = [];

  for (const entry of entries) {
    if (isSessionEntry(entry)) {
      session = structuredClone(entry);
      continue;
    }

    if (isCellEntry(entry)) {
      cells.push(structuredClone(entry));
    }
  }

  return { cells, session };
}

/**
 * Stores journal entries in memory so library consumers do not need filesystem access.
 */
export class InMemoryRLMLogger implements RLMLogger {
  readonly #entries: JournalEntry[] = [];

  /**
   * Appends one journal entry to the in-memory log.
   *
   * @param entry The journal record to store.
   */
  append(entry: JournalEntry): void {
    this.#entries.push(structuredClone(entry));
  }

  /**
   * Returns the executable journal view used to reopen sessions in the same process.
   *
   * @returns The reconstructed session header and replayable cells.
   */
  load(): LoadedJournal {
    return buildLoadedJournal(this.#entries);
  }

  /**
   * Exposes the raw append-only journal stream for tests and diagnostics.
   *
   * A structured clone is returned so consumers cannot mutate the logger's internal state.
   */
  get entries(): JournalEntry[] {
    return this.#entries.map((entry) => structuredClone(entry));
  }
}

/**
 * Discards all journal writes so runs can remain completely ephemeral.
 */
export class NullRLMLogger implements RLMLogger {
  /**
   * Ignores appended journal entries.
   *
   * @param _entry The discarded journal record.
   */
  append(_entry: JournalEntry): void {
    // Intentionally empty.
  }

  /**
   * Reports an empty journal so future opens always start fresh.
   *
   * @returns An always-empty session snapshot.
   */
  load(): LoadedJournal {
    return {
      cells: [],
      session: null,
    };
  }
}

/**
 * Persists append-only journal entries to a JSONL file for standalone workflows.
 */
export class JsonlFileLogger implements RLMLogger {
  readonly path: string;

  /**
   * Stores the filesystem path used by this append-only JSONL logger.
   *
   * @param path The JSONL file path that should receive appended journal entries.
   */
  constructor(path: string) {
    this.path = path;
  }

  /**
   * Appends one JSONL record to the configured journal file.
   *
   * @param entry The journal record to append.
   */
  async append(entry: JournalEntry): Promise<void> {
    await appendJournalEntry(this.path, entry);
  }

  /**
   * Loads the session header and executable cells from the JSONL journal file.
   *
   * @returns The session header and replayable cells reconstructed from disk.
   */
  async load(): Promise<LoadedJournal> {
    return await loadJournal(this.path);
  }
}

/**
 * Resolves the logger used by a library or compatibility call site.
 *
 * The resolution order is:
 * 1. explicit logger
 * 2. compatibility `journalPath`
 * 3. default in-memory logger
 *
 * @param options Logger selection inputs from a caller.
 * @returns A logger instance suitable for the requested call site.
 * @throws When both `logger` and `journalPath` are provided at the same time.
 */
export function resolveRLMLogger(
  options: {
    journalPath?: string;
    logger?: RLMLogger;
  } = {},
): RLMLogger {
  if (options.logger !== undefined && options.journalPath !== undefined) {
    throw new Error('Provide either logger or journalPath, not both.');
  }

  if (options.logger !== undefined) {
    return options.logger;
  }

  if (options.journalPath !== undefined) {
    return new JsonlFileLogger(options.journalPath);
  }

  return new InMemoryRLMLogger();
}

/**
 * Creates the child logger used by one nested llm_query sub-run.
 *
 * File loggers keep using derived JSONL paths, in-memory loggers stay in memory,
 * and null loggers remain fully ephemeral.
 *
 * @param parentLogger The logger used by the parent RLM run.
 * @param depth The depth of the child subquery.
 * @param queryIndex The sibling index of the subquery at the same depth.
 * @returns A logger instance dedicated to the child run.
 */
export function createSubqueryLogger(
  parentLogger: RLMLogger,
  depth: number,
  queryIndex: number,
): RLMLogger {
  if (parentLogger instanceof JsonlFileLogger) {
    return new JsonlFileLogger(createSubqueryJournalPath(parentLogger.path, depth, queryIndex));
  }

  if (parentLogger instanceof InMemoryRLMLogger) {
    return new InMemoryRLMLogger();
  }

  return new NullRLMLogger();
}

/**
 * Reads the backing journal path when the logger happens to be file-based.
 *
 * @param logger The logger whose storage mode should be inspected.
 * @returns The backing JSONL path for file loggers, or `undefined` for non-file loggers.
 */
export function getLoggerJournalPath(logger: RLMLogger): string | undefined {
  if (logger instanceof JsonlFileLogger) {
    return logger.path;
  }

  return undefined;
}
