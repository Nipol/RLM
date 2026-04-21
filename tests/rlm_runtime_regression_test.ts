import assert from 'node:assert/strict';

import type { LLMCaller, LLMCallerRequest, LLMCallerResponse } from '../src/llm_adapter.ts';
import { createRLM } from '../src/rlm_runner.ts';
import { InMemoryRLMLogger } from '../src/logger.ts';

function createClock(start = Date.parse('2026-03-24T00:00:00.000Z')): () => Date {
  let current = start;
  return () => {
    const value = new Date(current);
    current += 1_000;
    return value;
  };
}

function createIdGenerator(prefix = 'runtime-regression'): () => string {
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

Deno.test('runtime appends the previous assistant code and execution result into the next root turn input', async () => {
  const llm = new MockCaller([
    {
      outputText:
        '```repl\nconst subtotal = 40 + 2;\nconsole.log({ subtotal });\nFINAL_VAR(undefined);\n```',
      turnState: { opaque: 'root-1' },
    },
    {
      outputText: '```repl\nFINAL_VAR("50");\n```',
      turnState: { opaque: 'root-2' },
    },
  ]);

  const client = createRLM({
    llm,
    clock: createClock(),
    defaults: {
      maxSteps: 3,
      maxSubcallDepth: 1,
      outputCharLimit: 160,
    },
    idGenerator: createIdGenerator(),
    models: {
      root: 'gpt-5-nano',
      sub: 'gpt-5-mini',
    },
  });

  await client.run({
    context: null,
    prompt: 'Add eight after the first computation.',
  });

  assert.doesNotMatch(llm.requests[1]?.input ?? '', /단계 예산/u);
  assert.match(
    llm.requests[1]?.input ?? '',
    /## REPL 목표 :\nAdd eight after the first computation\./u,
  );
  assert.match(llm.requests[1]?.input ?? '', /assistant:\n```repl\nconst subtotal = 40 \+ 2/u);
  assert.match(llm.requests[1]?.input ?? '', /## REPL 코드 실행 결과/u);
  assert.match(llm.requests[1]?.input ?? '', /새로운 사용자 요청이 아닙니다/u);
  assert.match(llm.requests[1]?.input ?? '', /채택된 최종 답: undefined/u);
});

Deno.test('runtime appends evaluator feedback into the next root turn input after logging it', async () => {
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
      outputCharLimit: 160,
    },
    evaluator: {
      enabled: true,
      maxFeedbackChars: 64,
      model: 'gpt-5-evaluator',
    },
    idGenerator: createIdGenerator(),
    logger,
    models: {
      root: 'gpt-5-nano',
      sub: 'gpt-5-mini',
    },
  });

  await client.run({
    context: { document: 'Program Orion entry: status=approved amount=120 reviewer=west.' },
    prompt: 'Extract the approved amount.',
  });

  assert.equal(llm.requests[1]?.kind, 'plain_query');
  assert.equal(llm.requests[2]?.kind, 'root_turn');
  assert.doesNotMatch(llm.requests[2]?.input ?? '', /단계 예산/u);
  assert.match(llm.requests[2]?.input ?? '', /## Evaluator Feedback/u);
  assert.match(llm.requests[2]?.input ?? '', /You surfaced a sample row/u);
  const evaluatorEntry = logger.entries.find((entry) => entry.type === 'evaluator_feedback');
  assert.ok(evaluatorEntry !== undefined);
});
