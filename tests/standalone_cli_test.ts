import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createAoTPlugin } from '../plugin/aot/mod.ts';
import {
  __standaloneCLITestables,
  createStandaloneLogPath,
  createStandaloneProgressLogger,
  parseStandaloneCLIArgs,
  renderStandaloneFinalAnswer,
  resolveStandaloneCLIOptions,
  runStandaloneCLI,
} from '../examples/standalone/cli.ts';
import { InMemoryRLMLogger } from '../src/logger.ts';
import { estimateOpenAIRunCostUsd } from '../src/providers/openai.ts';
import type { AssistantTurnEntry, CellEntry, QueryTraceEntry, SessionEntry } from '../src/types.ts';

function createClock(timestamp = Date.parse('2026-03-26T11:22:33.456Z')): () => Date {
  return () => new Date(timestamp);
}

Deno.test('parseStandaloneCLIArgs accepts required flags and reject missing ones', () => {
  const parsed = parseStandaloneCLIArgs([
    '--input',
    'fixtures/book.txt',
    '--query',
    'Find the answer.',
    '--system-prompt',
    'prompts/ebook-system.txt',
  ]);

  assert.deepEqual(parsed, {
    inputPath: 'fixtures/book.txt',
    provider: 'openai',
    query: 'Find the answer.',
    systemPromptPath: 'prompts/ebook-system.txt',
  });

  assert.deepEqual(
    parseStandaloneCLIArgs([
      '--provider',
      'codex-oauth',
      '--login',
    ]),
    {
      login: true,
      provider: 'codex-oauth',
    },
  );

  assert.deepEqual(
    parseStandaloneCLIArgs([
      '--provider',
      'codex-oauth',
      '--list-models',
      '--request-timeout-ms',
      '65000',
      '--cell-timeout-ms',
      '35000',
      '--root-model',
      'gpt-5.4-mini',
      '--sub-model',
      'gpt-5.4-nano',
    ]),
    {
      cellTimeoutMs: 35_000,
      listModels: true,
      provider: 'codex-oauth',
      requestTimeoutMs: 65_000,
      rootModel: 'gpt-5.4-mini',
      subModel: 'gpt-5.4-nano',
    },
  );

  assert.throws(
    () => parseStandaloneCLIArgs(['--input', 'book.txt', '--query', 'missing system prompt']),
    /Missing required CLI flags/u,
  );
  assert.throws(
    () => parseStandaloneCLIArgs(['--input']),
    /Missing value for --input/u,
  );
  assert.throws(
    () => parseStandaloneCLIArgs(['--provider']),
    /Missing value for --provider/u,
  );
  assert.throws(
    () => parseStandaloneCLIArgs(['--query']),
    /Missing value for --query/u,
  );
  assert.throws(
    () => parseStandaloneCLIArgs(['--root-model']),
    /Missing value for --root-model/u,
  );
  assert.throws(
    () => parseStandaloneCLIArgs(['--sub-model']),
    /Missing value for --sub-model/u,
  );
  assert.throws(
    () => parseStandaloneCLIArgs(['--system-prompt']),
    /Missing value for --system-prompt/u,
  );
  assert.throws(
    () => parseStandaloneCLIArgs(['--log']),
    /Missing value for --log/u,
  );
  assert.throws(
    () => parseStandaloneCLIArgs(['--cell-timeout-ms']),
    /Missing value for --cell-timeout-ms/u,
  );
  assert.throws(
    () => parseStandaloneCLIArgs(['--cell-timeout-ms', '0']),
    /--cell-timeout-ms must be a positive integer/u,
  );
  assert.throws(
    () => parseStandaloneCLIArgs(['--cell-timeout-ms', 'abc']),
    /--cell-timeout-ms must be a positive integer/u,
  );
  assert.throws(
    () => parseStandaloneCLIArgs(['--request-timeout-ms']),
    /Missing value for --request-timeout-ms/u,
  );
  assert.throws(
    () => parseStandaloneCLIArgs(['--request-timeout-ms', '0']),
    /--request-timeout-ms must be a positive integer/u,
  );
  assert.throws(
    () => parseStandaloneCLIArgs(['--request-timeout-ms', 'abc']),
    /--request-timeout-ms must be a positive integer/u,
  );
  assert.throws(
    () => parseStandaloneCLIArgs(['--provider', 'unknown']),
    /Unknown provider/u,
  );
  assert.throws(
    () => parseStandaloneCLIArgs(['--unknown', 'value']),
    /Unknown CLI flag/u,
  );

  assert.deepEqual(
    parseStandaloneCLIArgs([
      '--aot',
      '--input',
      'fixtures/book.txt',
      '--query',
      'Find the answer.',
      '--system-prompt',
      'prompts/ebook-system.txt',
    ]),
    {
      aotMode: 'lite',
      inputPath: 'fixtures/book.txt',
      provider: 'openai',
      query: 'Find the answer.',
      systemPromptPath: 'prompts/ebook-system.txt',
    },
  );

  assert.deepEqual(
    parseStandaloneCLIArgs([
      '--aot-hard',
      '--aot-debug',
      '--input',
      'fixtures/book.txt',
      '--query',
      'Find the answer.',
      '--system-prompt',
      'prompts/ebook-system.txt',
    ]),
    {
      aotDebug: true,
      aotMode: 'hard',
      inputPath: 'fixtures/book.txt',
      provider: 'openai',
      query: 'Find the answer.',
      systemPromptPath: 'prompts/ebook-system.txt',
    },
  );

  assert.throws(
    () =>
      parseStandaloneCLIArgs([
        '--aot',
        '--aot-hard',
        '--query',
        'Find the answer.',
        '--system-prompt',
        'prompts/ebook-system.txt',
      ]),
    /Choose either --aot or --aot-hard/u,
  );
  assert.throws(
    () =>
      parseStandaloneCLIArgs([
        '--aot-hard',
        '--aot',
        '--query',
        'Find the answer.',
        '--system-prompt',
        'prompts/ebook-system.txt',
      ]),
    /Choose either --aot or --aot-hard/u,
  );

  assert.throws(
    () =>
      parseStandaloneCLIArgs([
        '--aot-debug',
        '--query',
        'Find the answer.',
        '--system-prompt',
        'prompts/ebook-system.txt',
      ]),
    /--aot-debug requires --aot or --aot-hard/u,
  );

  assert.deepEqual(
    parseStandaloneCLIArgs([
      '--query',
      'Find the answer.',
      '--system-prompt',
      'prompts/ebook-system.txt',
    ]),
    {
      provider: 'openai',
      query: 'Find the answer.',
      systemPromptPath: 'prompts/ebook-system.txt',
    },
  );

  assert.deepEqual(
    parseStandaloneCLIArgs([
      '--input',
      'fixtures/book.txt',
      '--query',
      'Find the answer.',
      '--system-prompt',
      'prompts/ebook-system.txt',
      '--request-timeout-ms',
      '90000',
      '--cell-timeout-ms',
      '45000',
      '--log',
      'logs/custom.jsonl',
    ]),
    {
      cellTimeoutMs: 45_000,
      inputPath: 'fixtures/book.txt',
      logPath: 'logs/custom.jsonl',
      provider: 'openai',
      query: 'Find the answer.',
      requestTimeoutMs: 90_000,
      systemPromptPath: 'prompts/ebook-system.txt',
    },
  );
});

Deno.test('resolveStandaloneCLIOptions makes paths absolute and creates a default standalone log path', () => {
  const resolved = resolveStandaloneCLIOptions(
    {
      inputPath: 'fixtures/book.txt',
      provider: 'openai',
      query: 'Find the answer.',
      systemPromptPath: 'prompts/ebook-system.txt',
    },
    {
      clock: createClock(),
      cwd: '/workspace/rlm',
    },
  );

  assert.equal(resolved.inputPath, '/workspace/rlm/fixtures/book.txt');
  assert.equal(resolved.systemPromptPath, '/workspace/rlm/prompts/ebook-system.txt');
  assert.equal(resolved.cellTimeoutMs, undefined);
  assert.equal(resolved.aotMode, undefined);
  assert.equal(resolved.aotDebug, undefined);
  assert.equal(resolved.provider, 'openai');
  assert.equal(resolved.query, 'Find the answer.');
  assert.match(
    resolved.logPath,
    /\/workspace\/rlm\/logs\/standalone\/20260326-112233-456\.jsonl$/u,
  );

  const withoutInput = resolveStandaloneCLIOptions(
    {
      provider: 'openai',
      query: 'Find the answer.',
      systemPromptPath: 'prompts/ebook-system.txt',
    },
    {
      clock: createClock(),
      cwd: '/workspace/rlm',
    },
  );

  assert.equal(withoutInput.inputPath, undefined);
  assert.equal(withoutInput.systemPromptPath, '/workspace/rlm/prompts/ebook-system.txt');

  const withExplicitLog = resolveStandaloneCLIOptions(
    {
      aotDebug: true,
      aotMode: 'hard',
      cellTimeoutMs: 45_000,
      inputPath: 'fixtures/book.txt',
      logPath: 'logs/custom.jsonl',
      provider: 'openai',
      query: 'Find the answer.',
      requestTimeoutMs: 90_000,
      systemPromptPath: 'prompts/ebook-system.txt',
    },
    {
      clock: createClock(),
      cwd: '/workspace/rlm',
    },
  );
  assert.equal(withExplicitLog.logPath, '/workspace/rlm/logs/custom.jsonl');
  assert.equal(withExplicitLog.aotMode, 'hard');
  assert.equal(withExplicitLog.aotDebug, true);
  assert.equal(withExplicitLog.cellTimeoutMs, 45_000);
  assert.equal(withExplicitLog.requestTimeoutMs, 90_000);
});

Deno.test('resolveStandaloneCLIOptions keeps codex-oauth login modes free of run-only file requirements', () => {
  const resolved = resolveStandaloneCLIOptions(
    {
      login: true,
      provider: 'codex-oauth',
    },
    {
      clock: createClock(),
      cwd: '/workspace/rlm',
    },
  );

  assert.equal(resolved.provider, 'codex-oauth');
  assert.equal(resolved.login, true);
  assert.equal(resolved.inputPath, undefined);
  assert.equal(resolved.query, undefined);
  assert.equal(resolved.systemPromptPath, undefined);
});

Deno.test('resolveCodexOAuthModels rejects explicit Codex model overrides that are not present in the current catalog', () => {
  assert.deepEqual(
    __standaloneCLITestables.resolveCodexOAuthModels(
      ['gpt-5-4-t-mini', 'gpt-5-3-instant'],
      {
        rootModel: 'gpt-5-4-t-mini',
        subModel: 'gpt-5-3-instant',
      },
    ),
    {
      rootModel: 'gpt-5-4-t-mini',
      subModel: 'gpt-5-3-instant',
    },
  );
  assert.throws(
    () =>
      __standaloneCLITestables.resolveCodexOAuthModels(
        ['gpt-5-4-t-mini', 'gpt-5-3-instant'],
        {
          rootModel: 'gpt-5.4-mini',
        },
      ),
    /Requested Codex model is unavailable: gpt-5\.4-mini\./u,
  );

  assert.throws(
    () =>
      __standaloneCLITestables.resolveCodexOAuthModels(
        ['gpt-5-4-t-mini', 'gpt-5-3-instant'],
        {
          subModel: 'gpt-5.3-instant',
        },
      ),
    /Requested Codex model is unavailable: gpt-5\.3-instant\./u,
  );

  assert.throws(
    () => __standaloneCLITestables.resolveCodexOAuthModels([], {}),
    /did not return any usable models/u,
  );
  assert.deepEqual(
    __standaloneCLITestables.resolveCodexOAuthModels(
      ['gpt-5-4-t-mini'],
      {},
    ),
    {
      rootModel: 'gpt-5-4-t-mini',
      subModel: 'gpt-5-4-t-mini',
    },
  );
  assert.deepEqual(
    __standaloneCLITestables.resolveCodexOAuthModels(
      ['gpt-5-4-t-mini', 'gpt-5-3-instant', 'gpt-5-mini'],
      {},
      {
        rootModel: 'gpt-5-4-t-mini',
        subModel: 'gpt-5-3-instant',
      },
    ),
    {
      rootModel: 'gpt-5-4-t-mini',
      subModel: 'gpt-5-3-instant',
    },
  );
  assert.deepEqual(
    __standaloneCLITestables.resolveCodexOAuthModels(
      ['gpt-5-4-t-mini', 'gpt-5-3-instant', 'gpt-5-mini'],
      {
        rootModel: 'gpt-5-mini',
      },
      {
        rootModel: 'gpt-5-4-t-mini',
        subModel: 'gpt-5-3-instant',
      },
    ),
    {
      rootModel: 'gpt-5-mini',
      subModel: 'gpt-5-3-instant',
    },
  );
  assert.deepEqual(
    __standaloneCLITestables.resolveCodexOAuthModels(
      ['gpt-5-4-t-mini', 'gpt-5-3-instant', 'gpt-5-mini'],
      {},
      {
        rootModel: 'gpt-5.4-mini',
        subModel: 'gpt-5.3-instant',
      },
    ),
    {
      rootModel: 'gpt-5-4-t-mini',
      subModel: 'gpt-5-3-instant',
    },
  );
});

Deno.test('createStandaloneLogPath can generate a deterministic standalone journal path', () => {
  const path = createStandaloneLogPath({
    clock: createClock(),
    cwd: '/workspace/rlm',
  });

  assert.equal(path, '/workspace/rlm/logs/standalone/20260326-112233-456.jsonl');
});

Deno.test('standalone log and option helpers can fall back to the current process cwd and clock', () => {
  const logPath = createStandaloneLogPath();
  assert.match(logPath, /logs\/standalone\/\d{8}-\d{6}-\d{3}\.jsonl$/u);
  assert.equal(logPath.startsWith(join(Deno.cwd(), 'logs', 'standalone')), true);

  const resolved = resolveStandaloneCLIOptions({
    inputPath: 'fixtures/book.txt',
    provider: 'openai',
    query: 'Find the answer.',
    systemPromptPath: 'prompts/ebook-system.txt',
  });
  assert.equal(resolved.inputPath, join(Deno.cwd(), 'fixtures/book.txt'));
  assert.equal(resolved.systemPromptPath, join(Deno.cwd(), 'prompts/ebook-system.txt'));
});

Deno.test('standalone CLI helpers expose deterministic timestamp, path resolution, and final suffix formatting', () => {
  assert.equal(
    __standaloneCLITestables.formatStandaloneTimestamp(new Date('2026-03-26T11:22:33.456Z')),
    '20260326-112233-456',
  );
  assert.equal(
    __standaloneCLITestables.resolveStandalonePath('/already/absolute.txt', '/workspace/rlm'),
    '/already/absolute.txt',
  );
  assert.equal(
    __standaloneCLITestables.resolveStandalonePath('relative.txt', '/workspace/rlm'),
    '/workspace/rlm/relative.txt',
  );
  assert.equal(__standaloneCLITestables.formatStandaloneFinalSuffix(null), '');
  assert.equal(__standaloneCLITestables.formatStandaloneFinalSuffix('42'), ' final=42');
  assert.equal(__standaloneCLITestables.formatStandaloneDurationMs(12), '12ms');
  assert.equal(__standaloneCLITestables.formatStandaloneDurationMs(Number.NaN), 'unknown');
  assert.equal(__standaloneCLITestables.formatStandaloneDurationMs(-1), 'unknown');
  assert.equal(__standaloneCLITestables.formatStandaloneDurationMs(1_250), '1.3s');
  assert.equal(__standaloneCLITestables.formatStandaloneDurationMs(12_000), '12s');
  assert.equal(__standaloneCLITestables.formatStandaloneDurationMs(300_061), '5m 0.1s');
  assert.equal(__standaloneCLITestables.formatStandaloneDurationMs(305_000), '5m 5.0s');
  assert.equal(__standaloneCLITestables.formatStandaloneDurationMs(315_000), '5m 15s');
  assert.equal(__standaloneCLITestables.formatStandaloneElapsedSuffix(null), '');
  assert.equal(__standaloneCLITestables.formatStandaloneElapsedSuffix(1_250), ' elapsed=1.3s');
  assert.equal(__standaloneCLITestables.parseStandaloneTimeMs(undefined), null);
  assert.equal(__standaloneCLITestables.parseStandaloneTimeMs('not-a-time'), null);
  assert.equal(
    __standaloneCLITestables.parseStandaloneTimeMs('2026-03-26T11:22:33.456Z'),
    Date.parse('2026-03-26T11:22:33.456Z'),
  );
  assert.equal(__standaloneCLITestables.formatStandaloneQueryTraceMaxSteps(undefined), null);
  assert.equal(__standaloneCLITestables.formatStandaloneQueryTraceMaxSteps(3), 'maxSteps=3');
  assert.equal(
    __standaloneCLITestables.formatStandaloneStepGapSuffix(null, '2026-03-26T11:22:34.000Z'),
    '',
  );
  assert.equal(
    __standaloneCLITestables.formatStandaloneStepGapSuffix(
      Date.parse('2026-03-26T11:22:35.000Z'),
      '2026-03-26T11:22:34.000Z',
    ),
    '',
  );
  assert.equal(
    __standaloneCLITestables.formatStandaloneStepGapSuffix(
      Date.parse('2026-03-26T11:22:33.000Z'),
      '2026-03-26T11:22:35.250Z',
    ),
    ' after=2.3s',
  );
  assert.equal(
    __standaloneCLITestables.formatStandaloneFinalSuffix('first line\nsecond line'),
    ' final=<captured>',
  );
});

Deno.test('standalone AoT plugin helpers load the built-in plugin and resolve injected plugin overrides', async () => {
  const loadedPlugin = await __standaloneCLITestables.loadStandaloneAOTPlugin();
  assert.equal(loadedPlugin.name, 'aot');
  await assert.rejects(
    () =>
      __standaloneCLITestables.loadStandaloneAOTPlugin(async () => {
        throw new Error('missing aot plugin');
      }),
    /Failed to load the default AoT plugin: missing aot plugin/u,
  );

  const injectedPlugin = { name: 'custom-aot' } as const;
  assert.deepEqual(
    await __standaloneCLITestables.resolveStandalonePlugins(
      { aotMode: undefined },
      { createAOTPlugin: async () => injectedPlugin as never },
    ),
    undefined,
  );
  assert.deepEqual(
    await __standaloneCLITestables.resolveStandalonePlugins(
      { aotMode: 'lite' },
      { createAOTPlugin: async () => injectedPlugin as never },
    ),
    [injectedPlugin],
  );
  assert.match(
    __standaloneCLITestables.resolveStandaloneSystemPromptExtension({ aotMode: 'lite' }) ?? '',
    /aot/u,
  );
  assert.match(
    __standaloneCLITestables.resolveStandaloneSystemPromptExtension({ aotMode: 'hard' }) ?? '',
    /aot/u,
  );
});

Deno.test('standalone readTextFile resolver fails clearly when the runtime exposes no default file reader', () => {
  const originalReadTextFile = Deno.readTextFile;

  try {
    Object.defineProperty(Deno, 'readTextFile', {
      configurable: true,
      value: undefined,
      writable: true,
    });

    assert.throws(
      () => __standaloneCLITestables.resolveStandaloneReadTextFile(undefined),
      /No default readTextFile implementation is available in this runtime/u,
    );
  } finally {
    Object.defineProperty(Deno, 'readTextFile', {
      configurable: true,
      value: originalReadTextFile,
      writable: true,
    });
  }
});

Deno.test('readStandaloneLoginLine reads one line from stdin and returns buffered EOF content when no newline arrives', async () => {
  const originalStdin = Deno.stdin;

  try {
    Object.defineProperty(Deno, 'stdin', {
      configurable: true,
      value: {
        readable: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('callback-one\ncallback-two'));
            controller.close();
          },
        }),
      },
    });

    const firstLine = await __standaloneCLITestables.readStandaloneLoginLine();
    assert.equal(firstLine, 'callback-one');

    Object.defineProperty(Deno, 'stdin', {
      configurable: true,
      value: {
        readable: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('callback-without-newline\r'));
            controller.close();
          },
        }),
      },
    });

    const eofLine = await __standaloneCLITestables.readStandaloneLoginLine();
    assert.equal(eofLine, 'callback-without-newline');
  } finally {
    Object.defineProperty(Deno, 'stdin', {
      configurable: true,
      value: originalStdin,
    });
  }
});

Deno.test('readStandaloneLoginLine aborts cleanly when the caller cancels the pending stdin wait', async () => {
  const originalStdin = Deno.stdin;
  const controller = new AbortController();

  try {
    Object.defineProperty(Deno, 'stdin', {
      configurable: true,
      value: {
        readable: new ReadableStream<Uint8Array>({
          cancel() {
            return Promise.resolve();
          },
          start() {
            queueMicrotask(() => controller.abort());
          },
        }),
      },
    });

    assert.equal(
      await __standaloneCLITestables.readStandaloneLoginLine(controller.signal),
      null,
    );
  } finally {
    Object.defineProperty(Deno, 'stdin', {
      configurable: true,
      value: originalStdin,
    });
  }
});

Deno.test('createStandaloneProgressLogger reports assistant turns, cells, and subqueries in real time', async () => {
  const lines: string[] = [];
  const logger = createStandaloneProgressLogger({
    baseLogger: new InMemoryRLMLogger(),
    writeLine: (line) => lines.push(line),
  });

  const sessionEntry: SessionEntry = {
    context: null,
    createdAt: '2026-03-26T00:00:00.000Z',
    defaultTimeoutMs: 5_000,
    sessionId: 'session-1',
    type: 'session',
  };
  const assistantEntry: AssistantTurnEntry = {
    assistantText: '```repl\n1 + 1\n```',
    createdAt: '2026-03-26T00:00:01.000Z',
    model: 'gpt-5.4-mini',
    step: 1,
    type: 'assistant_turn',
  };
  const cellEntry: CellEntry = {
    cellId: 'cell-1',
    code: '1 + 1',
    durationMs: 12,
    endedAt: '2026-03-26T00:00:01.012Z',
    error: null,
    finalAnswer: '2',
    replayedCellIds: [],
    result: { kind: 'number', json: 2, preview: '2' },
    startedAt: '2026-03-26T00:00:01.000Z',
    status: 'success',
    stderr: '',
    stdout: '',
    type: 'cell',
  };

  await logger.append(sessionEntry);
  await logger.append(assistantEntry);
  await logger.append(cellEntry);
  await logger.append({
    answer: '42',
    createdAt: '2026-03-26T00:00:02.000Z',
    depth: 1,
    journalPath: '/tmp/child.jsonl',
    model: 'gpt-5.4-mini',
    prompt: 'child task',
    steps: 2,
    type: 'subquery',
  });

  assert.deepEqual(lines, [
    '[session] started',
    '[step 1] assistant turn',
    '[step 1] cell success elapsed=12ms final=2',
    '[step 1] subquery depth=1 steps=2',
  ]);

  assert.deepEqual(await logger.load?.(), {
    cells: [cellEntry],
    session: {
      context: null,
      createdAt: '2026-03-26T00:00:00.000Z',
      defaultTimeoutMs: 5_000,
      sessionId: 'session-1',
      type: 'session',
    },
  });
});

Deno.test('createStandaloneProgressLogger summarizes long or multiline final answers instead of printing the full captured text inline', async () => {
  const lines: string[] = [];
  const logger = createStandaloneProgressLogger({
    baseLogger: new InMemoryRLMLogger(),
    writeLine: (line) => lines.push(line),
  });

  await logger.append({
    context: null,
    createdAt: '2026-03-26T00:00:00.000Z',
    defaultTimeoutMs: 5_000,
    sessionId: 'session-1',
    type: 'session',
  });
  await logger.append({
    assistantText: '```repl\nFINAL_VAR(answer)\n```',
    createdAt: '2026-03-26T00:00:01.000Z',
    model: 'gpt-5.4-mini',
    step: 1,
    type: 'assistant_turn',
  });
  await logger.append({
    cellId: 'cell-1',
    code: 'FINAL_VAR(answer)',
    durationMs: 12,
    endedAt: '2026-03-26T00:00:01.012Z',
    error: null,
    finalAnswer: '첫 줄입니다.\n둘째 줄입니다.',
    replayedCellIds: [],
    result: {
      kind: 'string',
      json: '첫 줄입니다.\n둘째 줄입니다.',
      preview: '첫 줄입니다.\n둘째 줄입니다.',
    },
    startedAt: '2026-03-26T00:00:01.000Z',
    status: 'success',
    stderr: '',
    stdout: '',
    type: 'cell',
  });

  assert.deepEqual(lines, [
    '[session] started',
    '[step 1] assistant turn',
    '[step 1] cell success elapsed=12ms final=<captured>',
  ]);
});

Deno.test('createStandaloneProgressLogger reports elapsed time between assistant turns', async () => {
  const lines: string[] = [];
  const logger = createStandaloneProgressLogger({
    baseLogger: new InMemoryRLMLogger(),
    writeLine: (line) => lines.push(line),
  });

  await logger.append({
    context: null,
    createdAt: '2026-03-26T00:00:00.000Z',
    defaultTimeoutMs: 5_000,
    sessionId: 'session-1',
    type: 'session',
  });
  await logger.append({
    assistantText: '```repl\n1 + 1\n```',
    createdAt: '2026-03-26T00:00:01.000Z',
    model: 'gpt-5.4-mini',
    step: 1,
    type: 'assistant_turn',
  });
  await logger.append({
    cellId: 'cell-1',
    code: '1 + 1',
    durationMs: 300_061,
    endedAt: '2026-03-26T00:05:01.061Z',
    error: { message: 'timed out', name: 'TimeoutError' },
    finalAnswer: null,
    replayedCellIds: [],
    result: { kind: 'undefined', preview: 'undefined' },
    startedAt: '2026-03-26T00:00:01.000Z',
    status: 'error',
    stderr: 'TimeoutError: timed out',
    stdout: '',
    type: 'cell',
  });
  await logger.append({
    assistantText: '```repl\n2 + 2\n```',
    createdAt: '2026-03-26T00:05:02.000Z',
    model: 'gpt-5.4-mini',
    step: 2,
    type: 'assistant_turn',
  });

  assert.deepEqual(lines, [
    '[session] started',
    '[step 1] assistant turn',
    '[step 1] cell error elapsed=5m 0.1s',
    '[step 2] assistant turn after=5m 1.0s',
  ]);
});

Deno.test('createStandaloneProgressLogger can report AoT query trace entries when debug output is enabled', async () => {
  const lines: string[] = [];
  const logger = createStandaloneProgressLogger({
    baseLogger: new InMemoryRLMLogger(),
    showQueryTrace: true,
    writeLine: (line) => lines.push(line),
  });

  const entry: QueryTraceEntry = {
    createdAt: '2026-03-26T00:00:01.000Z',
    depth: 1,
    durationMs: 42,
    kind: 'llm_query',
    maxSteps: 'unbounded',
    maxSubcallDepth: 1,
    model: 'gpt-5.4-mini',
    promptPreview: 'AOT_DECOMPOSE_JSON\\nCurrent question:\\nExplain gravity.',
    promptTag: 'AOT_DECOMPOSE_JSON',
    queryIndex: 0,
    status: 'success',
    type: 'query_trace',
  };

  await logger.append(entry);

  assert.deepEqual(lines, [
    '[aot-debug] llm_query tag=AOT_DECOMPOSE_JSON query=0 depth=1 elapsed=42ms status=success model=gpt-5.4-mini maxSteps=unbounded maxSubcallDepth=1',
  ]);
});

Deno.test('createStandaloneProgressLogger falls back to an empty load result when the base logger does not expose load', async () => {
  const logger = createStandaloneProgressLogger({
    baseLogger: {
      append() {},
    },
    writeLine() {},
  });

  assert.deepEqual(await logger.load?.(), {
    cells: [],
    session: null,
  });
  await logger.close?.();
});

Deno.test('createStandaloneProgressLogger preserves a logger path and can use the default console writer', async () => {
  const originalLog = console.log;
  const lines: string[] = [];

  try {
    console.log = (line?: unknown) => lines.push(String(line ?? ''));

    const logger = createStandaloneProgressLogger({
      baseLogger: ({
        append() {},
        path: '/tmp/standalone.jsonl',
      }) as unknown as InMemoryRLMLogger & { path: string },
    });

    await logger.append({
      context: null,
      createdAt: '2026-03-26T00:00:00.000Z',
      defaultTimeoutMs: 5_000,
      sessionId: 'session-1',
      type: 'session',
    });

    assert.equal(logger.path, '/tmp/standalone.jsonl');
    assert.deepEqual(lines, ['[session] started']);
  } finally {
    console.log = originalLog;
  }
});

Deno.test('renderStandaloneFinalAnswer uses the external system prompt to synthesize the final user-visible reply', async () => {
  const requests: Array<{ input: string; model: string; systemPrompt: string }> = [];

  const answer = await renderStandaloneFinalAnswer(
    {
      finalValue: '42',
      inputFilePath: '/workspace/book.txt',
      query: 'What is the answer?',
      rlmAnswer: '42',
      systemPrompt: 'Always answer in concise Korean.',
    },
    {
      llm: {
        async complete(request) {
          requests.push({
            input: request.input,
            model: request.model,
            systemPrompt: request.systemPrompt,
          });
          return {
            outputText: '정답은 42입니다.',
          };
        },
      },
      rootModel: 'gpt-5.4-mini',
    },
  );

  assert.equal(answer, '정답은 42입니다.');
  assert.deepEqual(requests, [
    {
      input: [
        'User query:',
        'What is the answer?',
        '',
        'Verified RLM answer:',
        '42',
        '',
        'Structured final value:',
        '"42"',
        '',
        'Input file path:',
        '/workspace/book.txt',
        '',
        'Write the final user-facing answer now.',
      ].join('\n'),
      model: 'gpt-5.4-mini',
      systemPrompt: 'Always answer in concise Korean.',
    },
  ]);
});

Deno.test('renderStandaloneFinalAnswer serializes omitted final values as null and trims provider output', async () => {
  const requests: Array<{ input: string; model: string; systemPrompt: string }> = [];

  const answer = await renderStandaloneFinalAnswer(
    {
      inputFilePath: '/workspace/book.txt',
      query: 'What is the answer?',
      rlmAnswer: 'intermediate',
      systemPrompt: 'Always answer in concise Korean.',
    },
    {
      llm: {
        async complete(request) {
          requests.push({
            input: request.input,
            model: request.model,
            systemPrompt: request.systemPrompt,
          });
          return {
            outputText: ' 최종 답변입니다. \n',
          };
        },
      },
      rootModel: 'gpt-5.4-mini',
    },
  );

  assert.equal(answer, '최종 답변입니다.');
  assert.match(requests[0]?.input ?? '', /Structured final value:\nnull/u);
});

Deno.test('renderStandaloneFinalAnswer omits the input file path section when no input file exists', async () => {
  const requests: Array<{ input: string; model: string; systemPrompt: string }> = [];

  const answer = await renderStandaloneFinalAnswer(
    {
      query: 'Answer from general reasoning.',
      rlmAnswer: 'General answer',
      systemPrompt: 'Always answer in concise Korean.',
    },
    {
      llm: {
        async complete(request) {
          requests.push({
            input: request.input,
            model: request.model,
            systemPrompt: request.systemPrompt,
          });
          return {
            outputText: ' 일반 추론 답변입니다. ',
          };
        },
      },
      rootModel: 'gpt-5.4-mini',
    },
  );

  assert.equal(answer, '일반 추론 답변입니다.');
  assert.doesNotMatch(requests[0]?.input ?? '', /Input file path:/u);
});

Deno.test('standalone helpers can leave cost fields blank without provider pricing and report missing model pricing when an estimator exists', async () => {
  assert.deepEqual(
    __standaloneCLITestables.buildStandaloneUsageLines({
      byModel: [
        {
          cachedInputTokens: 0,
          inputTokens: 12,
          model: 'unknown-model',
          outputTokens: 3,
          reportedRequests: 1,
          requests: 1,
          totalTokens: 15,
        },
      ],
      cachedInputTokens: 0,
      inputTokens: 12,
      outputTokens: 3,
      reportedRequests: 1,
      requests: 1,
      totalTokens: 15,
    }),
    [
      '[usage] input_tokens=12 output_tokens=3 total_tokens=15',
      '[cost] input_usd= output_usd= total_usd=',
    ],
  );

  assert.deepEqual(
    __standaloneCLITestables.buildStandaloneUsageLines({
      byModel: [
        {
          cachedInputTokens: 0,
          inputTokens: 12,
          model: 'unknown-model',
          outputTokens: 3,
          reportedRequests: 1,
          requests: 1,
          totalTokens: 15,
        },
      ],
      cachedInputTokens: 0,
      inputTokens: 12,
      outputTokens: 3,
      reportedRequests: 1,
      requests: 1,
      totalTokens: 15,
    }, estimateOpenAIRunCostUsd),
    [
      '[usage] input_tokens=12 output_tokens=3 total_tokens=15',
      '[cost] input_usd= output_usd= total_usd= missing_pricing_models=unknown-model',
    ],
  );

  const render = __standaloneCLITestables.resolveStandaloneRender({
    llm: {
      async complete() {
        return {
          outputText: '렌더된 답변',
        };
      },
    },
    rootModel: 'gpt-5.4-mini',
  });

  assert.equal(
    await render({
      finalValue: '42',
      inputFilePath: '/workspace/book.txt',
      query: 'What is the answer?',
      rlmAnswer: '42',
      systemPrompt: 'Always answer in concise Korean.',
    }),
    '렌더된 답변',
  );
});

Deno.test('renderStandaloneFinalAnswer can boot its default adapter and model from a local env file without live network', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-render-' });
  const previousCwd = Deno.cwd();
  const previousFetch = globalThis.fetch;

  await Deno.writeTextFile(
    join(root, '.env'),
    [
      'OPENAI_API_KEY=sk-test',
      'RLM_OPENAI_ROOT_MODEL=gpt-5.4-mini',
      'RLM_OPENAI_SUB_MODEL=gpt-5.4-nano',
    ].join('\n'),
  );

  try {
    Deno.chdir(root);
    globalThis.fetch = (async (_input, init) =>
      new Response(
        JSON.stringify({
          id: 'resp-final',
          output_text: `system=${
            JSON.parse(String((init as RequestInit | undefined)?.body)).instructions
          }`,
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      )) as typeof fetch;

    const answer = await renderStandaloneFinalAnswer({
      finalValue: '42',
      inputFilePath: '/workspace/book.txt',
      query: 'What is the answer?',
      rlmAnswer: '42',
      systemPrompt: 'Always answer in concise Korean.',
    });

    assert.equal(answer, 'system=Always answer in concise Korean.');
  } finally {
    Deno.chdir(previousCwd);
    globalThis.fetch = previousFetch;
  }
});

Deno.test('runStandaloneCLI loads the input and system prompt files, writes progress, and renders the final answer through the standalone system prompt', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-' });
  const inputPath = join(root, 'book.txt');
  const systemPromptPath = join(root, 'ebook-system.txt');
  await Deno.writeTextFile(inputPath, 'Chapter 1\nThe answer is 42.\n');
  await Deno.writeTextFile(systemPromptPath, 'Always answer in concise Korean.');
  await Deno.writeTextFile(
    join(root, '.env'),
    [
      'OPENAI_API_KEY=sk-test',
      'RLM_OPENAI_ROOT_MODEL=gpt-5.4-mini',
      'RLM_OPENAI_SUB_MODEL=gpt-5.4-nano',
      'RLM_REQUEST_TIMEOUT_MS=30000',
      'RLM_CELL_TIMEOUT_MS=5000',
    ].join('\n'),
  );

  const lines: string[] = [];
  const calls: Array<{
    cellTimeoutMs: number | undefined;
    context: unknown;
    logPath: string | undefined;
    prompt: string;
    requestTimeoutMs: number | undefined;
  }> = [];
  const renderCalls: Array<{
    finalValue: unknown;
    inputFilePath: string | undefined;
    query: string;
    rlmAnswer: string;
    systemPrompt: string;
  }> = [];

  const result = await runStandaloneCLI(
    [
      '--input',
      inputPath,
      '--query',
      'What is the answer?',
      '--system-prompt',
      systemPromptPath,
      '--request-timeout-ms',
      '90000',
      '--cell-timeout-ms',
      '45000',
    ],
    {
      clock: createClock(),
      cwd: root,
      run: async (options) => {
        calls.push({
          cellTimeoutMs: options.cellTimeoutMs,
          context: options.context,
          logPath: 'path' in (options.logger ?? {})
            ? (options.logger as { path?: string }).path
            : undefined,
          prompt: options.prompt,
          requestTimeoutMs: options.openAI.requestTimeoutMs,
        });

        await options.logger?.append({
          context: options.context,
          createdAt: '2026-03-26T00:00:00.000Z',
          defaultTimeoutMs: 5_000,
          sessionId: 'session-1',
          type: 'session',
        });
        await options.logger?.append({
          assistantText: '```repl\nFINAL_VAR("42")\n```',
          createdAt: '2026-03-26T00:00:01.000Z',
          model: 'gpt-5.4-mini',
          step: 1,
          type: 'assistant_turn',
        });
        await options.logger?.append({
          cellId: 'cell-1',
          code: 'FINAL_VAR("42")',
          durationMs: 10,
          endedAt: '2026-03-26T00:00:01.010Z',
          error: null,
          finalAnswer: '42',
          replayedCellIds: [],
          result: { kind: 'string', json: '42', preview: '42' },
          startedAt: '2026-03-26T00:00:01.000Z',
          status: 'success',
          stderr: '',
          stdout: '',
          type: 'cell',
        });

        return {
          answer: '42',
          finalValue: '42',
          usage: {
            byModel: [
              {
                cachedInputTokens: 0,
                inputTokens: 120,
                model: 'gpt-5.4-mini',
                outputTokens: 30,
                reportedRequests: 1,
                requests: 1,
                totalTokens: 150,
              },
            ],
            cachedInputTokens: 0,
            inputTokens: 120,
            outputTokens: 30,
            reportedRequests: 1,
            requests: 1,
            totalTokens: 150,
          },
        };
      },
      render: async (input) => {
        renderCalls.push({
          finalValue: input.finalValue,
          inputFilePath: input.inputFilePath,
          query: input.query,
          rlmAnswer: input.rlmAnswer,
          systemPrompt: input.systemPrompt,
        });
        return '정답은 42입니다.';
      },
      writeLine: (line) => lines.push(line),
    },
  );

  assert.equal(result.answer, '정답은 42입니다.');
  assert.deepEqual(calls, [
    {
      cellTimeoutMs: 45_000,
      context: {
        document: 'Chapter 1\nThe answer is 42.\n',
        inputFilePath: inputPath,
      },
      logPath: join(root, 'logs/standalone/20260326-112233-456.jsonl'),
      prompt: 'What is the answer?',
      requestTimeoutMs: 90_000,
    },
  ]);
  assert.deepEqual(renderCalls, [
    {
      finalValue: '42',
      inputFilePath: inputPath,
      query: 'What is the answer?',
      rlmAnswer: '42',
      systemPrompt: 'Always answer in concise Korean.',
    },
  ]);
  assert.deepEqual(lines, [
    '[standalone] provider: openai',
    `[standalone] input: ${inputPath}`,
    `[standalone] system prompt: ${systemPromptPath}`,
    `[standalone] log: ${join(root, 'logs/standalone/20260326-112233-456.jsonl')}`,
    '[session] started',
    '[step 1] assistant turn',
    '[step 1] cell success elapsed=10ms final=42',
    '[final] 정답은 42입니다.',
    '[usage] input_tokens=120 output_tokens=30 total_tokens=150',
    '[cost] input_usd=$0.000090 output_usd=$0.000135 total_usd=$0.000225',
  ]);
});

Deno.test('runStandaloneCLI can attach the AoT plugin and AoT-lite controller guidance to OpenAI runs when --aot is enabled', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-aot-openai-' });
  const inputPath = join(root, 'book.txt');
  const systemPromptPath = join(root, 'ebook-system.txt');
  await Deno.writeTextFile(inputPath, 'Chapter 1\nThe answer is 42.\n');
  await Deno.writeTextFile(systemPromptPath, 'Always answer in concise Korean.');
  await Deno.writeTextFile(
    join(root, '.env'),
    [
      'OPENAI_API_KEY=sk-test',
      'RLM_OPENAI_ROOT_MODEL=gpt-5.4-mini',
      'RLM_OPENAI_SUB_MODEL=gpt-5.4-nano',
      'RLM_REQUEST_TIMEOUT_MS=30000',
      'RLM_CELL_TIMEOUT_MS=5000',
    ].join('\n'),
  );

  const plugin = createAoTPlugin();
  const runCalls: Array<
    {
      plugins: unknown;
      prompt: string;
      queryTrace: boolean | undefined;
      systemPromptExtension: string | undefined;
    }
  > = [];

  const result = await runStandaloneCLI(
    [
      '--aot',
      '--input',
      inputPath,
      '--query',
      'Answer richly when the document is incomplete.',
      '--system-prompt',
      systemPromptPath,
    ],
    {
      clock: createClock(),
      createAOTPlugin: () => plugin,
      cwd: root,
      render: async () => '정답은 42입니다.',
      run: async (options) => {
        runCalls.push({
          plugins: options.plugins,
          prompt: options.prompt,
          queryTrace: options.queryTrace,
          systemPromptExtension: options.systemPromptExtension,
        });

        return {
          answer: '42',
          finalValue: '42',
        };
      },
      writeLine: () => {},
    },
  );

  assert.equal(result.answer, '정답은 42입니다.');
  assert.deepEqual(runCalls, [{
    plugins: [plugin],
    prompt: 'Answer richly when the document is incomplete.',
    queryTrace: undefined,
    systemPromptExtension: runCalls[0]?.systemPromptExtension,
  }]);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /must call `aot\(/u);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /AoT-lite mode is enabled/u);
  assert.match(
    runCalls[0]?.systemPromptExtension ?? '',
    /document` is empty, missing, or insufficient/u,
  );
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /maxIterations: 1/u);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /maxIndependentSubquestions: 2/u);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /maxRefinements: 0/u);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /includeTrace: false/u);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /answer without AoT/u);
});

Deno.test('runStandaloneCLI can attach the AoT-hard controller guidance and debug tracing to OpenAI runs when --aot-hard and --aot-debug are enabled', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-aot-hard-openai-' });
  const inputPath = join(root, 'book.txt');
  const systemPromptPath = join(root, 'ebook-system.txt');
  await Deno.writeTextFile(inputPath, 'Chapter 1\nThe answer is 42.\n');
  await Deno.writeTextFile(systemPromptPath, 'Always answer in concise Korean.');
  await Deno.writeTextFile(
    join(root, '.env'),
    [
      'OPENAI_API_KEY=sk-test',
      'RLM_OPENAI_ROOT_MODEL=gpt-5.4-mini',
      'RLM_OPENAI_SUB_MODEL=gpt-5.4-nano',
      'RLM_REQUEST_TIMEOUT_MS=30000',
      'RLM_CELL_TIMEOUT_MS=5000',
    ].join('\n'),
  );

  const plugin = createAoTPlugin();
  const runCalls: Array<
    {
      plugins: unknown;
      prompt: string;
      queryTrace: boolean | undefined;
      systemPromptExtension: string | undefined;
    }
  > = [];

  const result = await runStandaloneCLI(
    [
      '--aot-hard',
      '--aot-debug',
      '--input',
      inputPath,
      '--query',
      'Answer richly when the document is incomplete.',
      '--system-prompt',
      systemPromptPath,
    ],
    {
      clock: createClock(),
      createAOTPlugin: () => plugin,
      cwd: root,
      render: async () => '정답은 42입니다.',
      run: async (options) => {
        runCalls.push({
          plugins: options.plugins,
          prompt: options.prompt,
          queryTrace: options.queryTrace,
          systemPromptExtension: options.systemPromptExtension,
        });

        return {
          answer: '42',
          finalValue: '42',
        };
      },
      writeLine: () => {},
    },
  );

  assert.equal(result.answer, '정답은 42입니다.');
  assert.deepEqual(runCalls, [{
    plugins: [plugin],
    prompt: 'Answer richly when the document is incomplete.',
    queryTrace: true,
    systemPromptExtension: runCalls[0]?.systemPromptExtension,
  }]);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /AOT-hard mode is enabled/u);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /transitionSamples: 1/u);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /beamWidth: 1/u);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /maxRefinements: 1/u);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /Do not widen AoT search after a timeout/u);
});

Deno.test('runStandaloneCLI can execute without an input file by using an empty document context', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-no-input-' });
  const systemPromptPath = join(root, 'ebook-system.txt');
  await Deno.writeTextFile(systemPromptPath, 'Always answer in concise Korean.');
  await Deno.writeTextFile(
    join(root, '.env'),
    [
      'OPENAI_API_KEY=sk-test',
      'RLM_OPENAI_ROOT_MODEL=gpt-5.4-mini',
      'RLM_OPENAI_SUB_MODEL=gpt-5.4-nano',
      'RLM_REQUEST_TIMEOUT_MS=30000',
      'RLM_CELL_TIMEOUT_MS=5000',
    ].join('\n'),
  );

  const lines: string[] = [];
  const runCalls: Array<{ context: unknown; prompt: string }> = [];
  const renderCalls: Array<{ inputFilePath: string | undefined; query: string }> = [];

  const result = await runStandaloneCLI(
    [
      '--query',
      'Answer from general reasoning.',
      '--system-prompt',
      systemPromptPath,
    ],
    {
      clock: createClock(),
      cwd: root,
      render: async (input) => {
        renderCalls.push({
          inputFilePath: input.inputFilePath,
          query: input.query,
        });
        return '일반 추론 답변입니다.';
      },
      run: async (options) => {
        runCalls.push({
          context: options.context,
          prompt: options.prompt,
        });
        return {
          answer: 'General answer',
          finalValue: 'General answer',
        };
      },
      writeLine: (line) => lines.push(line),
    },
  );

  assert.equal(result.answer, '일반 추론 답변입니다.');
  assert.deepEqual(runCalls, [{
    context: {
      document: '',
      inputFilePath: null,
    },
    prompt: 'Answer from general reasoning.',
  }]);
  assert.deepEqual(renderCalls, [{
    inputFilePath: undefined,
    query: 'Answer from general reasoning.',
  }]);
  assert.ok(lines.includes('[standalone] input: (none)'));
});

Deno.test('runStandaloneCLI closes the returned session so standalone runs can exit cleanly after FINAL', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-close-' });
  const inputPath = join(root, 'book.txt');
  const systemPromptPath = join(root, 'ebook-system.txt');
  await Deno.writeTextFile(inputPath, 'Chapter 1\nThe answer is 42.\n');
  await Deno.writeTextFile(systemPromptPath, 'Always answer in concise Korean.');
  await Deno.writeTextFile(
    join(root, '.env'),
    [
      'OPENAI_API_KEY=sk-test',
      'RLM_OPENAI_ROOT_MODEL=gpt-5.4-mini',
      'RLM_OPENAI_SUB_MODEL=gpt-5.4-nano',
    ].join('\n'),
  );

  let closed = false;

  const result = await runStandaloneCLI(
    [
      '--input',
      inputPath,
      '--query',
      'What is the answer?',
      '--system-prompt',
      systemPromptPath,
    ],
    {
      clock: createClock(),
      cwd: root,
      run: async (_options) => ({
        answer: '42',
        finalValue: '42',
        session: {
          close() {
            closed = true;
          },
        },
      }),
      render: async () => '정답은 42입니다.',
      writeLine: () => {},
    },
  );

  assert.equal(result.answer, '정답은 42입니다.');
  assert.equal(closed, true);
});

Deno.test('runStandaloneCLI uses the default final renderer when no custom render dependency is provided', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-default-render-' });
  const previousCwd = Deno.cwd();
  const previousFetch = globalThis.fetch;
  const inputPath = join(root, 'book.txt');
  const systemPromptPath = join(root, 'ebook-system.txt');
  await Deno.writeTextFile(inputPath, 'Chapter 1\nThe answer is 42.\n');
  await Deno.writeTextFile(systemPromptPath, 'Always answer in concise Korean.');
  await Deno.writeTextFile(
    join(root, '.env'),
    [
      'OPENAI_API_KEY=sk-test',
      'RLM_OPENAI_ROOT_MODEL=gpt-5.4-mini',
      'RLM_OPENAI_SUB_MODEL=gpt-5.4-nano',
    ].join('\n'),
  );

  try {
    Deno.chdir(root);
    globalThis.fetch = (async (_input, init) =>
      new Response(
        JSON.stringify({
          id: 'resp-final',
          output_text: `rendered:${
            JSON.parse(String((init as RequestInit | undefined)?.body)).instructions
          }`,
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      )) as typeof fetch;

    const result = await runStandaloneCLI(
      [
        '--input',
        inputPath,
        '--query',
        'What is the answer?',
        '--system-prompt',
        systemPromptPath,
      ],
      {
        clock: createClock(),
        cwd: root,
        run: async () => ({
          answer: '42',
          finalValue: '42',
        }),
        writeLine: () => {},
      },
    );

    assert.equal(result.answer, 'rendered:Always answer in concise Korean.');
  } finally {
    Deno.chdir(previousCwd);
    globalThis.fetch = previousFetch;
  }
});

Deno.test('runStandaloneCLI can perform a Codex OAuth login flow and print the discovered models', async () => {
  const lines: string[] = [];
  let loginCalls = 0;
  let listCalls = 0;
  let receiveAuthorizationCodeCalls = 0;

  const result = await runStandaloneCLI(
    [
      '--provider',
      'codex-oauth',
      '--login',
    ],
    {
      createCodexOAuthProvider: () => ({
        createCaller() {
          throw new Error('run mode should not create a caller during login');
        },
        async listModels() {
          listCalls += 1;
          return ['gpt-5.4-mini', 'gpt-5.4-nano'];
        },
        async login(options) {
          loginCalls += 1;
          await options?.onAuthUrl?.('https://auth.example.test/login');
          await options?.receiveAuthorizationCode?.({
            authUrl: 'https://auth.example.test/login',
            callbackPort: 1455,
            redirectUri: 'http://localhost:1455/auth/callback',
            state: 'state-test',
          });
          receiveAuthorizationCodeCalls += 1;
          return {
            apiKey: 'sk-codex',
          };
        },
      }),
      readLoginLine: async () =>
        'http://localhost:1455/auth/callback?code=code-test&state=state-test',
      writeLine: (line) => lines.push(line),
    },
  );

  assert.equal(result.answer, '');
  assert.equal(loginCalls, 1);
  assert.equal(listCalls, 1);
  assert.equal(receiveAuthorizationCodeCalls, 1);
  assert.deepEqual(lines, [
    '[login] provider: codex-oauth',
    '[login] open: https://auth.example.test/login',
    '[login] waiting for callback: http://localhost:1455/auth/callback',
    '[login] 브라우저가 자동으로 완료되지 않으면 최종 callback URL 전체를 이 터미널에 붙여넣고 Enter를 누르세요.',
    '[login] success',
    '[model] gpt-5.4-mini',
    '[model] gpt-5.4-nano',
  ]);
});

Deno.test('runStandaloneCLI can use the default Codex OAuth provider for login and list models through the injected fetcher', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-default-codex-login-' });
  const lines: string[] = [];

  const result = await runStandaloneCLI(
    [
      '--provider',
      'codex-oauth',
      '--login',
    ],
    {
      clock: createClock(),
      cwd: root,
      fetcher: async (input, init) => {
        const url = String(input);
        const body = String((init as RequestInit | undefined)?.body ?? '');

        if (url.endsWith('/oauth/token')) {
          return new Response(
            JSON.stringify({
              access_token:
                'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjE3NTEyMzQ1NjcsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LXRlc3QifX0.signature',
              id_token:
                'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjE3NTEyMzQ1NjcsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LXRlc3QiLCJvcmdhbml6YXRpb25faWQiOiJvcmctdGVzdCJ9fQ.signature',
              refresh_token: 'refresh-test',
            }),
            {
              headers: { 'Content-Type': 'application/json' },
              status: 200,
            },
          );
        }

        if (url.includes('/codex/models')) {
          return new Response(
            JSON.stringify({
              models: [{ slug: 'gpt-5-4-t-mini' }, { slug: 'gpt-5-3-instant' }],
            }),
            {
              headers: { 'Content-Type': 'application/json' },
              status: 200,
            },
          );
        }

        throw new Error(`Unexpected request: ${url} ${body}`);
      },
      readLoginLine: async () =>
        'http://localhost:1455/auth/callback?code=code-test&state=state-test',
      receiveLoopbackAuthorizationCode: async (_session, signal) => {
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new DOMException('Aborted', 'AbortError');
      },
      writeLine: (line) => lines.push(line),
    },
  );

  assert.equal(result.answer, '');
  assert.ok(lines.includes('[login] provider: codex-oauth'));
  assert.ok(lines.includes('[login] success'));
  assert.ok(lines.includes('[model] gpt-5-4-t-mini'));
  assert.ok(lines.includes('[model] gpt-5-3-instant'));
});

Deno.test('standalone Codex OAuth authorization receiver can complete from a pasted callback URL during the same login session', async () => {
  const lines: string[] = [];
  const receiver = __standaloneCLITestables.createStandaloneCodexOAuthAuthorizationReceiver({
    readLoginLine: async () =>
      'http://localhost:1455/auth/callback?code=code-test&state=state-test',
    receiveLoopbackAuthorizationCode: async (_session: unknown, signal?: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error('manual callback paste should win before the loopback receiver resolves'),
          );
        }, 10);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      throw new DOMException('Aborted', 'AbortError');
    },
    writeLine: (line: string) => lines.push(line),
  });

  const result = await receiver({
    authUrl: 'https://auth.example.test/login',
    callbackPort: 1455,
    redirectUri: 'http://localhost:1455/auth/callback',
    state: 'state-test',
  });

  assert.deepEqual(result, {
    code: 'code-test',
    state: 'state-test',
  });
  assert.deepEqual(lines, [
    '[login] waiting for callback: http://localhost:1455/auth/callback',
    '[login] 브라우저가 자동으로 완료되지 않으면 최종 callback URL 전체를 이 터미널에 붙여넣고 Enter를 누르세요.',
  ]);
});

Deno.test('receiveStandaloneLoopbackAuthorizationCode can accept incomplete probes and then resolve the final callback through an injected server factory', async () => {
  let connectionListener:
    | ((socket: {
      destroy(): void;
      once(event: 'close', listener: () => void): void;
    }) => void)
    | undefined;
  let errorListener: ((error: Error) => void) | undefined;
  let requestHandler: ((request: unknown, response: unknown) => void) | undefined;
  let probeStatus = 0;
  let finalStatus = 0;
  let destroyedSockets = 0;
  let socketCloseListener: (() => void) | undefined;

  const receiverPromise = __standaloneCLITestables.receiveStandaloneLoopbackAuthorizationCode(
    {
      authUrl: 'https://auth.example.test/login',
      callbackPort: 14559,
      redirectUri: 'http://localhost:14559/auth/callback',
      state: 'state-test',
    },
    undefined,
    ((handler: unknown) => {
      requestHandler = handler as unknown as typeof requestHandler;

      return {
        close(callback?: (error?: Error) => void) {
          destroyedSockets += 1;
          callback?.();
        },
        listen(_port: number, _host: string) {
          connectionListener?.({
            destroy() {
              destroyedSockets += 1;
              socketCloseListener?.();
            },
            once(_event, listener) {
              socketCloseListener = listener;
            },
          });

          requestHandler?.(
            {
              headers: { host: '127.0.0.1:14559' },
              url: '/auth/callback?state=state-test',
            },
            {
              end(_body?: string, callback?: () => void) {
                callback?.();
              },
              writeHead(statusCode: number) {
                probeStatus = statusCode;
              },
            },
          );

          requestHandler?.(
            {
              headers: { host: '127.0.0.1:14559' },
              url: '/auth/callback?code=code-test&state=state-test',
            },
            {
              end(_body?: string, callback?: () => void) {
                callback?.();
              },
              writeHead(statusCode: number) {
                finalStatus = statusCode;
              },
            },
          );

          requestHandler?.(
            {
              headers: { host: '127.0.0.1:14559' },
              url: '/auth/callback?code=code-test&state=state-test',
            },
            {
              end(_body?: string, callback?: () => void) {
                callback?.();
              },
              writeHead() {},
            },
          );

          errorListener?.(new Error('late error'));
        },
        on(event: 'connection' | 'error', listener: (value: never) => void) {
          if (event === 'connection') {
            connectionListener = listener as typeof connectionListener;
            return;
          }

          errorListener = listener as typeof errorListener;
        },
      };
    }) as unknown as typeof import('node:http').createServer,
  );

  assert.deepEqual(await receiverPromise, {
    code: 'code-test',
    state: 'state-test',
  });
  assert.equal(probeStatus, 202);
  assert.equal(finalStatus, 200);
  assert.ok(destroyedSockets >= 1);
});

Deno.test('receiveStandaloneLoopbackAuthorizationCode falls back to default URL pieces when the probe omits url and host', async () => {
  let requestHandler: ((request: unknown, response: unknown) => void) | undefined;
  let probeStatus = 0;

  const receiverPromise = __standaloneCLITestables.receiveStandaloneLoopbackAuthorizationCode(
    {
      authUrl: 'https://auth.example.test/login',
      callbackPort: 14561,
      redirectUri: 'http://localhost:14561/auth/callback',
      state: 'state-test',
    },
    undefined,
    ((handler: unknown) => {
      requestHandler = handler as typeof requestHandler;
      return {
        close(callback?: (error?: Error) => void) {
          callback?.();
        },
        listen() {
          requestHandler?.(
            {
              headers: {},
              url: undefined,
            },
            {
              end(_body?: string, callback?: () => void) {
                callback?.();
              },
              writeHead(statusCode: number) {
                probeStatus = statusCode;
              },
            },
          );

          requestHandler?.(
            {
              headers: {},
              url: '/auth/callback?code=code-test&state=state-test',
            },
            {
              end(_body?: string, callback?: () => void) {
                callback?.();
              },
              writeHead() {},
            },
          );
        },
        on() {},
      };
    }) as unknown as typeof import('node:http').createServer,
  );

  assert.deepEqual(await receiverPromise, {
    code: 'code-test',
    state: 'state-test',
  });
  assert.equal(probeStatus, 202);
});

Deno.test('receiveStandaloneLoopbackAuthorizationCode rejects when the injected server reports an error', async () => {
  let errorListener: ((error: Error) => void) | undefined;

  await assert.rejects(
    async () =>
      await __standaloneCLITestables.receiveStandaloneLoopbackAuthorizationCode(
        {
          authUrl: 'https://auth.example.test/login',
          callbackPort: 14560,
          redirectUri: 'http://localhost:14560/auth/callback',
          state: 'state-test',
        },
        undefined,
        ((handler: unknown) => {
          void handler;
          return {
            close(callback?: (error?: Error) => void) {
              callback?.();
            },
            listen() {
              errorListener?.(new Error('listen failed'));
            },
            on(event: 'connection' | 'error', listener: (value: never) => void) {
              if (event === 'error') {
                errorListener = listener as typeof errorListener;
              }
            },
          };
        }) as unknown as typeof import('node:http').createServer,
      ),
    /listen failed/u,
  );
});

Deno.test('standalone Codex OAuth authorization receiver aborts and cleans up the losing stdin wait after the loopback callback wins', async () => {
  const lines: string[] = [];
  let abortedRead = false;
  let cleanupFinished = false;

  const receiver = __standaloneCLITestables.createStandaloneCodexOAuthAuthorizationReceiver({
    readLoginLine: async (signal?: AbortSignal) =>
      await new Promise<string | null>((resolve) => {
        signal?.addEventListener(
          'abort',
          () => {
            abortedRead = true;
            queueMicrotask(() => {
              cleanupFinished = true;
              resolve(null);
            });
          },
          { once: true },
        );
      }),
    receiveLoopbackAuthorizationCode: async () => ({
      code: 'code-from-loopback',
      state: 'state-test',
    }),
    writeLine: (line: string) => lines.push(line),
  });

  const result = await receiver({
    authUrl: 'https://auth.example.test/login',
    callbackPort: 1455,
    redirectUri: 'http://localhost:1455/auth/callback',
    state: 'state-test',
  });

  assert.deepEqual(result, {
    code: 'code-from-loopback',
    state: 'state-test',
  });
  assert.equal(abortedRead, true);
  assert.equal(cleanupFinished, true);
  assert.deepEqual(lines, [
    '[login] waiting for callback: http://localhost:1455/auth/callback',
    '[login] 브라우저가 자동으로 완료되지 않으면 최종 callback URL 전체를 이 터미널에 붙여넣고 Enter를 누르세요.',
  ]);
});

Deno.test('standalone Codex OAuth authorization receiver can ignore invalid pasted values and continue waiting for the final callback URL', async () => {
  const lines: string[] = [];
  const pastedValues = [
    'https://example.test/not-the-final-url',
    'http://localhost:1455/auth/callback?state=state-test',
    'http://localhost:1455/auth/callback?code=code-test&state=state-test',
  ];
  const receiver = __standaloneCLITestables.createStandaloneCodexOAuthAuthorizationReceiver({
    readLoginLine: async () => pastedValues.shift() ?? null,
    receiveLoopbackAuthorizationCode: async (_session: unknown, signal?: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('manual callback paste should eventually resolve'));
        }, 20);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      throw new DOMException('Aborted', 'AbortError');
    },
    writeLine: (line: string) => lines.push(line),
  });

  const result = await receiver({
    authUrl: 'https://auth.example.test/login',
    callbackPort: 1455,
    redirectUri: 'http://localhost:1455/auth/callback',
    state: 'state-test',
  });

  assert.deepEqual(result, {
    code: 'code-test',
    state: 'state-test',
  });
  assert.deepEqual(lines, [
    '[login] waiting for callback: http://localhost:1455/auth/callback',
    '[login] 브라우저가 자동으로 완료되지 않으면 최종 callback URL 전체를 이 터미널에 붙여넣고 Enter를 누르세요.',
    '[login] 붙여넣은 값에 code 와 state 가 없습니다. 브라우저가 연 최종 callback URL 전체를 붙여넣어 주세요.',
    '[login] 붙여넣은 값에 code 와 state 가 없습니다. 브라우저가 연 최종 callback URL 전체를 붙여넣어 주세요.',
  ]);
});

Deno.test('runStandaloneCLI can list Codex OAuth models without loading run-only files', async () => {
  const lines: string[] = [];
  let listCalls = 0;

  const result = await runStandaloneCLI(
    [
      '--provider',
      'codex-oauth',
      '--list-models',
    ],
    {
      createCodexOAuthProvider: () => ({
        createCaller() {
          throw new Error('list-models should not create a caller');
        },
        async listModels() {
          listCalls += 1;
          return ['gpt-5.4-mini', 'gpt-5.4-nano'];
        },
        async login() {
          throw new Error('list-models should not trigger login when auth already exists');
        },
      }),
      writeLine: (line) => lines.push(line),
    },
  );

  assert.equal(result.answer, '');
  assert.equal(listCalls, 1);
  assert.deepEqual(lines, [
    '[models] provider: codex-oauth',
    '[model] gpt-5.4-mini',
    '[model] gpt-5.4-nano',
  ]);
});

Deno.test('runStandaloneCLI can list Codex OAuth models through the default provider when auth already exists on disk', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-default-codex-list-' });
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(
    join(root, '.rlm/codex-oauth.json'),
    JSON.stringify(
      {
        apiBaseUrl: 'https://chatgpt.com/backend-api',
        authBaseUrl: 'https://auth.openai.com',
        clientId: 'client-test',
        provider: 'codex-oauth',
        tokens: {
          accessToken:
            'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjQ3NjcyMDAwMDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LXRlc3QifX0.signature',
          accountId: 'acct-test',
          expiresAt: '2121-01-01T00:00:00.000Z',
          idToken:
            'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjQ3NjcyMDAwMDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LXRlc3QiLCJvcmdhbml6YXRpb25faWQiOiJvcmctdGVzdCJ9fQ.signature',
          organizationId: 'org-test',
          refreshToken: 'refresh-test',
        },
        updatedAt: '2026-03-27T00:00:00.000Z',
        version: 2,
      },
      null,
      2,
    ),
  );

  const lines: string[] = [];
  const result = await runStandaloneCLI(
    ['--provider', 'codex-oauth', '--list-models'],
    {
      cwd: root,
      fetcher: async (input) => {
        const url = String(input);
        if (url.includes('/codex/models')) {
          return new Response(
            JSON.stringify({
              models: [{ slug: 'gpt-5-4-t-mini' }, { id: 'gpt-5-3-instant' }],
            }),
            {
              headers: { 'Content-Type': 'application/json' },
              status: 200,
            },
          );
        }

        throw new Error(`Unexpected request: ${url}`);
      },
      writeLine: (line) => lines.push(line),
    },
  );

  assert.equal(result.answer, '');
  assert.deepEqual(lines, [
    '[models] provider: codex-oauth',
    '[model] gpt-5-4-t-mini',
    '[model] gpt-5-3-instant',
  ]);
});

Deno.test('runStandaloneCLI can execute a Codex OAuth-backed run through the generic RLM runner', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-codex-' });
  const inputPath = join(root, 'book.txt');
  const systemPromptPath = join(root, 'ebook-system.txt');
  await Deno.writeTextFile(inputPath, 'Chapter 1\nThe answer is 42.\n');
  await Deno.writeTextFile(systemPromptPath, 'Always answer in concise Korean.');

  const lines: string[] = [];
  const runCalls: Array<{
    llmRequestTimeoutMs: number | undefined;
    cellTimeoutMs: number | undefined;
    context: unknown;
    prompt: string;
    rootModel: string;
    subModel: string;
  }> = [];
  const llm = {
    async complete() {
      return {
        outputText: 'unused',
      };
    },
  };

  const result = await runStandaloneCLI(
    [
      '--provider',
      'codex-oauth',
      '--input',
      inputPath,
      '--query',
      'What is the answer?',
      '--system-prompt',
      systemPromptPath,
    ],
    {
      clock: createClock(),
      createCodexOAuthProvider: () => ({
        createCaller(config) {
          runCalls.push({
            cellTimeoutMs: undefined,
            context: undefined,
            llmRequestTimeoutMs: config?.requestTimeoutMs,
            prompt: '',
            rootModel: '',
            subModel: '',
          });
          return llm;
        },
        async listModels() {
          return ['gpt-5-4-t-mini', 'gpt-5-3-instant', 'gpt-5-mini'];
        },
        async login() {
          throw new Error('run mode should use the stored auth state instead of forcing login');
        },
      }),
      cwd: root,
      render: async () => '정답은 42입니다.',
      runGeneric: async (options) => {
        runCalls[0] = {
          cellTimeoutMs: options.cellTimeoutMs,
          context: options.context,
          llmRequestTimeoutMs: runCalls[0]?.llmRequestTimeoutMs,
          prompt: options.prompt,
          rootModel: options.rootModel,
          subModel: options.subModel,
        };

        return {
          answer: '42',
          finalValue: '42',
          usage: {
            byModel: [
              {
                cachedInputTokens: 0,
                inputTokens: 60,
                model: 'gpt-5.4-mini',
                outputTokens: 20,
                reportedRequests: 1,
                requests: 1,
                totalTokens: 80,
              },
            ],
            cachedInputTokens: 0,
            inputTokens: 60,
            outputTokens: 20,
            reportedRequests: 1,
            requests: 1,
            totalTokens: 80,
          },
        };
      },
      writeLine: (line) => lines.push(line),
    },
  );

  assert.equal(result.answer, '정답은 42입니다.');
  assert.deepEqual(runCalls, [
    {
      llmRequestTimeoutMs: 30_000,
      cellTimeoutMs: 35_000,
      context: {
        document: 'Chapter 1\nThe answer is 42.\n',
        inputFilePath: inputPath,
      },
      prompt: 'What is the answer?',
      rootModel: 'gpt-5-4-t-mini',
      subModel: 'gpt-5-3-instant',
    },
  ]);
  assert.ok(lines.some((line) => line.includes('[standalone] provider: codex-oauth')));
  assert.ok(lines.includes('[usage] input_tokens=60 output_tokens=20 total_tokens=80'));
  assert.ok(lines.includes('[cost] input_usd= output_usd= total_usd='));
});

Deno.test('runStandaloneCLI uses CLI model overrides first, then .env model defaults, then fallback for Codex OAuth runs', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-codex-model-priority-' });
  const inputPath = join(root, 'book.txt');
  const systemPromptPath = join(root, 'ebook-system.txt');
  await Deno.writeTextFile(inputPath, 'Chapter 1\nThe answer is 42.\n');
  await Deno.writeTextFile(systemPromptPath, 'Always answer in concise Korean.');
  await Deno.writeTextFile(
    join(root, '.env'),
    [
      'RLM_OPENAI_ROOT_MODEL=gpt-5-4-t-mini',
      'RLM_OPENAI_SUB_MODEL=gpt-5-3-instant',
    ].join('\n'),
  );

  const envRunCalls: Array<{ rootModel: string; subModel: string }> = [];
  await runStandaloneCLI(
    [
      '--provider',
      'codex-oauth',
      '--input',
      inputPath,
      '--query',
      'What is the answer?',
      '--system-prompt',
      systemPromptPath,
    ],
    {
      clock: createClock(),
      createCodexOAuthProvider: () => ({
        createCaller() {
          return {
            async complete() {
              return { outputText: 'unused' };
            },
          };
        },
        async listModels() {
          return ['gpt-5-4-t-mini', 'gpt-5-3-instant', 'gpt-5'];
        },
        async login() {
          throw new Error('run mode should use the stored auth state instead of forcing login');
        },
      }),
      cwd: root,
      render: async () => '정답은 42입니다.',
      runGeneric: async (options) => {
        envRunCalls.push({
          rootModel: options.rootModel,
          subModel: options.subModel,
        });
        return {
          answer: '42',
          finalValue: '42',
        };
      },
      writeLine: () => {},
    },
  );

  assert.deepEqual(envRunCalls, [{
    rootModel: 'gpt-5-4-t-mini',
    subModel: 'gpt-5-3-instant',
  }]);

  const cliRunCalls: Array<{ rootModel: string; subModel: string }> = [];
  await runStandaloneCLI(
    [
      '--provider',
      'codex-oauth',
      '--root-model',
      'gpt-5',
      '--sub-model',
      'gpt-5-3-instant',
      '--input',
      inputPath,
      '--query',
      'What is the answer?',
      '--system-prompt',
      systemPromptPath,
    ],
    {
      clock: createClock(),
      createCodexOAuthProvider: () => ({
        createCaller() {
          return {
            async complete() {
              return { outputText: 'unused' };
            },
          };
        },
        async listModels() {
          return ['gpt-5-4-t-mini', 'gpt-5-3-instant', 'gpt-5'];
        },
        async login() {
          throw new Error('run mode should use the stored auth state instead of forcing login');
        },
      }),
      cwd: root,
      render: async () => '정답은 42입니다.',
      runGeneric: async (options) => {
        cliRunCalls.push({
          rootModel: options.rootModel,
          subModel: options.subModel,
        });
        return {
          answer: '42',
          finalValue: '42',
        };
      },
      writeLine: () => {},
    },
  );

  assert.deepEqual(cliRunCalls, [{
    rootModel: 'gpt-5',
    subModel: 'gpt-5-3-instant',
  }]);
});

Deno.test('runStandaloneCLI can attach the AoT-lite controller guidance to Codex OAuth runs when --aot is enabled', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-aot-codex-' });
  const inputPath = join(root, 'book.txt');
  const systemPromptPath = join(root, 'ebook-system.txt');
  await Deno.writeTextFile(inputPath, 'Chapter 1\nThe answer is 42.\n');
  await Deno.writeTextFile(systemPromptPath, 'Always answer in concise Korean.');

  const plugin = createAoTPlugin();
  const runCalls: Array<
    {
      plugins: unknown;
      prompt: string;
      queryTrace: boolean | undefined;
      systemPromptExtension: string | undefined;
    }
  > = [];

  const result = await runStandaloneCLI(
    [
      '--provider',
      'codex-oauth',
      '--aot',
      '--input',
      inputPath,
      '--query',
      'Answer richly when the document is incomplete.',
      '--system-prompt',
      systemPromptPath,
    ],
    {
      clock: createClock(),
      createAOTPlugin: () => plugin,
      createCodexOAuthProvider: () => ({
        createCaller() {
          return {
            async complete() {
              return {
                outputText: 'unused',
              };
            },
          };
        },
        async listModels() {
          return ['gpt-5-4-t-mini', 'gpt-5-3-instant'];
        },
        async login() {
          throw new Error('run mode should use the stored auth state instead of forcing login');
        },
      }),
      cwd: root,
      render: async () => '정답은 42입니다.',
      runGeneric: async (options) => {
        runCalls.push({
          plugins: options.plugins,
          prompt: options.prompt,
          queryTrace: options.queryTrace,
          systemPromptExtension: options.systemPromptExtension,
        });

        return {
          answer: '42',
          finalValue: '42',
        };
      },
      writeLine: () => {},
    },
  );

  assert.equal(result.answer, '정답은 42입니다.');
  assert.deepEqual(runCalls, [{
    plugins: [plugin],
    prompt: 'Answer richly when the document is incomplete.',
    queryTrace: undefined,
    systemPromptExtension: runCalls[0]?.systemPromptExtension,
  }]);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /must call `aot\(/u);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /AoT-lite mode is enabled/u);
  assert.match(
    runCalls[0]?.systemPromptExtension ?? '',
    /document` is empty, missing, or insufficient/u,
  );
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /maxIterations: 1/u);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /maxIndependentSubquestions: 2/u);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /maxRefinements: 0/u);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /includeTrace: false/u);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /answer without AoT/u);
});

Deno.test('runStandaloneCLI can attach the AoT-hard controller guidance and debug tracing to Codex OAuth runs when --aot-hard and --aot-debug are enabled', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-aot-hard-codex-' });
  const inputPath = join(root, 'book.txt');
  const systemPromptPath = join(root, 'ebook-system.txt');
  await Deno.writeTextFile(inputPath, 'Chapter 1\nThe answer is 42.\n');
  await Deno.writeTextFile(systemPromptPath, 'Always answer in concise Korean.');

  const plugin = createAoTPlugin();
  const runCalls: Array<
    {
      plugins: unknown;
      prompt: string;
      queryTrace: boolean | undefined;
      systemPromptExtension: string | undefined;
    }
  > = [];

  const result = await runStandaloneCLI(
    [
      '--provider',
      'codex-oauth',
      '--aot-hard',
      '--aot-debug',
      '--input',
      inputPath,
      '--query',
      'Answer richly when the document is incomplete.',
      '--system-prompt',
      systemPromptPath,
    ],
    {
      clock: createClock(),
      createAOTPlugin: () => plugin,
      createCodexOAuthProvider: () => ({
        createCaller() {
          return {
            async complete() {
              return {
                outputText: 'unused',
              };
            },
          };
        },
        async listModels() {
          return ['gpt-5-4-t-mini', 'gpt-5-3-instant'];
        },
        async login() {
          throw new Error('run mode should use the stored auth state instead of forcing login');
        },
      }),
      cwd: root,
      render: async () => '정답은 42입니다.',
      runGeneric: async (options) => {
        runCalls.push({
          plugins: options.plugins,
          prompt: options.prompt,
          queryTrace: options.queryTrace,
          systemPromptExtension: options.systemPromptExtension,
        });

        return {
          answer: '42',
          finalValue: '42',
        };
      },
      writeLine: () => {},
    },
  );

  assert.equal(result.answer, '정답은 42입니다.');
  assert.deepEqual(runCalls, [{
    plugins: [plugin],
    prompt: 'Answer richly when the document is incomplete.',
    queryTrace: true,
    systemPromptExtension: runCalls[0]?.systemPromptExtension,
  }]);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /AOT-hard mode is enabled/u);
  assert.match(runCalls[0]?.systemPromptExtension ?? '', /must call `aot\(/u);
});

Deno.test('runStandaloneCLI can use the default Codex provider and default final renderer in run mode', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-default-codex-run-' });
  const inputPath = join(root, 'book.txt');
  const systemPromptPath = join(root, 'ebook-system.txt');
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(inputPath, 'Chapter 1\nThe answer is 42.\n');
  await Deno.writeTextFile(systemPromptPath, 'Always answer in concise Korean.');
  await Deno.writeTextFile(
    join(root, '.rlm/codex-oauth.json'),
    JSON.stringify(
      {
        apiBaseUrl: 'https://chatgpt.com/backend-api',
        authBaseUrl: 'https://auth.openai.com',
        clientId: 'client-test',
        provider: 'codex-oauth',
        tokens: {
          accessToken:
            'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjQ3NjcyMDAwMDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LXRlc3QifX0.signature',
          accountId: 'acct-test',
          expiresAt: '2121-01-01T00:00:00.000Z',
          idToken:
            'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjQ3NjcyMDAwMDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LXRlc3QiLCJvcmdhbml6YXRpb25faWQiOiJvcmctdGVzdCJ9fQ.signature',
          organizationId: 'org-test',
          refreshToken: 'refresh-test',
        },
        updatedAt: '2026-03-27T00:00:00.000Z',
        version: 2,
      },
      null,
      2,
    ),
  );

  const lines: string[] = [];
  let responsesCallCount = 0;
  const result = await runStandaloneCLI(
    [
      '--provider',
      'codex-oauth',
      '--input',
      inputPath,
      '--query',
      'What is the answer?',
      '--system-prompt',
      systemPromptPath,
    ],
    {
      clock: createClock(),
      cwd: root,
      fetcher: async (input) => {
        const url = String(input);
        if (url.includes('/codex/models')) {
          return new Response(
            JSON.stringify({
              models: [{ slug: 'gpt-5-4-t-mini' }, { slug: 'gpt-5-3-instant' }],
            }),
            {
              headers: { 'Content-Type': 'application/json' },
              status: 200,
            },
          );
        }

        if (url.endsWith('/codex/responses')) {
          responsesCallCount += 1;
          return new Response(
            JSON.stringify({
              id: `resp-${responsesCallCount}`,
              output_text: responsesCallCount === 1 ? '정답은 42입니다.' : '정답은 42입니다.',
            }),
            {
              headers: { 'Content-Type': 'application/json' },
              status: 200,
            },
          );
        }

        throw new Error(`Unexpected request: ${url}`);
      },
      runGeneric: async (options) => {
        assert.equal(options.rootModel, 'gpt-5-4-t-mini');
        assert.equal(options.subModel, 'gpt-5-3-instant');
        return {
          answer: '42',
          finalValue: '42',
        };
      },
      writeLine: (line) => lines.push(line),
    },
  );

  assert.equal(result.answer, '정답은 42입니다.');
  assert.ok(lines.includes('[final] 정답은 42입니다.'));
});

Deno.test('runStandaloneCLI can forward an explicit cell timeout override into the generic Codex OAuth runner', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-codex-timeout-' });
  const inputPath = join(root, 'book.txt');
  const systemPromptPath = join(root, 'ebook-system.txt');
  await Deno.writeTextFile(inputPath, 'Chapter 1\nThe answer is 42.\n');
  await Deno.writeTextFile(systemPromptPath, 'Always answer in concise Korean.');

  const runCalls: Array<{ cellTimeoutMs: number | undefined }> = [];

  await runStandaloneCLI(
    [
      '--provider',
      'codex-oauth',
      '--input',
      inputPath,
      '--query',
      'What is the answer?',
      '--system-prompt',
      systemPromptPath,
      '--cell-timeout-ms',
      '47000',
    ],
    {
      clock: createClock(),
      createCodexOAuthProvider: () => ({
        createCaller(config) {
          assert.equal(config?.requestTimeoutMs, 30_000);
          return {
            async complete() {
              return {
                outputText: 'unused',
              };
            },
          };
        },
        async listModels() {
          return ['gpt-5-4-t-mini', 'gpt-5-3-instant'];
        },
        async login() {
          throw new Error('run mode should use the stored auth state instead of forcing login');
        },
      }),
      cwd: root,
      render: async () => '정답은 42입니다.',
      runGeneric: async (options) => {
        runCalls.push({
          cellTimeoutMs: options.cellTimeoutMs,
        });

        return {
          answer: '42',
          finalValue: '42',
        };
      },
      writeLine: () => {},
    },
  );

  assert.deepEqual(runCalls, [{ cellTimeoutMs: 77_000 }]);
});

Deno.test('runStandaloneCLI can forward an explicit request timeout override into the generic Codex OAuth runner', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-codex-request-timeout-' });
  const inputPath = join(root, 'book.txt');
  const systemPromptPath = join(root, 'ebook-system.txt');
  await Deno.writeTextFile(inputPath, 'Chapter 1\nThe answer is 42.\n');
  await Deno.writeTextFile(systemPromptPath, 'Always answer in concise Korean.');

  const runCalls: Array<
    { cellTimeoutMs: number | undefined; llmRequestTimeoutMs: number | undefined }
  > = [];

  await runStandaloneCLI(
    [
      '--provider',
      'codex-oauth',
      '--input',
      inputPath,
      '--query',
      'What is the answer?',
      '--system-prompt',
      systemPromptPath,
      '--request-timeout-ms',
      '95000',
      '--cell-timeout-ms',
      '47000',
    ],
    {
      clock: createClock(),
      createCodexOAuthProvider: () => ({
        createCaller(config) {
          runCalls.push({
            cellTimeoutMs: undefined,
            llmRequestTimeoutMs: config?.requestTimeoutMs,
          });
          return {
            async complete() {
              return {
                outputText: 'unused',
              };
            },
          };
        },
        async listModels() {
          return ['gpt-5-4-t-mini', 'gpt-5-3-instant'];
        },
        async login() {
          throw new Error('run mode should use the stored auth state instead of forcing login');
        },
      }),
      cwd: root,
      render: async () => '정답은 42입니다.',
      runGeneric: async (options) => {
        runCalls[0] = {
          cellTimeoutMs: options.cellTimeoutMs,
          llmRequestTimeoutMs: runCalls[0]?.llmRequestTimeoutMs,
        };

        return {
          answer: '42',
          finalValue: '42',
        };
      },
      writeLine: () => {},
    },
  );

  assert.deepEqual(runCalls, [{
    cellTimeoutMs: 142_000,
    llmRequestTimeoutMs: 95_000,
  }]);
});

Deno.test('runStandaloneCLI logs provider failures to the standalone journal and user-facing output', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-provider-error-' });
  const inputPath = join(root, 'book.txt');
  const systemPromptPath = join(root, 'ebook-system.txt');
  const logPath = join(root, 'logs', 'standalone', 'provider-error.jsonl');
  await Deno.writeTextFile(inputPath, 'Chapter 1\nThe answer is 42.\n');
  await Deno.writeTextFile(systemPromptPath, 'Always answer in concise Korean.');

  const lines: string[] = [];

  await assert.rejects(
    async () =>
      await runStandaloneCLI(
        [
          '--provider',
          'codex-oauth',
          '--input',
          inputPath,
          '--query',
          'What is the answer?',
          '--system-prompt',
          systemPromptPath,
          '--log',
          logPath,
        ],
        {
          clock: createClock(),
          createCodexOAuthProvider: () => ({
            createCaller() {
              return {
                async complete() {
                  throw new Error(
                    'Codex OAuth request failed with status 400. raw={"detail":"bad request"}',
                  );
                },
              };
            },
            async listModels() {
              return ['gpt-5.4-t-mini', 'gpt-5-3-instant'];
            },
            async login() {
              throw new Error('run mode should not force login');
            },
          }),
          cwd: root,
          runGeneric: async (options) => {
            await options.logger?.append({
              context: options.context,
              createdAt: '2026-03-26T00:00:00.000Z',
              defaultTimeoutMs: 5_000,
              sessionId: 'session-1',
              type: 'session',
            });
            const llm = options.llm;
            assert.ok(llm !== undefined);
            await llm.complete({
              input: options.prompt,
              kind: 'root_turn',
              metadata: { depth: 0, step: 1 },
              model: options.rootModel,
              systemPrompt: 'Use the REPL.',
            });
            return {
              answer: 'unreachable',
            };
          },
          writeLine: (line) => lines.push(line),
        },
      ),
    /status 400/u,
  );

  assert.ok(lines.includes('[session] started'));
  assert.ok(
    lines.includes(
      '[error] run: Codex OAuth request failed with status 400. raw={"detail":"bad request"}',
    ),
  );

  const journalLines = (await Deno.readTextFile(logPath)).trim().split('\n').map((line) =>
    JSON.parse(line) as {
      createdAt?: string;
      message?: string;
      stage?: string;
      type: string;
    }
  );
  assert.equal(journalLines[0]?.type, 'session');
  assert.deepEqual(journalLines.at(-1), {
    createdAt: '2026-03-26T11:22:33.456Z',
    message: 'Codex OAuth request failed with status 400. raw={"detail":"bad request"}',
    stage: 'run',
    type: 'standalone_error',
  });
});

Deno.test('runStandaloneCLI preserves non-Error failures and still records a standalone error entry before session startup', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-primitive-error-' });
  const inputPath = join(root, 'book.txt');
  const systemPromptPath = join(root, 'ebook-system.txt');
  const logPath = join(root, 'logs', 'standalone', 'primitive-error.jsonl');
  await Deno.writeTextFile(inputPath, 'Chapter 1\nThe answer is 42.\n');
  await Deno.writeTextFile(systemPromptPath, 'Always answer in concise Korean.');
  await Deno.writeTextFile(
    join(root, '.env'),
    [
      'OPENAI_API_KEY=sk-test',
      'RLM_OPENAI_ROOT_MODEL=gpt-5.4-mini',
      'RLM_OPENAI_SUB_MODEL=gpt-5.4-nano',
    ].join('\n'),
  );

  let thrown: unknown;
  try {
    await runStandaloneCLI(
      [
        '--input',
        inputPath,
        '--query',
        'What is the answer?',
        '--system-prompt',
        systemPromptPath,
        '--log',
        logPath,
      ],
      {
        cwd: root,
        run: async () => {
          throw { detail: 'primitive boom' };
        },
        writeLine: () => {},
      },
    );
  } catch (error) {
    thrown = error;
  }

  assert.deepEqual(thrown, { detail: 'primitive boom' });

  const journalLines = (await Deno.readTextFile(logPath)).trim().split('\n').map((line) =>
    JSON.parse(line) as {
      createdAt?: string;
      message?: string;
      stage?: string;
      type: string;
    }
  );
  assert.deepEqual(journalLines, [
    {
      createdAt: journalLines[0]?.createdAt,
      message: '[object Object]',
      stage: 'run',
      type: 'standalone_error',
    },
  ]);
});

Deno.test('runStandaloneCLI surfaces missing required run flags after provider-only modes are ruled out', async () => {
  await assert.rejects(
    async () => {
      await runStandaloneCLI(['--provider', 'openai'], {
        writeLine: () => {},
      });
    },
    /Missing required CLI flags: --query, --system-prompt\./u,
  );
});

Deno.test('runStandaloneCLI keeps the provider request timeout from config when no explicit override is supplied', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-openai-timeout-default-' });
  const inputPath = join(root, 'book.txt');
  const systemPromptPath = join(root, 'ebook-system.txt');
  await Deno.writeTextFile(inputPath, 'Chapter 1\nThe answer is 42.\n');
  await Deno.writeTextFile(systemPromptPath, 'Always answer in concise Korean.');
  await Deno.writeTextFile(
    join(root, '.env'),
    [
      'OPENAI_API_KEY=sk-test',
      'RLM_OPENAI_ROOT_MODEL=gpt-5.4-mini',
      'RLM_OPENAI_SUB_MODEL=gpt-5.4-nano',
      'RLM_REQUEST_TIMEOUT_MS=31000',
      'RLM_CELL_TIMEOUT_MS=5000',
    ].join('\n'),
  );

  const calls: Array<{ requestTimeoutMs: number | undefined }> = [];

  await runStandaloneCLI(
    [
      '--input',
      inputPath,
      '--query',
      'What is the answer?',
      '--system-prompt',
      systemPromptPath,
    ],
    {
      cwd: root,
      fetcher: async () =>
        new Response(
          JSON.stringify({
            id: 'resp-final',
            output_text: '정답은 42입니다.',
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          },
        ),
      run: async (options) => {
        calls.push({
          requestTimeoutMs: options.openAI.requestTimeoutMs,
        });
        return {
          answer: '42',
          finalValue: '42',
        };
      },
      writeLine: () => {},
    },
  );

  assert.deepEqual(calls, [{ requestTimeoutMs: 31_000 }]);
});

Deno.test('standalone helper resolvers cover injected and default dependencies', async () => {
  const customReadTextFile = async (path: string | URL) => String(path);
  const customReadLoginLine = async () => 'callback';
  const customRun = async () => ({ answer: '42' });
  const customRunGeneric = async () => ({ answer: '42' });
  const customRender = async () => 'rendered';
  const customWriteLine = (_line: string) => {};
  const customCodexProvider = {
    createCaller() {
      return {
        async complete() {
          return { outputText: 'unused' };
        },
      };
    },
    async listModels() {
      return ['gpt-5.4-mini'];
    },
    async login() {
      return {};
    },
  };

  assert.equal(
    __standaloneCLITestables.resolveStandaloneReadTextFile(customReadTextFile),
    customReadTextFile,
  );
  assert.equal(
    __standaloneCLITestables.resolveStandaloneReadLoginLine(customReadLoginLine),
    customReadLoginLine,
  );
  assert.equal(__standaloneCLITestables.resolveStandaloneRun(customRun), customRun);
  assert.equal(
    __standaloneCLITestables.resolveStandaloneGenericRun(customRunGeneric),
    customRunGeneric,
  );
  assert.equal(
    __standaloneCLITestables.resolveStandaloneRender({ render: customRender }),
    customRender,
  );
  assert.equal(
    __standaloneCLITestables.resolveStandaloneWriteLine(customWriteLine),
    customWriteLine,
  );
  assert.equal(
    __standaloneCLITestables.resolveCodexOAuthProvider(() => customCodexProvider),
    customCodexProvider,
  );
  assert.equal(
    typeof __standaloneCLITestables.resolveCodexOAuthProvider(undefined).createCaller,
    'function',
  );
  assert.deepEqual(
    __standaloneCLITestables.resolveCodexOAuthModels(
      ['gpt-5-4-t-mini', 'gpt-5-3-instant', 'gpt-5-mini'],
      {},
    ),
    {
      rootModel: 'gpt-5-4-t-mini',
      subModel: 'gpt-5-3-instant',
    },
  );

  assert.equal(
    __standaloneCLITestables.resolveStandaloneReadTextFile(undefined),
    Deno.readTextFile,
  );
  assert.equal(
    typeof __standaloneCLITestables.resolveStandaloneReadLoginLine(undefined),
    'function',
  );
  assert.equal(typeof __standaloneCLITestables.resolveStandaloneRun(undefined), 'function');
  assert.equal(typeof __standaloneCLITestables.resolveStandaloneGenericRun(undefined), 'function');
  assert.equal(typeof __standaloneCLITestables.resolveStandaloneRender({}), 'function');

  const lines: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (line?: unknown) => lines.push(String(line ?? ''));
    __standaloneCLITestables.resolveStandaloneWriteLine(undefined)('hello');
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(lines, ['hello']);
});

Deno.test('createStandaloneFetchLogger prints each HTTPS method, URL, and text body before delegating to fetch', async () => {
  const lines: string[] = [];
  const fetchCalls: Array<{ body?: string; method: string; url: string }> = [];
  const loggedFetch = __standaloneCLITestables.createStandaloneFetchLogger(
    (line) => lines.push(line),
    async (input, init) => {
      const requestInit = init as RequestInit | undefined;
      fetchCalls.push({
        body: typeof requestInit?.body === 'string' ? requestInit.body : undefined,
        method: String(requestInit?.method ?? 'GET').toUpperCase(),
        url: typeof input === 'string'
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url,
      });
      return new Response('{}', {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    },
  );

  await loggedFetch('https://chatgpt.com/backend-api/models', {
    body: JSON.stringify({ limit: 10, provider: 'codex-oauth' }),
    method: 'POST',
  });

  assert.deepEqual(lines, [
    '[https] POST https://chatgpt.com/backend-api/models',
    '[https-body] {"limit":10,"provider":"codex-oauth"}',
  ]);
  assert.deepEqual(fetchCalls, [
    {
      body: '{"limit":10,"provider":"codex-oauth"}',
      method: 'POST',
      url: 'https://chatgpt.com/backend-api/models',
    },
  ]);
});

Deno.test('createStandaloneFetchLogger falls back to GET and can derive a URL from Request objects', async () => {
  const lines: string[] = [];
  const fetchCalls: Array<{ method: string; url: string }> = [];
  const loggedFetch = __standaloneCLITestables.createStandaloneFetchLogger(
    (line) => lines.push(line),
    async (input, init) => {
      const requestInit = init as RequestInit | undefined;
      fetchCalls.push({
        method: String(requestInit?.method ?? 'GET').toUpperCase(),
        url: typeof input === 'string'
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url,
      });
      return new Response('{}', {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    },
  );

  await loggedFetch(new Request('https://chatgpt.com/backend-api/models?limit=1'));

  assert.deepEqual(lines, [
    '[https] GET https://chatgpt.com/backend-api/models?limit=1',
  ]);
  assert.deepEqual(fetchCalls, [
    {
      method: 'GET',
      url: 'https://chatgpt.com/backend-api/models?limit=1',
    },
  ]);
});

Deno.test('createStandaloneFetchLogger prints a placeholder for non-text request bodies', async () => {
  const lines: string[] = [];
  const loggedFetch = __standaloneCLITestables.createStandaloneFetchLogger(
    (line) => lines.push(line),
    async () =>
      new Response('{}', {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
  );

  await loggedFetch('https://chatgpt.com/backend-api/upload', {
    body: new Uint8Array([1, 2, 3]),
    method: 'POST',
  });

  assert.deepEqual(lines, [
    '[https] POST https://chatgpt.com/backend-api/upload',
    '[https-body] <non-text body>',
  ]);
});

Deno.test('standalone base logger closer handles present and missing close hooks', async () => {
  let closed = false;
  await __standaloneCLITestables.closeStandaloneBaseLogger({
    append() {},
    close() {
      closed = true;
    },
  });
  assert.equal(closed, true);

  await __standaloneCLITestables.closeStandaloneBaseLogger({
    append() {},
  });
});
