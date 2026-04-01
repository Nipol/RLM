import assert from 'node:assert/strict';

import { InMemoryRLMLogger } from '../src/index.ts';
import type {
  LLMCaller,
  LLMCallerRequest,
  LLMCallerResponse,
} from '../src/llm_adapter.ts';
import {
  buildLLMQuerySystemPrompt,
  createLLMQueryHandler,
  createRLMQueryHandler,
  createSubqueryJournalPath,
  RLMSubqueryContractError,
  RLMSubqueryDepthError,
  RLMSubqueryResultError,
} from '../src/llm_query.ts';
import { createUsageSummary } from '../src/usage_summary.ts';
import type { JsonValue } from '../src/types.ts';

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

async function flushMicrotasks(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
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

function assertRLMQueryResultEnvelope(
  actual: unknown,
  expectedValue: JsonValue,
  expectedStdout?: string,
): void {
  assert.deepEqual(actual, {
    __rlmQueryResultEnvelope: true,
    stdout: expectedStdout,
    value: expectedValue,
  });
}

Deno.test('llm_query forwards prompts into plain sub-model completions', async () => {
  const llm = new MockCaller([
    {
      outputText: '42',
      turnState: 'plain-turn-1',
      usage: {
        inputTokens: 9,
        outputTokens: 4,
        totalTokens: 13,
      },
    },
  ]);
  const captured: Array<{
    model: string;
    turnState?: unknown;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  }> = [];
  const handler = createLLMQueryHandler({
    llm,
    onComplete: (completion) => {
      captured.push(completion);
    },
    subModel: 'gpt-5-nano',
  });

  const answer = await handler('solve 6 * 7');

  assert.equal(answer, '42');
  assert.equal(llm.requests.length, 1);
  assert.equal(llm.requests[0]?.model, 'gpt-5-nano');
  assert.equal(llm.requests[0]?.kind, 'plain_query');
  assert.deepEqual(llm.requests[0]?.metadata, {
    depth: 0,
    queryIndex: 0,
  });
  assert.equal(llm.requests[0]?.systemPrompt, buildLLMQuerySystemPrompt());
  assert.match(llm.requests[0]?.input ?? '', /solve 6 \* 7/u);
  assert.deepEqual(captured, [
    {
      model: 'gpt-5-nano',
      turnState: 'plain-turn-1',
      usage: {
        inputTokens: 9,
        outputTokens: 4,
        totalTokens: 13,
      },
    },
  ]);
});

Deno.test('llm_query keeps provider turnState opaque and forwards it through completion callbacks', async () => {
  const llm = new MockCaller([
    {
      outputText: 'done',
      turnState: { cursor: 'opaque-1' },
    },
  ]);
  const states: unknown[] = [];
  const handler = createLLMQueryHandler({
    llm,
    onComplete: (completion) => {
      states.push(completion.turnState);
    },
    subModel: 'gpt-5-mini',
  });

  const result = await handler('return done');

  assert.equal(result, 'done');
  assert.deepEqual(states, [{ cursor: 'opaque-1' }]);
});

Deno.test('llm_query can report parent depth and monotonically increasing query indices to the caller', async () => {
  const llm = new MockCaller([
    { outputText: 'first' },
    { outputText: 'second' },
  ]);
  const handler = createLLMQueryHandler({
    currentDepth: 2,
    llm,
    subModel: 'gpt-5-mini',
  });

  await handler('first prompt');
  await handler('second prompt');

  assert.deepEqual(
    llm.requests.map((request) => request.metadata),
    [
      { depth: 2, queryIndex: 0 },
      { depth: 2, queryIndex: 1 },
    ],
  );
});

Deno.test('rlm_query forwards delegated prompts into nested RLM runs with narrowed child context', async () => {
  const childLogger = new InMemoryRLMLogger();
  const calls: Array<Record<string, JsonValue | number | string | null | unknown>> = [];
  const handler = createRLMQueryHandler({
    createChildLogger: () => childLogger,
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async (request) => {
      calls.push({
        context: request.context,
        depth: request.depth,
        logger: request.logger,
        maxSteps: request.maxSteps,
        maxSubcallDepth: request.maxSubcallDepth,
        outputCharLimit: request.outputCharLimit,
        prompt: request.prompt,
        rootModel: request.rootModel,
        subModel: request.subModel,
      });

      return { answer: '42', steps: 2, usage: createUsageSummary(), value: { answer: 42 } };
    },
    subModel: 'gpt-5-nano',
  });

  const answer = await handler('solve 6 * 7');

  assertRLMQueryResultEnvelope(answer, { answer: 42 });
  assert.deepEqual(calls, [
    {
      context: {
        task: 'solve 6 * 7',
        type: 'rlm_delegated_task',
      },
      depth: 1,
      logger: childLogger,
      maxSteps: 9,
      maxSubcallDepth: 3,
      outputCharLimit: 2048,
      prompt: 'solve 6 * 7',
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-nano',
    },
  ]);
});

Deno.test('rlm_query parses JSON delegated prompts into narrowed child payloads', async () => {
  let capturedContext: JsonValue | null = null;
  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async (request) => {
      capturedContext = request.context;
      return { answer: 'ok', steps: 1, usage: createUsageSummary(), value: 'ok' };
    },
    subModel: 'gpt-5-nano',
  });

  const delegatedPrompt = JSON.stringify({
    targetProfile: 'orion',
    candidates: [{ profile: 'orion', vaultKey: 'V-554' }],
  });
  const answer = await handler(delegatedPrompt);

  assertRLMQueryResultEnvelope(answer, 'ok');
  assert.deepEqual(capturedContext, {
    payload: {
      candidates: [{ profile: 'orion', vaultKey: 'V-554' }],
      targetProfile: 'orion',
    },
    task: delegatedPrompt,
    type: 'rlm_delegated_task',
  });
});

Deno.test('rlm_query uses an explicit delegated task field when the narrowed prompt provides one', async () => {
  let capturedContext: JsonValue | null = null;
  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async (request) => {
      capturedContext = request.context;
      return { answer: 'V-554', steps: 1, usage: createUsageSummary(), value: 'V-554' };
    },
    subModel: 'gpt-5-nano',
  });

  const delegatedPrompt = JSON.stringify({
    payload: {
      candidates: [{ profile: 'orion', vaultKey: 'V-554' }],
    },
    task: 'Return only the vaultKey for the active primary dispatch dossier.',
  });
  const answer = await handler(delegatedPrompt);

  assertRLMQueryResultEnvelope(answer, 'V-554');
  assert.deepEqual(capturedContext, {
    payload: {
      candidates: [{ profile: 'orion', vaultKey: 'V-554' }],
    },
    task: 'Return only the vaultKey for the active primary dispatch dossier.',
    type: 'rlm_delegated_task',
  });
});

Deno.test('rlm_query flattens extra top-level delegated keys into the child payload', async () => {
  let capturedContext: JsonValue | null = null;
  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async (request) => {
      capturedContext = request.context;
      return { answer: 'ok', steps: 1, usage: createUsageSummary(), value: 'ok' };
    },
    subModel: 'gpt-5-nano',
  });

  const delegatedPrompt = JSON.stringify({
    constraints: { targetProfile: 'orion' },
    payload: [{ profile: 'orion', vaultKey: 'V-554' }],
    task: 'Return only the matching vaultKey.',
  });

  await handler(delegatedPrompt);

  assert.deepEqual(capturedContext, {
    payload: {
      constraints: { targetProfile: 'orion' },
      payload: [{ profile: 'orion', vaultKey: 'V-554' }],
    },
    task: 'Return only the matching vaultKey.',
    type: 'rlm_delegated_task',
  });
});

Deno.test('rlm_query adds selection hints when narrowed payload rows differ on boolean selector fields', async () => {
  let capturedContext: JsonValue | null = null;
  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async (request) => {
      capturedContext = request.context;
      return { answer: 'ok', steps: 1, usage: createUsageSummary(), value: 'ok' };
    },
    subModel: 'gpt-5-nano',
  });

  await handler({
    payload: [
      { active: false, primaryDispatch: false, profile: 'orion', vaultKey: 'V-101' },
      { active: true, primaryDispatch: true, profile: 'orion', vaultKey: 'V-554' },
    ],
    task: 'Return the matching vaultKey.',
  });

  assert.deepEqual(capturedContext, {
    payload: [
      { active: false, primaryDispatch: false, profile: 'orion', vaultKey: 'V-101' },
      { active: true, primaryDispatch: true, profile: 'orion', vaultKey: 'V-554' },
    ],
    selectionHints: {
      positiveSelectors: ['active', 'primaryDispatch'],
    },
    task: 'Return the matching vaultKey.',
    type: 'rlm_delegated_task',
  });
});

Deno.test('rlm_query accepts direct delegation objects with optional expect contracts', async () => {
  let capturedContext: JsonValue | null = null;
  let capturedPrompt: string | null = null;
  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async (request) => {
      capturedContext = request.context;
      capturedPrompt = request.prompt;
      return { answer: 'ignored', steps: 1, usage: createUsageSummary(), value: 'V-554' };
    },
    subModel: 'gpt-5-nano',
  });

  const answer = await handler({
    expect: {
      field: 'vaultKey',
      type: 'string',
    },
    payload: {
      candidates: [{ profile: 'orion', vaultKey: 'V-554' }],
      targetProfile: 'orion',
    },
    task:
      'Return only the vaultKey string for the active primary dispatch dossier of profile "orion".',
  });

  assertRLMQueryResultEnvelope(answer, 'V-554');
  assert.equal(
    capturedPrompt,
    'Return only the vaultKey string for the active primary dispatch dossier of profile "orion".',
  );
  assert.deepEqual(capturedContext, {
    expect: {
      field: 'vaultKey',
      type: 'string',
    },
    payload: {
      candidates: [{ profile: 'orion', vaultKey: 'V-554' }],
      targetProfile: 'orion',
    },
    task:
      'Return only the vaultKey string for the active primary dispatch dossier of profile "orion".',
    type: 'rlm_delegated_task',
  });
});

Deno.test('rlm_query normalizes shorthand object expect contracts before the child run starts', async () => {
  let capturedContext: JsonValue | null = null;
  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async (request) => {
      capturedContext = request.context;
      return {
        answer: 'ignored',
        steps: 1,
        usage: createUsageSummary(),
        value: { vaultKey: 'V-554' },
      };
    },
    subModel: 'gpt-5-nano',
  });

  const answer = await handler({
    expect: { vaultKey: 'string' },
    payload: {
      candidates: [{ profile: 'orion', vaultKey: 'V-554' }],
    },
    task: 'Return the vaultKey object.',
  });

  assertRLMQueryResultEnvelope(answer, { vaultKey: 'V-554' });
  assert.deepEqual(capturedContext, {
    expect: {
      fields: {
        vaultKey: 'string',
      },
      requiredKeys: ['vaultKey'],
      type: 'object',
    },
    payload: {
      candidates: [{ profile: 'orion', vaultKey: 'V-554' }],
    },
    task: 'Return the vaultKey object.',
    type: 'rlm_delegated_task',
  });
});

Deno.test('rlm_query normalizes scalar string expect shorthands into scalar contracts', async () => {
  let capturedContext: JsonValue | null = null;
  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async (request) => {
      capturedContext = request.context;
      return {
        answer: 'ignored',
        steps: 1,
        usage: createUsageSummary(),
        value: 'V-554',
      };
    },
    subModel: 'gpt-5-nano',
  });

  const answer = await handler({
    expect: 'string',
    payload: {
      candidates: [{ profile: 'orion', vaultKey: 'V-554' }],
    },
    task: 'Return only the vaultKey string.',
  });

  assertRLMQueryResultEnvelope(answer, 'V-554');
  assert.deepEqual(capturedContext, {
    expect: {
      type: 'string',
    },
    payload: {
      candidates: [{ profile: 'orion', vaultKey: 'V-554' }],
    },
    task: 'Return only the vaultKey string.',
    type: 'rlm_delegated_task',
  });
});

Deno.test('rlm_query normalizes string field shorthands into field-based scalar contracts', async () => {
  let capturedContext: JsonValue | null = null;
  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async (request) => {
      capturedContext = request.context;
      return {
        answer: 'ignored',
        steps: 1,
        usage: createUsageSummary(),
        value: { vaultKey: 'V-554' },
      };
    },
    subModel: 'gpt-5-nano',
  });

  const answer = await handler({
    expect: 'vaultKey',
    payload: {
      candidates: [{ profile: 'orion', vaultKey: 'V-554' }],
    },
    task: 'Return an object containing vaultKey.',
  });

  assertRLMQueryResultEnvelope(answer, 'V-554');
  assert.deepEqual(capturedContext, {
    expect: {
      field: 'vaultKey',
      type: 'string',
    },
    payload: {
      candidates: [{ profile: 'orion', vaultKey: 'V-554' }],
    },
    task: 'Return an object containing vaultKey.',
    type: 'rlm_delegated_task',
  });
});

Deno.test('rlm_query extracts a scalar field when field-based scalar expect receives an object result', async () => {
  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async () => ({
      answer: 'ignored',
      steps: 1,
      usage: createUsageSummary(),
      value: { vaultKey: 'V-554' },
    }),
    subModel: 'gpt-5-nano',
  });

  const answer = await handler({
    expect: 'vaultKey',
    payload: {
      candidates: [{ profile: 'orion', vaultKey: 'V-554' }],
    },
    task: 'Return the vaultKey field.',
  });

  assertRLMQueryResultEnvelope(answer, 'V-554');
});

Deno.test('rlm_query wraps a scalar value into a single-field object contract when requested', async () => {
  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async () => ({
      answer: 'ignored',
      steps: 1,
      usage: createUsageSummary(),
      value: 'V-554',
    }),
    subModel: 'gpt-5-nano',
  });

  const answer = await handler({
    expect: { vaultKey: 'string' },
    payload: {
      candidates: [{ profile: 'orion', vaultKey: 'V-554' }],
    },
    task: 'Return an object containing vaultKey.',
  });

  assertRLMQueryResultEnvelope(answer, { vaultKey: 'V-554' });
});

Deno.test('rlm_query wraps a scalar number into a single-field object contract when requested', async () => {
  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async () => ({
      answer: 'ignored',
      steps: 1,
      usage: createUsageSummary(),
      value: 3,
    }),
    subModel: 'gpt-5-nano',
  });

  const answer = await handler({
    expect: { index: 'number' },
    payload: {
      candidates: [{ index: 3 }],
    },
    task: 'Return an object containing index.',
  });

  assertRLMQueryResultEnvelope(answer, { index: 3 });
});

Deno.test('rlm_query rejects a delegated selection that ignores positive selector hints', async () => {
  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async () => ({
      answer: 'ignored',
      steps: 1,
      usage: createUsageSummary(),
      value: { vaultKey: 'V-101' },
    }),
    subModel: 'gpt-5-nano',
  });

  await assert.rejects(
    async () =>
      await handler({
        expect: { vaultKey: 'string' },
        payload: [
          { active: false, primaryDispatch: false, profile: 'orion', vaultKey: 'V-101' },
          { active: true, primaryDispatch: true, profile: 'orion', vaultKey: 'V-554' },
        ],
        task: 'Return an object containing vaultKey.',
      }),
    RLMSubqueryContractError,
    'positive selector',
  );
});

Deno.test('rlm_query accepts a delegated selection that matches the hinted positive selector row', async () => {
  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async () => ({
      answer: 'ignored',
      steps: 1,
      usage: createUsageSummary(),
      value: { vaultKey: 'V-554' },
    }),
    subModel: 'gpt-5-nano',
  });

  const answer = await handler({
    expect: { vaultKey: 'string' },
    payload: [
      { active: false, primaryDispatch: false, profile: 'orion', vaultKey: 'V-101' },
      { active: true, primaryDispatch: true, profile: 'orion', vaultKey: 'V-554' },
    ],
    task: 'Return an object containing vaultKey.',
  });

  assertRLMQueryResultEnvelope(answer, { vaultKey: 'V-554' });
});

Deno.test('rlm_query rejects child values that violate scalar expect contracts', async () => {
  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async () => ({
      answer: '42',
      steps: 1,
      usage: createUsageSummary(),
      value: 42,
    }),
    subModel: 'gpt-5-nano',
  });

  await assert.rejects(
    async () =>
      await handler({
        expect: { type: 'string' },
        payload: { candidate: 42 },
        task: 'Return only the candidate code as a string.',
      }),
    RLMSubqueryContractError,
    'expected string',
  );
});

Deno.test('rlm_query rejects child object values that miss required keys from the expect contract', async () => {
  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async () => ({
      answer: 'ok',
      steps: 1,
      usage: createUsageSummary(),
      value: { label: 'ok' },
    }),
    subModel: 'gpt-5-nano',
  });

  await assert.rejects(
    async () =>
      await handler({
        expect: {
          requiredKeys: ['vaultKey'],
          type: 'object',
        },
        payload: { candidate: { label: 'ok' } },
        task: 'Return an object containing the vaultKey field.',
      }),
    RLMSubqueryContractError,
    'missing required keys',
  );
});

Deno.test('rlm_query rejects invalid shorthand expect contracts before running the child query', async () => {
  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async () => {
      throw new Error('should not run');
    },
    subModel: 'gpt-5-nano',
  });

  await assert.rejects(
    async () =>
      await handler({
        expect: { vaultKey: 'uuid' as never },
        payload: { candidate: { vaultKey: 'V-554' } },
        task: 'Return an object containing vaultKey.',
      }),
    RLMSubqueryContractError,
    'invalid expect contract',
  );
});

Deno.test('llm_query increments child journal paths so sibling subcalls never collide', () => {
  assert.equal(
    createSubqueryJournalPath('/tmp/root/session.jsonl', 2, 0),
    '/tmp/root/session.subquery.d2.q0.jsonl',
  );
  assert.equal(
    createSubqueryJournalPath('/tmp/root/session.jsonl', 2, 1),
    '/tmp/root/session.subquery.d2.q1.jsonl',
  );
  assert.equal(
    createSubqueryJournalPath('/tmp/root/session', 2, 1),
    '/tmp/root/session.subquery.d2.q1',
  );
});

Deno.test('rlm_query stops recursive expansion before it crosses the configured depth cap', async () => {
  const handler = createRLMQueryHandler({
    currentDepth: 3,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async () => {
      throw new Error('should not run');
    },
    subModel: 'gpt-5-nano',
  });

  await assert.rejects(
    async () => await handler('too deep'),
    RLMSubqueryDepthError,
  );
});

Deno.test('rlm_query rejects nested runs that finish without a final answer', async () => {
  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async () => ({
      answer: null,
      steps: 9,
      usage: createUsageSummary(),
      value: null,
    }),
    subModel: 'gpt-5-nano',
  });

  await assert.rejects(
    async () => await handler('missing final'),
    RLMSubqueryResultError,
  );
});

Deno.test('rlm_query defaults the starting depth to zero when the parent run omits it', async () => {
  const calls: number[] = [];
  const handler = createRLMQueryHandler({
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async (request) => {
      calls.push(request.depth);
      return { answer: 'ok', steps: 1, usage: createUsageSummary(), value: 'ok' };
    },
    subModel: 'gpt-5-nano',
  });

  const answer = await handler('start from zero');

  assertRLMQueryResultEnvelope(answer, 'ok');
  assert.deepEqual(calls, [1]);
});

Deno.test('rlm_query serializes sibling nested runs instead of starting them in parallel', async () => {
  const first = createDeferred<{
    answer: string;
    steps: number;
    usage: ReturnType<typeof createUsageSummary>;
    value: string;
  }>();
  const second = createDeferred<{
    answer: string;
    steps: number;
    usage: ReturnType<typeof createUsageSummary>;
    value: string;
  }>();
  const started: string[] = [];
  let callIndex = 0;

  const handler = createRLMQueryHandler({
    currentDepth: 0,
    maxSteps: 9,
    maxSubcallDepth: 3,
    outputCharLimit: 2048,
    runNestedRLM: async (request) => {
      started.push(request.prompt);
      const current = callIndex++;
      if (current === 0) {
        return await first.promise;
      }

      return await second.promise;
    },
    subModel: 'gpt-5-nano',
  });

  const firstAnswerPromise = handler('first prompt');
  const secondAnswerPromise = handler('second prompt');

  await flushMicrotasks(2);
  assert.deepEqual(started, ['first prompt']);

  first.resolve({ answer: 'first', steps: 1, usage: createUsageSummary(), value: 'first' });
  assertRLMQueryResultEnvelope(await firstAnswerPromise, 'first');

  await flushMicrotasks(2);
  assert.deepEqual(started, ['first prompt', 'second prompt']);

  second.resolve({ answer: 'second', steps: 1, usage: createUsageSummary(), value: 'second' });
  assertRLMQueryResultEnvelope(await secondAnswerPromise, 'second');
});
