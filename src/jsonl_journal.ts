import { dirnameFilePath, importNodeBuiltin, isNotFoundError } from './platform.ts';
import type { CellEntry, JournalEntry, LoadedJournal, SessionEntry } from './types.ts';

interface NodeFsPromisesLike {
  appendFile(path: string, data: string, encoding: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string, encoding: string): Promise<string>;
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

/**
 * Appends one JSONL record to the journal, creating parent directories as needed.
 */
export async function appendJournalEntry(path: string, entry: JournalEntry): Promise<void> {
  const deno = (globalThis as typeof globalThis & {
    Deno?: {
      mkdir?: (path: string, options?: { recursive?: boolean }) => Promise<void>;
      writeTextFile?: (
        path: string,
        data: string,
        options?: { append?: boolean },
      ) => Promise<void>;
    };
  }).Deno;

  if (typeof deno?.mkdir === 'function' && typeof deno?.writeTextFile === 'function') {
    await deno.mkdir(dirnameFilePath(path), { recursive: true });
    await deno.writeTextFile(path, `${JSON.stringify(entry)}\n`, { append: true });
    return;
  }

  const fs = await importNodeBuiltin<NodeFsPromisesLike>('fs/promises');
  await fs.mkdir(dirnameFilePath(path), { recursive: true });
  await fs.appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
}

/**
 * Loads a journal from disk and separates the session header from executable cells.
 */
export async function loadJournal(path: string): Promise<LoadedJournal> {
  try {
    const deno = (globalThis as typeof globalThis & {
      Deno?: {
        readTextFile?: (path: string) => Promise<string>;
      };
    }).Deno;
    const raw = typeof deno?.readTextFile === 'function'
      ? await deno.readTextFile(path)
      : await (await importNodeBuiltin<NodeFsPromisesLike>('fs/promises')).readFile(
        path,
        'utf8',
      );
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
  } catch (error) {
    if (isNotFoundError(error)) {
      return { cells: [], session: null };
    }

    throw error;
  }
}
