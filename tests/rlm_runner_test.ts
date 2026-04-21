import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createDefaultExecutionBackend } from '../src/execution_backend.ts';
import { loadJournal } from '../src/jsonl_journal.ts';
import type { LLMCaller, LLMCallerRequest, LLMCallerResponse } from '../src/llm_adapter.ts';
import { __openAIProviderTestables, runOpenAIRLM } from '../src/providers/openai.ts';
import {
  __rlmRunnerTestables,
  RLMMaxStepsError,
  RLMProtocolError,
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

Deno.test('runner sends append-only messages across root turns without provider turnState', async () => {
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
  assert.doesNotMatch(llm.requests[0]?.input ?? '', /단계 예산/u);
  assert.doesNotMatch(llm.requests[1]?.input ?? '', /단계 예산/u);
  assert.match(llm.requests[0]?.systemPrompt ?? '', /^# Recursive Language Agent/mu);
  assert.match(llm.requests[1]?.systemPrompt ?? '', /^# Recursive Language Agent/mu);
  assert.equal(llm.requests[0]?.turnState, undefined);
  assert.equal(llm.requests[1]?.turnState, undefined);
  assert.equal(llm.requests[0]?.messages?.length, 1);
  assert.equal(llm.requests[0]?.messages?.[0]?.role, 'user');
  assert.match(llm.requests[0]?.messages?.[0]?.content ?? '', /## REPL 목표 :\nAdd eight/u);
  assert.match(llm.requests[0]?.messages?.[0]?.content ?? '', /## 사용 가능한 런타임 문맥/u);
  assert.equal(llm.requests[1]?.messages?.length, 3);
  assert.equal(llm.requests[1]?.messages?.[0]?.role, 'user');
  assert.equal(llm.requests[1]?.messages?.[1]?.role, 'assistant');
  assert.match(llm.requests[1]?.messages?.[1]?.content ?? '', /const subtotal = 40 \+ 2/u);
  assert.equal(llm.requests[1]?.messages?.[2]?.role, 'user');
  assert.match(llm.requests[1]?.messages?.[2]?.content ?? '', /REPL 코드 실행 결과/u);
  assert.match(llm.requests[1]?.messages?.[2]?.content ?? '', /새로운 사용자 요청이 아닙니다/u);
  assert.match(llm.requests[1]?.messages?.[2]?.content ?? '', /42/u);
});

Deno.test('runner helper utilities cover limit resolution, final acceptance, and abort handling', () => {
  assert.equal(__rlmRunnerTestables.resolveRunLimit(undefined, 12), 12);
  assert.equal(__rlmRunnerTestables.resolveRunLimit(5, 12), 5);
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
  assert.equal(
    __rlmRunnerTestables.shouldAcceptExecutionFinalAnswer('success', 'null', {
      json: null,
      kind: 'null',
      preview: 'null',
    }),
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
    __rlmRunnerTestables.readLatestAcceptedFinalStdout([
      {
        finalAnswer: null,
        status: 'success',
        stdout: 'intermediate\n',
      },
      {
        finalAnswer: '42',
        finalResult: { json: '42', kind: 'string', preview: '42' },
        status: 'success',
        stdout: '{"childExtracted":"42"}\n',
      },
    ]),
    '{"childExtracted":"42"}\n',
  );
  assert.equal(
    __rlmRunnerTestables.readLatestAcceptedFinalStdout([
      {
        finalAnswer: null,
        status: 'success',
        stdout: 'intermediate\n',
      },
    ]),
    '',
  );
  assert.equal(__rlmRunnerTestables.isLikelyMultipleChoiceAnswer('A'), true);
  assert.equal(__rlmRunnerTestables.isLikelyMultipleChoiceAnswer('AA'), false);
  assert.equal(__rlmRunnerTestables.isPlaceholderLikeFinalAnswer('unknown'), true);
  assert.equal(__rlmRunnerTestables.isPlaceholderLikeFinalAnswer('pending'), true);
  assert.equal(__rlmRunnerTestables.isPlaceholderLikeFinalAnswer('42'), false);
  assert.match(
    __rlmRunnerTestables.buildEvaluatorInput({
      assistantText: '```repl\nconst sample = "amount=120";\n```',
      executions: [{
        code: 'const sample = "amount=120";',
        finalAnswer: null,
        resultPreview: '"amount=120"',
        resultSignals: [{ kind: 'string', path: '$', preview: 'amount=120' }],
        status: 'success',
        stderr: '',
        stdout: 'amount=120',
      }],
      prompt: 'Extract the approved amount.',
      step: 1,
      totalSteps: 3,
    }),
    /작업 프롬프트:\nExtract the approved amount\./u,
  );
  assert.equal(
    __rlmRunnerTestables.summarizeWeakFinalization({
      context: { document: 'alpha '.repeat(4_000) },
      execution: {
        code: 'FINAL_VAR("")',
        finalAnswer: '',
        resultPreview: '""',
        stdout: '',
      },
      prompt: 'Return only the decimal digits through FINAL_VAR.',
      role: 'root',
      transcript: [],
    }),
    null,
  );
  assert.deepEqual(
    __rlmRunnerTestables.collectRequestedEntityLabels(
      'Return only the exact stamp identifier through FINAL_VAR.',
      { question: 'Which stamp identifier seals the outgoing manifests?' },
    ),
    ['stamp identifier', 'stamp'],
  );
  assert.deepEqual(
    __rlmRunnerTestables.collectRequestedEntityLabels(
      'Return only the exact dossier name through FINAL_VAR.',
      { question: 'Which dossier name is associated with the alias moon garden?' },
    ),
    ['dossier name', 'dossier'],
  );
  assert.deepEqual(
    __rlmRunnerTestables.extractTargetCandidatesFromEvidence(
      'stamp',
      [
        'Supervisor Niko seals the outgoing manifests with stamp 22-Q.',
        'Supervisor Imani seals the outgoing manifests with stamp 14-B.',
      ].join('\n'),
    ),
    ['22-Q', '14-B'],
  );
  assert.deepEqual(
    __rlmRunnerTestables.extractTargetCandidatesFromEvidence(
      'dossier',
      [
        'Project Atlas moved into dossier Glass Lantern.',
        'Project Selene moved into dossier Silver Fern.',
      ].join('\n'),
    ),
    ['Glass Lantern', 'Silver Fern'],
  );
  assert.deepEqual(
    __rlmRunnerTestables.readCompetingTargetCandidates({
      context: {
        document: 'alpha '.repeat(4_000),
        question:
          'Which stamp identifier seals the outgoing manifests for the courier carrying the cobalt envelope?',
      },
      execution: {
        resultPreview: 'undefined',
        stdout: [
          'Assignment sheet: courier Rowan reports to depot Kestrel while carrying the cobalt envelope.',
          'Supervisor Niko seals the outgoing manifests with stamp 22-Q.',
          'Supervisor Imani seals the outgoing manifests with stamp 14-B.',
        ].join('\n'),
      },
      prompt: 'Return only the exact stamp identifier through FINAL_VAR.',
      transcript: [],
    }),
    {
      candidates: ['22-Q', '14-B'],
      labels: ['stamp identifier', 'stamp'],
    },
  );
  assert.equal(
    __rlmRunnerTestables.usesFirstCandidateFinalWithoutUniquenessGuard(
      'FINAL_VAR(candidates[0] || "");',
    ),
    true,
  );
  assert.equal(
    __rlmRunnerTestables.usesFirstCandidateFinalWithoutUniquenessGuard(
      'const selected = rows.find((row) => row.active) ?? rows[0]; FINAL_VAR(selected);',
    ),
    true,
  );
  assert.equal(
    __rlmRunnerTestables.usesFirstCandidateFinalWithoutUniquenessGuard(
      'if (candidates.length === 1) FINAL_VAR(candidates[0]);',
    ),
    false,
  );
  assert.equal(
    __rlmRunnerTestables.usesMergedWorkingSetProjectionWithoutUniquenessGuard(
      'const joined = rows.map((row) => row.contextText).join("\\n\\n"); const answer = joined.match(/stamp\\s+([A-Z0-9-]+)/)?.[1] ?? ""; FINAL_VAR(answer);',
    ),
    true,
  );
  assert.equal(
    __rlmRunnerTestables.usesMergedWorkingSetProjectionWithoutUniquenessGuard(
      'if (rows.length === 1) { const answer = rows[0]; FINAL_VAR(answer); }',
    ),
    false,
  );
  assert.equal(
    __rlmRunnerTestables.readTruncatedScalarPrefixFromEvidence(
      '731845',
      [
        '{"candidate":"7318452"}',
        'The exact code is 7318452.',
      ].join('\n'),
    ),
    '7318452',
  );
  assert.equal(
    __rlmRunnerTestables.readTruncatedScalarPrefixFromEvidence('abcd', '!!!'),
    null,
  );
  assert.equal(
    __rlmRunnerTestables.summarizeWeakFinalization({
      context: {
        document: 'alpha '.repeat(4_000),
      },
      execution: {
        code: 'const candidates = ["wrong", "right"]; FINAL_VAR(candidates[0] || "");',
        finalAnswer: 'wrong',
        resultPreview: 'undefined',
        stdout: '{"candidateCount":2,"candidates":["wrong","right"]}\n',
      },
      prompt: 'Return only the exact answer through FINAL_VAR.',
      role: 'root',
      transcript: [],
    }),
    null,
  );
  assert.equal(
    __rlmRunnerTestables.summarizeWeakFinalization({
      context: {
        document: 'alpha '.repeat(4_000),
      },
      execution: {
        code: 'FINAL_VAR("unknown");',
        finalAnswer: 'unknown',
        resultPreview: 'undefined',
        stdout: '{"hitCount":3,"sample":["alpha","beta"]}\n',
      },
      prompt: 'Return only the exact answer through FINAL_VAR.',
      role: 'root',
      transcript: [],
    }),
    null,
  );
  assert.equal(
    __rlmRunnerTestables.summarizeWeakFinalization({
      context: {
        document: 'alpha '.repeat(4_000),
        question:
          'Which stamp identifier seals the outgoing manifests for the courier carrying the cobalt envelope?',
      },
      execution: {
        code:
          'const joined = rows.map((row) => row.contextText).join("\\n\\n"); const answer = joined.match(/stamp\\s+([A-Z0-9-]+)/)?.[1] ?? ""; FINAL_VAR(answer);',
        finalAnswer: '22-Q.\n\nHarbor',
        resultPreview: 'undefined',
        stdout: [
          'Assignment sheet: courier Rowan reports to depot Kestrel while carrying the cobalt envelope.',
          'Supervisor Niko seals the outgoing manifests with stamp 22-Q.',
          'Supervisor Imani seals the outgoing manifests with stamp 14-B.',
        ].join('\n'),
      },
      prompt: 'Return only the exact stamp identifier through FINAL_VAR.',
      role: 'root',
      transcript: [],
    }),
    null,
  );
  assert.equal(
    __rlmRunnerTestables.summarizeWeakFinalization({
      context: {
        document: 'alpha '.repeat(4_000),
        retrievalQuestion: 'What is the exact code?',
      },
      execution: {
        code:
          'const answer = doc.match(/Chicago[^\\n]{0,80}?(\\d{2,6})/)?.[1] ?? ""; FINAL_VAR(answer);',
        finalAnswer: '731845',
        resultPreview: 'undefined',
        stdout: '{"candidate":"7318452"}\n',
      },
      prompt: 'Return only the decimal digits through FINAL_VAR.',
      role: 'root',
      transcript: [],
    }),
    null,
  );
  assert.match(
    __rlmRunnerTestables.buildEvaluatorInput({
      assistantText: '```repl\nFINAL_VAR("430");\n```',
      executions: [
        {
          code: 'FINAL_VAR("430");',
          finalAnswer: '430',
          resultPreview: 'undefined',
          resultSignals: [
            {
              kind: 'number',
              path: '$.sum',
              preview: '430',
            },
          ],
          status: 'success',
          stderr: '',
          stdout: '{"sum":430}\n',
        },
      ],
      prompt: 'Sum the approved amounts.',
      step: 2,
      totalSteps: 12,
    }),
    /관찰된 값:\n\$\.sum \(number\): 430/u,
  );
  assert.doesNotMatch(
    __rlmRunnerTestables.buildEvaluatorInput({
      assistantText: '```repl\n42\n```',
      executions: [
        {
          code: '42',
          finalAnswer: null,
          resultPreview: '42',
          status: 'success',
          stderr: '',
          stdout: '',
        },
      ],
      prompt: 'Inspect the scalar.',
      step: 1,
      totalSteps: 3,
    }),
    /단계 예산:/u,
  );
  assert.match(
    __rlmRunnerTestables.buildEvaluatorInput({
      assistantText: '```repl\nFINAL_VAR("ok");\n```',
      executions: [
        {
          code: 'FINAL_VAR("ok");',
          finalAnswer: 'ok',
          resultPreview: '"ok"',
          resultSignals: [
            {
              preview: 'ok',
            },
          ],
          status: 'success',
          stderr: '',
          stdout: '',
        },
      ],
      prompt: 'Return ok.',
      step: 1,
      totalSteps: 3,
    }),
    /관찰된 값:\n\$ \(알 수 없음\): ok/u,
  );
  assert.deepEqual(
    __rlmRunnerTestables.readContextOptions({
      options: {
        A: 'bundle A',
        B: 'bundle B',
      },
    }),
    {
      A: 'bundle A',
      B: 'bundle B',
    },
  );
  assert.deepEqual(
    __rlmRunnerTestables.readAvailableOptions({
      document: [
        'Lecture note: the safe handoff sequence is verify seal, read checksum, archive copy.',
        'Question options: A=read checksum, verify seal, archive copy.',
        'Question options: B=verify seal, read checksum, archive copy.',
      ].join('\n'),
    }),
    {
      A: 'read checksum, verify seal, archive copy',
      B: 'verify seal, read checksum, archive copy',
    },
  );
  assert.equal(
    __rlmRunnerTestables.isLikelyMultipleChoiceTask(
      'Return only the uppercase option letter through FINAL_VAR.',
      null,
    ),
    true,
  );
  assert.equal(
    __rlmRunnerTestables.usesLiteralFinalChoice('FINAL_VAR("A");', 'A'),
    true,
  );
  assert.equal(
    __rlmRunnerTestables.usesLiteralFinalChoice('FINAL_VAR(selectedOption);', 'A'),
    false,
  );
  assert.equal(
    __rlmRunnerTestables.hasSelectedOptionEvidence(
      'B',
      'Return the option letter.',
      { options: { A: 'bundle A', B: 'bundle B' } },
      {
        code: 'const selected = context.options.B; FINAL_VAR(selectedOption);',
        resultPreview: 'undefined',
        stdout: 'matched bundle B in the appendix',
      },
    ),
    true,
  );
  assert.equal(
    __rlmRunnerTestables.hasSelectedOptionEvidence(
      'B',
      'Return the option letter.',
      {
        document: [
          'Lecture note: the safe handoff sequence is verify seal, read checksum, archive copy.',
          'Question options: A=read checksum, verify seal, archive copy.',
          'Question options: B=verify seal, read checksum, archive copy.',
        ].join('\n'),
      },
      {
        code: 'FINAL_VAR("B");',
        resultPreview: 'undefined',
        stdout: 'seq=verify seal, read checksum, archive copy',
      },
    ),
    true,
  );
  assert.deepEqual(
    __rlmRunnerTestables.matchOptionFromEvidence(
      'Return the option letter.',
      {
        document: [
          'Lecture note: the safe handoff sequence is verify seal, read checksum, archive copy.',
          'Question options: A=read checksum, verify seal, archive copy.',
          'Question options: B=verify seal, read checksum, archive copy.',
          'Question options: C=archive copy, verify seal, read checksum.',
        ].join('\n'),
      },
      {
        code: 'FINAL_VAR("C");',
        resultPreview: 'undefined',
        stdout: 'seq=verify seal, read checksum, archive copy',
      },
    ),
    {
      label: 'B',
      text: 'verify seal, read checksum, archive copy',
    },
  );
  assert.equal(
    __rlmRunnerTestables.hasSelectedOptionEvidence(
      'B',
      'Return the option letter.',
      { options: { A: 'bundle A', B: 'bundle B' } },
      {
        code: 'FINAL_VAR("B");',
        resultPreview: 'undefined',
        stdout: '',
      },
    ),
    false,
  );
  assert.equal(
    __rlmRunnerTestables.summarizeWeakFinalization({
      context: {
        document: 'alpha '.repeat(4_000),
        options: { A: 'bundle A', B: 'bundle B' },
      },
      execution: {
        code: 'FINAL_VAR("A");',
        finalAnswer: 'A',
        resultPreview: 'undefined',
        stdout: '',
      },
      prompt: 'Return the uppercase option letter through FINAL_VAR.',
      role: 'root',
      transcript: [],
    }),
    null,
  );
  assert.equal(
    __rlmRunnerTestables.summarizeWeakFinalization({
      context: {
        document: 'alpha '.repeat(4_000),
      },
      execution: {
        code: 'FINAL_VAR("");',
        finalAnswer: '',
        resultPreview: 'undefined',
        stdout: '',
      },
      prompt: 'Return the final answer.',
      role: 'root',
      transcript: [],
    }),
    null,
  );
  assert.equal(
    __rlmRunnerTestables.summarizeWeakFinalization({
      context: {
        document: [
          'alpha '.repeat(4_000),
          'Lecture note: the safe handoff sequence is verify seal, read checksum, archive copy.',
          'Question options: A=read checksum, verify seal, archive copy.',
          'Question options: B=verify seal, read checksum, archive copy.',
          'Question options: C=archive copy, verify seal, read checksum.',
        ].join('\n'),
      },
      execution: {
        code: 'FINAL_VAR("C");',
        finalAnswer: 'C',
        resultPreview: 'undefined',
        stdout: 'seq=verify seal, read checksum, archive copy',
      },
      prompt: 'Return only the uppercase option letter through FINAL_VAR.',
      role: 'root',
      transcript: [],
    }),
    null,
  );
  assert.equal(
    __rlmRunnerTestables.summarizeWeakFinalization({
      context: {
        document: 'alpha '.repeat(4_000),
        options: { A: 'bundle A', B: 'bundle B', C: 'bundle C', D: 'bundle D' },
      },
      execution: {
        code: 'FINAL_VAR("C");',
        finalAnswer: 'C',
        resultPreview: 'undefined',
        stdout: '',
      },
      prompt: 'Return only the uppercase option letter through FINAL_VAR.',
      role: 'root',
      transcript: [{
        executions: [{
          finalAnswer: 'C',
          resultPreview: 'undefined',
          stdout: '',
        }],
      }],
    }),
    null,
  );
  assert.equal(
    __rlmRunnerTestables.summarizeWeakFinalization({
      context: {
        document: 'short',
        options: { A: 'bundle A', B: 'bundle B' },
      },
      execution: {
        code: 'FINAL_VAR("A");',
        finalAnswer: 'A',
        resultPreview: 'undefined',
        stdout: '',
      },
      prompt: 'Return the uppercase option letter through FINAL_VAR.',
      role: 'root',
      transcript: [],
    }),
    null,
  );

  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => __rlmRunnerTestables.throwIfAborted(controller.signal),
    /RLM execution was aborted/u,
  );
  assert.doesNotThrow(() => __rlmRunnerTestables.throwIfAborted(undefined));
});

Deno.test('runner evidence helpers cover null contexts, embedded string documents, transcript matches, and surfaced candidate signals', () => {
  assert.deepEqual(
    __rlmRunnerTestables.collectRequestedEntityLabels(
      'Summarize the ledger.',
      { note: 'irrelevant' } as never,
    ),
    [],
  );
  assert.deepEqual(
    __rlmRunnerTestables.collectRequestedEntityLabels(
      'Return only the exact final requested dossier name through FINAL_VAR.',
      {
        question:
          'Which exact final requested dossier name is assigned to the moon garden initiative?',
      },
    ),
    ['exact final requested dossier name', 'dossier name', 'dossier'],
  );

  assert.equal(__rlmRunnerTestables.readContextOptions(null), null);
  assert.equal(__rlmRunnerTestables.readContextOptions('plain text' as never), null);
  assert.equal(__rlmRunnerTestables.readContextOptions([] as never), null);
  assert.equal(
    __rlmRunnerTestables.readContextOptions({
      options: { A: 1, B: false },
    } as never),
    null,
  );

  assert.deepEqual(
    __rlmRunnerTestables.readAvailableOptions([
      'Question options: A=west route.',
      'Question options: B=east route.',
    ].join('\n') as never),
    {
      A: 'west route',
      B: 'east route',
    },
  );
  assert.equal(__rlmRunnerTestables.readAvailableOptions({ document: 'no options here' }), null);
  assert.equal(__rlmRunnerTestables.readAvailableOptions({ note: 'no document' } as never), null);

  assert.equal(
    __rlmRunnerTestables.matchOptionFromEvidence(
      'Return the multiple-choice option letter.',
      {
        options: {
          A: 'west route',
          B: 'east route',
        },
      },
      {
        resultPreview: 'undefined',
        stdout: 'west route and east route both appear in the notes',
      },
    ),
    null,
  );
  assert.equal(
    __rlmRunnerTestables.matchOptionFromEvidence(
      'Return the multiple-choice option letter.',
      {
        options: {
          A: 'west route',
          B: 'east route',
        },
      },
      {
        resultPreview: 'west route east route',
        stdout: '',
      },
    ),
    null,
  );
  assert.deepEqual(
    __rlmRunnerTestables.matchOptionFromEvidence(
      'Return the multiple-choice option letter.',
      {
        options: {
          A: 'west route',
          B: 'east route',
        },
      },
      {
        resultPreview: 'west route only',
        stdout: '',
      },
    ),
    {
      label: 'A',
      text: 'west route',
    },
  );
  assert.deepEqual(
    __rlmRunnerTestables.matchOptionFromTranscriptEvidence(
      'Return the option letter.',
      {
        options: {
          A: 'bundle A',
          B: 'bundle B',
        },
      },
      [
        {
          executions: [
            {
              resultPreview: 'undefined',
              stdout: 'matched bundle B in the appendix',
            },
          ],
        },
      ],
    ),
    {
      label: 'B',
      text: 'bundle B',
    },
  );
  assert.equal(
    __rlmRunnerTestables.matchOptionFromTranscriptEvidence(
      'Return the option letter.',
      {
        options: {
          A: 'bundle A',
          B: 'bundle B',
        },
      },
      [
        {
          executions: [
            {
              resultPreview: 'bundle A and bundle B were both observed',
              stdout: '',
            },
          ],
        },
      ],
    ),
    null,
  );
  assert.deepEqual(
    __rlmRunnerTestables.matchOptionFromEvidence(
      'Return the option letter.',
      {
        options: {
          A: 'bundle A',
          B: 'bundle B',
        },
      },
      {
        resultPreview: 'undefined',
        resultSignals: [{ preview: 'bundle B' }],
        stdout: '',
      },
    ),
    {
      label: 'B',
      text: 'bundle B',
    },
  );
  assert.equal(
    __rlmRunnerTestables.matchOptionFromTranscriptEvidence(
      'Return the option letter.',
      null,
      [{ executions: [{ resultPreview: 'undefined', stdout: 'bundle B' }] }],
    ),
    null,
  );

  assert.equal(
    __rlmRunnerTestables.hasSelectedOptionEvidence(
      'B',
      'Return the option letter.',
      null,
      {
        resultPreview: 'undefined',
        stdout: 'B) selected after comparing the appendix',
      },
    ),
    true,
  );
  assert.equal(
    __rlmRunnerTestables.hasSelectedOptionEvidence(
      'A',
      'Return the multiple-choice option letter.',
      null,
      {
        resultPreview: 'undefined',
        stdout: 'question options were loaded and optionMatchCount=1',
      },
    ),
    true,
  );

  assert.equal(
    __rlmRunnerTestables.hasPositiveSurfacedCandidateEvidence({
      execution: {
        resultPreview: 'undefined',
        stdout: 'candidateCount=2',
      },
      transcript: [],
    }),
    true,
  );
  assert.equal(
    __rlmRunnerTestables.hasPositiveSurfacedCandidateEvidence({
      execution: {
        resultPreview: 'undefined',
        stdout: '{"sample":["alpha"]}',
      },
      transcript: [],
    }),
    true,
  );
  assert.equal(
    __rlmRunnerTestables.hasPositiveSurfacedCandidateEvidence({
      execution: {
        resultPreview: 'undefined',
        stdout: 'rows: ["alpha", "beta"]',
      },
      transcript: [],
    }),
    true,
  );
  assert.equal(
    __rlmRunnerTestables.hasPositiveSurfacedCandidateEvidence({
      execution: {
        resultPreview: 'undefined',
        stdout: 'nothing surfaced',
      },
      transcript: [],
    }),
    false,
  );

  assert.equal(__rlmRunnerTestables.readLatestTranscriptFinalAnswer([]), null);
  assert.equal(
    __rlmRunnerTestables.readLatestTranscriptFinalAnswer([
      { executions: [{ finalAnswer: null }, { finalAnswer: ' 42 ' }] },
    ]),
    '42',
  );
  assert.equal(
    __rlmRunnerTestables.readLatestTranscriptFinalAnswer([
      { executions: [{ finalAnswer: null }] },
    ]),
    null,
  );

  assert.equal(
    __rlmRunnerTestables.readCompetingTargetCandidates({
      context: { options: { A: 'alpha', B: 'beta' } },
      execution: {
        resultPreview: 'undefined',
        stdout: 'alpha beta',
      },
      prompt: 'Return the multiple-choice option letter.',
      transcript: [],
    }),
    null,
  );
  assert.equal(
    __rlmRunnerTestables.readCompetingTargetCandidates({
      context: { question: 'Which dossier is assigned to the moon garden initiative?' },
      execution: {
        resultPreview: 'undefined',
        stdout: 'Project Selene moved into dossier Silver Fern.',
      },
      prompt: 'Return only the exact dossier name through FINAL_VAR.',
      transcript: [],
    }),
    null,
  );
  assert.equal(__rlmRunnerTestables.readQuestionLikeText(null), null);
  assert.equal(__rlmRunnerTestables.readQuestionLikeText([] as never), null);
  assert.equal(
    __rlmRunnerTestables.readQuestionLikeText({ retrievalQuestion: 'What is the exact code?' }),
    'What is the exact code?',
  );
  assert.deepEqual(
    __rlmRunnerTestables.extractTargetCandidatesFromEvidence('', 'stamp 14-B'),
    [],
  );
  assert.deepEqual(
    __rlmRunnerTestables.extractTargetCandidatesFromEvidence('stamp', ''),
    [],
  );
  assert.deepEqual(
    __rlmRunnerTestables.extractTargetCandidatesFromEvidence(
      'stamp',
      'The stamp is which option should we choose for the question?',
    ),
    [],
  );
  assert.deepEqual(
    __rlmRunnerTestables.extractTargetCandidatesFromEvidence(
      'stamp',
      'The stamp is this phrase is definitely far too long to keep.',
    ),
    [],
  );
  assert.deepEqual(
    __rlmRunnerTestables.extractTargetCandidatesFromEvidence(
      'stamp',
      'stamp = ""\nstamp = 14-B',
    ),
    ['14-B'],
  );
  assert.equal(
    __rlmRunnerTestables.readAvailableOptions({
      document: 'A=,\nB=,',
    }),
    null,
  );
  assert.equal(
    __rlmRunnerTestables.matchOptionFromEvidence(
      'Return the option letter.',
      { options: { A: 'bundle A' } },
      {
        resultPreview: '',
        stdout: '',
      },
    ),
    null,
  );
  assert.equal(
    __rlmRunnerTestables.matchOptionFromTranscriptEvidence(
      'Return the option letter.',
      { options: { A: 'bundle A' } },
      [{ executions: [{ resultPreview: '', stdout: '' }] }],
    ),
    null,
  );
  assert.equal(
    __rlmRunnerTestables.hasSelectedOptionEvidence(
      'B',
      'Return the option letter.',
      { options: { A: 'bundle A', B: 'bundle B' } },
      {
        resultPreview: 'undefined',
        stdout: 'matched bundle B in the appendix without printing the label',
      },
    ),
    true,
  );
  assert.equal(
    __rlmRunnerTestables.hasSelectedOptionEvidence(
      'B',
      'This is a multiple-choice question. Return the option letter only.',
      { options: { A: 'bundle A', B: 'bundle B' } },
      {
        resultPreview: 'undefined',
        stdout: 'question options mention bundle A and bundle B together',
      },
    ),
    true,
  );
  assert.equal(
    __rlmRunnerTestables.finalAnswerRepeatsTargetLabel('stamp: 14-B', ['stamp']),
    true,
  );
  assert.equal(
    __rlmRunnerTestables.finalAnswerRepeatsTargetLabel('14-B', ['stamp']),
    false,
  );
  assert.equal(
    __rlmRunnerTestables.isScalarLikeTask(
      'Return only the exact identifier.',
      { question: 'Which code applies?' },
    ),
    true,
  );
  assert.equal(
    __rlmRunnerTestables.isScalarLikeTask(
      'Explain the policy in detail.',
      { question: 'Describe the document.' },
    ),
    false,
  );
  assert.equal(__rlmRunnerTestables.isScalarLikeTask('Explain generally.', null), false);
  assert.equal(
    __rlmRunnerTestables.isScalarLikeTask(
      'Pick the correct option.',
      { options: { A: 'first route', B: 'second route' } },
    ),
    true,
  );
  assert.equal(
    __rlmRunnerTestables.readTruncatedScalarPrefixFromEvidence('ab', 'abcdef'),
    null,
  );
  assert.equal(
    __rlmRunnerTestables.readTruncatedScalarPrefixFromEvidence('abc def', 'abcdef'),
    null,
  );
  assert.equal(
    __rlmRunnerTestables.readCompetingTargetCandidates({
      context: { note: 'irrelevant' } as never,
      execution: {
        resultPreview: 'undefined',
        stdout: 'nothing useful here',
      },
      prompt: 'Summarize the ledger.',
      transcript: [],
    }),
    null,
  );
  assert.equal(
    __rlmRunnerTestables.usesFirstCandidateFinalWithoutUniquenessGuard(
      'const answer = candidates[1]; FINAL_VAR(answer);',
    ),
    false,
  );
  assert.equal(
    __rlmRunnerTestables.usesMergedWorkingSetProjectionWithoutUniquenessGuard(
      'const joined = rows.join(", "); FINAL_VAR(joined);',
    ),
    false,
  );
  assert.equal(
    __rlmRunnerTestables.clipEvaluatorFeedback('  concise feedback  ', 40),
    'concise feedback',
  );
});

Deno.test('runner evaluator helper returns undefined before calling the evaluator when disabled or empty', async () => {
  let llmCalls = 0;
  const llm: LLMCaller = {
    complete: async () => {
      llmCalls += 1;
      return { outputText: 'unused' };
    },
  };

  assert.equal(
    await __rlmRunnerTestables.generateEvaluatorFeedback({
      assistantText: 'plain answer',
      depth: 0,
      evaluator: { enabled: false, model: 'gpt-5-evaluator' },
      executions: [{
        code: 'FINAL_VAR("ok");',
        finalAnswer: 'ok',
        resultPreview: '"ok"',
        status: 'success',
        stderr: '',
        stdout: '',
      }],
      llm,
      onComplete: () => {},
      prompt: 'Return ok.',
      step: 1,
      totalSteps: 3,
    }),
    undefined,
  );
  assert.equal(
    await __rlmRunnerTestables.generateEvaluatorFeedback({
      assistantText: 'plain answer',
      depth: 0,
      evaluator: { model: 'gpt-5-evaluator' },
      executions: [],
      llm,
      onComplete: () => {},
      prompt: 'Return ok.',
      step: 1,
      totalSteps: 3,
    }),
    undefined,
  );
  assert.equal(llmCalls, 0);

  let evaluatorRequest: LLMCallerRequest | undefined;
  const whitespaceEvaluator: LLMCaller = {
    complete: async (request) => {
      evaluatorRequest = request;
      return { outputText: '   ' };
    },
  };
  const completedModels: string[] = [];

  assert.equal(
    await __rlmRunnerTestables.generateEvaluatorFeedback({
      assistantText: '```repl\nFINAL_VAR("ok");\n```',
      depth: 0,
      evaluator: { enabled: true, model: 'gpt-5-evaluator' },
      executions: [{
        code: 'FINAL_VAR("ok");',
        finalAnswer: 'ok',
        resultPreview: '"ok"',
        status: 'success',
        stderr: '',
        stdout: '',
      }],
      llm: whitespaceEvaluator,
      onComplete: (_response, model) => {
        completedModels.push(model);
      },
      prompt: 'Return ok.',
      step: 1,
      totalSteps: 3,
    }),
    undefined,
  );
  assert.equal(evaluatorRequest?.model, 'gpt-5-evaluator');
  assert.match(evaluatorRequest?.systemPrompt ?? '', /240자 이내/u);
  assert.deepEqual(completedModels, ['gpt-5-evaluator']);
});

Deno.test('runner appends query trace entries when tracing is enabled', async () => {
  const llm = new MockCaller([
    {
      outputText: '```repl\nconst value = await llm_query("Return ok.");\nFINAL_VAR(value);\n```',
      turnState: { conversation: 'root-1' },
    },
    {
      outputText: 'ok',
      turnState: { conversation: 'sub-1' },
    },
  ]);

  const journalPath = await createSessionPath('query-trace');
  await runRLM({
    llm,
    clock: createClock(),
    context: null,
    idGenerator: createIdGenerator(),
    journalPath,
    maxSteps: 2,
    maxSubcallDepth: 1,
    outputCharLimit: 120,
    prompt: 'Return ok.',
    queryTrace: true,
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  const journalText = await Deno.readTextFile(journalPath);
  assert.match(journalText, /"type":"query_trace"/u);
  assert.match(journalText, /"kind":"llm_query"/u);
});

Deno.test('runner preserves the original failure when runtime cleanup throws after an unsuccessful run', async () => {
  const llm = new MockCaller([
    {
      outputText: '```repl\nconst subtotal = 40 + 2;\n```',
      turnState: { conversation: 'root-1' },
    },
  ]);

  class ThrowingCloseExecutionBackend implements ExecutionBackend {
    createRuntime(): PersistentRuntimeLike {
      return {
        close: async () => {
          throw new Error('runtime cleanup should be swallowed');
        },
        execute: async () => ({
          error: null,
          finalAnswer: null,
          result: { kind: 'number', json: 42, preview: '42' },
          status: 'success',
          stderr: '',
          stdout: '',
        }),
      };
    }
  }

  await assert.rejects(
    async () => {
      await runRLM({
        llm,
        clock: createClock(),
        context: null,
        executionBackend: new ThrowingCloseExecutionBackend(),
        idGenerator: createIdGenerator(),
        maxSteps: 1,
        maxSubcallDepth: 1,
        outputCharLimit: 120,
        prompt: 'Return ok.',
        rootModel: 'gpt-5-nano',
        subModel: 'gpt-5-mini',
      });
    },
    RLMMaxStepsError,
  );
});

Deno.test('OpenAI provider helper utilities cover provider-aware timeout and logger resolution', async () => {
  assert.equal(
    __openAIProviderTestables.resolveProviderAwareCellTimeoutMs(undefined, 30_000),
    35_000,
  );
  assert.equal(
    __openAIProviderTestables.resolveProviderAwareCellTimeoutMs(undefined, 4_000),
    9_000,
  );
  assert.equal(__openAIProviderTestables.resolveProviderAwareCellTimeoutMs(45_000, 30_000), 75_000);
  assert.equal(
    __openAIProviderTestables.resolveProviderAwareCellTimeoutMs(undefined, 30_000, 7_000),
    37_000,
  );
  assert.equal(__openAIProviderTestables.resolveOpenAIRunLogger(undefined, undefined), undefined);

  const journalPath = await createSessionPath('openai-convenience-logger');
  const logger = __openAIProviderTestables.resolveOpenAIRunLogger(undefined, journalPath);

  assert.ok(logger !== undefined);
  assert.equal('path' in logger, true);
  assert.equal((logger as { path?: string }).path, journalPath);
});

Deno.test('runner appends prior assistant code and execution feedback into later root turns', async () => {
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
  assert.doesNotMatch(adapter.requests[1]?.input ?? '', /단계 예산/u);
  assert.match(
    adapter.requests[1]?.input ?? '',
    /## REPL 목표 :\nAdd eight after the first computation\./u,
  );
  assert.match(adapter.requests[1]?.input ?? '', /assistant:\n```repl\nconst subtotal = 40 \+ 2/u);
  assert.match(adapter.requests[1]?.input ?? '', /## REPL 코드 실행 결과/u);
  assert.match(adapter.requests[1]?.input ?? '', /REPL 결과:[\s\S]*42/u);
  assert.match(adapter.requests[1]?.input ?? '', /상태: success/u);
});

Deno.test('runner appends result signals into the next root turn input', async () => {
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
  assert.doesNotMatch(adapter.requests[1]?.input ?? '', /단계 예산/u);
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
  assert.match(adapter.requests[0]?.systemPrompt ?? '', /^# Recursive Language Agent/mu);
  assert.match(adapter.requests[1]?.systemPrompt ?? '', /일반 언어 모델 하위 호출/u);
  assert.doesNotMatch(adapter.requests[1]?.systemPrompt ?? '', /focused child controller/u);

  const journalText = await Deno.readTextFile(journalPath);
  assert.match(journalText, /"type":"assistant_turn"/u);
  assert.doesNotMatch(journalText, /"type":"subquery"/u);
});

Deno.test('runner raises a protocol error immediately when the model returns no repl block', async () => {
  const adapter = new MockCaller([
    {
      outputText: '',
      turnState: 'resp_root_invalid',
    },
  ]);

  const journalPath = await createSessionPath('protocol-recovery');
  await assert.rejects(
    async () => {
      await runRLM({
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
    },
    RLMProtocolError,
  );
  assert.equal(adapter.requests.length, 1);
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
  assert.doesNotMatch(adapter.requests[2]?.input ?? '', /위임 계약 복구/u);
  assert.match(adapter.requests[2]?.input ?? '', /RLMSubqueryContractError/u);
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
  assert.match(adapter.requests[0]?.systemPrompt ?? '', /^# Recursive Language Agent/mu);
  assert.match(adapter.requests[1]?.systemPrompt ?? '', /^# Recursive Language Agent/mu);
  assert.doesNotMatch(adapter.requests[1]?.systemPrompt ?? '', /상위 에이전트에서 위임/u);
  assert.match(adapter.requests[1]?.input ?? '', /## REPL 목표 :\nCompute 6 \* 7\./u);

  const journalText = await Deno.readTextFile(journalPath);
  assert.match(journalText, /"type":"subquery"/u);
  const childJournalPath = journalText.match(/"journalPath":"([^"]+)"/u)?.[1];
  assert.ok(childJournalPath !== undefined);
  const childJournalText = await Deno.readTextFile(childJournalPath);
  assert.match(childJournalText, /"type":"rlm_delegated_task"/u);
  assert.match(childJournalText, /"task":"Compute 6 \* 7\."/u);
});

Deno.test('runner lets a nested rlm_query override the root step budget for the child run', async () => {
  const adapter = new MockCaller([
    {
      outputText:
        '```repl\nconst nested = await rlm_query("Compute 6 * 7.", { maxSteps: Number.POSITIVE_INFINITY });\nFINAL_VAR(nested);\n```',
      turnState: 'resp_root_1',
    },
    {
      outputText: '```repl\nconst scratch = 40 + 2;\n```',
      turnState: 'resp_sub_1',
    },
    {
      outputText: '```repl\nFINAL_VAR("42");\n```',
      turnState: 'resp_sub_2',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: { source: 'nested-unbounded-child-steps' },
    idGenerator: createIdGenerator(),
    maxSteps: 1,
    maxSubcallDepth: 2,
    outputCharLimit: 120,
    prompt: 'Use rlm_query once and finish in the same root step.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, '42');
  assert.equal(adapter.requests.length, 3);
  assert.equal(adapter.requests[0]?.kind, 'root_turn');
  assert.equal(adapter.requests[0]?.messages?.length, 1);
  assert.equal(adapter.requests[1]?.kind, 'child_turn');
  assert.deepEqual(adapter.requests[1]?.metadata, { depth: 1, step: 1 });
  assert.equal(adapter.requests[1]?.messages?.length, 1);
  assert.match(
    adapter.requests[1]?.messages?.[0]?.content ?? '',
    /## REPL 목표 :\nCompute 6 \* 7\./u,
  );
  assert.match(
    adapter.requests[1]?.messages?.[0]?.content ?? '',
    /## 사용 가능한 런타임 문맥/u,
  );
  assert.equal(adapter.requests[2]?.kind, 'child_turn');
  assert.deepEqual(adapter.requests[2]?.metadata, { depth: 1, step: 2 });
  assert.equal(adapter.requests[2]?.messages?.length, 3);
  assert.equal(adapter.requests[2]?.messages?.[1]?.role, 'assistant');
  assert.match(adapter.requests[2]?.messages?.[1]?.content ?? '', /const scratch = 40 \+ 2/u);
  assert.equal(adapter.requests[2]?.messages?.[2]?.role, 'user');
  assert.match(adapter.requests[2]?.messages?.[2]?.content ?? '', /REPL 코드 실행 결과/u);
  assert.match(adapter.requests[2]?.messages?.[2]?.content ?? '', /undefined/u);
});

Deno.test('runner keeps root step budget and metadata aligned after an internal rlm_query before the next root turn', async () => {
  const adapter = new MockCaller([
    {
      outputText:
        '```repl\nconst nested = await rlm_query("Compute 6 * 7.");\nconsole.log({ nested });\n```',
      turnState: 'resp_root_1',
    },
    {
      outputText: '```repl\nFINAL_VAR("42");\n```',
      turnState: 'resp_sub_1',
    },
    {
      outputText: '```repl\nFINAL_VAR(nested);\n```',
      turnState: 'resp_root_2',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: { source: 'nested-step-budget' },
    idGenerator: createIdGenerator(),
    maxSteps: 4,
    maxSubcallDepth: 2,
    outputCharLimit: 160,
    prompt: 'Use rlm_query first, then finalize on the next root turn.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, '42');
  assert.equal(adapter.requests.length, 3);

  assert.doesNotMatch(adapter.requests[0]?.input ?? '', /단계 예산/u);
  assert.equal(adapter.requests[0]?.metadata?.step, 1);
  assert.equal(adapter.requests[0]?.metadata?.depth, 0);

  assert.doesNotMatch(adapter.requests[1]?.input ?? '', /단계 예산/u);
  assert.equal(adapter.requests[1]?.metadata?.step, 1);
  assert.equal(adapter.requests[1]?.metadata?.depth, 1);

  assert.doesNotMatch(adapter.requests[2]?.input ?? '', /단계 예산/u);
  assert.doesNotMatch(adapter.requests[2]?.input ?? '', /## 이전 REPL 기록/u);
  assert.match(adapter.requests[2]?.input ?? '', /REPL 표준 출력:/u);
  assert.match(adapter.requests[2]?.input ?? '', /\{"nested":"42"\}/u);
  assert.equal(adapter.requests[2]?.metadata?.step, 2);
  assert.equal(adapter.requests[2]?.metadata?.depth, 0);
});

Deno.test('runner surfaces child final stdout through append-only execution feedback', async () => {
  const adapter = new MockCaller([
    {
      outputText: '```repl\nconst nested = await rlm_query("Compute 6 * 7.");\n({ nested })\n```',
      turnState: 'resp_root_1',
    },
    {
      outputText: '```repl\nconsole.log({ childExtracted: "42" });\nFINAL_VAR("42");\n```',
      turnState: 'resp_sub_1',
    },
    {
      outputText: '```repl\nFINAL_VAR(nested);\n```',
      turnState: 'resp_root_2',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: { source: 'nested-child-stdout' },
    idGenerator: createIdGenerator(),
    maxSteps: 4,
    maxSubcallDepth: 2,
    outputCharLimit: 200,
    prompt: 'Use rlm_query first, then finalize on the next root turn.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, '42');
  assert.match(adapter.requests[2]?.input ?? '', /childExtracted/u);
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

Deno.test('runner closes failed nested child sessions and lets the root recover on the next turn', async () => {
  const adapter = new MockCaller([
    {
      outputText: '```repl\nawait rlm_query("Compute 6 * 7.");\n```',
      turnState: 'resp_root_1',
    },
    {
      outputText: 'The child forgot to return a repl block.',
      turnState: 'resp_sub_1',
    },
    {
      outputText: '```repl\nFINAL_VAR("recovered");\n```',
      turnState: 'resp_root_2',
    },
  ]);
  const executionBackend = new TrackingExecutionBackend();

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: { source: 'nested-failure-recovery' },
    executionBackend,
    idGenerator: createIdGenerator(),
    maxSteps: 4,
    maxSubcallDepth: 2,
    outputCharLimit: 160,
    prompt: 'Recover if the delegated child fails.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, 'recovered');
  assert.equal(result.session.history.length, 2);
  assert.equal(result.session.history[0]?.status, 'error');
  assert.match(
    result.session.history[0]?.stderr ?? '',
    /Assistant turn did not contain a ```repl``` block/u,
  );
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

Deno.test('runner uses an injected system prompt markdown for both root and child model calls', async () => {
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
    context: { source: 'system-prompt-markdown' },
    idGenerator: createIdGenerator(),
    maxSteps: 4,
    maxSubcallDepth: 2,
    outputCharLimit: 120,
    prompt: 'Use rlm_query to solve the task.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
    systemPromptMarkdown:
      '# 사용자 정의 시스템\n{{MAX_STEPS_SENTENCE}}\n이 프롬프트는 동적으로 주입됩니다.',
  });

  assert.equal(result.answer, '42');
  assert.match(adapter.requests[0]?.systemPrompt ?? '', /^# 사용자 정의 시스템/mu);
  assert.match(adapter.requests[0]?.systemPrompt ?? '', /이 프롬프트는 동적으로 주입됩니다\./u);
  assert.doesNotMatch(adapter.requests[0]?.systemPrompt ?? '', /사용할 수 있는 최대 단계 예산/u);
  assert.match(adapter.requests[1]?.systemPrompt ?? '', /^# 사용자 정의 시스템/mu);
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
  assert.doesNotMatch(adapter.requests[1]?.input ?? '', /단계 예산/u);
  assert.match(adapter.requests[1]?.input ?? '', /Error: boom/u);
  assert.match(adapter.requests[1]?.input ?? '', /상태: error/u);
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
  assert.doesNotMatch(adapter.requests[1]?.input ?? '', /단계 예산/u);
  assert.match(adapter.requests[1]?.input ?? '', /채택된 최종 답: undefined/u);
});

Deno.test('runner ignores FINAL_VAR(null) and asks the model to keep working', async () => {
  const adapter = new MockCaller([
    {
      outputText: '```repl\nconst answer = null;\nFINAL_VAR(answer);\n```',
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
    context: { source: 'null-final' },
    idGenerator: createIdGenerator(),
    maxSteps: 3,
    maxSubcallDepth: 1,
    outputCharLimit: 200,
    prompt: 'Return a valid final answer and never finish with null.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, '42');
  assert.equal(result.steps, 2);
  assert.doesNotMatch(adapter.requests[1]?.input ?? '', /단계 예산/u);
  assert.match(adapter.requests[1]?.input ?? '', /채택된 최종 답: null/u);
});

Deno.test('runner accepts empty finals once execution succeeds under the current compact policy', async () => {
  const adapter = new MockCaller([
    {
      outputText: '```repl\nFINAL_VAR("");\n```',
      turnState: 'resp_root_1',
    },
    {
      outputText: '```repl\nFINAL_VAR("7318452");\n```',
      turnState: 'resp_root_2',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: {
      document: 'alpha '.repeat(4_000),
      retrievalQuestion: 'What is the code?',
    },
    idGenerator: createIdGenerator(),
    maxSteps: 3,
    maxSubcallDepth: 1,
    outputCharLimit: 200,
    prompt: 'Return only the decimal digits through FINAL_VAR.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, '');
  assert.equal(result.steps, 1);
  assert.equal(adapter.requests.length, 1);
});

Deno.test('runner accepts the first successful multiple-choice final under the current compact policy', async () => {
  const adapter = new MockCaller([
    {
      outputText: [
        '```repl',
        'const appendix = "Archive ARC-812 maps to memo bundle C.";',
        'console.log(appendix);',
        'FINAL_VAR("D");',
        '```',
      ].join('\n'),
      turnState: 'resp_root_1',
    },
    {
      outputText: [
        '```repl',
        'const selectedOption = "C";',
        'console.log({ selectedOption, matchedOptionText: context.options[selectedOption] });',
        'FINAL_VAR(selectedOption);',
        '```',
      ].join('\n'),
      turnState: 'resp_root_2',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: {
      document: 'alpha '.repeat(4_000),
      options: {
        A: 'bundle A',
        B: 'bundle B',
        C: 'bundle C',
        D: 'bundle D',
      },
      question: 'Which memo bundle is correct?',
    },
    idGenerator: createIdGenerator(),
    maxSteps: 4,
    maxSubcallDepth: 1,
    outputCharLimit: 200,
    prompt: 'Return only the single uppercase option letter through FINAL_VAR.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, 'D');
  assert.equal(result.steps, 1);
  assert.equal(adapter.requests.length, 1);
});

Deno.test('runner accepts placeholder-looking finals once execution succeeds', async () => {
  const adapter = new MockCaller([
    {
      outputText: [
        '```repl',
        'const candidates = ["14-B", "22-Q"];',
        'console.log({ candidateCount: candidates.length, candidates });',
        'FINAL_VAR("unknown");',
        '```',
      ].join('\n'),
      turnState: 'resp_root_1',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: {
      document: 'alpha '.repeat(4_000),
      question: 'Return only the exact stamp identifier.',
    },
    idGenerator: createIdGenerator(),
    maxSteps: 3,
    maxSubcallDepth: 1,
    outputCharLimit: 200,
    prompt: 'Return only the exact stamp identifier through FINAL_VAR.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, 'unknown');
  assert.equal(result.steps, 1);
  assert.equal(adapter.requests.length, 1);
});

Deno.test('runner accepts first-candidate finals once execution succeeds', async () => {
  const adapter = new MockCaller([
    {
      outputText: [
        '```repl',
        'const candidates = ["Glass Lantern", "Silver Fern"];',
        'console.log({ candidateCount: candidates.length, candidates });',
        'FINAL_VAR(candidates[0] || "");',
        '```',
      ].join('\n'),
      turnState: 'resp_root_1',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: {
      document: 'alpha '.repeat(4_000),
      question: 'Return only the exact dossier name.',
    },
    idGenerator: createIdGenerator(),
    maxSteps: 3,
    maxSubcallDepth: 1,
    outputCharLimit: 200,
    prompt: 'Return only the exact dossier name through FINAL_VAR.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, 'Glass Lantern');
  assert.equal(result.steps, 1);
  assert.equal(adapter.requests.length, 1);
});

Deno.test('runner accepts working-set projections once execution succeeds', async () => {
  const adapter = new MockCaller([
    {
      outputText: [
        '```repl',
        'const rows = [',
        '  "Assignment sheet: courier Rowan reports to depot Kestrel while carrying the cobalt envelope.",',
        '  "Supervisor Niko seals the outgoing manifests with stamp 22-Q.",',
        '  "Supervisor Imani seals the outgoing manifests with stamp 14-B.",',
        '];',
        'const joined = rows.join("\\n\\n");',
        'const answer = joined.match(/stamp\\s+([A-Z0-9-]+)/)?.[1] ?? "";',
        'console.log({ rowCount: rows.length, rows, answer });',
        'FINAL_VAR(answer);',
        '```',
      ].join('\n'),
      turnState: 'resp_root_1',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: {
      document: 'alpha '.repeat(4_000),
      question:
        'Which stamp identifier seals the outgoing manifests for the courier carrying the cobalt envelope?',
    },
    idGenerator: createIdGenerator(),
    maxSteps: 4,
    maxSubcallDepth: 1,
    outputCharLimit: 200,
    prompt: 'Return only the exact stamp identifier through FINAL_VAR.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, '22-Q');
  assert.equal(result.steps, 1);
  assert.equal(adapter.requests.length, 1);
});

Deno.test('runner accepts first-row fallback finals under the current compact policy', async () => {
  const adapter = new MockCaller([
    {
      outputText: [
        '```repl',
        'const rows = [',
        '  "Project Atlas moved into dossier Glass Lantern.",',
        '  "Project Selene moved into dossier Silver Fern.",',
        '  "Field note: Project Selene is the canonical name for the moon garden alias.",',
        '];',
        'const row = rows.find((entry) => /moon garden/i.test(entry) && /dossier/i.test(entry)) || rows[0];',
        'const answer = row.match(/dossier ([A-Za-z ]+)/)?.[1] ?? "";',
        'console.log({ rowCount: rows.length, rows, answer });',
        'FINAL_VAR(answer);',
        '```',
      ].join('\n'),
      turnState: 'resp_root_1',
    },
    {
      outputText: [
        '```repl',
        'const answer = "Silver Fern";',
        'console.log({ answer });',
        'FINAL_VAR(answer);',
        '```',
      ].join('\n'),
      turnState: 'resp_root_2',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: {
      document: 'alpha '.repeat(4_000),
      question: 'Which dossier name is associated with the alias moon garden?',
    },
    idGenerator: createIdGenerator(),
    maxSteps: 4,
    maxSubcallDepth: 1,
    outputCharLimit: 200,
    prompt: 'Return only the exact dossier name through FINAL_VAR.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, 'Glass Lantern');
  assert.equal(result.steps, 1);
  assert.equal(adapter.requests.length, 1);
});

Deno.test('runner accepts a non-literal multiple-choice final on the first successful turn', async () => {
  const adapter = new MockCaller([
    {
      outputText: [
        '```repl',
        'const archiveCode = "ARC-812";',
        'const memoBundle = "bundle " + "C";',
        'const answer = memoBundle.slice(-1);',
        'console.log({ archiveCode, answer });',
        'FINAL_VAR(answer);',
        '```',
      ].join('\n'),
      turnState: 'resp_root_1',
    },
    {
      outputText: [
        '```repl',
        'const archiveCode = "ARC-812";',
        'const memoBundle = "bundle " + "C";',
        'const answer = memoBundle.slice(-1);',
        'console.log({ archiveCode, answer });',
        'FINAL_VAR(answer);',
        '```',
      ].join('\n'),
      turnState: 'resp_root_2',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: {
      document: 'alpha '.repeat(4_000),
      options: {
        A: 'bundle A',
        B: 'bundle B',
        C: 'bundle C',
        D: 'bundle D',
      },
      question: 'Which memo bundle is correct?',
    },
    idGenerator: createIdGenerator(),
    maxSteps: 3,
    maxSubcallDepth: 1,
    outputCharLimit: 200,
    prompt: 'Return only the single uppercase option letter through FINAL_VAR.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, 'C');
  assert.equal(result.steps, 1);
  assert.equal(adapter.requests.length, 1);
});

Deno.test('runner accepts a literal multiple-choice final on the first successful turn', async () => {
  const adapter = new MockCaller([
    {
      outputText: [
        '```repl',
        'FINAL_VAR("C");',
        '```',
      ].join('\n'),
      turnState: 'resp_root_1',
    },
    {
      outputText: [
        '```repl',
        'FINAL_VAR("C");',
        '```',
      ].join('\n'),
      turnState: 'resp_root_2',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: {
      document: 'alpha '.repeat(4_000),
      options: {
        A: 'bundle A',
        B: 'bundle B',
        C: 'bundle C',
        D: 'bundle D',
      },
      question: 'Which memo bundle is correct?',
    },
    idGenerator: createIdGenerator(),
    maxSteps: 3,
    maxSubcallDepth: 1,
    outputCharLimit: 200,
    prompt: 'Return only the single uppercase option letter through FINAL_VAR.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, 'C');
  assert.equal(result.steps, 1);
  assert.equal(adapter.requests.length, 1);
});

Deno.test('runner accepts multiple-choice finals when the supporting option text is only embedded inside the document', async () => {
  const adapter = new MockCaller([
    {
      outputText: [
        '```repl',
        'const seq = "verify seal, read checksum, archive copy";',
        'console.log({ seq });',
        'FINAL_VAR("B");',
        '```',
      ].join('\n'),
      turnState: 'resp_root_1',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: {
      document: [
        'alpha '.repeat(4_000),
        'Lecture note: the safe handoff sequence is verify seal, read checksum, archive copy.',
        'Question options: A=read checksum, verify seal, archive copy.',
        'Question options: B=verify seal, read checksum, archive copy.',
        'Question options: C=archive copy, verify seal, read checksum.',
        'Question options: D=verify seal, archive copy, read checksum.',
      ].join('\n'),
      question: 'Which option gives the correct safe handoff sequence?',
    },
    idGenerator: createIdGenerator(),
    maxSteps: 4,
    maxSubcallDepth: 1,
    outputCharLimit: 200,
    prompt: 'Return only the single uppercase option letter through FINAL_VAR.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, 'B');
  assert.equal(result.steps, 1);
});

Deno.test('runner keeps the original option letter when no recovery path is active', async () => {
  const adapter = new MockCaller([
    {
      outputText: [
        '```repl',
        'const seq = "verify seal, read checksum, archive copy";',
        'console.log({ seq });',
        'FINAL_VAR("C");',
        '```',
      ].join('\n'),
      turnState: 'resp_root_1',
    },
    {
      outputText: '```repl\nFINAL_VAR("B");\n```',
      turnState: 'resp_root_2',
    },
  ]);

  const result = await runRLM({
    adapter,
    clock: createClock(),
    context: {
      document: [
        'alpha '.repeat(4_000),
        'Lecture note: the safe handoff sequence is verify seal, read checksum, archive copy.',
        'Question options: A=read checksum, verify seal, archive copy.',
        'Question options: B=verify seal, read checksum, archive copy.',
        'Question options: C=archive copy, verify seal, read checksum.',
        'Question options: D=verify seal, archive copy, read checksum.',
      ].join('\n'),
      question: 'Which option gives the correct safe handoff sequence?',
    },
    idGenerator: createIdGenerator(),
    maxSteps: 4,
    maxSubcallDepth: 1,
    outputCharLimit: 200,
    prompt: 'Return only the single uppercase option letter through FINAL_VAR.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, 'C');
  assert.equal(result.steps, 1);
  assert.equal(adapter.requests.length, 1);
});

Deno.test('runner continues executing later repl blocks in the same assistant turn after a failed block', async () => {
  const adapter = new MockCaller([
    {
      outputText: [
        '```repl',
        'throw new Error("boom");',
        '```',
        '',
        '```repl',
        'FINAL_VAR("fixed");',
        '```',
      ].join('\n'),
      turnState: 'resp_root_1',
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
    prompt:
      'Report the failed block in stderr and continue to the trailing block in the same turn.',
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  assert.equal(result.answer, 'fixed');
  assert.equal(result.steps, 1);
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

Deno.test('runner raises a protocol error for explicit FINAL(null) without repl output', async () => {
  const adapter = new MockCaller([
    {
      outputText: 'FINAL(null)',
      turnState: 'resp_root_1',
    },
  ]);

  await assert.rejects(
    async () => {
      await runRLM({
        adapter,
        clock: createClock(),
        context: null,
        idGenerator: createIdGenerator(),
        maxSteps: 2,
        maxSubcallDepth: 1,
        outputCharLimit: 120,
        prompt: 'Finish immediately.',
        rootModel: 'gpt-5-nano',
        subModel: 'gpt-5-mini',
      });
    },
    RLMProtocolError,
  );
  assert.equal(adapter.requests.length, 1);
});

Deno.test('runner raises a protocol error for malformed repl responses that never close the fence', async () => {
  const adapter = new MockCaller([
    {
      outputText: '```repl\nFINAL_VAR("wrong")',
      turnState: 'resp_root_1',
    },
  ]);

  await assert.rejects(
    async () => {
      await runRLM({
        adapter,
        clock: createClock(),
        context: null,
        idGenerator: createIdGenerator(),
        maxSteps: 2,
        maxSubcallDepth: 1,
        outputCharLimit: 120,
        prompt: 'Finish immediately.',
        rootModel: 'gpt-5-nano',
        subModel: 'gpt-5-mini',
      });
    },
    RLMProtocolError,
  );
  assert.equal(adapter.requests.length, 1);
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

Deno.test('runOpenAIRLM requires explicit OpenAI config instead of reading repository env state', async () => {
  const runWithoutConfig = runOpenAIRLM as unknown as (
    options: Record<string, unknown>,
  ) => Promise<unknown>;

  await assert.rejects(
    async () =>
      await runWithoutConfig({
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
        prompt: 'Finish immediately.',
      }),
    /openAI/u,
  );
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
