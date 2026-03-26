import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';

import { assertCodeIsRunnable, splitTrailingExpression } from '../src/code_guard.ts';
import { InMemoryRLMLogger, NullRLMLogger } from '../src/index.ts';
import { ReplSession } from '../src/index.ts';
import { appendJournalEntry, loadJournal } from '../src/jsonl_journal.ts';
import { __replSessionTestables } from '../src/repl_session.ts';
import {
  __workerRuntimeTestables,
  executeCellInSandbox,
  PersistentSandboxRuntime,
  SandboxTimeoutError,
} from '../src/worker_runtime.ts';
import type { CellEntry, ExecutionBackend, PersistentRuntimeLike, SessionEntry } from '../src/types.ts';

function createClock(start = Date.parse('2026-03-22T00:00:00.000Z')): () => Date {
  let current = start;
  return () => {
    const value = new Date(current);
    current += 1_000;
    return value;
  };
}

function createIdGenerator(prefix = 'id'): () => string {
  let current = 0;
  return () => `${prefix}-${current++}`;
}

async function createSessionPath(testName: string): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: 'rlm-tests-' });
  return join(root, testName, 'session.jsonl');
}

function createCellEntry(overrides: Partial<CellEntry> = {}): CellEntry {
  return {
    cellId: 'cell-0',
    code: '1',
    durationMs: 0,
    endedAt: '2026-03-22T00:00:01.000Z',
    error: null,
    finalAnswer: null,
    replayedCellIds: [],
    result: { kind: 'number', json: 1, preview: '1' },
    startedAt: '2026-03-22T00:00:00.000Z',
    status: 'success',
    stderr: '',
    stdout: '',
    type: 'cell',
    ...overrides,
  };
}

function createSandboxOutput(
  requestId: number,
  overrides: Partial<{
    error: CellEntry['error'];
    finalAnswer: string | null;
    result: CellEntry['result'];
    status: 'error' | 'success';
    stderr: string;
    stdout: string;
  }> = {},
) {
  return {
    error: null,
    finalAnswer: null,
    requestId,
    result: { kind: 'undefined', preview: 'undefined' },
    status: 'success' as const,
    stderr: '',
    stdout: '',
    type: 'execute_result' as const,
    ...overrides,
  };
}

function createPersistentWorker(
  handleMessage: (
    message: { type: string; requestId?: number; queryId?: number },
    worker: {
      onerror: ((event: ErrorEvent) => void) | null;
      onmessage: ((event: MessageEvent<unknown>) => void) | null;
      onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
      postMessage(message: unknown): void;
      terminate(): void;
      terminated: boolean;
    },
  ) => void,
) {
  const worker = {
    onerror: null as ((event: ErrorEvent) => void) | null,
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    onmessageerror: null as ((event: MessageEvent<unknown>) => void) | null,
    postMessage(message: unknown) {
      handleMessage(message as { type: string; requestId?: number; queryId?: number }, worker);
    },
    terminate() {
      worker.terminated = true;
    },
    terminated: false,
  };

  return worker;
}

function createDeferred<T>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

async function flushMicrotasks(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}

Deno.test('session bootstraps a journal and executes arithmetic expressions', async () => {
  const journalPath = await createSessionPath('arithmetic');
  const session = await ReplSession.open({
    clock: createClock(),
    context: 'seed context',
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const result = await session.execute('1 + 2');

  assert.equal(result.status, 'success');
  assert.equal(result.result.preview, '3');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.historyLength, 1);

  const journal = await Deno.readTextFile(journalPath);
  const lines = journal.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).type, 'session');
  assert.equal(JSON.parse(lines[1]).type, 'cell');
});

Deno.test('history and context are exposed automatically to later cells', async () => {
  const journalPath = await createSessionPath('history');
  const session = await ReplSession.open({
    clock: createClock(),
    context: { title: 'context object' },
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const first = await session.execute('console.log(context.title)');
  const second = await session.execute('history.length');

  assert.equal(first.stdout, 'context object\n');
  assert.equal(second.result.preview, '1');
  assert.equal(second.replayedCellIds.length, 1);
});

Deno.test('computed values can be stored in one block and used for later arithmetic', async () => {
  const journalPath = await createSessionPath('computed-values');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const first = await session.execute('const subtotal = 18 + 24;\nsubtotal');
  const second = await session.execute('const tax = subtotal / 3;\nsubtotal + tax');
  const third = await session.execute('subtotal + tax + 10');

  assert.equal(first.status, 'success');
  assert.equal(first.result.preview, '42');
  assert.equal(second.status, 'success');
  assert.equal(second.result.preview, '56');
  assert.equal(second.replayedCellIds.length, 1);
  assert.equal(third.status, 'success');
  assert.equal(third.result.preview, '66');
  assert.equal(third.replayedCellIds.length, 2);
});

Deno.test('top-level function declarations remain callable from later cells', async () => {
  const journalPath = await createSessionPath('function-persistence');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const first = await session.execute(`// helper declaration
function entryTargetsProject(entry, target) {
  return entry?.project === target;
}`);
  const second = await session.execute(
    'entryTargetsProject({ project: "marlin" }, "marlin")',
  );

  assert.equal(first.status, 'success');
  assert.equal(first.result.preview, 'undefined');
  assert.equal(second.status, 'success');
  assert.equal(second.result.preview, 'true');
});

Deno.test('top-level block cells run as statements instead of invalid object expressions', async () => {
  const journalPath = await createSessionPath('block-cell');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const result = await session.execute(`{
  const answer = 40 + 2;
  FINAL_VAR(answer);
}`);

  assert.equal(result.status, 'success');
  assert.equal(result.finalAnswer, '42');
});

Deno.test('persistent interpreter keeps live values instead of replaying prior cells', async () => {
  const journalPath = await createSessionPath('persistent-state');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const first = await session.execute('const token = Math.random(); token');
  const second = await session.execute('token === history[0].result.json');

  assert.equal(first.status, 'success');
  assert.equal(second.status, 'success');
  assert.equal(second.result.preview, 'true');
});

Deno.test('result snapshots preserve exact nested scalar and undefined signals for later controller turns', async () => {
  const journalPath = await createSessionPath('result-signals');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const result = await session.execute(
    '({ operatorId: "op-7", routing: { lockerId: "locker-9", accessCode: "7318452", missingLockerId: undefined } })',
  );

  assert.equal(result.status, 'success');
  assert.deepEqual(result.result.signals, [
    {
      kind: 'string',
      path: '$.operatorId',
      preview: 'op-7',
    },
    {
      kind: 'string',
      path: '$.routing.lockerId',
      preview: 'locker-9',
    },
    {
      kind: 'string',
      path: '$.routing.accessCode',
      preview: '7318452',
    },
    {
      kind: 'undefined',
      path: '$.routing.missingLockerId',
      preview: 'undefined',
    },
  ]);
});

Deno.test('FINAL and FINAL_VAR capture the final answer without closing the session', async () => {
  const journalPath = await createSessionPath('final');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const first = await session.execute('const answer = "done"; FINAL(answer);');
  const second = await session.execute('const nextAnswer = "again"; FINAL_VAR(nextAnswer);');
  const third = await session.execute(
    'history.filter((entry) => entry.finalAnswer !== null).length',
  );

  assert.equal(first.finalAnswer, 'done');
  assert.equal(second.finalAnswer, 'again');
  assert.equal(third.result.preview, '2');
});

Deno.test('session close tears down the runtime and logger explicitly when requested', async () => {
  let runtimeClosed = false;
  let loggerClosed = false;

  const logger = {
    append() {},
    close() {
      loggerClosed = true;
    },
    load() {
      return { cells: [], session: null };
    },
  };

  const runtime: PersistentRuntimeLike = {
    close() {
      runtimeClosed = true;
    },
    async execute() {
      return {
        error: null,
        finalAnswer: null,
        result: { kind: 'undefined', preview: 'undefined' },
        status: 'success' as const,
        stderr: '',
        stdout: '',
      };
    },
  };

  const backend: ExecutionBackend = {
    createRuntime() {
      return runtime;
    },
  };

  const session = await ReplSession.open({
    clock: createClock(),
    executionBackend: backend,
    idGenerator: createIdGenerator(),
    logger,
  });

  await session.close();

  assert.equal(runtimeClosed, true);
  assert.equal(loggerClosed, true);
});

Deno.test('session can open with a logger that does not implement load and falls back to a fresh session', async () => {
  const logger = {
    append() {},
  };

  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    logger,
  });

  assert.equal(session.history.length, 0);
  assert.equal(session.session.type, 'session');
});

Deno.test('console warning and errors are captured in stderr', async () => {
  const journalPath = await createSessionPath('stderr');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const result = await session.execute('console.warn("careful"); console.error("boom");');

  assert.equal(result.stderr, 'careful\nboom\n');
});

Deno.test('runtime failures are recorded and not replayed into future state', async () => {
  const journalPath = await createSessionPath('runtime-error');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  await session.execute('let counter = 1;');
  const failed = await session.execute('counter += 1;\nthrow new Error("explode");');
  const afterFailure = await session.execute('counter');

  assert.equal(failed.status, 'error');
  assert.match(failed.stderr, /Error: explode/u);
  assert.equal(afterFailure.result.preview, '1');
  assert.equal(afterFailure.replayedCellIds.length, 1);
});

Deno.test('validation errors are logged when import syntax is attempted', async () => {
  const journalPath = await createSessionPath('import-block');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const result = await session.execute('await import("data:text/javascript,export default 1");');

  assert.equal(result.status, 'error');
  assert.match(result.stderr, /does not support import\/export syntax/u);
});

Deno.test('reserved REPL identifiers cannot be reassigned', async () => {
  const journalPath = await createSessionPath('reserved');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const result = await session.execute('const context = "shadow";');

  assert.equal(result.status, 'error');
  assert.match(result.stderr, /Reserved REPL identifiers/u);
});

Deno.test('normalizeTarget trims question punctuation and returns empty strings for unresolved non-null inputs', async () => {
  const journalPath = await createSessionPath('normalize-target');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const cleaned = await session.execute(`({
  plain: normalizeTarget(' linen? '),
  quoted: normalizeTarget('"linen?"'),
  empty: normalizeTarget(' ? '),
  object: normalizeTarget({ value: 'linen' }),
  nullish: normalizeTarget(null),
})`);

  assert.equal(cleaned.status, 'success');
  assert.deepEqual(cleaned.result.json, {
    plain: 'linen',
    quoted: 'linen',
    empty: '',
    object: '',
    nullish: null,
  });
});

Deno.test('normalizeTarget extracts clear trailing targets from query-like strings and returns empty strings when the target is ambiguous', async () => {
  const journalPath = await createSessionPath('normalize-target-queries');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const cleaned = await session.execute(`({
  questionFor: normalizeTarget('What is the control code for linen?'),
  imperativeFor: normalizeTarget('Return the control code for "linen".'),
  namedTarget: normalizeTarget('Find the route beacon named cedar.'),
  calledTarget: normalizeTarget('Identify the active dossier called onyx!'),
  belongsToTarget: normalizeTarget('Which vault key belongs to profile amber?'),
  ambiguousQuestion: normalizeTarget('Which control code should we inspect?'),
  plainLabelQuestion: normalizeTarget('linen?'),
})`);

  assert.equal(cleaned.status, 'success');
  assert.deepEqual(cleaned.result.json, {
    questionFor: 'linen',
    imperativeFor: 'linen',
    namedTarget: 'cedar',
    calledTarget: 'onyx',
    belongsToTarget: 'amber',
    ambiguousQuestion: '',
    plainLabelQuestion: 'linen',
  });
});

Deno.test('normalizeTarget strips trailing descriptor nouns from partial question remnants seen in live retrieval prompts', async () => {
  const journalPath = await createSessionPath('normalize-target-remnants');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const cleaned = await session.execute(`({
  exactLiveFailure: normalizeTarget('Sydney number?'),
  lowercaseCode: normalizeTarget('linen code.'),
  uppercaseId: normalizeTarget('AMBER id'),
  extraSpaces: normalizeTarget('   Barcelona token   '),
  descriptorOnly: normalizeTarget('number?'),
  stablePlain: normalizeTarget('release-current'),
})`);

  assert.equal(cleaned.status, 'success');
  assert.deepEqual(cleaned.result.json, {
    exactLiveFailure: 'Sydney',
    lowercaseCode: 'linen',
    uppercaseId: 'AMBER',
    extraSpaces: 'Barcelona',
    descriptorOnly: '',
    stablePlain: 'release-current',
  });
});

Deno.test('findAnchoredValue extracts substrings between exact anchors and returns empty strings when matching fails', async () => {
  const journalPath = await createSessionPath('find-anchored-value');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const extracted = await session.execute(`({
  hit: findAnchoredValue(
    'The special magic Barcelona number is: 6985442. filler',
    'The special magic Barcelona number is: ',
    '.',
  ),
  fallback: findAnchoredValue(
    '비밀 코드: 528612 filler',
    '비밀 코드: ',
    '\\n',
  ),
  emptySuffix: findAnchoredValue(
    'What is the control code for linen?',
    'What is the control code for ',
    '',
  ),
  miss: findAnchoredValue(
    'The special magic Toronto number is: 7451057. filler',
    'The special magic Barcelona number is: ',
    '.',
  ),
  badInput: findAnchoredValue({ text: 'nope' }, 'prefix', '.'),
  nullish: findAnchoredValue(null, 'prefix', '.'),
})`);

  assert.equal(extracted.status, 'success');
  assert.deepEqual(extracted.result.json, {
    hit: '6985442',
    fallback: '528612',
    emptySuffix: 'linen',
    miss: '',
    badInput: '',
    nullish: null,
  });
});

Deno.test('findAnchoredValue prefers the exact anchored span and normalizes token fallback punctuation', async () => {
  const journalPath = await createSessionPath('find-anchored-value-repeated');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const extracted = await session.execute(`({
  firstExact: findAnchoredValue(
    'The route beacon for amber has control code 721228. The route beacon for linen has control code 848562.',
    'The route beacon for linen has control code ',
    '.',
  ),
  tokenFallbackQuestionMark: findAnchoredValue(
    'Control code for linen? 848562',
    'Control code for ',
    '::missing::',
  ),
  emptyValue: findAnchoredValue(
    'The route beacon for linen has control code .',
    'The route beacon for linen has control code ',
    '.',
  ),
})`);

  assert.equal(extracted.status, 'success');
  assert.deepEqual(extracted.result.json, {
    firstExact: '848562',
    tokenFallbackQuestionMark: 'linen',
    emptyValue: '',
  });
});

Deno.test('network-facing globals are unavailable inside the sandbox', async () => {
  const journalPath = await createSessionPath('sandbox');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const result = await session.execute('typeof fetch');

  assert.equal(result.status, 'success');
  assert.equal(result.result.preview, 'undefined');
});

Deno.test('file hierarchy access is rejected inside the sandbox with a clear error', async () => {
  const tempDir = await Deno.makeTempDir({ prefix: 'rlm-sandbox-files-' });
  const targetPath = join(tempDir, 'secret.txt');
  await Deno.writeTextFile(targetPath, 'top-secret');

  const journalPath = await createSessionPath('sandbox-file-access');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const result = await session.execute(`await Deno.readTextFile(${JSON.stringify(targetPath)})`);

  assert.equal(result.status, 'error');
  assert.match(result.stderr, /File system access is disabled in the RLM sandbox/u);
  assert.doesNotMatch(result.stderr, /top-secret/u);
});

Deno.test('timeouts are surfaced as timeout cells', async () => {
  const journalPath = await createSessionPath('timeout');
  const session = await ReplSession.open({
    clock: createClock(),
    defaultTimeoutMs: 20,
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const result = await session.execute('while (true) {}');

  assert.equal(result.status, 'timeout');
  assert.match(result.stderr, /TimeoutError: Execution timed out after 20ms/u);
});

Deno.test('timeouts do not discard previously committed persistent state', async () => {
  const journalPath = await createSessionPath('timeout-recovery');
  const sharedClock = createClock();
  const sharedIds = createIdGenerator();

  const session = await ReplSession.open({
    clock: sharedClock,
    defaultTimeoutMs: 1_000,
    idGenerator: sharedIds,
    journalPath,
  });

  await session.execute('let counter = 1;');
  const timedOut = await session.execute('while (true) {}');
  const resumed = await ReplSession.open({
    clock: sharedClock,
    idGenerator: sharedIds,
    journalPath,
  });
  const recovered = await resumed.execute('counter');

  assert.equal(timedOut.status, 'timeout');
  assert.equal(recovered.status, 'success');
  assert.equal(recovered.result.preview, '1');
});

Deno.test('existing journals can be reopened and resumed', async () => {
  const journalPath = await createSessionPath('resume');
  const sharedClock = createClock();
  const sharedIds = createIdGenerator();

  const firstSession = await ReplSession.open({
    clock: sharedClock,
    context: ['seed'],
    idGenerator: sharedIds,
    journalPath,
  });
  await firstSession.execute('const value = 40;');

  const resumed = await ReplSession.open({
    clock: sharedClock,
    idGenerator: sharedIds,
    journalPath,
  });
  const result = await resumed.execute('value + 2');

  assert.deepEqual(resumed.context, ['seed']);
  assert.equal(result.result.preview, '42');
  assert.equal(resumed.history.length, 2);
});

Deno.test('saved computed variables can be replayed after reopening the journal', async () => {
  const journalPath = await createSessionPath('resume-computed-values');
  const sharedClock = createClock();
  const sharedIds = createIdGenerator();

  const firstSession = await ReplSession.open({
    clock: sharedClock,
    idGenerator: sharedIds,
    journalPath,
  });
  const initial = await firstSession.execute('const baseTotal = 7 * 6;\nbaseTotal');

  const resumed = await ReplSession.open({
    clock: sharedClock,
    idGenerator: sharedIds,
    journalPath,
  });
  const next = await resumed.execute('const adjustedTotal = baseTotal + 8;\nadjustedTotal');
  const final = await resumed.execute('adjustedTotal * 2');

  assert.equal(initial.result.preview, '42');
  assert.equal(next.result.preview, '50');
  assert.equal(next.replayedCellIds.length, 1);
  assert.equal(final.result.preview, '100');
  assert.equal(final.replayedCellIds.length, 2);
});

Deno.test('sessions can be reopened from an injected in-memory logger without any journal file', async () => {
  const logger = new InMemoryRLMLogger();
  const sharedClock = createClock();
  const sharedIds = createIdGenerator();

  const firstSession = await ReplSession.open({
    clock: sharedClock,
    idGenerator: sharedIds,
    logger,
  });
  await firstSession.execute('const value = 40;');

  const resumed = await ReplSession.open({
    clock: sharedClock,
    idGenerator: sharedIds,
    logger,
  });
  const result = await resumed.execute('value + 2');

  assert.equal(result.status, 'success');
  assert.equal(result.result.preview, '42');
  assert.equal(resumed.history.length, 2);
});

Deno.test('null loggers keep a session ephemeral across reopen attempts', async () => {
  const logger = new NullRLMLogger();
  const sharedClock = createClock();
  const sharedIds = createIdGenerator();

  const firstSession = await ReplSession.open({
    clock: sharedClock,
    idGenerator: sharedIds,
    logger,
  });
  await firstSession.execute('const hidden = 40;');

  const resumed = await ReplSession.open({
    clock: sharedClock,
    idGenerator: sharedIds,
    logger,
  });
  const result = await resumed.execute('typeof hidden');

  assert.equal(result.status, 'success');
  assert.equal(result.result.preview, 'undefined');
  assert.equal(resumed.history.length, 1);
});

Deno.test('llm_query can be mocked and awaited from inside the REPL', async () => {
  const journalPath = await createSessionPath('llm-query');
  const prompts: string[] = [];
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    llmQueryHandler: async (prompt) => {
      prompts.push(prompt);
      return {
        answer: 41,
        label: 'mocked',
      };
    },
  });

  const result = await session.execute(
    'const response = await llm_query("solve this");\nresponse.answer + 1',
  );

  assert.deepEqual(prompts, ['solve this']);
  assert.equal(result.status, 'success');
  assert.equal(result.result.preview, '42');
});

Deno.test('rlm_query can be mocked and awaited from inside the REPL', async () => {
  const journalPath = await createSessionPath('rlm-query');
  const prompts: Array<string | object> = [];
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    rlmQueryHandler: async (prompt) => {
      prompts.push(prompt);
      return {
        answer: 41,
        label: 'delegated',
      };
    },
  });

  const result = await session.execute(
    'const response = await rlm_query("solve this");\nresponse.answer + 1',
  );

  assert.deepEqual(prompts, ['solve this']);
  assert.equal(result.status, 'success');
  assert.equal(result.result.preview, '42');
});

Deno.test('rlm_query forwards direct delegation objects from inside the REPL', async () => {
  const journalPath = await createSessionPath('rlm-query-object');
  const prompts: Array<string | object> = [];
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    rlmQueryHandler: async (prompt) => {
      prompts.push(prompt as object);
      return 41;
    },
  });

  const result = await session.execute(
    `const response = await rlm_query({
  task: "Return only the resolved number.",
  payload: { candidate: 41 },
  expect: { type: "number" }
});
response + 1`,
  );

  assert.deepEqual(prompts, [
    {
      expect: { type: 'number' },
      payload: { candidate: 41 },
      task: 'Return only the resolved number.',
    },
  ]);
  assert.equal(result.status, 'success');
  assert.equal(result.result.preview, '42');
});

Deno.test('llm_query reports a clear error when no handler is configured', async () => {
  const journalPath = await createSessionPath('llm-query-missing-handler');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const result = await session.execute('await llm_query("solve this")');

  assert.equal(result.status, 'error');
  assert.match(result.stderr, /llm_query is not configured/u);
});

Deno.test('rlm_query reports a clear error when no handler is configured', async () => {
  const journalPath = await createSessionPath('rlm-query-missing-handler');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const result = await session.execute('await rlm_query("solve this")');

  assert.equal(result.status, 'error');
  assert.match(result.stderr, /rlm_query is not configured/u);
});

Deno.test('rlm_query rejects undefined prompts before it reaches the host handler', async () => {
  const prompts: Array<string | object> = [];
  const journalPath = await createSessionPath('rlm-query-invalid-prompt');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    rlmQueryHandler: async (prompt) => {
      prompts.push(prompt);
      return 'unreachable';
    },
  });

  const result = await session.execute(
    'const delegatedPrompt = undefined;\nawait rlm_query(delegatedPrompt)',
  );

  assert.equal(result.status, 'error');
  assert.match(result.stderr, /rlm_query requires a concrete prompt/u);
  assert.deepEqual(prompts, []);
});

Deno.test('rlm_query rejects object requests without a task before they reach the host handler', async () => {
  const prompts: Array<string | object> = [];
  const journalPath = await createSessionPath('rlm-query-missing-task');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    rlmQueryHandler: async (prompt) => {
      prompts.push(prompt as object);
      return 'unreachable';
    },
  });

  const result = await session.execute('await rlm_query({ payload: { candidate: 1 } })');

  assert.equal(result.status, 'error');
  assert.match(result.stderr, /rlm_query object requests require a string task/u);
  assert.deepEqual(prompts, []);
});

Deno.test('opening an existing journal with a different context fails fast', async () => {
  const journalPath = await createSessionPath('context-mismatch');
  const session = await ReplSession.open({
    clock: createClock(),
    context: 'alpha',
    idGenerator: createIdGenerator(),
    journalPath,
  });

  await session.execute('1');

  await assert.rejects(
    () =>
      ReplSession.open({
        clock: createClock(),
        context: 'beta',
        idGenerator: createIdGenerator(),
        journalPath,
      }),
    /does not match the requested context/u,
  );
});

Deno.test('invalid timeout configuration is rejected when the session is created', async () => {
  const journalPath = await createSessionPath('bad-timeout');

  await assert.rejects(
    () =>
      ReplSession.open({
        clock: createClock(),
        defaultTimeoutMs: 0,
        idGenerator: createIdGenerator(),
        journalPath,
      }),
    /Timeout must be a positive integer/u,
  );
});

Deno.test('empty journals are read as new sessions and nested directories are created', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-tests-' });
  const journalPath = join(root, 'nested', 'dir', 'session.jsonl');

  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  assert.equal(dirname(journalPath).endsWith(join('nested', 'dir')), true);
  assert.equal(session.session.type, 'session');
  assert.equal((await Deno.stat(journalPath)).isFile, true);
});

Deno.test('sessions can be opened with default clock and id generator', async () => {
  const journalPath = await createSessionPath('defaults');
  const session = await ReplSession.open({ journalPath });

  assert.equal(session.session.type, 'session');
  assert.equal(typeof session.session.sessionId, 'string');
  assert.equal(session.session.sessionId.length > 0, true);
});

Deno.test('code guard ignores import-like text inside comments and escaped strings', () => {
  assert.doesNotThrow(() =>
    assertCodeIsRunnable('// import nope\nconst value = "escaped \\" import";\nvalue')
  );
  assert.doesNotThrow(() =>
    assertCodeIsRunnable('/* import still nope */\nconst text = `escaped \\` import`;\ntext')
  );
});

Deno.test('code guard allows reserved bindings to be compared or read without treating them as assignments', () => {
  assert.doesNotThrow(() =>
    assertCodeIsRunnable('const raw = typeof context === "string" ? context : "";\nraw')
  );
  assert.doesNotThrow(() => assertCodeIsRunnable('const same = context == null;\nsame'));
  assert.doesNotThrow(() => assertCodeIsRunnable('const target = normalizeTarget("linen?");\ntarget'));
  assert.doesNotThrow(() =>
    assertCodeIsRunnable('const code = findAnchoredValue("A: 1.", "A: ", ".");\ncode')
  );
});

Deno.test('code guard handles single quotes, multiline comments, and continued strings', () => {
  assert.doesNotThrow(() =>
    assertCodeIsRunnable("const single = 'import stays text';\nconst value = single;")
  );
  assert.doesNotThrow(() =>
    assertCodeIsRunnable("/* multi\nline block comment */\nconst value = 'ok';")
  );
  assert.doesNotThrow(() => assertCodeIsRunnable("const joined = 'line\\\ncontinued';\njoined"));
  assert.doesNotThrow(() =>
    assertCodeIsRunnable('const template = `first line\nsecond line`;\ntemplate')
  );
});

Deno.test('splitTrailingExpression handles empty, trailing blank, and non-expression endings', () => {
  assert.deepEqual(splitTrailingExpression('   \n\t'), { body: '', expression: null });
  assert.deepEqual(splitTrailingExpression('const value = 1\n\n'), {
    body: 'const value = 1',
    expression: null,
  });
  assert.deepEqual(splitTrailingExpression('const value = 1; value + 1'), {
    body: 'const value = 1;',
    expression: 'value + 1',
  });
  assert.deepEqual(splitTrailingExpression('if (true) {\n  1\n}'), {
    body: 'if (true) {\n  1\n}',
    expression: null,
  });
});

Deno.test('splitTrailingExpression handles comments, escapes, and open blocks', () => {
  assert.deepEqual(splitTrailingExpression('const value = 1; // trailing comment\nvalue'), {
    body: 'const value = 1; // trailing comment',
    expression: 'value',
  });
  assert.deepEqual(splitTrailingExpression('const value = 1; /* trailing block */\nvalue'), {
    body: 'const value = 1; /* trailing block */',
    expression: 'value',
  });
  assert.deepEqual(splitTrailingExpression('const text = "a\\"b";\ntext'), {
    body: 'const text = "a\\"b";',
    expression: 'text',
  });
  assert.deepEqual(splitTrailingExpression("const single = 'value';\nsingle"), {
    body: "const single = 'value';",
    expression: 'single',
  });
  assert.deepEqual(splitTrailingExpression('const template = `first\nsecond`;\ntemplate'), {
    body: 'const template = `first\nsecond`;',
    expression: 'template',
  });
  assert.deepEqual(splitTrailingExpression('while (true) {'), {
    body: 'while (true) {',
    expression: null,
  });
  assert.deepEqual(splitTrailingExpression('{\n  const value = 1;\n  value;\n}'), {
    body: '{\n  const value = 1;\n  value;\n}',
    expression: null,
  });
  assert.deepEqual(splitTrailingExpression('{ value: 1 }'), {
    body: '',
    expression: '{ value: 1 }',
  });
  assert.deepEqual(
    splitTrailingExpression(`// helper declaration
function entryTargetsProject(entry, target) {
  return entry?.project === target;
}`),
    {
      body: `// helper declaration
function entryTargetsProject(entry, target) {
  return entry?.project === target;
}`,
      expression: null,
    },
  );
});

Deno.test('journal loader rethrows malformed journal content', async () => {
  const journalPath = await createSessionPath('bad-journal');
  await Deno.mkdir(dirname(journalPath), { recursive: true });
  await Deno.writeTextFile(journalPath, '{not-json}\n');

  await assert.rejects(() => loadJournal(journalPath), SyntaxError);
});

Deno.test('journal append and load helpers preserve session and cell entries', async () => {
  const journalPath = await createSessionPath('journal-roundtrip');
  const sessionEntry: SessionEntry = {
    context: 'ctx',
    createdAt: '2026-03-22T00:00:00.000Z',
    defaultTimeoutMs: 5_000,
    sessionId: 'session-1',
    type: 'session',
  };
  const cellEntry: CellEntry = {
    cellId: 'cell-1',
    code: '1 + 1',
    durationMs: 1,
    endedAt: '2026-03-22T00:00:01.000Z',
    error: null,
    finalAnswer: null,
    replayedCellIds: [],
    result: { kind: 'number', preview: '2', json: 2 },
    startedAt: '2026-03-22T00:00:00.000Z',
    status: 'success',
    stderr: '',
    stdout: '',
    type: 'cell',
  };

  await appendJournalEntry(journalPath, sessionEntry);
  await appendJournalEntry(journalPath, cellEntry);

  const loaded = await loadJournal(journalPath);
  assert.deepEqual(loaded.session, sessionEntry);
  assert.deepEqual(loaded.cells, [cellEntry]);
});

Deno.test('repl session helpers cover non-error snapshots and stderr joining', () => {
  const typedFailure = new TypeError('typed failure');

  assert.deepEqual(__replSessionTestables.createErrorSnapshot('plain failure'), {
    message: 'plain failure',
    name: 'Error',
  });
  assert.deepEqual(__replSessionTestables.createErrorSnapshot(typedFailure), {
    message: 'typed failure',
    name: 'TypeError',
    stack: typedFailure.stack,
  });
  assert.equal(
    __replSessionTestables.appendErrorToStderr('existing', {
      message: 'bad',
      name: 'Oops',
    }),
    'existing\nOops: bad',
  );
  assert.equal(
    __replSessionTestables.appendErrorToStderr('existing\n', {
      message: 'bad',
      name: 'Oops',
    }),
    'existing\nOops: bad',
  );
  assert.equal(__replSessionTestables.normalizeTimeout(undefined), 5_000);
});

Deno.test('worker runtime test helpers expose transformed source for expression and statement cells', () => {
  assert.equal(
    __workerRuntimeTestables.buildCurrentCellCode('const value = 1\nvalue + 1'),
    'const value = 1\n__resultSnapshot = __snapshotValue(value + 1);',
  );
  assert.equal(
    __workerRuntimeTestables.buildCurrentCellCode('const value = 1;'),
    'const value = 1;\n__resultSnapshot = __snapshotValue(undefined);',
  );
  assert.equal(
    __workerRuntimeTestables.buildPersistentCellCode('{\n  const value = 1;\n  value;\n}'),
    '{\n  const value = 1;\n  value;\n}\n__setResult(undefined);',
  );
  assert.match(
    __workerRuntimeTestables.buildWorkerSource({
      context: null,
      currentCode: '1 + 1',
      history: [],
      replayCells: [],
      timeoutMs: 10,
    }),
    /const context = __deepFreeze/u,
  );
  assert.deepEqual(__workerRuntimeTestables.createUndefinedSnapshot(), {
    kind: 'undefined',
    preview: 'undefined',
  });
});

Deno.test('worker runtime persistent transform handles comments, destructuring, functions, classes, and vars', () => {
  const transformed = __workerRuntimeTestables.rewriteTopLevelBindings(`
// line comment
const [first] = [1];
/* block comment */
const { second } = { second: 2 };
async function load () { return "ok"; }
function* iterate () { yield 1; }
class Box { method() { return "box"; } }
var total = first + second;
const trailing = 1,
`);

  assert.match(transformed, /\(\[first\] = \[1\]\);/u);
  assert.match(transformed, /\(\{ second \} = \{ second: 2 \}\);/u);
  assert.match(transformed, /load = async function load/u);
  assert.match(transformed, /iterate = function\* iterate/u);
  assert.match(transformed, /Box = class Box/u);
  assert.match(transformed, /total = first \+ second;/u);
  assert.match(
    __workerRuntimeTestables.buildPersistentCellCode('const value = 1; value + 1'),
    /__setResult\(value \+ 1\);/u,
  );
});

Deno.test('worker runtime persistent transform handles string states and terminated declarations', () => {
  const transformed = __workerRuntimeTestables.rewriteTopLevelBindings(`
const escaped = "a\\"b";
const single = 'value';
const template = \`first
second\`;
let pending;
async function load() { return 'ok'; };
function inspect() {
  const text = "a\\"b";
  const singleText = 'value';
  const templateText = \`first
second\`;
  // inside comment
  /* inside block */
  return text;
};
class Box {};
function broken() {
  const open = "still open";
`);

  assert.match(transformed, /escaped = "a\\"b";/u);
  assert.match(transformed, /single = 'value';/u);
  assert.match(transformed, /template = `first\nsecond`;/u);
  assert.match(transformed, /pending = undefined;/u);
  assert.match(transformed, /load = async function load/u);
  assert.match(transformed, /inspect = function inspect/u);
  assert.match(transformed, /Box = class Box/u);
  assert.match(transformed, /broken = function broken/u);
  assert.equal(__workerRuntimeTestables.rewriteTopLevelBindings('const ;'), '');
});

Deno.test('direct sandbox helper executes a cell in the default worker runtime', async () => {
  const result = await executeCellInSandbox({
    context: null,
    currentCode: '1 + 1',
    history: [],
    replayCells: [],
    timeoutMs: 1_000,
  });

  assert.equal(result.status, 'success');
  assert.equal(result.result.preview, '2');
});

Deno.test('persistent runtime rejects inconsistent successful history during restore', async () => {
  const worker = createPersistentWorker((message, fakeWorker) => {
    if (message.type === 'execute' && typeof message.requestId === 'number') {
      queueMicrotask(() => {
        fakeWorker.onmessage?.(
          new MessageEvent('message', {
            data: createSandboxOutput(message.requestId!, {
              error: { message: 'restore failed', name: 'Error' },
              status: 'error',
            }),
          }),
        );
      });
    }
  });

  const runtime = new PersistentSandboxRuntime(
    { context: null },
    () => worker as unknown as Worker,
  );

  await assert.rejects(
    () =>
      runtime.execute({
        code: '1',
        history: [createCellEntry({ code: 'const stale = 1;' })],
        timeoutMs: 100,
      }),
    /Failed to restore persistent interpreter state/u,
  );
});

Deno.test('persistent runtime rejects concurrent executions and supports explicit close', async () => {
  let pendingRequestId: number | null = null;
  const worker = createPersistentWorker((message) => {
    if (message.type === 'execute' && pendingRequestId === null) {
      pendingRequestId = message.requestId ?? null;
    }
  });

  const runtime = new PersistentSandboxRuntime(
    { context: null },
    () => worker as unknown as Worker,
  );

  const first = runtime.execute({ code: '1', history: [], timeoutMs: 1_000 });
  await assert.rejects(
    () => runtime.execute({ code: '2', history: [], timeoutMs: 1_000 }),
    /Concurrent REPL executions are not supported/u,
  );

  queueMicrotask(() => {
    worker.onmessage?.(
      new MessageEvent('message', {
        data: createSandboxOutput(pendingRequestId ?? 0),
      }),
    );
  });

  const result = await first;
  assert.equal(result.status, 'success');
  runtime.close();
});

Deno.test('persistent runtime synchronizes history incrementally instead of resending full history on every execute', async () => {
  const postedMessages: Array<Record<string, unknown>> = [];
  const worker = createPersistentWorker((message, fakeWorker) => {
    postedMessages.push(message as Record<string, unknown>);

    if (message.type === 'execute' && typeof message.requestId === 'number') {
      queueMicrotask(() => {
        fakeWorker.onmessage?.(
          new MessageEvent('message', {
            data: createSandboxOutput(message.requestId!),
          }),
        );
      });
    }
  });

  const runtime = new PersistentSandboxRuntime(
    { context: { document: 'alpha '.repeat(8_000) } },
    () => worker as unknown as Worker,
  );

  await runtime.execute({
    code: 'const first = 1;',
    history: [],
    timeoutMs: 100,
  });
  await runtime.execute({
    code: 'first + 1',
    history: [createCellEntry({ cellId: 'cell-1', code: 'const first = 1;' })],
    timeoutMs: 100,
  });

  const initMessage = postedMessages.find((message) => message.type === 'init');
  const executeMessages = postedMessages.filter((message) => message.type === 'execute');
  assert.ok(initMessage !== undefined);
  assert.equal(executeMessages.length, 2);
  assert.equal('context' in (executeMessages[0] ?? {}), false);
  assert.equal('history' in (executeMessages[0] ?? {}), false);
  assert.deepEqual(executeMessages[0]?.historyDelta ?? [], []);
  assert.deepEqual(executeMessages[1]?.historyDelta ?? [], [
    createCellEntry({ cellId: 'cell-1', code: 'const first = 1;' }),
  ]);
});

Deno.test('persistent runtime resolves worker error and messageerror failures', async () => {
  const workerErrorWorker = createPersistentWorker((_message, fakeWorker) => {
    queueMicrotask(() => {
      fakeWorker.onerror?.(new ErrorEvent('error', { message: 'persistent worker failed' }));
    });
  });
  const messageErrorWorker = createPersistentWorker((_message, fakeWorker) => {
    queueMicrotask(() => {
      fakeWorker.onmessageerror?.(new MessageEvent('messageerror'));
    });
  });

  const workerErrorRuntime = new PersistentSandboxRuntime(
    { context: null },
    () => workerErrorWorker as unknown as Worker,
  );
  const messageErrorRuntime = new PersistentSandboxRuntime(
    { context: null },
    () => messageErrorWorker as unknown as Worker,
  );

  const workerError = await workerErrorRuntime.execute({
    code: '1',
    history: [],
    timeoutMs: 100,
  });
  const messageError = await messageErrorRuntime.execute({
    code: '1',
    history: [],
    timeoutMs: 100,
  });

  assert.equal(workerError.status, 'error');
  assert.equal(workerError.error?.name, 'WorkerError');
  assert.equal(messageError.status, 'error');
  assert.equal(messageError.error?.name, 'MessageError');
});

Deno.test('llm_query handler failures surface as REPL errors', async () => {
  const journalPath = await createSessionPath('llm-query-handler-error');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    llmQueryHandler: async () => {
      throw 'denied';
    },
  });

  const result = await session.execute('await llm_query("solve this")');

  assert.equal(result.status, 'error');
  assert.match(result.stderr, /denied/u);
});

Deno.test('llm_query error snapshots preserve Error metadata', async () => {
  const journalPath = await createSessionPath('llm-query-error-metadata');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    llmQueryHandler: async () => {
      throw new TypeError('denied');
    },
  });

  const result = await session.execute('await llm_query("solve this")');

  assert.equal(result.status, 'error');
  assert.equal(result.error?.name, 'TypeError');
  assert.match(result.stderr, /TypeError: denied/u);
});

Deno.test('persistent runtime returns late startup failures and ignores stale callbacks', async () => {
  const captured: {
    onerror: ((event: ErrorEvent) => void) | null;
    onmessage: ((event: MessageEvent) => void) | null;
    onmessageerror: ((event: MessageEvent) => void) | null;
  } = {
    onerror: null,
    onmessage: null,
    onmessageerror: null,
  };

  const worker = createPersistentWorker((message, fakeWorker) => {
    if (message.type === 'init') {
      captured.onerror = fakeWorker.onerror;
      captured.onmessage = fakeWorker.onmessage;
      captured.onmessageerror = fakeWorker.onmessageerror;
      queueMicrotask(() => {
        queueMicrotask(() => {
          fakeWorker.onerror?.(new ErrorEvent('error', { message: 'late startup failure' }));
        });
      });
    }
  });

  const runtime = new PersistentSandboxRuntime(
    { context: null },
    () => worker as unknown as Worker,
  );

  const result = await runtime.execute({ code: '1', history: [], timeoutMs: 100 });

  assert.equal(result.status, 'error');
  assert.equal(result.error?.name, 'WorkerError');

  if (captured.onmessage !== null) {
    captured.onmessage(new MessageEvent('message', { data: createSandboxOutput(999) }));
  }
  if (captured.onerror !== null) {
    captured.onerror(new ErrorEvent('error', { message: 'stale worker failure' }));
  }
  if (captured.onmessageerror !== null) {
    captured.onmessageerror(new MessageEvent('messageerror'));
  }
});

Deno.test('persistent runtime ignores mismatched results before in-flight worker failures', async () => {
  const worker = createPersistentWorker((message, fakeWorker) => {
    if (message.type === 'execute' && typeof message.requestId === 'number') {
      queueMicrotask(() => {
        fakeWorker.onmessage?.(
          new MessageEvent('message', {
            data: createSandboxOutput(message.requestId! + 1),
          }),
        );
        fakeWorker.onerror?.(
          new ErrorEvent('error', { message: 'worker failed after dispatch' }),
        );
      });
    }
  });

  const runtime = new PersistentSandboxRuntime(
    { context: null },
    () => worker as unknown as Worker,
  );

  const result = await runtime.execute({ code: '1', history: [], timeoutMs: 100 });

  assert.equal(result.status, 'error');
  assert.equal(result.error?.name, 'WorkerError');
});

Deno.test('persistent runtime drops llm_query responses after close', async () => {
  const deferred = createDeferred<{ answer: number }>();
  const hostMessages: Array<{ queryId?: number; type: string }> = [];
  const worker = createPersistentWorker((message, fakeWorker) => {
    hostMessages.push(message);

    if (message.type === 'execute' && typeof message.requestId === 'number') {
      queueMicrotask(() => {
        fakeWorker.onmessage?.(
          new MessageEvent('message', {
            data: createSandboxOutput(message.requestId!),
          }),
        );
      });
    }
  });

  const runtime = new PersistentSandboxRuntime(
    {
      context: null,
      llmQueryHandler: () => deferred.promise,
    },
    () => worker as unknown as Worker,
  );

  await runtime.execute({ code: '1', history: [], timeoutMs: 100 });
  worker.onmessage?.(
    new MessageEvent('message', {
      data: {
        prompt: 'slow',
        queryId: 7,
        type: 'llm_query_request',
      },
    }),
  );
  await flushMicrotasks(1);

  runtime.close();
  deferred.resolve({ answer: 42 });
  await flushMicrotasks(2);

  assert.equal(
    hostMessages.some((message) => message.type === 'llm_query_response' && message.queryId === 7),
    false,
  );
});

Deno.test('persistent runtime drops llm_query errors after close', async () => {
  const deferred = createDeferred<never>();
  const hostMessages: Array<{ queryId?: number; type: string }> = [];
  const worker = createPersistentWorker((message, fakeWorker) => {
    hostMessages.push(message);

    if (message.type === 'execute' && typeof message.requestId === 'number') {
      queueMicrotask(() => {
        fakeWorker.onmessage?.(
          new MessageEvent('message', {
            data: createSandboxOutput(message.requestId!),
          }),
        );
      });
    }
  });

  const runtime = new PersistentSandboxRuntime(
    {
      context: null,
      llmQueryHandler: () => deferred.promise,
    },
    () => worker as unknown as Worker,
  );

  await runtime.execute({ code: '1', history: [], timeoutMs: 100 });
  worker.onmessage?.(
    new MessageEvent('message', {
      data: {
        prompt: 'slow',
        queryId: 8,
        type: 'llm_query_request',
      },
    }),
  );
  await flushMicrotasks(1);

  runtime.close();
  deferred.reject(new Error('worker closed'));
  await flushMicrotasks(2);

  assert.equal(
    hostMessages.some((message) => message.type === 'llm_query_error' && message.queryId === 8),
    false,
  );
});

Deno.test('persistent runtime drops rlm_query responses after close', async () => {
  const deferred = createDeferred<{ answer: string }>();
  const hostMessages: Array<{ queryId?: number; type: string }> = [];
  const worker = createPersistentWorker((message, fakeWorker) => {
    hostMessages.push(message);

    if (message.type === 'execute' && typeof message.requestId === 'number') {
      queueMicrotask(() => {
        fakeWorker.onmessage?.(
          new MessageEvent('message', {
            data: createSandboxOutput(message.requestId!),
          }),
        );
      });
    }
  });

  const runtime = new PersistentSandboxRuntime(
    {
      context: null,
      rlmQueryHandler: () => deferred.promise,
    },
    () => worker as unknown as Worker,
  );

  await runtime.execute({ code: '1', history: [], timeoutMs: 100 });
  worker.onmessage?.(
    new MessageEvent('message', {
      data: {
        prompt: 'slow child task',
        queryId: 9,
        type: 'rlm_query_request',
      },
    }),
  );
  await flushMicrotasks(1);

  runtime.close();
  deferred.resolve({ answer: 'ok' });
  await flushMicrotasks(2);

  assert.equal(
    hostMessages.some((message) => message.type === 'llm_query_response' && message.queryId === 9),
    false,
  );
});

Deno.test('persistent runtime drops rlm_query errors after close', async () => {
  const deferred = createDeferred<never>();
  const hostMessages: Array<{ queryId?: number; type: string }> = [];
  const worker = createPersistentWorker((message, fakeWorker) => {
    hostMessages.push(message);

    if (message.type === 'execute' && typeof message.requestId === 'number') {
      queueMicrotask(() => {
        fakeWorker.onmessage?.(
          new MessageEvent('message', {
            data: createSandboxOutput(message.requestId!),
          }),
        );
      });
    }
  });

  const runtime = new PersistentSandboxRuntime(
    {
      context: null,
      rlmQueryHandler: () => deferred.promise,
    },
    () => worker as unknown as Worker,
  );

  await runtime.execute({ code: '1', history: [], timeoutMs: 100 });
  worker.onmessage?.(
    new MessageEvent('message', {
      data: {
        prompt: 'slow child task',
        queryId: 10,
        type: 'rlm_query_request',
      },
    }),
  );
  await flushMicrotasks(1);

  runtime.close();
  deferred.reject(new Error('worker closed'));
  await flushMicrotasks(2);

  assert.equal(
    hostMessages.some((message) => message.type === 'llm_query_error' && message.queryId === 10),
    false,
  );
});

Deno.test('persistent runtime aborts in-flight rlm_query handlers when an execution times out', async () => {
  let aborted = false;
  const worker = createPersistentWorker((message, fakeWorker) => {
    if (message.type === 'execute' && typeof message.requestId === 'number') {
      queueMicrotask(() => {
        fakeWorker.onmessage?.(
          new MessageEvent('message', {
            data: {
              prompt: 'slow child task',
              queryId: 11,
              type: 'rlm_query_request',
            },
          }),
        );
      });
    }
  });

  const runtime = new PersistentSandboxRuntime(
    {
      context: null,
      rlmQueryHandler: async (_prompt, options) =>
        await new Promise((_, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('aborted'));
            },
            { once: true },
          );
        }),
    },
    () => worker as unknown as Worker,
  );

  await assert.rejects(
    async () => {
      await runtime.execute({
        code: 'await rlm_query("slow child task")',
        history: [],
        timeoutMs: 10,
      });
    },
    SandboxTimeoutError,
  );

  await flushMicrotasks(2);
  assert.equal(aborted, true);
});

Deno.test('worker runtime helper resolves worker error and messageerror paths', async () => {
  const baseInput = {
    context: null,
    currentCode: '1 + 1',
    history: [],
    replayCells: [],
    timeoutMs: 50,
  };

  const workerError = await __workerRuntimeTestables.executeCellInSandboxWithFactory(
    baseInput,
    () => {
      const fakeWorker: {
        onerror: ((event: ErrorEvent) => void) | null;
        onmessage: ((event: MessageEvent<unknown>) => void) | null;
        onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
        terminate(): void;
      } = {
        onerror: null,
        onmessage: null,
        onmessageerror: null,
        terminate() {},
      };

      queueMicrotask(() => {
        fakeWorker.onerror?.(new ErrorEvent('error', { message: 'worker failed' }));
      });

      return fakeWorker;
    },
  );

  const messageError = await __workerRuntimeTestables.executeCellInSandboxWithFactory(
    baseInput,
    () => {
      const fakeWorker: {
        onerror: ((event: ErrorEvent) => void) | null;
        onmessage: ((event: MessageEvent<unknown>) => void) | null;
        onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
        terminate(): void;
      } = {
        onerror: null,
        onmessage: null,
        onmessageerror: null,
        terminate() {},
      };

      queueMicrotask(() => {
        fakeWorker.onmessageerror?.(new MessageEvent('messageerror'));
      });

      return fakeWorker;
    },
  );

  assert.equal(workerError.status, 'error');
  assert.equal(workerError.error?.name, 'WorkerError');
  assert.equal(messageError.status, 'error');
  assert.equal(messageError.error?.name, 'MessageError');
});

Deno.test('worker runtime helper rejects when the worker never replies', async () => {
  await assert.rejects(
    () =>
      __workerRuntimeTestables.executeCellInSandboxWithFactory(
        {
          context: null,
          currentCode: '1 + 1',
          history: [],
          replayCells: [],
          timeoutMs: 5,
        },
        () => ({
          onerror: null,
          onmessage: null,
          onmessageerror: null,
          terminate() {},
        }),
      ),
    SandboxTimeoutError,
  );
});
