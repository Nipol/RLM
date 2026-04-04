import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';

import { createAoTPlugin } from '../plugin/aot/mod.ts';
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
import type {
  CellEntry,
  ExecutionBackend,
  PersistentRuntimeLike,
  SessionEntry,
} from '../src/types.ts';

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

Deno.test('runtime failures are recorded while keeping live REPL state available to later cells', async () => {
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
  assert.equal(afterFailure.result.preview, '2');
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

Deno.test('normalizeTarget and findAnchoredValue are not exposed on the REPL surface', async () => {
  const journalPath = await createSessionPath('removed-lookup-helpers');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const extracted = await session.execute(`({
  normalizeTargetType: typeof normalizeTarget,
  findAnchoredValueType: typeof findAnchoredValue,
})`);

  assert.equal(extracted.status, 'success');
  assert.deepEqual(extracted.result.json, {
    findAnchoredValueType: 'undefined',
    normalizeTargetType: 'undefined',
  });
});

Deno.test('grep collects matching lines as structured records with optional surrounding context', async () => {
  const journalPath = await createSessionPath('grep-lines');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const extracted = await session.execute(`grep(
  [
    'header',
    'Program Orion entry: status=approved amount=120 reviewer=west.',
    'skip',
    'program orion entry: status=approved amount=140 reviewer=south.',
    'Program Nova entry: status=approved amount=900 reviewer=east.',
  ].join('\\n'),
  'program orion',
  { before: 1, after: 0, limit: 2 },
)`);

  assert.equal(extracted.status, 'success');
  assert.deepEqual(extracted.result.json, [
    {
      contextText: 'header\nProgram Orion entry: status=approved amount=120 reviewer=west.',
      endLine: 2,
      line: 'Program Orion entry: status=approved amount=120 reviewer=west.',
      lineNumber: 2,
      startLine: 1,
    },
    {
      contextText: 'skip\nprogram orion entry: status=approved amount=140 reviewer=south.',
      endLine: 4,
      line: 'program orion entry: status=approved amount=140 reviewer=south.',
      lineNumber: 4,
      startLine: 3,
    },
  ]);
});

Deno.test('grep supports regex mode and handles defensive nullish or invalid inputs', async () => {
  const journalPath = await createSessionPath('grep-lines-regex');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
  });

  const extracted = await session.execute(`({
  regexString: grep(
    'A=1\\nB=22\\nC=333',
    '\\\\d{2,}',
    { mode: 'regex' },
  ),
  regexLiteral: grep(
    'stamp 14-B\\nstamp 22-Q',
    /stamp\\s+\\d{2}-[A-Z]/,
    { limit: 1 },
  ),
  emptyPattern: grep('alpha', '', {}),
  badInput: grep({ text: 'alpha' }, 'alpha'),
  nullish: grep(null, 'alpha'),
})`);

  assert.equal(extracted.status, 'success');
  assert.deepEqual(extracted.result.json, {
    regexString: [
      { contextText: 'B=22', endLine: 2, line: 'B=22', lineNumber: 2, startLine: 2 },
      { contextText: 'C=333', endLine: 3, line: 'C=333', lineNumber: 3, startLine: 3 },
    ],
    regexLiteral: [
      { contextText: 'stamp 14-B', endLine: 1, line: 'stamp 14-B', lineNumber: 1, startLine: 1 },
    ],
    emptyPattern: [],
    badInput: [],
    nullish: null,
  });
});

Deno.test('SHOW_VARS returns current user-defined bindings without reserved helper names', async () => {
  const journalPath = await createSessionPath('show-vars');
  const session = await ReplSession.open({
    clock: createClock(),
    context: { project: 'orion' },
    idGenerator: createIdGenerator(),
    journalPath,
  });

  await session.execute(`const dossier = 'Silver Fern';
const parsedAmounts = [120, 140, 170];
function chooseStamp(value) {
  return value;
}`);

  const result = await session.execute('SHOW_VARS()');

  assert.equal(result.status, 'success');
  assert.deepEqual(result.result.json, [
    'chooseStamp',
    'dossier',
    'parsedAmounts',
  ]);
});

Deno.test('runtime helpers can be injected into the REPL and awaited like built-in helpers', async () => {
  const journalPath = await createSessionPath('runtime-helper-ping');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    runtimeHelpers: [{
      description: 'PING을 입력으로 받으면 PONG을 반환합니다.',
      inputKinds: ['text'],
      name: 'ping_pong',
      source: 'input === "PING" ? "PONG" : "UNKNOWN"',
    }],
  });

  const result = await session.execute('await ping_pong("PING")');

  assert.equal(result.status, 'success');
  assert.equal(result.result.preview, 'PONG');
  assert.equal(result.result.json, 'PONG');
});

Deno.test('runtime helper names are treated as reserved identifiers once injected', async () => {
  const journalPath = await createSessionPath('runtime-helper-reserved');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    runtimeHelpers: [{
      description: 'PING을 입력으로 받으면 PONG을 반환합니다.',
      inputKinds: ['text'],
      name: 'ping_pong',
      source: 'input',
    }],
  });

  const result = await session.execute('const ping_pong = "shadow";');

  assert.equal(result.status, 'error');
  assert.match(result.stderr, /Reserved REPL identifiers/u);
});

Deno.test('runtime helper source can use built-in llm_query inside its sandbox', async () => {
  const journalPath = await createSessionPath('runtime-helper-llm-query');
  const seenPrompts: string[] = [];
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    llmQueryHandler: async (prompt) => {
      seenPrompts.push(prompt);
      return `echo:${prompt}`;
    },
    runtimeHelpers: [{
      description: '입력을 llm_query에 위임합니다.',
      inputKinds: ['text'],
      name: 'echo_with_llm',
      source: [
        'const reply = await llm_query(String(input));',
        'reply',
      ].join('\n'),
    }],
  });

  const result = await session.execute('await echo_with_llm("PING")');

  assert.equal(result.status, 'success');
  assert.equal(result.result.preview, 'echo:PING');
  assert.equal(result.result.json, 'echo:PING');
  assert.deepEqual(seenPrompts, ['PING']);
});

Deno.test('runtime helper source injects a default rlm_query maxSubcallDepth of 1 and leaves maxSteps unbounded', async () => {
  const journalPath = await createSessionPath('runtime-helper-rlm-query-default-depth');
  const seenCalls: Array<{ maxSteps?: number; maxSubcallDepth?: number; prompt: string | object }> = [];
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    rlmQueryHandler: async (prompt, options) => {
      seenCalls.push({
        maxSteps: options?.maxSteps,
        maxSubcallDepth: options?.maxSubcallDepth,
        prompt,
      });
      return 'delegated';
    },
    runtimeHelpers: [{
      description: '입력을 child RLM에 위임합니다.',
      inputKinds: ['text'],
      name: 'delegate_once',
      source: [
        'await rlm_query(String(input));',
        '"DONE"',
      ].join('\n'),
    }],
  });

  const result = await session.execute('await delegate_once("solve this")');

  assert.equal(result.status, 'success');
  assert.equal(result.result.json, 'DONE');
  assert.deepEqual(seenCalls, [{
    maxSteps: Number.POSITIVE_INFINITY,
    maxSubcallDepth: 1,
    prompt: 'solve this',
  }]);
});

Deno.test('runtime helper source preserves an explicit rlm_query maxSubcallDepth override while keeping maxSteps unbounded', async () => {
  const journalPath = await createSessionPath('runtime-helper-rlm-query-explicit-depth');
  const seenCalls: Array<{ maxSteps?: number; maxSubcallDepth?: number; prompt: string | object }> = [];
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    rlmQueryHandler: async (prompt, options) => {
      seenCalls.push({
        maxSteps: options?.maxSteps,
        maxSubcallDepth: options?.maxSubcallDepth,
        prompt,
      });
      return 'delegated';
    },
    runtimeHelpers: [{
      description: '명시적으로 지정한 child depth를 사용합니다.',
      inputKinds: ['text'],
      name: 'delegate_with_depth',
      rlmQueryMaxSubcallDepth: 1,
      source: [
        'await rlm_query({ task: String(input), maxSubcallDepth: 2 });',
        '"DONE"',
      ].join('\n'),
    }],
  });

  const result = await session.execute('await delegate_with_depth("solve this")');

  assert.equal(result.status, 'success');
  assert.equal(result.result.json, 'DONE');
  assert.deepEqual(seenCalls, [{
    maxSteps: Number.POSITIVE_INFINITY,
    maxSubcallDepth: undefined,
    prompt: {
      maxSubcallDepth: 2,
      task: 'solve this',
    },
  }]);
});

Deno.test('runtime helper source can explicitly override nested rlm_query maxSteps with a second argument', async () => {
  const journalPath = await createSessionPath('runtime-helper-rlm-query-explicit-steps');
  const seenCalls: Array<{ maxSteps?: number; maxSubcallDepth?: number; prompt: string | object }> = [];
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    rlmQueryHandler: async (prompt, options) => {
      seenCalls.push({
        maxSteps: options?.maxSteps,
        maxSubcallDepth: options?.maxSubcallDepth,
        prompt,
      });
      return 'delegated';
    },
    runtimeHelpers: [{
      description: '명시적으로 지정한 child step budget을 사용합니다.',
      inputKinds: ['text'],
      name: 'delegate_with_steps',
      source: [
        'await rlm_query(String(input), { maxSteps: 5 });',
        '"DONE"',
      ].join('\n'),
    }],
  });

  const result = await session.execute('await delegate_with_steps("solve this")');

  assert.equal(result.status, 'success');
  assert.equal(result.result.json, 'DONE');
  assert.deepEqual(seenCalls, [{
    maxSteps: 5,
    maxSubcallDepth: 1,
    prompt: 'solve this',
  }]);
});

Deno.test('runtime helper input rejects nullish and non-string payloads', async () => {
  const journalPath = await createSessionPath('runtime-helper-input-contract');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    runtimeHelpers: [{
      description: '텍스트만 허용합니다.',
      inputKinds: ['text'],
      name: 'text_only',
      source: 'input.toUpperCase()',
    }],
  });

  const nullResult = await session.execute('await text_only(null)');
  const undefinedResult = await session.execute('await text_only(undefined)');
  const objectResult = await session.execute('await text_only({ task: "PING" })');

  assert.equal(nullResult.status, 'error');
  assert.match(nullResult.stderr, /requires a non-null text input/u);
  assert.equal(undefinedResult.status, 'error');
  assert.match(undefinedResult.stderr, /requires a non-null text input/u);
  assert.equal(objectResult.status, 'error');
  assert.match(objectResult.stderr, /expects text input/u);
});

Deno.test('runtime helper accepts object input when the helper declares object support', async () => {
  const journalPath = await createSessionPath('runtime-helper-object-input');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    runtimeHelpers: [{
      description: '객체 키 수를 셉니다.',
      inputKinds: ['object'],
      name: 'count_object_keys',
      source: 'Object.keys(input).length',
    }],
  });

  const result = await session.execute('await count_object_keys({ task: "PING", mode: "AOT" })');

  assert.equal(result.status, 'success');
  assert.equal(result.result.preview, '2');
  assert.equal(result.result.json, 2);
});

Deno.test('runtime helper accepts array input when the helper declares array support', async () => {
  const journalPath = await createSessionPath('runtime-helper-array-input');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    runtimeHelpers: [{
      description: '배열 길이를 셉니다.',
      inputKinds: ['array'],
      name: 'count_array_items',
      source: 'input.length',
    }],
  });

  const result = await session.execute('await count_array_items(["PING", "PONG", "AOT"])');

  assert.equal(result.status, 'success');
  assert.equal(result.result.preview, '3');
  assert.equal(result.result.json, 3);
});

Deno.test('runtime helper rejects undeclared object and array input types', async () => {
  const journalPath = await createSessionPath('runtime-helper-typed-input-mismatch');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    runtimeHelpers: [{
      description: '객체만 허용합니다.',
      inputKinds: ['object'],
      name: 'object_only',
      source: 'Object.keys(input).length',
    }, {
      description: '배열만 허용합니다.',
      inputKinds: ['array'],
      name: 'array_only',
      source: 'input.length',
    }],
  });

  const textResult = await session.execute('await object_only("PING")');
  const objectResult = await session.execute('await array_only({ task: "PING" })');

  assert.equal(textResult.status, 'error');
  assert.match(textResult.stderr, /expects object input/u);
  assert.equal(objectResult.status, 'error');
  assert.match(objectResult.stderr, /expects array input/u);
});

Deno.test('runtime helper timeout floors widen the outer cell timeout budget', async () => {
  const journalPath = await createSessionPath('runtime-helper-timeout-floor');
  const session = await ReplSession.open({
    clock: createClock(),
    defaultTimeoutMs: 20,
    idGenerator: createIdGenerator(),
    journalPath,
    llmQueryHandler: async (prompt) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return prompt;
    },
    runtimeHelpers: [{
      description: '짧은 session timeout보다 오래 걸리는 계산을 수행합니다.',
      inputKinds: ['text'],
      name: 'slow_helper',
      source: [
        'await llm_query(input);',
        'input.toUpperCase()',
      ].join('\n'),
      timeoutMs: 200,
    }],
  });

  const result = await session.execute('await slow_helper("done")');

  assert.equal(result.status, 'success');
  assert.equal(result.result.json, 'DONE');
});

Deno.test('AoT plugin lite mode follows a single decomposition-contraction path without judge, graph solve, or frontier search', async () => {
  const journalPath = await createSessionPath('aot-plugin-lite-flow');
  const llmPrompts: string[] = [];
  const rlmPrompts: string[] = [];
  const plugin = createAoTPlugin();

  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    llmQueryHandler: async (prompt) => {
      llmPrompts.push(prompt);

      if (
        prompt.includes('AOT_DECOMPOSE_JSON') &&
        prompt.includes('Explain why the sky appears blue and summarize it briefly.')
      ) {
        return JSON.stringify({
          atomic: false,
          reason: 'cause and summary can be solved through one reduction',
          subquestions: [
            { id: 'q1', question: 'Why does the sky appear blue?', deps: [] },
          ],
        });
      }

      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('Why does the sky appear blue?')) {
        return 'Rayleigh scattering makes shorter blue wavelengths scatter more strongly.';
      }

      if (prompt.includes('AOT_CONTRACT_JSON')) {
        return JSON.stringify({
          next_question:
            'Explain briefly that the sky appears blue because Rayleigh scattering scatters shorter blue wavelengths more strongly.',
          ready: true,
          reason: 'the reduced state is already directly answerable',
        });
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Rayleigh scattering scatters shorter blue wavelengths more strongly')
      ) {
        return '하늘이 파랗게 보이는 이유는 레일리 산란으로 짧은 파란 파장이 더 강하게 산란되기 때문이다.';
      }

      throw new Error(`Unexpected llm_query prompt: ${prompt}`);
    },
    rlmQueryHandler: async (prompt) => {
      const task = typeof prompt === 'string' ? prompt : prompt.task;
      rlmPrompts.push(task);

      throw new Error(`Unexpected rlm_query prompt: ${task}`);
    },
    runtimeHelpers: plugin.runtimeHelpers,
  });

  const result = await session.execute(`await aot({
  question: "Explain why the sky appears blue and summarize it briefly.",
  maxIterations: 1,
  maxIndependentSubquestions: 2,
  maxRefinements: 0,
  includeTrace: true
})`);

  assert.equal(result.status, 'success');
  const aotResult = result.result.json as Record<string, unknown>;
  const iterations = aotResult.iterations as Array<Record<string, unknown>>;

  assert.equal(
    aotResult.answer,
    '하늘이 파랗게 보이는 이유는 레일리 산란으로 짧은 파란 파장이 더 강하게 산란되기 때문이다.',
  );
  assert.equal(String(aotResult.finalQuestion).includes('Rayleigh scattering'), true);
  assert.equal(aotResult.stoppedBecause, 'lite_ready');
  assert.equal(iterations.length, 1);
  assert.equal(llmPrompts.filter((prompt) => prompt.includes('AOT_DECOMPOSE_JSON')).length, 1);
  assert.equal(llmPrompts.filter((prompt) => prompt.includes('AOT_CONTRACT_JSON')).length, 1);
  assert.equal(llmPrompts.filter((prompt) => prompt.includes('AOT_JUDGE_JSON')).length, 0);
  assert.equal(llmPrompts.filter((prompt) => prompt.includes('AOT_REFINE_JSON')).length, 0);
  assert.equal(llmPrompts.filter((prompt) => prompt.includes('AOT_FRONTIER_JSON')).length, 0);
  assert.equal(llmPrompts.filter((prompt) => prompt.includes('AOT_SOLVE_GRAPH')).length, 0);
  assert.equal(llmPrompts.filter((prompt) => prompt.includes('AOT_SOLVE_STATE')).length, 1);
  assert.equal(rlmPrompts.length, 0);
});

Deno.test('AoT plugin judges solve(Qi), solve(Gi), and solve(Qi+1) before accepting the next state', async () => {
  const journalPath = await createSessionPath('aot-plugin-flow');
  const llmPrompts: string[] = [];
  const rlmPrompts: string[] = [];
  const plugin = createAoTPlugin();

  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    llmQueryHandler: async (prompt) => {
      llmPrompts.push(prompt);

      if (
        prompt.includes('AOT_DECOMPOSE_JSON') &&
        prompt.includes('Who wrote Hamlet and what is its genre?')
      ) {
        return JSON.stringify({
          atomic: false,
          reason: 'author and genre can be solved independently',
          subquestions: [
            { id: 'q1', question: 'Who wrote Hamlet?', deps: [] },
            { id: 'q2', question: 'What genre is Hamlet?', deps: [] },
          ],
        });
      }

      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('Who wrote Hamlet?')) {
        return 'William Shakespeare';
      }

      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('What genre is Hamlet?')) {
        return 'tragedy';
      }

      if (prompt.includes('AOT_CONTRACT_JSON')) {
        return JSON.stringify({
          next_question:
            'Answer in one sentence: Hamlet was written by William Shakespeare and its genre is tragedy.',
          ready: true,
          reason: 'both independent atoms are solved',
        });
      }

      if (prompt.includes('AOT_JUDGE_JSON')) {
        return JSON.stringify({
          accept_next_state: true,
          answer: 'Hamlet was written by William Shakespeare, and it is a tragedy.',
          reason: 'the contracted next state preserves the answer and reduces complexity',
          refine_next_state: false,
          selected: 'next',
        });
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nWho wrote Hamlet and what is its genre?')
      ) {
        return 'Hamlet is a well-known work in English literature.';
      }

      if (prompt.includes('AOT_SOLVE_GRAPH')) {
        return 'Hamlet was written by Shakespeare and is usually categorized as a revenge tragedy.';
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes(
          'Current Markov state:\nAnswer in one sentence: Hamlet was written by William Shakespeare and its genre is tragedy.',
        )
      ) {
        return 'Hamlet was written by William Shakespeare, and it is a tragedy.';
      }

      throw new Error(`Unexpected llm_query prompt: ${prompt}`);
    },
    rlmQueryHandler: async (prompt) => {
      const task = typeof prompt === 'string' ? prompt : prompt.task;
      rlmPrompts.push(task);

      throw new Error(`Unexpected rlm_query prompt: ${task}`);
    },
    runtimeHelpers: plugin.runtimeHelpers,
  });

  const result = await session.execute(
    'JSON.stringify(await aot("Who wrote Hamlet and what is its genre?"))',
  );

  assert.equal(result.status, 'success');
  assert.deepEqual(JSON.parse(String(result.result.json)), {
    answer: 'Hamlet was written by William Shakespeare, and it is a tragedy.',
    finalQuestion:
      'Answer in one sentence: Hamlet was written by William Shakespeare and its genre is tragedy.',
    iterations: [{
      contractedQuestion:
        'Answer in one sentence: Hamlet was written by William Shakespeare and its genre is tragedy.',
      contractedQuestionAnswer: 'Hamlet was written by William Shakespeare, and it is a tragedy.',
      currentStateAnswer: 'Hamlet is a well-known work in English literature.',
      decompositionReason: 'author and genre can be solved independently',
      frontierRank: 1,
      frontierScore: 1,
      graphAnswer:
        'Hamlet was written by Shakespeare and is usually categorized as a revenge tragedy.',
      independentSubquestions: [
        { answer: 'William Shakespeare', id: 'q1', question: 'Who wrote Hamlet?' },
        { answer: 'tragedy', id: 'q2', question: 'What genre is Hamlet?' },
      ],
      iteration: 1,
      judgeAcceptedNextState: true,
      judgeReason: 'the contracted next state preserves the answer and reduces complexity',
      judgeSelection: 'next',
      question: 'Who wrote Hamlet and what is its genre?',
      ready: true,
      refinement: null,
      reason: 'both independent atoms are solved',
      subquestions: [
        { deps: [], id: 'q1', question: 'Who wrote Hamlet?' },
        { deps: [], id: 'q2', question: 'What genre is Hamlet?' },
      ],
    }],
    maxIterations: 3,
    originalQuestion: 'Who wrote Hamlet and what is its genre?',
    stoppedBecause: 'judge_selected_next_state',
  });
  assert.equal(llmPrompts.filter((prompt) => prompt.includes('AOT_DECOMPOSE_JSON')).length, 1);
  assert.equal(llmPrompts.filter((prompt) => prompt.includes('AOT_ATOM_SOLVE')).length, 2);
  assert.equal(llmPrompts.filter((prompt) => prompt.includes('AOT_CONTRACT_JSON')).length, 1);
  assert.equal(llmPrompts.filter((prompt) => prompt.includes('AOT_JUDGE_JSON')).length, 1);
  assert.equal(llmPrompts.filter((prompt) => prompt.includes('AOT_SOLVE_STATE')).length, 2);
  assert.equal(llmPrompts.filter((prompt) => prompt.includes('AOT_SOLVE_GRAPH')).length, 1);
  assert.equal(rlmPrompts.length, 0);
});

Deno.test('AoT plugin can use reflective refinement when the first contracted state is rejected', async () => {
  const journalPath = await createSessionPath('aot-plugin-object-input');
  const llmPrompts: string[] = [];
  const rlmPrompts: string[] = [];
  const plugin = createAoTPlugin();

  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    llmQueryHandler: async (prompt) => {
      llmPrompts.push(prompt);

      if (
        prompt.includes('AOT_DECOMPOSE_JSON') &&
        prompt.includes('When did Atlas launches happen?')
      ) {
        return JSON.stringify({
          atomic: false,
          reason: 'date lookup and aggregation can be separated',
          subquestions: [
            { id: 'q1', question: 'What launch dates are listed for Atlas?', deps: [] },
          ],
        });
      }

      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('What launch dates are listed')) {
        return '2025-01 and 2025-02';
      }

      if (prompt.includes('AOT_CONTRACT_JSON')) {
        return JSON.stringify({
          next_question: 'State the launch dates.',
          ready: false,
          reason: 'the dates have been surfaced but the question is too terse',
        });
      }

      if (prompt.includes('AOT_JUDGE_JSON') && prompt.includes('State the launch dates.')) {
        return JSON.stringify({
          accept_next_state: false,
          answer: 'Atlas launches happened in 2025-01 and 2025-02.',
          reason: 'the proposed next state is too underspecified to be a reliable Markov state',
          refine_next_state: true,
          selected: 'graph',
        });
      }

      if (prompt.includes('AOT_REFINE_JSON')) {
        return JSON.stringify({
          next_question:
            'Using the listed launch dates 2025-01 and 2025-02, answer when Atlas launches happened in one sentence.',
          ready: true,
          reason: 'the refined state is self-contained and answer-equivalent',
        });
      }

      if (
        prompt.includes('AOT_JUDGE_JSON') &&
        prompt.includes('Using the listed launch dates 2025-01 and 2025-02')
      ) {
        return JSON.stringify({
          accept_next_state: true,
          answer: 'Atlas launches happened in 2025-01 and 2025-02.',
          reason: 'the refined state is self-contained and lower-complexity',
          refine_next_state: false,
          selected: 'next',
        });
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nWhen did Atlas launches happen?')
      ) {
        return 'Atlas launches were mentioned in a schedule.';
      }

      if (prompt.includes('AOT_SOLVE_GRAPH')) {
        return 'Atlas launches happened in 2025-01 and 2025-02.';
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nState the launch dates.')
      ) {
        return 'The launch dates are 2025-01 and 2025-02.';
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nUsing the listed launch dates 2025-01 and 2025-02')
      ) {
        return 'Atlas launches happened in 2025-01 and 2025-02.';
      }

      throw new Error(`Unexpected llm_query prompt: ${prompt}`);
    },
    rlmQueryHandler: async (prompt) => {
      const task = typeof prompt === 'string' ? prompt : prompt.task;
      rlmPrompts.push(task);

      throw new Error(`Unexpected rlm_query prompt: ${task}`);
    },
    runtimeHelpers: plugin.runtimeHelpers,
  });

  const result = await session.execute(`await aot({
  question: "When did Atlas launches happen?",
  context: { launches: ["2025-01", "2025-02"] },
  maxIterations: 2,
  maxRefinements: 1,
  includeTrace: false,
})`);

  assert.equal(result.status, 'success');
  assert.deepEqual(result.result.json, {
    answer: 'Atlas launches happened in 2025-01 and 2025-02.',
    finalQuestion:
      'Using the listed launch dates 2025-01 and 2025-02, answer when Atlas launches happened in one sentence.',
    iterations: [],
    maxIterations: 2,
    originalQuestion: 'When did Atlas launches happen?',
    stoppedBecause: 'judge_selected_next_state',
  });
  assert.match(llmPrompts[0] ?? '', /Shared context:/u);
  assert.match(llmPrompts[0] ?? '', /"launches"/u);
  assert.equal(llmPrompts.filter((prompt) => prompt.includes('AOT_REFINE_JSON')).length, 1);
  assert.match(
    llmPrompts.find((prompt) => prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Using the listed launch dates 2025-01 and 2025-02')) ?? '',
    /Using the listed launch dates 2025-01 and 2025-02/u,
  );
  assert.equal(rlmPrompts.length, 0);
});

Deno.test('AoT plugin can rank multiple accepted next states at the same depth and continue with the best branch', async () => {
  const journalPath = await createSessionPath('aot-plugin-frontier-search');
  const llmPrompts: string[] = [];
  const rlmPrompts: string[] = [];
  const plugin = createAoTPlugin();

  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    llmQueryHandler: async (prompt) => {
      llmPrompts.push(prompt);

      if (
        prompt.includes('AOT_DECOMPOSE_JSON') &&
        prompt.includes('Summarize the signal using both clues.')
      ) {
        return JSON.stringify({
          atomic: false,
          reason: 'the two clues can be extracted independently',
          subquestions: [
            { id: 'q1', question: 'What is clue alpha?', deps: [] },
            { id: 'q2', question: 'What is clue beta?', deps: [] },
          ],
        });
      }

      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('What is clue alpha?')) {
        return 'alpha=7';
      }

      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('What is clue beta?')) {
        return 'beta=11';
      }

      if (prompt.includes('AOT_CONTRACT_JSON') && prompt.includes('Candidate sample: 1 / 2')) {
        return JSON.stringify({
          next_question: 'Answer using only alpha.',
          ready: false,
          reason: 'this branch keeps only the first clue',
        });
      }

      if (prompt.includes('AOT_CONTRACT_JSON') && prompt.includes('Candidate sample: 2 / 2')) {
        return JSON.stringify({
          next_question: 'Answer using both alpha and beta.',
          ready: false,
          reason: 'this branch preserves both clues in a self-contained state',
        });
      }

      if (
        prompt.includes('AOT_JUDGE_JSON') &&
        prompt.includes('Proposed next Markov state:\nAnswer using only alpha.')
      ) {
        return JSON.stringify({
          accept_next_state: true,
          answer: 'The signal mentions alpha but misses beta.',
          reason: 'the state is answer-equivalent but weak',
          refine_next_state: false,
          selected: 'next',
        });
      }

      if (
        prompt.includes('AOT_JUDGE_JSON') &&
        prompt.includes('Proposed next Markov state:\nAnswer using both alpha and beta.')
      ) {
        return JSON.stringify({
          accept_next_state: true,
          answer: 'The signal combines alpha=7 and beta=11.',
          reason: 'the state is answer-equivalent and clearly lower complexity',
          refine_next_state: false,
          selected: 'next',
        });
      }

      if (prompt.includes('AOT_FRONTIER_JSON')) {
        return JSON.stringify({
          reason: 'the branch preserving both clues is stronger and more complete',
          selected_ids: ['c2'],
        });
      }

      if (
        prompt.includes('AOT_DECOMPOSE_JSON') &&
        prompt.includes('Answer using both alpha and beta.')
      ) {
        return JSON.stringify({
          atomic: true,
          reason: 'the selected state is already atomic',
          subquestions: [],
        });
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nSummarize the signal using both clues.')
      ) {
        return 'The signal contains some clues.';
      }

      if (prompt.includes('AOT_SOLVE_GRAPH')) {
        return 'The signal combines alpha=7 and beta=11.';
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nAnswer using only alpha.')
      ) {
        return 'The signal mentions only alpha=7.';
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nAnswer using both alpha and beta.')
      ) {
        return 'The signal combines alpha=7 and beta=11.';
      }

      throw new Error(`Unexpected llm_query prompt: ${prompt}`);
    },
    rlmQueryHandler: async (prompt) => {
      const task = typeof prompt === 'string' ? prompt : prompt.task;
      rlmPrompts.push(task);

      throw new Error(`Unexpected rlm_query prompt: ${task}`);
    },
    runtimeHelpers: plugin.runtimeHelpers,
  });

  const result = await session.execute(`await aot({
  question: "Summarize the signal using both clues.",
  transitionSamples: 2,
  beamWidth: 1,
})`);

  assert.equal(result.status, 'success');
  const aotResult = result.result.json as Record<string, unknown>;
  const iterations = aotResult.iterations as Array<Record<string, unknown>>;

  assert.equal(aotResult.answer, 'The signal combines alpha=7 and beta=11.');
  assert.equal(aotResult.finalQuestion, 'Answer using both alpha and beta.');
  assert.equal(aotResult.originalQuestion, 'Summarize the signal using both clues.');
  assert.equal(aotResult.stoppedBecause, 'atomic');
  assert.equal(iterations.length, 2);
  assert.equal(
    iterations[0]?.contractedQuestion,
    'Answer using both alpha and beta.',
  );
  assert.equal(
    iterations[0]?.judgeReason,
    'the state is answer-equivalent and clearly lower complexity',
  );
  assert.equal(iterations[1]?.judgeSelection, 'current');
  assert.equal(llmPrompts.filter((prompt) => prompt.includes('AOT_FRONTIER_JSON')).length, 1);
  assert.match(
    llmPrompts.find((prompt) => prompt.includes('AOT_FRONTIER_JSON')) ?? '',
    /selected_ids/u,
  );
  assert.match(
    llmPrompts.find((prompt) => prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Answer using both alpha and beta.')) ?? '',
    /Answer using both alpha and beta\./u,
  );
  assert.equal(rlmPrompts.length, 0);
});

Deno.test('AoT plugin can rank accepted candidates globally across multiple frontier parents', async () => {
  const journalPath = await createSessionPath('aot-plugin-global-frontier-search');
  const llmPrompts: string[] = [];
  const rlmPrompts: string[] = [];
  const plugin = createAoTPlugin();

  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    llmQueryHandler: async (prompt) => {
      llmPrompts.push(prompt);

      if (
        prompt.includes('AOT_DECOMPOSE_JSON') &&
        prompt.includes('Assemble the final brief.')
      ) {
        return JSON.stringify({
          atomic: false,
          reason: 'red and blue threads can be separated',
          subquestions: [
            { id: 'q1', question: 'What is thread red?', deps: [] },
            { id: 'q2', question: 'What is thread blue?', deps: [] },
          ],
        });
      }

      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('What is thread red?')) {
        return 'red';
      }

      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('What is thread blue?')) {
        return 'blue';
      }

      if (prompt.includes('AOT_CONTRACT_JSON') && prompt.includes('Candidate sample: 1 / 2') &&
        prompt.includes('Current question:\nAssemble the final brief.')) {
        return JSON.stringify({
          next_question: 'Track red branch.',
          ready: false,
          reason: 'follow the red thread first',
        });
      }

      if (prompt.includes('AOT_CONTRACT_JSON') && prompt.includes('Candidate sample: 2 / 2') &&
        prompt.includes('Current question:\nAssemble the final brief.')) {
        return JSON.stringify({
          next_question: 'Track blue branch.',
          ready: false,
          reason: 'follow the blue thread first',
        });
      }

      if (
        prompt.includes('AOT_JUDGE_JSON') &&
        prompt.includes('Proposed next Markov state:\nTrack red branch.')
      ) {
        return JSON.stringify({
          accept_next_state: true,
          answer: 'The brief can be followed through the red thread.',
          reason: 'red is acceptable',
          refine_next_state: false,
          selected: 'next',
        });
      }

      if (
        prompt.includes('AOT_JUDGE_JSON') &&
        prompt.includes('Proposed next Markov state:\nTrack blue branch.')
      ) {
        return JSON.stringify({
          accept_next_state: true,
          answer: 'The brief can be followed through the blue thread.',
          reason: 'blue is acceptable',
          refine_next_state: false,
          selected: 'next',
        });
      }

      if (
        prompt.includes('AOT_DECOMPOSE_JSON') &&
        prompt.includes('Track red branch.')
      ) {
        return JSON.stringify({
          atomic: false,
          reason: 'red can branch into weak or medium paths',
          subquestions: [
            { id: 'q1', question: 'What detail strengthens red?', deps: [] },
          ],
        });
      }

      if (
        prompt.includes('AOT_DECOMPOSE_JSON') &&
        prompt.includes('Track blue branch.')
      ) {
        return JSON.stringify({
          atomic: false,
          reason: 'blue can branch into medium or best paths',
          subquestions: [
            { id: 'q1', question: 'What detail strengthens blue?', deps: [] },
          ],
        });
      }

      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('What detail strengthens red?')) {
        return 'red-strong';
      }

      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('What detail strengthens blue?')) {
        return 'blue-strong';
      }

      if (prompt.includes('AOT_CONTRACT_JSON') && prompt.includes('Candidate sample: 1 / 2') &&
        prompt.includes('Current question:\nTrack red branch.')) {
        return JSON.stringify({
          next_question: 'Red child weak.',
          ready: false,
          reason: 'a weaker red branch',
        });
      }

      if (prompt.includes('AOT_CONTRACT_JSON') && prompt.includes('Candidate sample: 2 / 2') &&
        prompt.includes('Current question:\nTrack red branch.')) {
        return JSON.stringify({
          next_question: 'Red child medium.',
          ready: false,
          reason: 'a medium red branch',
        });
      }

      if (prompt.includes('AOT_CONTRACT_JSON') && prompt.includes('Candidate sample: 1 / 2') &&
        prompt.includes('Current question:\nTrack blue branch.')) {
        return JSON.stringify({
          next_question: 'Blue child medium.',
          ready: false,
          reason: 'a medium blue branch',
        });
      }

      if (prompt.includes('AOT_CONTRACT_JSON') && prompt.includes('Candidate sample: 2 / 2') &&
        prompt.includes('Current question:\nTrack blue branch.')) {
        return JSON.stringify({
          next_question: 'Blue child best.',
          ready: true,
          reason: 'the strongest blue branch',
        });
      }

      if (
        prompt.includes('AOT_JUDGE_JSON') &&
        prompt.includes('Proposed next Markov state:\nRed child weak.')
      ) {
        return JSON.stringify({
          accept_next_state: true,
          answer: 'Red weak path is incomplete.',
          reason: 'weak red branch',
          refine_next_state: false,
          selected: 'next',
        });
      }

      if (
        prompt.includes('AOT_JUDGE_JSON') &&
        prompt.includes('Proposed next Markov state:\nRed child medium.')
      ) {
        return JSON.stringify({
          accept_next_state: true,
          answer: 'Red medium path is usable.',
          reason: 'medium red branch',
          refine_next_state: false,
          selected: 'next',
        });
      }

      if (
        prompt.includes('AOT_JUDGE_JSON') &&
        prompt.includes('Proposed next Markov state:\nBlue child medium.')
      ) {
        return JSON.stringify({
          accept_next_state: true,
          answer: 'Blue medium path is usable.',
          reason: 'medium blue branch',
          refine_next_state: false,
          selected: 'next',
        });
      }

      if (
        prompt.includes('AOT_JUDGE_JSON') &&
        prompt.includes('Proposed next Markov state:\nBlue child best.')
      ) {
        return JSON.stringify({
          accept_next_state: true,
          answer: 'Blue best path resolves the full brief.',
          reason: 'best blue branch',
          refine_next_state: false,
          selected: 'next',
        });
      }

      if (prompt.includes('AOT_FRONTIER_JSON') && prompt.includes('Track red branch.')) {
        return JSON.stringify({
          reason: 'all accepted candidates fit within the beam at this depth',
          selected_ids: ['c1', 'c2'],
        });
      }

      if (prompt.includes('AOT_FRONTIER_JSON') && prompt.includes('Red child weak.')) {
        return JSON.stringify({
          reason: 'the blue best and red medium branches dominate the other options',
          selected_ids: ['c4', 'c2'],
        });
      }

      if (
        prompt.includes('AOT_DECOMPOSE_JSON') &&
        prompt.includes('Red child medium.')
      ) {
        return JSON.stringify({
          atomic: true,
          reason: 'red medium is already atomic',
          subquestions: [],
        });
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nAssemble the final brief.')
      ) {
        return 'The brief starts unresolved.';
      }

      if (
        prompt.includes('AOT_SOLVE_GRAPH') &&
        prompt.includes('Current Markov state:\nAssemble the final brief.')
      ) {
        return 'The brief contains both red and blue threads.';
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nTrack red branch.')
      ) {
        return 'The brief follows the red thread.';
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nTrack blue branch.')
      ) {
        return 'The brief follows the blue thread.';
      }

      if (
        prompt.includes('AOT_SOLVE_GRAPH') &&
        prompt.includes('Current Markov state:\nTrack red branch.')
      ) {
        return 'Red graph resolves to medium quality.';
      }

      if (
        prompt.includes('AOT_SOLVE_GRAPH') &&
        prompt.includes('Current Markov state:\nTrack blue branch.')
      ) {
        return 'Blue graph resolves to the strongest answer.';
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nRed child weak.')
      ) {
        return 'Red weak path is incomplete.';
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nRed child medium.')
      ) {
        return 'Red medium path is usable.';
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nBlue child medium.')
      ) {
        return 'Blue medium path is usable.';
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nBlue child best.')
      ) {
        return 'Blue best path resolves the full brief.';
      }

      throw new Error(`Unexpected llm_query prompt: ${prompt}`);
    },
    rlmQueryHandler: async (prompt) => {
      const task = typeof prompt === 'string' ? prompt : prompt.task;
      rlmPrompts.push(task);

      throw new Error(`Unexpected rlm_query prompt: ${task}`);
    },
    runtimeHelpers: plugin.runtimeHelpers,
  });

  const result = await session.execute(`await aot({
  question: "Assemble the final brief.",
  transitionSamples: 2,
  beamWidth: 2,
})`);

  assert.equal(result.status, 'success');
  const aotResult = result.result.json as Record<string, unknown>;
  const iterations = aotResult.iterations as Array<Record<string, unknown>>;

  assert.equal(aotResult.answer, 'Blue best path resolves the full brief.');
  assert.equal(aotResult.finalQuestion, 'Blue child best.');
  assert.equal(aotResult.stoppedBecause, 'judge_selected_next_state');
  assert.equal(iterations.length, 2);
  assert.equal(iterations[0]?.contractedQuestion, 'Track blue branch.');
  assert.equal(iterations[1]?.contractedQuestion, 'Blue child best.');
  assert.equal(
    iterations[1]?.judgeReason,
    'best blue branch',
  );
  assert.equal(llmPrompts.filter((prompt) => prompt.includes('AOT_FRONTIER_JSON')).length, 1);
  assert.match(
    llmPrompts.find((prompt) => prompt.includes('AOT_FRONTIER_JSON') && prompt.includes('Red child weak.')) ?? '',
    /"selected_ids": \[/u,
  );
  assert.equal(rlmPrompts.length, 0);
});

Deno.test('AoT plugin keeps exploring the beam when a ready candidate is selected but a deeper branch can surpass it', async () => {
  const journalPath = await createSessionPath('aot-plugin-ready-beam-continuation');
  const llmPrompts: string[] = [];
  const rlmPrompts: string[] = [];
  const plugin = createAoTPlugin();

  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    llmQueryHandler: async (prompt) => {
      llmPrompts.push(prompt);

      if (
        prompt.includes('AOT_DECOMPOSE_JSON') &&
        prompt.includes('Pick the best final brief.')
      ) {
        return JSON.stringify({
          atomic: false,
          reason: 'the brief can be drafted quickly or investigated further',
          subquestions: [
            { id: 'q1', question: 'What evidence is already available?', deps: [] },
          ],
        });
      }

      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('What evidence is already available?')) {
        return 'core-evidence';
      }

      if (
        prompt.includes('AOT_CONTRACT_JSON') &&
        prompt.includes('Candidate sample: 1 / 3') &&
        prompt.includes('Current question:\nPick the best final brief.')
      ) {
        return JSON.stringify({
          next_question: 'Quick draft.',
          ready: true,
          reason: 'a serviceable answer is already available',
        });
      }

      if (
        prompt.includes('AOT_CONTRACT_JSON') &&
        prompt.includes('Candidate sample: 2 / 3') &&
        prompt.includes('Current question:\nPick the best final brief.')
      ) {
        return JSON.stringify({
          next_question: 'Investigate deeply.',
          ready: false,
          reason: 'one more reasoning step could improve the answer',
        });
      }

      if (
        prompt.includes('AOT_CONTRACT_JSON') &&
        prompt.includes('Candidate sample: 3 / 3') &&
        prompt.includes('Current question:\nPick the best final brief.')
      ) {
        return JSON.stringify({
          next_question: 'Discard the secondary clue.',
          ready: false,
          reason: 'this branch drops important evidence',
        });
      }

      if (
        prompt.includes('AOT_JUDGE_JSON') &&
        prompt.includes('Proposed next Markov state:\nQuick draft.')
      ) {
        return JSON.stringify({
          accept_next_state: true,
          answer: 'Quick draft answer.',
          reason: 'good enough ready branch',
          refine_next_state: false,
          selected: 'next',
        });
      }

      if (
        prompt.includes('AOT_JUDGE_JSON') &&
        prompt.includes('Proposed next Markov state:\nInvestigate deeply.')
      ) {
        return JSON.stringify({
          accept_next_state: true,
          answer: 'Investigating could produce the strongest answer.',
          reason: 'promising deeper branch',
          refine_next_state: false,
          selected: 'next',
        });
      }

      if (
        prompt.includes('AOT_JUDGE_JSON') &&
        prompt.includes('Proposed next Markov state:\nDiscard the secondary clue.')
      ) {
        return JSON.stringify({
          accept_next_state: true,
          answer: 'This branch is weak.',
          reason: 'weak branch',
          refine_next_state: false,
          selected: 'next',
        });
      }

      if (prompt.includes('AOT_FRONTIER_JSON') && prompt.includes('Quick draft.')) {
        return JSON.stringify({
          reason: 'keep the ready draft and the strongest unfinished branch in the beam',
          selected_ids: ['c1', 'c2'],
        });
      }

      if (
        prompt.includes('AOT_DECOMPOSE_JSON') &&
        prompt.includes('Investigate deeply.')
      ) {
        return JSON.stringify({
          atomic: false,
          reason: 'one final reduction yields the strongest brief',
          subquestions: [
            { id: 'q1', question: 'What final detail completes the investigation?', deps: [] },
          ],
        });
      }

      if (
        prompt.includes('AOT_ATOM_SOLVE') &&
        prompt.includes('What final detail completes the investigation?')
      ) {
        return 'final-detail';
      }

      if (
        prompt.includes('AOT_CONTRACT_JSON') &&
        prompt.includes('Current question:\nInvestigate deeply.')
      ) {
        return JSON.stringify({
          next_question: 'Best final answer.',
          ready: true,
          reason: 'the investigation now yields the strongest self-contained answer',
        });
      }

      if (
        prompt.includes('AOT_JUDGE_JSON') &&
        prompt.includes('Proposed next Markov state:\nBest final answer.')
      ) {
        return JSON.stringify({
          accept_next_state: true,
          answer: 'Best investigated answer.',
          reason: 'strongest branch after one extra reasoning step',
          refine_next_state: false,
          selected: 'next',
        });
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nPick the best final brief.')
      ) {
        return 'The brief starts incomplete.';
      }

      if (
        prompt.includes('AOT_SOLVE_GRAPH') &&
        prompt.includes('Current Markov state:\nPick the best final brief.')
      ) {
        return 'The brief can be drafted now or improved by one more step.';
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nQuick draft.')
      ) {
        return 'Quick draft answer.';
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nInvestigate deeply.')
      ) {
        return 'The investigation is not finished yet.';
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nDiscard the secondary clue.')
      ) {
        return 'This branch is weak.';
      }

      if (
        prompt.includes('AOT_SOLVE_GRAPH') &&
        prompt.includes('Current Markov state:\nInvestigate deeply.')
      ) {
        return 'The investigation can produce the strongest answer.';
      }

      if (
        prompt.includes('AOT_SOLVE_STATE') &&
        prompt.includes('Current Markov state:\nBest final answer.')
      ) {
        return 'Best investigated answer.';
      }

      throw new Error(`Unexpected llm_query prompt: ${prompt}`);
    },
    rlmQueryHandler: async (prompt) => {
      const task = typeof prompt === 'string' ? prompt : prompt.task;
      rlmPrompts.push(task);

      throw new Error(`Unexpected rlm_query prompt: ${task}`);
    },
    runtimeHelpers: plugin.runtimeHelpers,
  });

  const result = await session.execute(`JSON.stringify(await aot({
  question: "Pick the best final brief.",
  transitionSamples: 3,
  beamWidth: 2,
}))`);

  assert.equal(result.status, 'success');
  const aotResult = JSON.parse(String(result.result.json)) as Record<string, unknown>;
  const iterations = aotResult.iterations as Array<Record<string, unknown>>;

  assert.equal(aotResult.answer, 'Best investigated answer.');
  assert.equal(aotResult.finalQuestion, 'Best final answer.');
  assert.equal(aotResult.stoppedBecause, 'judge_selected_next_state');
  assert.equal(iterations.length, 2);
  assert.equal(iterations[0]?.contractedQuestion, 'Investigate deeply.');
  assert.equal(iterations[1]?.contractedQuestion, 'Best final answer.');
  assert.equal(iterations[0]?.frontierScore, 1);
  assert.equal(iterations[1]?.frontierScore, 3);
  assert.equal(llmPrompts.filter((prompt) => prompt.includes('AOT_FRONTIER_JSON')).length, 1);
  assert.match(
    llmPrompts.find((prompt) => prompt.includes('AOT_FRONTIER_JSON')) ?? '',
    /"pathScore": 0/u,
  );
  assert.match(
    llmPrompts.find((prompt) => prompt.includes('Best final answer.') && prompt.includes('AOT_SOLVE_STATE')) ?? '',
    /Best final answer\./u,
  );
  assert.equal(rlmPrompts.length, 0);
});

Deno.test('llm_query_batched resolves plain subcalls in input order', async () => {
  const journalPath = await createSessionPath('llm-query-batched');
  const seenPrompts: string[] = [];
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    llmQueryHandler: async (prompt) => {
      seenPrompts.push(prompt);
      return `echo:${prompt}`;
    },
  });

  const result = await session.execute(
    'await llm_query_batched(["alpha", "beta", "gamma"])',
  );

  assert.equal(result.status, 'success');
  assert.deepEqual(result.result.json, [
    'echo:alpha',
    'echo:beta',
    'echo:gamma',
  ]);
  assert.deepEqual(seenPrompts, ['alpha', 'beta', 'gamma']);
});

Deno.test('rlm_query_batched resolves delegated subcalls in input order', async () => {
  const journalPath = await createSessionPath('rlm-query-batched');
  const seenPrompts: Array<string | { task: string }> = [];
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    rlmQueryHandler: async (prompt) => {
      seenPrompts.push(typeof prompt === 'string' ? prompt : { task: prompt.task });
      return typeof prompt === 'string' ? `delegated:${prompt}` : { task: prompt.task, ok: true };
    },
  });

  const result = await session.execute(`await rlm_query_batched([
  "pick dossier",
  { task: "pick stamp", expect: "string" },
])`);

  assert.equal(result.status, 'success');
  assert.deepEqual(result.result.json, [
    'delegated:pick dossier',
    { ok: true, task: 'pick stamp' },
  ]);
  assert.deepEqual(seenPrompts, [
    'pick dossier',
    { task: 'pick stamp' },
  ]);
});

Deno.test('batched query helpers reject invalid prompt collections defensively', async () => {
  const journalPath = await createSessionPath('batched-query-invalid');
  const session = await ReplSession.open({
    clock: createClock(),
    idGenerator: createIdGenerator(),
    journalPath,
    llmQueryHandler: async (prompt) => prompt,
    rlmQueryHandler: async (prompt) => typeof prompt === 'string' ? prompt : prompt.task,
  });

  const result = await session.execute(`({
  badLlmType: await llm_query_batched('alpha').catch((error) => error.message),
  emptyLlm: await llm_query_batched([]).catch((error) => error.message),
  badRlmEntry: await rlm_query_batched([null]).catch((error) => error.message),
  emptyRlmTask: await rlm_query_batched([{ task: '   ' }]).catch((error) => error.message),
})`);

  assert.equal(result.status, 'success');
  assert.deepEqual(result.result.json, {
    badLlmType: 'llm_query_batched requires a non-empty prompt array.',
    emptyLlm: 'llm_query_batched requires a non-empty prompt array.',
    badRlmEntry:
      'rlm_query_batched expects each entry to be either a non-empty task string or an object with a non-empty task field.',
    emptyRlmTask:
      'rlm_query_batched expects each entry to be either a non-empty task string or an object with a non-empty task field.',
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
});

Deno.test('code guard allows normalizeTarget and findAnchoredValue to be reused as ordinary user variable names', () => {
  assert.doesNotThrow(() =>
    assertCodeIsRunnable('const normalizeTarget = "linen";\nconst value = normalizeTarget;\nvalue')
  );
  assert.doesNotThrow(() =>
    assertCodeIsRunnable(
      'const findAnchoredValue = "A: 1.";\nconst value = findAnchoredValue;\nvalue',
    )
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
  assert.equal(
    __replSessionTestables.resolveRuntimeHelperTimeoutFloor([
      { description: 'slow', name: 'slow', source: 'input', timeoutMs: 200 },
      { description: 'fast', name: 'fast', source: 'input', timeoutMs: 50 },
    ]),
    200,
  );
  assert.equal(
    __replSessionTestables.resolveExecutionTimeout(30, 200),
    200,
  );
  assert.equal(
    __replSessionTestables.resolveExecutionTimeout(300, 200),
    300,
  );
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

Deno.test('worker runtime persistent transform preserves top-level grep calls with regex and options objects', () => {
  const transformed = __workerRuntimeTestables.buildPersistentCellCode(`
const optionRows = grep(context.document, /Question options:|Option [A-Z]|^[A-E][).:-]/i, { before: 0, after: 1, limit: 20 }) || [];
const evidenceRows = grep(context.document, /handoff|checksum|archive copy|verify seal/i, { before: 1, after: 1, limit: 20 }) || [];
({ optionRows: optionRows.map((row) => row.contextText), evidenceRows: evidenceRows.map((row) => row.contextText) });
`);

  assert.match(
    transformed,
    /optionRows = grep\(context\.document, \/Question options:\|Option \[A-Z\]\|\^\[A-E\]\[\)\.:-\]\/i, \{ before: 0, after: 1, limit: 20 \}\) \|\| \[\];/u,
  );
  assert.match(
    transformed,
    /evidenceRows = grep\(context\.document, \/handoff\|checksum\|archive copy\|verify seal\/i, \{ before: 1, after: 1, limit: 20 \}\) \|\| \[\];/u,
  );
  assert.doesNotMatch(transformed, /\|\| \[\] = undefined/u);
  assert.doesNotThrow(() => new Function(transformed));
});

Deno.test('worker runtime persistent transform preserves top-level grep calls with inline regex character classes', () => {
  const transformed = __workerRuntimeTestables.buildPersistentCellCode(`
const hits = grep(doc, /safe handoff|handoff sequence|option [A-E]|^[A-E][).:-]/i, { before: 2, after: 2, limit: 50 }) || [];
console.log({ hitCount: hits.length });
hits.slice(0, 10).map((hit) => hit.contextText).join("\\n---\\n");
`);

  assert.match(
    transformed,
    /hits = grep\(doc, \/safe handoff\|handoff sequence\|option \[A-E\]\|\^\[A-E\]\[\)\.:-\]\/i, \{ before: 2, after: 2, limit: 50 \}\) \|\| \[\];/u,
  );
  assert.doesNotThrow(() => new Function(transformed));
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

Deno.test('direct sandbox helper fails clearly when the runtime has no global Worker constructor', async () => {
  const originalWorker = globalThis.Worker;

  try {
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      value: undefined,
      writable: true,
    });

    await assert.rejects(
      () =>
        executeCellInSandbox({
          context: null,
          currentCode: '1 + 1',
          history: [],
          replayCells: [],
          timeoutMs: 100,
        }),
      /No global Worker constructor is available in this runtime/u,
    );
  } finally {
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      value: originalWorker,
      writable: true,
    });
  }
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

Deno.test('persistent runtime can bootstrap from an async worker factory before the first execution', async () => {
  let created = 0;
  let pendingRequestId: number | null = null;
  const worker = createPersistentWorker((message, fakeWorker) => {
    if (message.type === 'execute' && pendingRequestId === null) {
      pendingRequestId = message.requestId ?? null;
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
    { context: null },
    async () => {
      created += 1;
      return worker as unknown as Worker;
    },
  );

  const result = await runtime.execute({ code: '1 + 1', history: [], timeoutMs: 100 });

  assert.equal(created, 1);
  assert.equal(result.status, 'success');
  assert.equal(pendingRequestId !== null, true);
});

Deno.test('persistent runtime keeps the active worker alive after one cell returns an execution error', async () => {
  let created = 0;
  let executeCount = 0;
  const worker = createPersistentWorker((message, fakeWorker) => {
    if (message.type !== 'execute' || typeof message.requestId !== 'number') {
      return;
    }

    executeCount += 1;
    queueMicrotask(() => {
      fakeWorker.onmessage?.(
        new MessageEvent('message', {
          data: executeCount === 1
            ? createSandboxOutput(message.requestId!, {
              error: { message: 'missing ) after argument list', name: 'SyntaxError' },
              status: 'error',
              stderr: 'SyntaxError: missing ) after argument list',
            })
            : createSandboxOutput(message.requestId!, {
              finalAnswer: 'fixed',
              result: { kind: 'string', json: 'fixed', preview: '"fixed"' },
            }),
        }),
      );
    });
  });

  const runtime = new PersistentSandboxRuntime(
    { context: null },
    async () => {
      created += 1;
      return worker as unknown as Worker;
    },
  );

  const first = await runtime.execute({
    code: 'const broken = (',
    history: [],
    timeoutMs: 100,
  });
  const second = await runtime.execute({
    code: 'FINAL_VAR("fixed")',
    history: [
      createCellEntry({
        cellId: 'cell-error',
        code: 'const broken = (',
        error: { message: 'missing ) after argument list', name: 'SyntaxError' },
        status: 'error',
        stderr: 'SyntaxError: missing ) after argument list',
      }),
    ],
    timeoutMs: 100,
  });

  assert.equal(first.status, 'error');
  assert.equal(first.error?.name, 'SyntaxError');
  assert.match(first.stderr, /missing \) after argument list/u);
  assert.equal(second.status, 'success');
  assert.equal(second.finalAnswer, 'fixed');
  assert.equal(created, 1);
  assert.equal(executeCount, 2);
  assert.equal(worker.terminated, false);

  runtime.close();
  assert.equal(worker.terminated, true);
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

      setTimeout(() => {
        fakeWorker.onerror?.(new ErrorEvent('error', { message: 'worker failed' }));
      }, 0);

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

      setTimeout(() => {
        fakeWorker.onmessageerror?.(new MessageEvent('messageerror'));
      }, 0);

      return fakeWorker;
    },
  );

  assert.equal(workerError.status, 'error');
  assert.equal(workerError.error?.name, 'WorkerError');
  assert.equal(messageError.status, 'error');
  assert.equal(messageError.error?.name, 'MessageError');
});

Deno.test('worker runtime helper accepts async worker factories before it starts the timeout window', async () => {
  const output = await __workerRuntimeTestables.executeCellInSandboxWithFactory(
    {
      context: null,
      currentCode: '1 + 1',
      history: [],
      replayCells: [],
      timeoutMs: 50,
    },
    async () => {
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

      setTimeout(() => {
        fakeWorker.onmessage?.(
          new MessageEvent('message', {
            data: {
              error: null,
              finalAnswer: '2',
              finalResult: null,
              result: { kind: 'number', preview: '2' },
              status: 'success',
              stderr: '',
              stdout: '',
            },
          }),
        );
      }, 0);

      return fakeWorker;
    },
  );

  assert.equal(output.status, 'success');
  assert.equal(output.finalAnswer, '2');
});

Deno.test('persistent runtime rejects duplicate runtime helper names before worker startup', () => {
  assert.throws(
    () =>
      new PersistentSandboxRuntime(
        {
          context: null,
          runtimeHelpers: [
            { description: 'first', name: 'repeat', source: 'input' },
            { description: 'second', name: 'repeat', source: 'input' },
          ],
        },
        () => createPersistentWorker(() => {}) as unknown as Worker,
      ),
    /Duplicate runtime helper name: repeat/u,
  );
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
