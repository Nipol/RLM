/**
 * JSONL journal persistence helpers for standalone and file-backed RLM runs.
 *
 * @module
 *
 * @example
 * ```ts
 * import { appendJournalEntry } from './jsonl_journal.ts';
 * ```
 */
import { dirnameFilePath, importNodeBuiltin, isNotFoundError } from './platform.ts';
import type { CellEntry, JournalEntry, LoadedJournal, SessionEntry } from './types.ts';

interface NodeFsPromisesLike {
  appendFile(path: string, data: string, encoding: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string, encoding: string): Promise<string>;
}

interface JournalDenoRuntimeLike {
  mkdir?: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: (
    path: string,
    data: string,
    options?: { append?: boolean },
  ) => Promise<void>;
}

interface JournalDependencies {
  deno?: JournalDenoRuntimeLike;
  importNodeBuiltin?: <Module>(name: string) => Promise<Module>;
}

/**
 * Narrows an arbitrary JSON value into the session header entry shape.
 */
function isSessionEntry(value: unknown): value is SessionEntry {
  return typeof value === 'object' && value !== null &&
    (value as { type?: string }).type === 'session';
}

/**
 * Narrows an arbitrary JSON value into an executable cell entry shape.
 */
function isCellEntry(value: unknown): value is CellEntry {
  return typeof value === 'object' && value !== null &&
    (value as { type?: string }).type === 'cell';
}

function parseJournalText(raw: string): LoadedJournal {
  const cells: CellEntry[] = [];
  let session: SessionEntry | null = null;

  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }

    const parsed = JSON.parse(line) as unknown;
    if (isSessionEntry(parsed)) {
      session = parsed;
      continue;
    }

    if (isCellEntry(parsed)) {
      cells.push(parsed);
    }
  }

  return { cells, session };
}

async function appendJournalEntryWithDependencies(
  path: string,
  entry: JournalEntry,
  dependencies: JournalDependencies = {},
): Promise<void> {
  const deno = dependencies.deno ?? (globalThis as typeof globalThis & {
    Deno?: JournalDenoRuntimeLike;
  }).Deno;

  if (typeof deno?.mkdir === 'function' && typeof deno?.writeTextFile === 'function') {
    await deno.mkdir(dirnameFilePath(path), { recursive: true });
    await deno.writeTextFile(path, `${JSON.stringify(entry)}\n`, { append: true });
    return;
  }

  const fs = await (dependencies.importNodeBuiltin ?? importNodeBuiltin)<NodeFsPromisesLike>(
    'fs/promises',
  );
  await fs.mkdir(dirnameFilePath(path), { recursive: true });
  await fs.appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
}

async function loadJournalWithDependencies(
  path: string,
  dependencies: JournalDependencies = {},
): Promise<LoadedJournal> {
  try {
    const deno = dependencies.deno ?? (globalThis as typeof globalThis & {
      Deno?: JournalDenoRuntimeLike;
    }).Deno;
    const raw = typeof deno?.readTextFile === 'function'
      ? await deno.readTextFile(path)
      : await (await (dependencies.importNodeBuiltin ?? importNodeBuiltin)<NodeFsPromisesLike>(
        'fs/promises',
      )).readFile(
        path,
        'utf8',
      );
    return parseJournalText(raw);
  } catch (error) {
    if (isNotFoundError(error)) {
      return { cells: [], session: null };
    }

    throw error;
  }
}

/**
 * Appends one JSONL record to the journal, creating parent directories as needed.
 */
export async function appendJournalEntry(path: string, entry: JournalEntry): Promise<void> {
  await appendJournalEntryWithDependencies(path, entry);
}

/**
 * Loads a journal from disk and separates the session header from executable cells.
 */
export async function loadJournal(path: string): Promise<LoadedJournal> {
  return await loadJournalWithDependencies(path);
}

/**
 * Exposes JSONL journal internals for focused tests.
 */
export const __jsonlJournalTestables = {
  appendJournalEntryWithDependencies,
  isCellEntry,
  isSessionEntry,
  loadJournalWithDependencies,
  parseJournalText,
};
