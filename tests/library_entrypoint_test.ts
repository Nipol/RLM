import assert from 'node:assert/strict';

import type { ExecutionBackend, PersistentRuntimeLike } from '../src/index.ts';
import { createRLM, InMemoryRLMLogger, NullRLMLogger, runRLM } from '../src/index.ts';
import type { LLMCaller, LLMCallerRequest, LLMCallerResponse } from '../src/llm_adapter.ts';
import { createOpenAIRLM } from '../src/providers/openai.ts';
import type { CellEntry } from '../src/types.ts';

function createClock(start = Date.parse('2026-03-24T00:00:00.000Z')): () => Date {
  let current = start;
  return () => {
    const value = new Date(current);
    current += 1_000;
    return value;
  };
}

function createIdGenerator(prefix = 'entry'): () => string {
  let current = 0;
  return () => `${prefix}-${current++}`;
}

class MockCaller implements LLMCaller {
  readonly requests: LLMCallerRequest[] = [];
  readonly #responses: LLMCallerResponse[];

  constructor(responses: LLMCallerResponse[]) {
    this.#responses = [...responses];
  }

  async complete(request: LLMCallerRequest): Promise<LLMCallerResponse> {
    this.requests.push(request);
    const next = this.#responses.shift();
    if (next === undefined) {
      throw new Error('No mock response configured.');
    }

    return next;
  }
}

function createRuntimeResult(overrides: Partial<{
  finalAnswer: string | null;
  result: { kind: 'undefined'; preview: string };
  status: 'error' | 'success';
  stderr: string;
  stdout: string;
}> = {}) {
  return {
    error: null,
    finalAnswer: null,
    result: { kind: 'undefined' as const, preview: 'undefined' },
    status: 'success' as const,
    stderr: '',
    stdout: '',
    ...overrides,
  };
}

Deno.test('createRLM runs without a journal path and uses the default in-memory library flow through llm caller injection', async () => {
  const llm = new MockCaller([
    {
      outputText: '```repl\nconst answer = 6 * 7;\nFINAL_VAR(answer);\n```',
      turnState: { opaque: 'root-1' },
    },
  ]);

  const client = createRLM({
    llm,
    clock: createClock(),
    defaults: {
      maxSteps: 3,
      maxSubcallDepth: 2,
      outputCharLimit: 120,
    },
    idGenerator: createIdGenerator(),
    models: {
      root: 'gpt-5-nano',
      sub: 'gpt-5-mini',
    },
  });

  const result = await client.run({
    context: { source: 'library-entrypoint' },
    prompt: 'Compute 6 * 7.',
  });

  assert.equal(result.answer, '42');
  assert.equal(result.steps, 1);
  assert.equal(result.session.history.length, 1);
  assert.equal(llm.requests[0]?.model, 'gpt-5-nano');
  assert.equal(llm.requests[0]?.kind, 'root_turn');
});

Deno.test('createRLM keeps legacy adapter injection available through a compatibility shim', async () => {
  const adapter = new MockCaller([
    {
      outputText: '```repl\nFINAL_VAR("shimmed");\n```',
      turnState: 'shim-state',
    },
  ]);

  const client = createRLM({
    adapter,
    clock: createClock(),
    defaults: {
      maxSteps: 2,
      maxSubcallDepth: 1,
      outputCharLimit: 120,
    },
    idGenerator: createIdGenerator(),
    models: {
      root: 'gpt-5-nano',
      sub: 'gpt-5-mini',
    },
  });

  const result = await client.run({
    context: null,
    prompt: 'Return shimmed.',
  });

  assert.equal(result.answer, 'shimmed');
  assert.equal(adapter.requests[0]?.kind, 'root_turn');
});

Deno.test('createRLM lets callers override the base system prompt markdown per run', async () => {
  const llm = new MockCaller([
    {
      outputText: '```repl\nFINAL_VAR("ok");\n```',
      turnState: { opaque: 'root-1' },
    },
  ]);

  const client = createRLM({
    llm,
    clock: createClock(),
    idGenerator: createIdGenerator(),
    models: {
      root: 'gpt-5-nano',
      sub: 'gpt-5-mini',
    },
    systemPromptMarkdown: '# 클라이언트 기본 시스템\n기본 프롬프트입니다.',
  });

  const result = await client.run({
    context: null,
    prompt: 'Return ok.',
    systemPromptMarkdown: '# 실행별 시스템\n{{MAX_STEPS_SENTENCE}}\n실행별 프롬프트입니다.',
  });

  assert.equal(result.answer, 'ok');
  assert.match(llm.requests[0]?.systemPrompt ?? '', /^# 실행별 시스템/mu);
  assert.match(llm.requests[0]?.systemPrompt ?? '', /실행별 프롬프트입니다\./u);
});

Deno.test('createRLM appends a client-level system prompt extension when runs do not override it', async () => {
  const llm = new MockCaller([
    {
      outputText: '```repl\nFINAL_VAR("ok");\n```',
      turnState: { opaque: 'root-1' },
    },
  ]);

  const client = createRLM({
    llm,
    clock: createClock(),
    idGenerator: createIdGenerator(),
    models: {
      root: 'gpt-5-nano',
      sub: 'gpt-5-mini',
    },
    systemPromptExtension: 'Always prefer `context.document` when it is present.',
  });

  const result = await client.run({
    context: { document: 'Prompt extension test.' },
    prompt: 'Return ok.',
  });

  assert.equal(result.answer, 'ok');
  assert.match(
    llm.requests[0]?.systemPrompt ?? '',
    /Always prefer `context\.document` when it is present\./u,
  );
});

Deno.test('createRLM lets runs override the client-level system prompt extension', async () => {
  const llm = new MockCaller([
    {
      outputText: '```repl\nFINAL_VAR("ok");\n```',
      turnState: { opaque: 'root-1' },
    },
  ]);

  const client = createRLM({
    llm,
    clock: createClock(),
    idGenerator: createIdGenerator(),
    models: {
      root: 'gpt-5-nano',
      sub: 'gpt-5-mini',
    },
    systemPromptExtension: 'Use the client default extension.',
  });

  const result = await client.run({
    context: null,
    prompt: 'Return ok.',
    systemPromptExtension: 'Use the per-run extension instead.',
  });

  assert.equal(result.answer, 'ok');
  assert.match(llm.requests[0]?.systemPrompt ?? '', /Use the per-run extension instead\./u);
  assert.doesNotMatch(llm.requests[0]?.systemPrompt ?? '', /Use the client default extension\./u);
});

Deno.test('createRLM can request optional evaluator feedback through the same injected caller', async () => {
  const llm = new MockCaller([
    {
      outputText: '```repl\nconst sample = "amount=120";\nconsole.log({ sample });\n```',
      turnState: { opaque: 'root-1' },
    },
    {
      outputText: 'You surfaced a sample row but have not validated the parsed numeric amount yet.',
    },
    {
      outputText: '```repl\nFINAL_VAR("120");\n```',
      turnState: { opaque: 'root-2' },
    },
  ]);
  const logger = new InMemoryRLMLogger();

  const client = createRLM({
    llm,
    clock: createClock(),
    defaults: {
      maxSteps: 3,
      maxSubcallDepth: 1,
      outputCharLimit: 120,
    },
    evaluator: {
      enabled: true,
      maxFeedbackChars: 48,
      model: 'gpt-5-evaluator',
    },
    idGenerator: createIdGenerator(),
    logger,
    models: {
      root: 'gpt-5-nano',
      sub: 'gpt-5-mini',
    },
  });

  const result = await client.run({
    context: { document: 'Program Orion entry: status=approved amount=120 reviewer=west.' },
    prompt: 'Extract the approved amount.',
  });

  assert.equal(result.answer, '120');
  assert.equal(llm.requests.length, 3);
  assert.equal(llm.requests[0]?.kind, 'root_turn');
  assert.equal(llm.requests[0]?.model, 'gpt-5-nano');
  assert.equal(llm.requests[1]?.kind, 'plain_query');
  assert.equal(llm.requests[1]?.model, 'gpt-5-evaluator');
  assert.equal(llm.requests[1]?.metadata?.step, 1);
  assert.equal(llm.requests[2]?.kind, 'root_turn');
  assert.match(llm.requests[2]?.input ?? '', /단계 예산: 2 \/ 3/u);
  assert.doesNotMatch(llm.requests[2]?.input ?? '', /Evaluator feedback:/u);
  assert.doesNotMatch(llm.requests[2]?.input ?? '', /You surfaced a sample row/u);
  const evaluatorEntry = logger.entries.find(
    (entry): entry is {
      createdAt: string;
      feedback: string;
      model: string;
      step: number;
      type: 'evaluator_feedback';
    } => entry.type === 'evaluator_feedback',
  );
  assert.ok(evaluatorEntry !== undefined);
  assert.equal(evaluatorEntry.model, 'gpt-5-evaluator');
  assert.equal(evaluatorEntry.step, 1);
  assert.match(evaluatorEntry.feedback, /You surfaced a sample row/u);
});

Deno.test('runRLM accepts an injected in-memory logger and records the session without filesystem state', async () => {
  const adapter = new MockCaller([
    {
      outputText: '```repl\nFINAL_VAR("ok");\n```',
      turnState: 'root-1',
    },
  ]);
  const logger = new InMemoryRLMLogger();

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: null,
    idGenerator: createIdGenerator(),
    logger,
    maxSteps: 1,
    maxSubcallDepth: 1,
    outputCharLimit: 120,
    prompt: 'Finish immediately.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  const loaded = await logger.load?.();

  assert.equal(result.answer, 'ok');
  assert.equal(loaded?.session?.type, 'session');
  assert.equal(loaded?.cells.length, 1);
  assert.equal(logger.entries.some((entry) => entry.type === 'assistant_turn'), true);
});

Deno.test('runRLM accepts a null logger for fully ephemeral library runs', async () => {
  const adapter = new MockCaller([
    {
      outputText: '```repl\nFINAL_VAR("ephemeral");\n```',
      turnState: 'root-1',
    },
  ]);
  const logger = new NullRLMLogger();

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: null,
    idGenerator: createIdGenerator(),
    logger,
    maxSteps: 1,
    maxSubcallDepth: 1,
    outputCharLimit: 120,
    prompt: 'Finish immediately.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  const loaded = await logger.load?.();

  assert.equal(result.answer, 'ephemeral');
  assert.equal(result.session.history.length, 1);
  assert.deepEqual(loaded, {
    cells: [],
    session: null,
  });
});

Deno.test('runRLM uses an injected execution backend instead of assuming the built-in worker runtime', async () => {
  const adapter = new MockCaller([
    {
      outputText: '```repl\nFINAL_VAR("ignored by mock backend");\n```',
      turnState: 'root-1',
    },
  ]);
  const runtimeCalls: Array<{
    code: string;
    historyLength: number;
    timeoutMs: number;
  }> = [];
  const backendCalls: Array<{
    context: unknown;
    hasLLMQueryHandler: boolean;
  }> = [];

  const backend: ExecutionBackend = {
    createRuntime(options): PersistentRuntimeLike {
      backendCalls.push({
        context: options.context,
        hasLLMQueryHandler: typeof options.llmQueryHandler === 'function',
      });

      return {
        async execute(input: { code: string; history: CellEntry[]; timeoutMs: number }) {
          runtimeCalls.push({
            code: input.code,
            historyLength: input.history.length,
            timeoutMs: input.timeoutMs,
          });

          return createRuntimeResult({
            finalAnswer: '42',
          });
        },
      };
    },
  };

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: { topic: 'backend-injection' },
    executionBackend: backend,
    idGenerator: createIdGenerator(),
    maxSteps: 1,
    maxSubcallDepth: 1,
    outputCharLimit: 120,
    prompt: 'Use the backend.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, '42');
  assert.deepEqual(backendCalls, [
    {
      context: { topic: 'backend-injection' },
      hasLLMQueryHandler: true,
    },
  ]);
  assert.equal(runtimeCalls.length, 1);
  assert.match(runtimeCalls[0]?.code ?? '', /FINAL_VAR/u);
});

Deno.test('createOpenAIRLM builds the OpenAI adapter from explicit arguments instead of requiring env loading', async () => {
  let capturedInit: RequestInit | undefined;
  const client = createOpenAIRLM({
    clock: createClock(),
    defaults: {
      maxSteps: 1,
      maxSubcallDepth: 1,
      outputCharLimit: 120,
    },
    fetcher: async (_input, init) => {
      capturedInit = init;

      return new Response(
        JSON.stringify({
          id: 'resp_openai_1',
          output_text: '```repl\nFINAL_VAR("ok")\n```',
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      );
    },
    idGenerator: createIdGenerator(),
    openAI: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
  });

  const result = await client.run({
    context: null,
    prompt: 'Finish immediately.',
  });

  const payload = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.equal(payload.model, 'gpt-5-nano');
  assert.equal(result.answer, 'ok');
});

Deno.test('createOpenAIRLM forwards a client-level system prompt extension into the provider instructions', async () => {
  let capturedInit: RequestInit | undefined;
  const client = createOpenAIRLM({
    clock: createClock(),
    defaults: {
      maxSteps: 1,
      maxSubcallDepth: 1,
      outputCharLimit: 120,
    },
    fetcher: async (_input, init) => {
      capturedInit = init;

      return new Response(
        JSON.stringify({
          id: 'resp_openai_extension_1',
          output_text: '```repl\nFINAL_VAR("ok")\n```',
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      );
    },
    idGenerator: createIdGenerator(),
    openAI: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    systemPromptExtension: 'Honor browser-specific conversation memory hints.',
  });

  const result = await client.run({
    context: { conversation: [] },
    prompt: 'Finish immediately.',
  });

  const payload = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.equal(result.answer, 'ok');
  assert.match(
    String(payload.instructions ?? ''),
    /Honor browser-specific conversation memory hints\./u,
  );
});

Deno.test('createOpenAIRLM treats cellTimeoutMs overrides as additional time beyond the provider timeout', async () => {
  const client = createOpenAIRLM({
    clock: createClock(),
    defaults: {
      cellTimeoutMs: 7_000,
      maxSteps: 1,
      maxSubcallDepth: 1,
      outputCharLimit: 120,
    },
    fetcher: async () =>
      new Response(
        JSON.stringify({
          id: 'resp_openai_timeout_1',
          output_text: '```repl\nFINAL_VAR("ok")\n```',
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      ),
    idGenerator: createIdGenerator(),
    openAI: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
  });

  const result = await client.run({
    cellTimeoutMs: 11_000,
    context: null,
    prompt: 'Finish immediately.',
  });

  assert.equal(result.answer, 'ok');
  assert.equal(result.session.session.defaultTimeoutMs, 41_000);
});

Deno.test('createRLM falls back to built-in defaults when client defaults are omitted', async () => {
  const adapter = new MockCaller([
    {
      outputText: '```repl\nFINAL_VAR("defaulted")\n```',
      turnState: 'resp_root_default_1',
    },
  ]);

  const client = createRLM({
    adapter,
    clock: createClock(),
    idGenerator: createIdGenerator(),
    models: {
      root: 'gpt-5-nano',
      sub: 'gpt-5-mini',
    },
  });

  const result = await client.run({
    context: null,
    prompt: 'Finish immediately.',
  });

  assert.equal(result.answer, 'defaulted');
  assert.equal(adapter.requests[0]?.model, 'gpt-5-nano');
});
