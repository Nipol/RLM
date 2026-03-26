import { dirname } from 'node:path';

import type { CellEntry, JournalEntry, LoadedJournal, SessionEntry } from './types.ts';

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
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, `${JSON.stringify(entry)}\n`, { append: true });
}

/**
 * Loads a journal from disk and separates the session header from executable cells.
 */
export async function loadJournal(path: string): Promise<LoadedJournal> {
  try {
    const raw = await Deno.readTextFile(path);
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
    if (error instanceof Deno.errors.NotFound) {
      return { cells: [], session: null };
    }

    throw error;
  }
}
