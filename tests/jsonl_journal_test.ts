import assert from 'node:assert/strict';

import { __jsonlJournalTestables } from '../src/jsonl_journal.ts';
import type { CellEntry, SessionEntry } from '../src/types.ts';

function createNodeFsImportStub(module: {
  appendFile(path: string, data: string, encoding: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string, encoding: string): Promise<string>;
}): <Module>(name: string) => Promise<Module> {
  return async <Module>(_name: string) => module as Module;
}

Deno.test('jsonl journal parser keeps the latest session, keeps cell entries, and ignores other rows', () => {
  const firstSession: SessionEntry = {
    context: 'alpha',
    createdAt: '2026-04-04T00:00:00.000Z',
    defaultTimeoutMs: 1_000,
    sessionId: 'session-1',
    type: 'session',
  };
  const finalSession: SessionEntry = {
    ...firstSession,
    context: 'beta',
    sessionId: 'session-2',
  };
  const cell: CellEntry = {
    cellId: 'cell-1',
    code: '1 + 1',
    durationMs: 1,
    endedAt: '2026-04-04T00:00:01.000Z',
    error: null,
    finalAnswer: null,
    replayedCellIds: [],
    result: { json: 2, kind: 'number', preview: '2' },
    startedAt: '2026-04-04T00:00:00.000Z',
    status: 'success',
    stderr: '',
    stdout: '',
    type: 'cell',
  };

  const loaded = __jsonlJournalTestables.parseJournalText([
    JSON.stringify(firstSession),
    '',
    JSON.stringify({ type: 'assistant_turn' }),
    JSON.stringify(cell),
    JSON.stringify(finalSession),
  ].join('\n'));

  assert.equal(__jsonlJournalTestables.isSessionEntry(firstSession), true);
  assert.equal(__jsonlJournalTestables.isSessionEntry(cell), false);
  assert.equal(__jsonlJournalTestables.isCellEntry(cell), true);
  assert.equal(__jsonlJournalTestables.isCellEntry(firstSession), false);
  assert.deepEqual(loaded, {
    cells: [cell],
    session: finalSession,
  });
});

Deno.test('jsonl journal helpers cover node fallback append and load paths', async () => {
  const writes: string[] = [];
  const mkdirs: Array<{ path: string; recursive?: boolean }> = [];
  const session: SessionEntry = {
    context: null,
    createdAt: '2026-04-04T00:00:00.000Z',
    defaultTimeoutMs: 1_000,
    sessionId: 'session-1',
    type: 'session',
  };

  await __jsonlJournalTestables.appendJournalEntryWithDependencies(
    '/tmp/rlm/session.jsonl',
    session,
    {
      deno: {},
      importNodeBuiltin: createNodeFsImportStub({
        appendFile: async (_path: string, data: string) => {
          writes.push(data);
        },
        mkdir: async (path: string, options?: { recursive?: boolean }) => {
          mkdirs.push({ path, recursive: options?.recursive });
        },
        readFile: async () => '',
      }),
    },
  );

  assert.deepEqual(mkdirs, [{ path: '/tmp/rlm', recursive: true }]);
  assert.deepEqual(writes, [`${JSON.stringify(session)}\n`]);

  const loaded = await __jsonlJournalTestables.loadJournalWithDependencies(
    '/tmp/rlm/session.jsonl',
    {
      deno: {},
      importNodeBuiltin: createNodeFsImportStub({
        appendFile: async () => undefined,
        mkdir: async () => undefined,
        readFile: async () => `${JSON.stringify(session)}\n${JSON.stringify({
          cellId: 'cell-1',
          code: '42',
          durationMs: 2,
          endedAt: '2026-04-04T00:00:02.000Z',
          error: null,
          finalAnswer: '42',
          replayedCellIds: [],
          result: { json: 42, kind: 'number', preview: '42' },
          startedAt: '2026-04-04T00:00:00.000Z',
          status: 'success',
          stderr: '',
          stdout: '',
          type: 'cell',
        })}\n`,
      }),
    },
  );

  assert.equal(loaded.session?.sessionId, 'session-1');
  assert.equal(loaded.cells.length, 1);
  assert.equal(loaded.cells[0]?.finalAnswer, '42');
});

Deno.test('jsonl journal helpers can use the default node fallback importer', async () => {
  const tempDir = await Deno.makeTempDir();
  const journalPath = `${tempDir}/session.jsonl`;
  const session: SessionEntry = {
    context: null,
    createdAt: '2026-04-04T00:00:00.000Z',
    defaultTimeoutMs: 1_000,
    sessionId: 'session-default-node',
    type: 'session',
  };

  try {
    await __jsonlJournalTestables.appendJournalEntryWithDependencies(
      journalPath,
      session,
      { deno: {} },
    );
    const loaded = await __jsonlJournalTestables.loadJournalWithDependencies(
      journalPath,
      { deno: {} },
    );

    assert.equal(loaded.session?.sessionId, 'session-default-node');
    assert.deepEqual(loaded.cells, []);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('jsonl journal helpers return an empty snapshot for not-found errors and rethrow unknown failures', async () => {
  const missing = await __jsonlJournalTestables.loadJournalWithDependencies(
    '/tmp/missing/session.jsonl',
    {
      deno: {},
      importNodeBuiltin: createNodeFsImportStub({
        appendFile: async () => undefined,
        mkdir: async () => undefined,
        readFile: async () => {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
      }),
    },
  );

  assert.deepEqual(missing, { cells: [], session: null });

  await assert.rejects(
    () =>
      __jsonlJournalTestables.loadJournalWithDependencies('/tmp/broken/session.jsonl', {
        deno: {},
        importNodeBuiltin: createNodeFsImportStub({
          appendFile: async () => undefined,
          mkdir: async () => undefined,
          readFile: async () => {
            throw new TypeError('broken');
          },
        }),
      }),
    TypeError,
    'broken',
  );
});
