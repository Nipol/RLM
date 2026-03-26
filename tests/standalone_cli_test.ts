import assert from 'node:assert/strict';
import { join } from 'node:path';

import { InMemoryRLMLogger } from '../src/logger.ts';
import type { AssistantTurnEntry, CellEntry, SessionEntry } from '../src/types.ts';
import {
  __standaloneCLITestables,
  createStandaloneLogPath,
  createStandaloneProgressLogger,
  parseStandaloneCLIArgs,
  renderStandaloneFinalAnswer,
  resolveStandaloneCLIOptions,
  runStandaloneCLI,
} from '../src/standalone/cli.ts';

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
    query: 'Find the answer.',
    systemPromptPath: 'prompts/ebook-system.txt',
  });

  assert.throws(
    () => parseStandaloneCLIArgs(['--input', 'book.txt', '--query', 'missing system prompt']),
    /Missing required CLI flags/u,
  );
  assert.throws(
    () => parseStandaloneCLIArgs(['--input']),
    /Missing value for --input/u,
  );
  assert.throws(
    () => parseStandaloneCLIArgs(['--query']),
    /Missing value for --query/u,
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
    () => parseStandaloneCLIArgs(['--unknown', 'value']),
    /Unknown CLI flag/u,
  );

  assert.deepEqual(
    parseStandaloneCLIArgs([
      '--input',
      'fixtures/book.txt',
      '--query',
      'Find the answer.',
      '--system-prompt',
      'prompts/ebook-system.txt',
      '--log',
      'logs/custom.jsonl',
    ]),
    {
      inputPath: 'fixtures/book.txt',
      logPath: 'logs/custom.jsonl',
      query: 'Find the answer.',
      systemPromptPath: 'prompts/ebook-system.txt',
    },
  );
});

Deno.test('resolveStandaloneCLIOptions makes paths absolute and creates a default standalone log path', () => {
  const resolved = resolveStandaloneCLIOptions(
    {
      inputPath: 'fixtures/book.txt',
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
  assert.equal(resolved.query, 'Find the answer.');
  assert.match(
    resolved.logPath,
    /\/workspace\/rlm\/logs\/standalone\/20260326-112233-456\.jsonl$/u,
  );

  const withExplicitLog = resolveStandaloneCLIOptions(
    {
      inputPath: 'fixtures/book.txt',
      logPath: 'logs/custom.jsonl',
      query: 'Find the answer.',
      systemPromptPath: 'prompts/ebook-system.txt',
    },
    {
      clock: createClock(),
      cwd: '/workspace/rlm',
    },
  );
  assert.equal(withExplicitLog.logPath, '/workspace/rlm/logs/custom.jsonl');
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
  assert.equal(
    __standaloneCLITestables.formatStandaloneFinalSuffix('first line\nsecond line'),
    ' final=<captured>',
  );
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
    responseId: 'resp-1',
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
    '[step 1] cell success final=2',
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
    responseId: 'resp-1',
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
    '[step 1] cell success final=<captured>',
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
      adapter: {
        async complete(request) {
          requests.push({
            input: request.input,
            model: request.model,
            systemPrompt: request.systemPrompt,
          });
          return {
            outputText: '정답은 42입니다.',
            responseId: 'resp-final',
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
      adapter: {
        async complete(request) {
          requests.push({
            input: request.input,
            model: request.model,
            systemPrompt: request.systemPrompt,
          });
          return {
            outputText: ' 최종 답변입니다. \n',
            responseId: 'resp-final',
          };
        },
      },
      rootModel: 'gpt-5.4-mini',
    },
  );

  assert.equal(answer, '최종 답변입니다.');
  assert.match(requests[0]?.input ?? '', /Structured final value:\nnull/u);
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

  const lines: string[] = [];
  const calls: Array<{
    context: unknown;
    logPath: string | undefined;
    prompt: string;
  }> = [];
  const renderCalls: Array<{
    finalValue: unknown;
    inputFilePath: string;
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
    ],
    {
      clock: createClock(),
      cwd: root,
      run: async (options) => {
        calls.push({
          context: options.context,
          logPath: 'path' in (options.logger ?? {})
            ? (options.logger as { path?: string }).path
            : undefined,
          prompt: options.prompt,
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
          responseId: 'resp-1',
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
      context: {
        document: 'Chapter 1\nThe answer is 42.\n',
        inputFilePath: inputPath,
      },
      logPath: join(root, 'logs/standalone/20260326-112233-456.jsonl'),
      prompt: 'What is the answer?',
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
    `[standalone] input: ${inputPath}`,
    `[standalone] system prompt: ${systemPromptPath}`,
    `[standalone] log: ${join(root, 'logs/standalone/20260326-112233-456.jsonl')}`,
    '[session] started',
    '[step 1] assistant turn',
    '[step 1] cell success final=42',
    '[final] 정답은 42입니다.',
  ]);
});

Deno.test('runStandaloneCLI closes the returned session so standalone runs can exit cleanly after FINAL', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-standalone-cli-close-' });
  const inputPath = join(root, 'book.txt');
  const systemPromptPath = join(root, 'ebook-system.txt');
  await Deno.writeTextFile(inputPath, 'Chapter 1\nThe answer is 42.\n');
  await Deno.writeTextFile(systemPromptPath, 'Always answer in concise Korean.');

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

Deno.test('standalone helper resolvers cover injected and default dependencies', async () => {
  const customReadTextFile = async (path: string | URL) => String(path);
  const customRun = async () => ({ answer: '42' });
  const customRender = async () => 'rendered';
  const customWriteLine = (_line: string) => {};

  assert.equal(
    __standaloneCLITestables.resolveStandaloneReadTextFile(customReadTextFile),
    customReadTextFile,
  );
  assert.equal(__standaloneCLITestables.resolveStandaloneRun(customRun), customRun);
  assert.equal(
    __standaloneCLITestables.resolveStandaloneRender({ render: customRender }),
    customRender,
  );
  assert.equal(
    __standaloneCLITestables.resolveStandaloneWriteLine(customWriteLine),
    customWriteLine,
  );

  assert.equal(
    __standaloneCLITestables.resolveStandaloneReadTextFile(undefined),
    Deno.readTextFile,
  );
  assert.equal(typeof __standaloneCLITestables.resolveStandaloneRun(undefined), 'function');
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
