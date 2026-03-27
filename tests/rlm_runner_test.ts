import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createDefaultExecutionBackend } from '../src/execution_backend.ts';
import { loadJournal } from '../src/jsonl_journal.ts';
import type { LLMCaller, LLMCallerRequest, LLMCallerResponse } from '../src/llm_adapter.ts';
import {
  __rlmRunnerTestables,
  RLMMaxStepsError,
  RLMProtocolError,
  runOpenAIRLM,
  runRLM,
} from '../src/rlm_runner.ts';
import type { ExecutionBackend, PersistentRuntimeLike } from '../src/types.ts';

function createClock(start = Date.parse('2026-03-24T00:00:00.000Z')): () => Date {
  let current = start;
  return () => {
    const value = new Date(current);
    current += 1_000;
    return value;
  };
}

function createIdGenerator(prefix = 'rlm'): () => string {
  let current = 0;
  return () => `${prefix}-${current++}`;
}

async function createSessionPath(testName: string): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: 'rlm-runner-tests-' });
  return join(root, testName, 'session.jsonl');
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

class TrackingExecutionBackend implements ExecutionBackend {
  readonly runtimes: Array<{ closeCalls: number; runtime: PersistentRuntimeLike }> = [];
  readonly #delegate = createDefaultExecutionBackend();

  createRuntime(
    options: Parameters<ExecutionBackend['createRuntime']>[0],
  ): PersistentRuntimeLike {
    const runtime = this.#delegate.createRuntime(options);
    const tracked = {
      closeCalls: 0,
      runtime,
    };
    this.runtimes.push(tracked);

    return {
      close: async () => {
        tracked.closeCalls += 1;
        await runtime.close?.();
      },
      execute: runtime.execute.bind(runtime),
    };
  }
}

Deno.test('runner executes a repl turn and returns the final answer captured inside the session', async () => {
  const llm = new MockCaller([
    {
      outputText: '```repl\nconst answer = 6 * 7;\nFINAL_VAR(answer);\n```',
      turnState: { conversation: 'root-1' },
    },
  ]);

  const journalPath = await createSessionPath('single-turn');
  const result = await runRLM({
    llm,
    clock: createClock(),
    context: { source: 'unit-test' },
    idGenerator: createIdGenerator(),
    journalPath,
    maxSteps: 3,
    maxSubcallDepth: 2,
    outputCharLimit: 120,
    prompt: 'Compute 6 * 7.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, '42');
  assert.equal(result.steps, 1);
  assert.equal(result.session.history.length, 1);
  assert.equal(llm.requests[0]?.model, 'gpt-5-nano');
  assert.equal(llm.requests[0]?.kind, 'root_turn');
  assert.equal('responseId' in result, false);
});

Deno.test('runner keeps provider turnState opaque and forwards it across root turns', async () => {
  const llm = new MockCaller([
    {
      outputText: '```repl\nconst subtotal = 40 + 2;\nsubtotal\n```',
      turnState: { opaque: 'root-1' },
    },
    {
      outputText: '```repl\nFINAL_VAR(subtotal + 8);\n```',
      turnState: { opaque: 'root-2' },
    },
  ]);

  const result = await runRLM({
    llm,
    clock: createClock(),
    context: null,
    idGenerator: createIdGenerator(),
    maxSteps: 3,
    maxSubcallDepth: 1,
    outputCharLimit: 120,
    prompt: 'Add eight after the first computation.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, '50');
  assert.match(llm.requests[0]?.input ?? '', /Step budget: 1 \/ 3/u);
  assert.match(llm.requests[1]?.input ?? '', /Step budget: 2 \/ 3/u);
  assert.equal(llm.requests[0]?.turnState, undefined);
  assert.deepEqual(llm.requests[1]?.turnState, { opaque: 'root-1' });
});

Deno.test('runner helper utilities cover limit resolution, final acceptance, and abort handling', () => {
  assert.equal(__rlmRunnerTestables.resolveRunLimit(undefined, 12), 12);
  assert.equal(__rlmRunnerTestables.resolveRunLimit(5, 12), 5);
  assert.equal(__rlmRunnerTestables.resolveProviderAwareCellTimeoutMs(undefined, 30_000), 35_000);
  assert.equal(__rlmRunnerTestables.resolveProviderAwareCellTimeoutMs(undefined, 4_000), 9_000);
  assert.equal(__rlmRunnerTestables.resolveProviderAwareCellTimeoutMs(45_000, 30_000), 75_000);
  assert.equal(
    __rlmRunnerTestables.resolveProviderAwareCellTimeoutMs(undefined, 30_000, 7_000),
    37_000,
  );
  assert.equal(__rlmRunnerTestables.resolveControllerRole(undefined), 'root');
  assert.equal(__rlmRunnerTestables.resolveControllerRole(0), 'root');
  assert.equal(__rlmRunnerTestables.resolveControllerRole(1), 'child');
  assert.throws(
    () => __rlmRunnerTestables.resolveRLMCaller(undefined, undefined),
    /llm caller or legacy adapter/u,
  );

  assert.equal(__rlmRunnerTestables.shouldAcceptExecutionFinalAnswer('success', '42'), true);
  assert.equal(__rlmRunnerTestables.shouldAcceptExecutionFinalAnswer('success', null), false);
  assert.equal(__rlmRunnerTestables.shouldAcceptExecutionFinalAnswer('error', '42'), false);
  assert.equal(
    __rlmRunnerTestables.shouldAcceptExecutionFinalAnswer('success', 'undefined'),
    false,
  );

  assert.equal(__rlmRunnerTestables.extractFinalJsonValue(undefined), null);
  assert.equal(__rlmRunnerTestables.extractFinalJsonValue(null), null);
  assert.equal(
    __rlmRunnerTestables.extractFinalJsonValue({ kind: 'string', preview: '42' }),
    null,
  );
  assert.equal(
    __rlmRunnerTestables.extractFinalJsonValue({ json: '42', kind: 'string', preview: '42' }),
    '42',
  );
  assert.equal(
    __rlmRunnerTestables.resolveSubqueryAnswerValue({ answer: '42', finalValue: null }),
    '42',
  );
  assert.equal(
    __rlmRunnerTestables.resolveSubqueryAnswerValue({ answer: '42', finalValue: '43' }),
    '43',
  );
  assert.equal(
    __rlmRunnerTestables.resolveOpenAIRunLogger(undefined, undefined),
    undefined,
  );

  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => __rlmRunnerTestables.throwIfAborted(controller.signal),
    /RLM execution was aborted/u,
  );
  assert.doesNotThrow(() => __rlmRunnerTestables.throwIfAborted(undefined));
});

Deno.test('runner resolves an explicit journal path into a logger when OpenAI convenience runs omit a logger', async () => {
  const journalPath = await createSessionPath('openai-convenience-logger');
  const logger = __rlmRunnerTestables.resolveOpenAIRunLogger(undefined, journalPath);

  assert.ok(logger !== undefined);
  assert.equal('path' in logger, true);
  assert.equal((logger as { path?: string }).path, journalPath);
});

Deno.test('runner feeds execution feedback into the next model turn so later code can build on it', async () => {
  const adapter = new MockCaller([
    {
      outputText: '```repl\nconst subtotal = 40 + 2;\nsubtotal\n```',
      turnState: 'resp_root_1',
    },
    {
      outputText: '```repl\nFINAL_VAR(subtotal + 8);\n```',
      turnState: 'resp_root_2',
    },
  ]);

  const journalPath = await createSessionPath('multi-turn');
  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: null,
    idGenerator: createIdGenerator(),
    journalPath,
    maxSteps: 3,
    maxSubcallDepth: 2,
    outputCharLimit: 120,
    prompt: 'Add eight after the first computation.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, '50');
  assert.match(adapter.requests[1]?.input ?? '', /42/u);
  assert.match(adapter.requests[1]?.input ?? '', /success/u);
});

Deno.test('runner carries exact nested result signals into the next turn so root can see propagated leaf values', async () => {
  const adapter = new MockCaller([
    {
      outputText:
        '```repl\n({ operatorId: "op-7", routing: { lockerId: "locker-9", accessCode: "7318452", missingLockerId: undefined } })\n```',
      turnState: 'resp_root_1',
    },
    {
      outputText: '```repl\nFINAL_VAR("done");\n```',
      turnState: 'resp_root_2',
    },
  ]);

  const journalPath = await createSessionPath('signal-propagation');
  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: { source: 'signal-test' },
    idGenerator: createIdGenerator(),
    journalPath,
    maxSteps: 3,
    maxSubcallDepth: 2,
    outputCharLimit: 240,
    prompt: 'Inspect the propagated result signals.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, 'done');
  assert.match(adapter.requests[1]?.input ?? '', /\$\.operatorId \(string\): op-7/u);
  assert.match(adapter.requests[1]?.input ?? '', /\$\.routing\.lockerId \(string\): locker-9/u);
  assert.match(adapter.requests[1]?.input ?? '', /\$\.routing\.accessCode \(string\): 7318452/u);
  assert.match(
    adapter.requests[1]?.input ?? '',
    /\$\.routing\.missingLockerId \(undefined\): undefined/u,
  );
});

Deno.test('runner routes llm_query through the sub-model as a plain completion without spawning a nested RLM journal', async () => {
  const adapter = new MockCaller([
    {
      outputText:
        '```repl\nconst nested = await llm_query("Compute 6 * 7.");\nFINAL_VAR(nested.trim());\n```',
      turnState: 'resp_root_1',
    },
    {
      outputText: '42',
      turnState: 'resp_sub_1',
    },
  ]);

  const journalPath = await createSessionPath('plain-llm-query');
  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: { source: 'nested-test' },
    idGenerator: createIdGenerator(),
    journalPath,
    maxSteps: 4,
    maxSubcallDepth: 2,
    outputCharLimit: 120,
    prompt: 'Use llm_query to solve the task.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, '42');
  assert.deepEqual(
    adapter.requests.map((request) => request.model),
    ['gpt-5-nano', 'gpt-5-mini'],
  );
  assert.match(adapter.requests[0]?.systemPrompt ?? '', /root controller/u);
  assert.match(adapter.requests[1]?.systemPrompt ?? '', /plain language model subcall/u);
  assert.doesNotMatch(adapter.requests[1]?.systemPrompt ?? '', /focused child controller/u);

  const journalText = await Deno.readTextFile(journalPath);
  assert.match(journalText, /"type":"assistant_turn"/u);
  assert.doesNotMatch(journalText, /"type":"subquery"/u);
});

Deno.test('runner retries once with a protocol recovery hint when the model returns no repl block', async () => {
  const adapter = new MockCaller([
    {
      outputText: '',
      turnState: 'resp_root_invalid',
    },
    {
      outputText: '```repl\nFINAL_VAR("42");\n```',
      turnState: 'resp_root_recovered',
    },
  ]);

  const journalPath = await createSessionPath('protocol-recovery');
  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: { source: 'protocol-recovery' },
    idGenerator: createIdGenerator(),
    journalPath,
    maxSteps: 2,
    maxSubcallDepth: 2,
    outputCharLimit: 120,
    prompt: 'Solve the task.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, '42');
  assert.equal(adapter.requests.length, 2);
  assert.match(adapter.requests[1]?.input ?? '', /Protocol recovery/u);
  assert.match(adapter.requests[1]?.input ?? '', /Respond with one or more ```repl blocks/u);
});

Deno.test('runner surfaces delegated contract mismatches into the next turn so root can retry with a narrower contract', async () => {
  const adapter = new MockCaller([
    {
      outputText:
        '```repl\nconst child = await rlm_query({ task: "Return an object containing vaultKey and approvalCount.", payload: [{ vaultKey: "V-554" }], expect: { vaultKey: "string", approvalCount: "number" } });\nFINAL_VAR(child.vaultKey);\n```',
      turnState: 'resp_root_1',
    },
    {
      outputText: '```repl\nFINAL_VAR("V-554");\n```',
      turnState: 'resp_sub_1',
    },
    {
      outputText:
        '```repl\nconst child = await rlm_query({ task: "Return only the vaultKey string.", payload: [{ vaultKey: "V-554" }], expect: "string" });\nFINAL_VAR(child);\n```',
      turnState: 'resp_root_2',
    },
    {
      outputText: '```repl\nFINAL_VAR("V-554");\n```',
      turnState: 'resp_sub_2',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: { source: 'contract-recovery' },
    idGenerator: createIdGenerator(),
    maxSteps: 4,
    maxSubcallDepth: 2,
    outputCharLimit: 160,
    prompt: 'Use one delegated call to return the vault key object.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, 'V-554');
  assert.match(adapter.requests[2]?.input ?? '', /Delegated contract recovery is active/u);
  assert.match(
    adapter.requests[2]?.input ?? '',
    /Rewrite the next `rlm_query` call with a concrete `expect` contract/u,
  );
});

Deno.test('runner routes rlm_query through the sub-model and records the nested subquery in the journal', async () => {
  const adapter = new MockCaller([
    {
      outputText:
        '```repl\nconst nested = await rlm_query("Compute 6 * 7.");\nFINAL_VAR(nested);\n```',
      turnState: 'resp_root_1',
    },
    {
      outputText: '```repl\nFINAL_VAR("42");\n```',
      turnState: 'resp_sub_1',
    },
  ]);

  const journalPath = await createSessionPath('nested-rlm-query');
  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: { source: 'nested-test' },
    idGenerator: createIdGenerator(),
    journalPath,
    maxSteps: 4,
    maxSubcallDepth: 2,
    outputCharLimit: 120,
    prompt: 'Use rlm_query to solve the task.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, '42');
  assert.deepEqual(
    adapter.requests.map((request) => request.model),
    ['gpt-5-nano', 'gpt-5-mini'],
  );
  assert.match(adapter.requests[0]?.systemPrompt ?? '', /root controller/u);
  assert.match(adapter.requests[1]?.systemPrompt ?? '', /focused child controller/u);
  assert.match(
    adapter.requests[1]?.systemPrompt ?? '',
    /This child run is terminal for recursion/u,
  );
  assert.match(adapter.requests[1]?.input ?? '', /Task:\nCompute 6 \* 7\./u);

  const journalText = await Deno.readTextFile(journalPath);
  assert.match(journalText, /"type":"subquery"/u);
  const childJournalPath = journalText.match(/"journalPath":"([^"]+)"/u)?.[1];
  assert.ok(childJournalPath !== undefined);
  const childJournalText = await Deno.readTextFile(childJournalPath);
  assert.match(childJournalText, /"type":"rlm_delegated_task"/u);
  assert.match(childJournalText, /"task":"Compute 6 \* 7\."/u);
});

Deno.test('runner closes nested child sessions after rlm_query returns so only the root session remains live', async () => {
  const adapter = new MockCaller([
    {
      outputText:
        '```repl\nconst nested = await rlm_query("Compute 6 * 7.");\nFINAL_VAR(nested);\n```',
      turnState: 'resp_root_1',
    },
    {
      outputText: '```repl\nFINAL_VAR("42");\n```',
      turnState: 'resp_sub_1',
    },
  ]);
  const executionBackend = new TrackingExecutionBackend();

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: { source: 'nested-close-test' },
    executionBackend,
    idGenerator: createIdGenerator(),
    maxSteps: 4,
    maxSubcallDepth: 2,
    outputCharLimit: 120,
    prompt: 'Use rlm_query to solve the task.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, '42');
  assert.equal(executionBackend.runtimes.length, 2);
  assert.equal(executionBackend.runtimes[0]?.closeCalls, 0);
  assert.equal(executionBackend.runtimes[1]?.closeCalls, 1);

  await result.session.close();
  assert.equal(executionBackend.runtimes[0]?.closeCalls, 1);
  assert.equal(executionBackend.runtimes[1]?.closeCalls, 1);
});

Deno.test('runner appends a custom system prompt extension to both root and child model calls', async () => {
  const adapter = new MockCaller([
    {
      outputText:
        '```repl\nconst nested = await rlm_query("Compute 6 * 7.");\nFINAL_VAR(nested);\n```',
      turnState: 'resp_root_1',
    },
    {
      outputText: '```repl\nFINAL_VAR("42");\n```',
      turnState: 'resp_sub_1',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: { source: 'system-prompt-extension' },
    idGenerator: createIdGenerator(),
    maxSteps: 4,
    maxSubcallDepth: 2,
    outputCharLimit: 120,
    prompt: 'Use rlm_query to solve the task.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
    systemPromptExtension:
      'Read `context.inputFilePath` and honor the external system prompt file.',
  });

  assert.equal(result.answer, '42');
  assert.match(
    adapter.requests[0]?.systemPrompt ?? '',
    /Read `context\.inputFilePath` and honor the external system prompt file\./u,
  );
  assert.match(
    adapter.requests[1]?.systemPrompt ?? '',
    /Read `context\.inputFilePath` and honor the external system prompt file\./u,
  );
});

Deno.test('runner lets root inspect structured values returned by rlm_query before extracting a field', async () => {
  const adapter = new MockCaller([
    {
      outputText:
        '```repl\nconst nested = await rlm_query(JSON.stringify({ targetProfile: "orion", candidates: [{ profile: "orion", vaultKey: "V-554" }] }));\nFINAL_VAR(nested.vaultKey);\n```',
      turnState: 'resp_root_1',
    },
    {
      outputText: '```repl\nFINAL_VAR({ vaultKey: "V-554", profile: "orion" });\n```',
      turnState: 'resp_sub_1',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: { source: 'nested-object' },
    idGenerator: createIdGenerator(),
    maxSteps: 4,
    maxSubcallDepth: 2,
    outputCharLimit: 160,
    prompt: 'Use rlm_query and inspect the returned object.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, 'V-554');
});

Deno.test('runner aggregates usage across root plain llm_query calls and nested rlm_query completions', async () => {
  const adapter = new MockCaller([
    {
      outputText:
        '```repl\nconst plain = await llm_query("Compute 6 * 7.");\nconst nested = await rlm_query("Return the same value again.");\nFINAL_VAR(String(Number(plain) + Number(nested)));\n```',
      turnState: 'resp_root_1',
      usage: {
        cachedInputTokens: 2,
        inputTokens: 20,
        outputTokens: 8,
        totalTokens: 28,
      },
    },
    {
      outputText: '42',
      turnState: 'resp_plain_1',
      usage: {
        inputTokens: 9,
        outputTokens: 4,
        totalTokens: 13,
      },
    },
    {
      outputText: '```repl\nFINAL_VAR("42");\n```',
      turnState: 'resp_sub_1',
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
      },
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: { source: 'usage-test' },
    idGenerator: createIdGenerator(),
    maxSteps: 4,
    maxSubcallDepth: 2,
    outputCharLimit: 120,
    prompt: 'Use both llm_query and rlm_query to solve the task.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, '84');
  assert.deepEqual(result.usage, {
    byModel: [
      {
        cachedInputTokens: 2,
        inputTokens: 20,
        model: 'gpt-5-nano',
        outputTokens: 8,
        reportedRequests: 1,
        requests: 1,
        totalTokens: 28,
      },
      {
        cachedInputTokens: 0,
        inputTokens: 16,
        model: 'gpt-5-mini',
        outputTokens: 7,
        reportedRequests: 2,
        requests: 2,
        totalTokens: 23,
      },
    ],
    cachedInputTokens: 2,
    inputTokens: 36,
    outputTokens: 15,
    reportedRequests: 3,
    requests: 3,
    totalTokens: 51,
  });
});

Deno.test('runner ignores FINAL_VAR values from a cell that later errors and asks for another turn', async () => {
  const adapter = new MockCaller([
    {
      outputText: '```repl\nFINAL_VAR("wrong");\nthrow new Error("boom");\n```',
      turnState: 'resp_root_1',
    },
    {
      outputText: '```repl\nFINAL_VAR("fixed");\n```',
      turnState: 'resp_root_2',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: { source: 'error-after-final' },
    idGenerator: createIdGenerator(),
    maxSteps: 3,
    maxSubcallDepth: 1,
    outputCharLimit: 200,
    prompt: 'Recover from the failed execution and return the repaired answer.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, 'fixed');
  assert.equal(result.steps, 2);
  assert.match(adapter.requests[1]?.input ?? '', /Error: boom/u);
  assert.match(adapter.requests[1]?.input ?? '', /status: error/u);
});

Deno.test('runner ignores FINAL_VAR(undefined) and asks the model to keep working', async () => {
  const adapter = new MockCaller([
    {
      outputText: '```repl\nconst answer = undefined;\nFINAL_VAR(answer);\n```',
      turnState: 'resp_root_1',
    },
    {
      outputText: '```repl\nFINAL_VAR("42");\n```',
      turnState: 'resp_root_2',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: { source: 'undefined-final' },
    idGenerator: createIdGenerator(),
    maxSteps: 3,
    maxSubcallDepth: 1,
    outputCharLimit: 200,
    prompt: 'Return a valid final answer and never finish with undefined.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, '42');
  assert.equal(result.steps, 2);
  assert.match(adapter.requests[1]?.input ?? '', /final: undefined/u);
});

Deno.test('runner stops executing later repl blocks in the same assistant turn after a failed block', async () => {
  const adapter = new MockCaller([
    {
      outputText: [
        '```repl',
        'throw new Error("boom");',
        '```',
        '',
        '```repl',
        'FINAL_VAR("wrong");',
        '```',
      ].join('\n'),
      turnState: 'resp_root_1',
    },
    {
      outputText: '```repl\nFINAL_VAR("fixed");\n```',
      turnState: 'resp_root_2',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: { source: 'turn-failure-short-circuit' },
    idGenerator: createIdGenerator(),
    maxSteps: 3,
    maxSubcallDepth: 1,
    outputCharLimit: 200,
    prompt: 'Recover after the first block fails and do not run the trailing block.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, 'fixed');
  assert.equal(result.session.history.length, 2);
  assert.equal(result.session.history[0]?.status, 'error');
  assert.match(result.session.history[0]?.stderr ?? '', /boom/u);
  assert.equal(result.session.history[1]?.status, 'success');
  assert.equal(result.session.history[1]?.finalAnswer, 'fixed');
});

Deno.test('runner accepts explicit FINAL text when the assistant finishes without a repl block', async () => {
  const adapter = new MockCaller([
    {
      outputText: 'FINAL("done")',
      turnState: 'resp_root_1',
    },
  ]);

  const journalPath = await createSessionPath('final-fallback');
  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: null,
    idGenerator: createIdGenerator(),
    journalPath,
    maxSteps: 2,
    maxSubcallDepth: 1,
    outputCharLimit: 120,
    prompt: 'Finish immediately.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, '"done"');
});

Deno.test('runner raises a protocol error when the assistant never emits repl code or a final signal', async () => {
  const adapter = new MockCaller([
    {
      outputText: 'I think the answer is probably 42.',
      turnState: 'resp_root_1',
    },
    {
      outputText: 'Still just prose.',
      turnState: 'resp_root_2',
    },
    {
      outputText: '',
      turnState: 'resp_root_3',
    },
  ]);

  const journalPath = await createSessionPath('protocol-error');

  await assert.rejects(
    async () => {
      await runRLM({
        adapter,
        clock: createClock(),
        context: null,
        idGenerator: createIdGenerator(),
        journalPath,
        maxSteps: 2,
        maxSubcallDepth: 2,
        outputCharLimit: 120,
        prompt: 'Solve the task.',
        rootModel: 'gpt-5-nano',
        subModel: 'gpt-5-mini',
      });
    },
    RLMProtocolError,
  );
});

Deno.test('runner raises a max-steps error when no turn reaches FINAL within the budget', async () => {
  const adapter = new MockCaller([
    {
      outputText: '```repl\nconst subtotal = 40 + 2;\n```',
      turnState: 'resp_root_1',
    },
  ]);

  const journalPath = await createSessionPath('max-steps');

  await assert.rejects(
    async () => {
      await runRLM({
        adapter,
        clock: createClock(),
        context: null,
        idGenerator: createIdGenerator(),
        journalPath,
        maxSteps: 1,
        maxSubcallDepth: 2,
        outputCharLimit: 120,
        prompt: 'Solve the task.',
        rootModel: 'gpt-5-nano',
        subModel: 'gpt-5-mini',
      });
    },
    RLMMaxStepsError,
  );
});

Deno.test('runner journaling stays backward-compatible with the existing session loader', async () => {
  const adapter = new MockCaller([
    {
      outputText: '```repl\nFINAL_VAR("ok");\n```',
      turnState: 'resp_root_1',
    },
  ]);

  const journalPath = await createSessionPath('compat');
  await runRLM({
    adapter,
    clock: createClock(),
    context: null,
    idGenerator: createIdGenerator(),
    journalPath,
    maxSteps: 1,
    maxSubcallDepth: 1,
    outputCharLimit: 120,
    prompt: 'Finish immediately.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  const journal = await loadJournal(journalPath);
  assert.equal(journal.session?.type, 'session');
  assert.equal(journal.cells.length, 1);
});

Deno.test('runOpenAIRLM boots the OpenAI adapter from env-backed config without touching live network', async () => {
  const tempDir = await Deno.makeTempDir({ prefix: 'rlm-openai-env-' });
  const previousCwd = Deno.cwd();

  try {
    await Deno.writeTextFile(
      join(tempDir, '.env'),
      [
        'OPENAI_API_KEY=sk-test',
        'RLM_OPENAI_ROOT_MODEL=gpt-5-nano',
        'RLM_OPENAI_SUB_MODEL=gpt-5-mini',
        'RLM_CELL_TIMEOUT_MS=2222',
        'RLM_REQUEST_TIMEOUT_MS=54321',
        'RLM_MAX_STEPS=2',
        'RLM_MAX_SUBCALL_DEPTH=1',
        'RLM_MAX_OUTPUT_CHARS=120',
      ].join('\n'),
    );
    Deno.chdir(tempDir);

    const journalPath = join(tempDir, 'openai', 'session.jsonl');
    const result = await runOpenAIRLM({
      context: null,
      fetcher: async () =>
        new Response(
          JSON.stringify({
            id: 'resp_openai_1',
            output_text: '```repl\nFINAL_VAR("ok")\n```',
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          },
        ),
      journalPath,
      prompt: 'Finish immediately.',
    });

    assert.equal(result.answer, 'ok');
    assert.equal(result.session.session.defaultTimeoutMs, 56_543);
  } finally {
    Deno.chdir(previousCwd);
  }
});

Deno.test('runOpenAIRLM accepts explicit OpenAI config without loading repository env state', async () => {
  const journalPath = await createSessionPath('run-openai-direct-config');
  const result = await runOpenAIRLM({
    context: null,
    fetcher: async () =>
      new Response(
        JSON.stringify({
          id: 'resp_openai_direct_1',
          output_text: '```repl\nFINAL_VAR("ok")\n```',
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      ),
    journalPath,
    openAI: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 12_345,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    prompt: 'Finish immediately.',
  });

  assert.equal(result.answer, 'ok');
  assert.equal(result.session.session.defaultTimeoutMs, 17_345);
});
