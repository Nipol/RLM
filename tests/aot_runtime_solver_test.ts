import assert from 'node:assert/strict';

import type { AoTNormalizedInput } from '../plugin/aot/types.ts';
import {
  appendTracePath,
  buildContractionCandidates,
  chooseBestCompletedCandidate,
  evaluateNextStateCandidate,
  expandFrontierNode,
  finalizeSelectedAcceptedCandidate,
  judgeTransition,
  orderSelectedAcceptedCandidates,
  rankFrontierCandidates,
  refineRejectedState,
  runAOTHardHelperFromConfig,
  runAOTHelper,
  runAOTLiteHelperFromConfig,
  selectJudgeAnswer,
  solveGraphAnswer,
  solveIndependentSubquestions,
  solveStateAnswer,
} from '../plugin/aot/runtime_solver.ts';

type RuntimeMockMap = {
  llm_query?: (prompt: string) => Promise<unknown>;
  llm_query_batched?: (prompts: string[]) => Promise<unknown[]>;
};

async function withAoTRuntimeMocks(
  mocks: RuntimeMockMap,
  run: () => Promise<void> | void,
) {
  const globalRecord = globalThis as typeof globalThis & Record<string, unknown>;
  const hadLLMQuery = Object.prototype.hasOwnProperty.call(globalRecord, 'llm_query');
  const hadLLMQueryBatched = Object.prototype.hasOwnProperty.call(globalRecord, 'llm_query_batched');
  const originalLLMQuery = globalRecord.llm_query;
  const originalLLMQueryBatched = globalRecord.llm_query_batched;

  Object.defineProperty(globalRecord, 'llm_query', {
    configurable: true,
    value: mocks.llm_query ?? (async () => {
      throw new Error('Unexpected llm_query call');
    }),
    writable: true,
  });
  Object.defineProperty(globalRecord, 'llm_query_batched', {
    configurable: true,
    value: mocks.llm_query_batched ?? (async () => {
      throw new Error('Unexpected llm_query_batched call');
    }),
    writable: true,
  });

  try {
    await run();
  } finally {
    if (hadLLMQuery) {
      Object.defineProperty(globalRecord, 'llm_query', {
        configurable: true,
        value: originalLLMQuery,
        writable: true,
      });
    } else {
      delete globalRecord.llm_query;
    }

    if (hadLLMQueryBatched) {
      Object.defineProperty(globalRecord, 'llm_query_batched', {
        configurable: true,
        value: originalLLMQueryBatched,
        writable: true,
      });
    } else {
      delete globalRecord.llm_query_batched;
    }
  }
}

function baseConfig(overrides: Partial<AoTNormalizedInput> = {}): AoTNormalizedInput {
  return {
    beamWidth: 1,
    context: null,
    goal: null,
    includeTrace: true,
    maxIndependentSubquestions: 2,
    maxIterations: 2,
    maxRefinements: 1,
    question: 'Original question?',
    transitionSamples: 1,
    ...overrides,
  };
}

Deno.test('AoT solver small helpers cover independent solving and direct state solves', async () => {
  await withAoTRuntimeMocks({
    llm_query: async (prompt) => {
      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('Atomic subquestion:\nOnly one?')) {
        return 'single answer';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nState?')) {
        return 'state answer';
      }
      if (prompt.includes('AOT_SOLVE_GRAPH') && prompt.includes('Decomposition DAG:')) {
        return 'graph answer';
      }
      throw new Error(`Unexpected llm_query prompt: ${prompt}`);
    },
    llm_query_batched: async (prompts) => prompts.map((prompt, index) =>
      prompt.includes('AOT_ATOM_SOLVE') ? `batched-${String(index + 1)}` : 'unexpected'
    ),
  }, async () => {
    assert.deepEqual(
      await solveIndependentSubquestions([{ id: 'q1', question: 'Only one?' }], 'Parent?', {
        context: null,
      }),
      [{ answer: 'single answer', id: 'q1', question: 'Only one?' }],
    );

    assert.deepEqual(
      await solveIndependentSubquestions(
        [
          { id: 'q1', question: 'First?' },
          { id: 'q2', question: 'Second?' },
        ],
        'Parent?',
        { context: { doc: 'x' } },
      ),
      [
        { answer: 'batched-1', id: 'q1', question: 'First?' },
        { answer: 'batched-2', id: 'q2', question: 'Second?' },
      ],
    );

    assert.equal(
      await solveStateAnswer('Original?', 'State?', { context: null, goal: null }),
      'state answer',
    );
    assert.equal(
      await solveGraphAnswer(
        'Original?',
        'State?',
        { atomic: false, reason: 'split', subquestions: [{ id: 'q1', question: 'Why?', deps: [] }] },
        [{ answer: 'Because.', id: 'q1', question: 'Why?' }],
        { context: null, goal: null },
      ),
      'graph answer',
    );
  });
});

Deno.test('AoT solver helpers cover contraction, judging, evaluation, and refinement', async () => {
  await withAoTRuntimeMocks({
    llm_query: async (prompt) => {
      if (prompt.includes('AOT_CONTRACT_JSON') && prompt.includes('Current question:\nCurrent?')) {
        return '{"next_question":"Reduced?","ready":false,"reason":"shorter"}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nReduced?')) {
        return 'next answer';
      }
      if (prompt.includes('AOT_JUDGE_JSON') && prompt.includes('Proposed next Markov state:\nReduced?')) {
        return '{"selected":"next","accept_next_state":true,"reason":"good enough"}';
      }
      if (prompt.includes('AOT_REFINE_JSON')) {
        return '{"next_question":"Refined?","ready":true,"reason":"clearer"}';
      }
      throw new Error(`Unexpected llm_query prompt: ${prompt}`);
    },
  }, async () => {
    assert.deepEqual(
      await buildContractionCandidates(
        'Current?',
        { atomic: false, reason: 'split', subquestions: [{ id: 'q1', question: 'Why?', deps: [] }] },
        [{ answer: 'Because.', id: 'q1', question: 'Why?' }],
        { context: null, transitionSamples: 1 },
      ),
      [{ nextQuestion: 'Reduced?', ready: false, reason: 'shorter' }],
    );

    const judgeDecision = await judgeTransition('Original?', 'Current?', 'Reduced?', {
      currentAnswer: 'current',
      graphAnswer: 'graph',
      nextAnswer: 'next',
    });
    assert.deepEqual(judgeDecision, {
      acceptNextState: true,
      answer: null,
      reason: 'good enough',
      refineNextState: false,
      selected: 'next',
    });

    assert.equal(
      selectJudgeAnswer(
        { acceptNextState: false, answer: null, reason: '', refineNextState: false, selected: 'graph' },
        { currentAnswer: 'current', graphAnswer: 'graph', nextAnswer: 'next' },
      ),
      'graph',
    );
    assert.equal(
      selectJudgeAnswer(
        { acceptNextState: false, answer: 'judge answer', reason: '', refineNextState: false, selected: 'current' },
        { currentAnswer: 'current', graphAnswer: 'graph', nextAnswer: 'next' },
      ),
      'judge answer',
    );
    assert.equal(
      selectJudgeAnswer(
        { acceptNextState: false, answer: null, reason: '', refineNextState: false, selected: 'current' },
        { currentAnswer: 'current', graphAnswer: 'graph', nextAnswer: 'next' },
      ),
      'current',
    );

    assert.deepEqual(
      await evaluateNextStateCandidate(
        'Original?',
        'Current?',
        'current',
        'graph',
        { nextQuestion: 'Reduced?', ready: false, reason: 'shorter' },
        { context: null, goal: null },
      ),
      {
        judgeDecision: {
          acceptNextState: true,
          answer: null,
          reason: 'good enough',
          refineNextState: false,
          selected: 'next',
        },
        nextAnswer: 'next answer',
      },
    );

    assert.deepEqual(
      await refineRejectedState(
        'Original?',
        'Current?',
        { atomic: false, reason: 'split', subquestions: [{ id: 'q1', question: 'Why?', deps: [] }] },
        [{ answer: 'Because.', id: 'q1', question: 'Why?' }],
        'Reduced?',
        'too vague',
        { context: null, goal: null },
      ),
      { nextQuestion: 'Refined?', ready: true, reason: 'clearer' },
    );
  });
});

Deno.test('AoT frontier helpers cover ranking, trace accumulation, and selected candidate ordering', async () => {
  let frontierCallCount = 0;
  await withAoTRuntimeMocks({
    llm_query: async (prompt) => {
      if (prompt.includes('AOT_FRONTIER_JSON')) {
        frontierCallCount += 1;
        return frontierCallCount === 1
          ? '{"selected_ids":["c2","missing","c1"],"reason":"ranked"}'
          : '{"selected_ids":["missing"],"reason":"ranked"}';
      }
      throw new Error(`Unexpected llm_query prompt: ${prompt}`);
    },
  }, async () => {
    assert.deepEqual(
      await rankFrontierCandidates('Original?', [{ answer: 'a', id: 'c1', judgeReason: 'ok', pathScore: 0, question: 'Q1', ready: false }], 2),
      {
        reason: 'All accepted candidates fit within the current beam width.',
        selectedIds: ['c1'],
      },
    );

    assert.deepEqual(
      await rankFrontierCandidates(
        'Original?',
        [
          { answer: 'a', id: 'c1', judgeReason: 'ok', pathScore: 0, question: 'Q1', ready: false },
          { answer: 'b', id: 'c2', judgeReason: 'best', pathScore: 2, question: 'Q2', ready: true },
        ],
        1,
      ),
      {
        reason: 'ranked',
        selectedIds: ['c2'],
      },
    );

    assert.deepEqual(
      await rankFrontierCandidates(
        'Original?',
        [
          { answer: 'a', id: 'c1', judgeReason: 'ok', pathScore: 0, question: 'Q1', ready: false },
          { answer: 'b', id: 'c2', judgeReason: 'best', pathScore: 2, question: 'Q2', ready: true },
        ],
        1,
      ),
      {
        reason: 'ranked',
        selectedIds: ['c1'],
      },
    );
  });

  assert.deepEqual(appendTracePath([], { step: 1 }, true), [{ step: 1 }]);
  assert.deepEqual(appendTracePath([{ step: 0 }], { step: 1 }, false), [{ step: 0 }]);

  assert.deepEqual(
    chooseBestCompletedCandidate(null, {
      answer: 'a',
      path: [],
      priority: 1,
      question: 'Q1',
      score: 1,
      stoppedBecause: 'done',
    }),
    {
      answer: 'a',
      path: [],
      priority: 1,
      question: 'Q1',
      score: 1,
      stoppedBecause: 'done',
    },
  );
  assert.deepEqual(
    chooseBestCompletedCandidate(
      { answer: 'a', path: [], priority: 1, question: 'Q1', score: 1, stoppedBecause: 'done' },
      { answer: 'b', path: [], priority: 2, question: 'Q2', score: 0, stoppedBecause: 'better' },
    ),
    { answer: 'b', path: [], priority: 2, question: 'Q2', score: 0, stoppedBecause: 'better' },
  );
  assert.deepEqual(
    chooseBestCompletedCandidate(
      { answer: 'a', path: [], priority: 2, question: 'Q1', score: 5, stoppedBecause: 'best' },
      { answer: 'b', path: [], priority: 2, question: 'Q2', score: 4, stoppedBecause: 'worse' },
    ),
    { answer: 'a', path: [], priority: 2, question: 'Q1', score: 5, stoppedBecause: 'best' },
  );
  assert.deepEqual(
    chooseBestCompletedCandidate(
      { answer: 'a', path: [], priority: 2, question: 'Q1', score: 4, stoppedBecause: 'best' },
      { answer: 'b', path: [], priority: 2, question: 'Q2', score: 5, stoppedBecause: 'better-score' },
    ),
    { answer: 'b', path: [], priority: 2, question: 'Q2', score: 5, stoppedBecause: 'better-score' },
  );

  assert.deepEqual(
    orderSelectedAcceptedCandidates(
      [
        { answer: 'a', id: 'c1', parentPath: [], parentScore: 0, question: 'Q1', ready: false, traceEntry: { judgeReason: 'ok' } },
        { answer: 'b', id: 'c2', parentPath: [], parentScore: 1, question: 'Q2', ready: true, traceEntry: { judgeReason: 'best' } },
      ],
      ['c2', 'missing', 'c1'],
    ).map((candidate) => candidate.id),
    ['c2', 'c1'],
  );

  const finalized = finalizeSelectedAcceptedCandidate(
    {
      answer: 'b',
      id: 'c2',
      parentPath: [{ step: 0 }],
      parentScore: 1,
      question: 'Q2',
      ready: true,
      traceEntry: { judgeReason: 'best' },
    },
    {
      beamWidth: 2,
      frontierReason: 'ranked',
      frontierSelected: true,
      frontierRank: 0,
      includeTrace: true,
      shouldAnnotateFrontier: true,
    },
  );
  assert.equal(finalized.answer, 'b');
  assert.equal(finalized.score, 3);
  assert.deepEqual(finalized.path, [{
    step: 0,
  }, {
    frontierRank: 1,
    frontierReason: 'ranked',
    frontierScore: 3,
    frontierSelected: true,
    judgeReason: 'best',
  }]);
});

Deno.test('expandFrontierNode covers atomic, no-independent, and refinement-accepted branches', async () => {
  await withAoTRuntimeMocks({
    llm_query: async (prompt) => {
      if (prompt.includes('AOT_DECOMPOSE_JSON') && prompt.includes('Current question:\nAtomic?')) {
        return '{"atomic":true,"reason":"already atomic","subquestions":[]}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nAtomic?')) {
        return 'atomic answer';
      }
      if (prompt.includes('AOT_DECOMPOSE_JSON') && prompt.includes('Current question:\nNo-independent?')) {
        return '{"atomic":false,"reason":"cyclic","subquestions":[{"id":"q1","question":"Later one?","deps":["q2"]},{"id":"q2","question":"Later two?","deps":["q1"]}]}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nNo-independent?')) {
        return 'current only';
      }
      if (prompt.includes('AOT_DECOMPOSE_JSON') && prompt.includes('Current question:\nNeeds refinement?')) {
        return '{"atomic":false,"reason":"split","subquestions":[{"id":"q1","question":"Why?","deps":[]}]}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nNeeds refinement?')) {
        return 'current answer';
      }
      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('Atomic subquestion:\nWhy?')) {
        return 'because';
      }
      if (prompt.includes('AOT_SOLVE_GRAPH') && prompt.includes('Current Markov state:\nNeeds refinement?')) {
        return 'graph answer';
      }
      if (prompt.includes('AOT_CONTRACT_JSON')) {
        return '{"next_question":"Candidate?","ready":true,"reason":"first try"}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nCandidate?')) {
        return 'candidate answer';
      }
      if (prompt.includes('AOT_JUDGE_JSON') && prompt.includes('Proposed next Markov state:\nCandidate?')) {
        return '{"selected":"graph","accept_next_state":false,"reason":"too vague","refine_next_state":true}';
      }
      if (prompt.includes('AOT_REFINE_JSON')) {
        return '{"next_question":"Refined?","ready":true,"reason":"clear enough"}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nRefined?')) {
        return 'refined answer';
      }
      if (prompt.includes('AOT_JUDGE_JSON') && prompt.includes('Proposed next Markov state:\nRefined?')) {
        return '{"selected":"next","accept_next_state":true,"reason":"accept refined","refine_next_state":false}';
      }
      throw new Error(`Unexpected llm_query prompt: ${prompt}`);
    },
  }, async () => {
    const atomic = await expandFrontierNode(
      { path: [], question: 'Atomic?', score: 0 },
      1,
      baseConfig({ question: 'Original?' }),
    );
    assert.equal(atomic.acceptedCandidates.length, 0);
    assert.equal(atomic.completedCandidates[0]?.stoppedBecause, 'atomic');

    const noIndependent = await expandFrontierNode(
      { path: [], question: 'No-independent?', score: 0 },
      1,
      baseConfig({ question: 'Original?' }),
    );
    assert.equal(noIndependent.acceptedCandidates.length, 0);
    assert.equal(noIndependent.completedCandidates[0]?.stoppedBecause, 'no_independent_subquestion');

    const refined = await expandFrontierNode(
      { path: [{ seed: true }], question: 'Needs refinement?', score: 2 },
      1,
      baseConfig({ question: 'Original?' }),
    );
    assert.equal(refined.completedCandidates.length, 0);
    assert.equal(refined.acceptedCandidates.length, 1);
    assert.equal(refined.acceptedCandidates[0]?.question, 'Refined?');
    assert.equal(refined.acceptedCandidates[0]?.answer, 'refined answer');
    assert.match(
      JSON.stringify(refined.acceptedCandidates[0]?.traceEntry ?? {}),
      /"reason":"clear enough"/u,
    );
    assert.match(
      JSON.stringify(refined.acceptedCandidates[0]?.traceEntry ?? {}),
      /"refinement":\{/u,
    );
  });
});

Deno.test('expandFrontierNode covers atomic fallback reasons without appending trace', async () => {
  await withAoTRuntimeMocks({
    llm_query: async (prompt) => {
      if (prompt.includes('AOT_DECOMPOSE_JSON') && prompt.includes('Current question:\nAtomic fallback?')) {
        return '{"atomic":true,"reason":"","subquestions":[]}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nAtomic fallback?')) {
        return 'atomic fallback answer';
      }
      throw new Error(`Unexpected llm_query prompt: ${prompt}`);
    },
  }, async () => {
    const result = await expandFrontierNode(
      { path: [], question: 'Atomic fallback?', score: 0 },
      1,
      baseConfig({ includeTrace: false, question: 'Original?' }),
    );
    assert.equal(result.acceptedCandidates.length, 0);
    assert.equal(result.completedCandidates[0]?.stoppedBecause, 'atomic');
    assert.deepEqual(result.completedCandidates[0]?.path, []);
  });
});

Deno.test('expandFrontierNode covers judge-terminated candidates', async () => {
  await withAoTRuntimeMocks({
    llm_query: async (prompt) => {
      if (prompt.includes('AOT_DECOMPOSE_JSON') && prompt.includes('Current question:\nJudge stop?')) {
        return '{"atomic":false,"reason":"split","subquestions":[{"id":"q1","question":"Why stop?","deps":[]}]}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nJudge stop?')) {
        return 'current answer';
      }
      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('Atomic subquestion:\nWhy stop?')) {
        return 'because';
      }
      if (prompt.includes('AOT_SOLVE_GRAPH') && prompt.includes('Current Markov state:\nJudge stop?')) {
        return 'graph answer';
      }
      if (prompt.includes('AOT_CONTRACT_JSON')) {
        return '{"next_question":"Rejected?","ready":false,"reason":"candidate"}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nRejected?')) {
        return 'next answer';
      }
      if (prompt.includes('AOT_JUDGE_JSON') && prompt.includes('Proposed next Markov state:\nRejected?')) {
        return '{"selected":"current","accept_next_state":false,"reason":"stay put","refine_next_state":false}';
      }
      throw new Error(`Unexpected llm_query prompt: ${prompt}`);
    },
  }, async () => {
    const result = await expandFrontierNode(
      { path: [], question: 'Judge stop?', score: 1 },
      1,
      baseConfig({ maxRefinements: 0, question: 'Original?' }),
    );
    assert.equal(result.acceptedCandidates.length, 0);
    assert.equal(result.completedCandidates.length, 1);
    assert.equal(result.completedCandidates[0]?.stoppedBecause, 'judge_terminated');
  });
});

Deno.test('AoT lite entrypoint can suppress trace across atomic, no-independent, ready, and max-iteration exits', async () => {
  await withAoTRuntimeMocks({
    llm_query: async (prompt) => {
      if (prompt.includes('AOT_DECOMPOSE_JSON') && prompt.includes('Current question:\nLite atomic fallback?')) {
        return '{"atomic":true,"reason":"","subquestions":[]}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nLite atomic fallback?')) {
        return 'lite atomic fallback answer';
      }

      if (prompt.includes('AOT_DECOMPOSE_JSON') && prompt.includes('Current question:\nLite no trace no-independent?')) {
        return '{"atomic":false,"reason":"cyclic","subquestions":[{"id":"q1","question":"Later one?","deps":["q2"]},{"id":"q2","question":"Later two?","deps":["q1"]}]}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nLite no trace no-independent?')) {
        return 'lite no trace no-independent answer';
      }

      if (prompt.includes('AOT_DECOMPOSE_JSON') && prompt.includes('Current question:\nLite no trace ready?')) {
        return '{"atomic":false,"reason":"split","subquestions":[{"id":"q1","question":"Why ready?","deps":[]}]}';
      }
      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('Atomic subquestion:\nWhy ready?')) {
        return 'because ready';
      }
      if (prompt.includes('AOT_CONTRACT_JSON') && prompt.includes('Current question:\nLite no trace ready?')) {
        return '{"next_question":"Lite no trace final?","ready":true,"reason":"done"}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nLite no trace final?')) {
        return 'lite no trace ready answer';
      }

      if (prompt.includes('AOT_DECOMPOSE_JSON') && prompt.includes('Current question:\nLite no trace continue?')) {
        return '{"atomic":false,"reason":"split","subquestions":[{"id":"q1","question":"Why continue?","deps":[]}]}';
      }
      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('Atomic subquestion:\nWhy continue?')) {
        return 'because continue';
      }
      if (prompt.includes('AOT_CONTRACT_JSON') && prompt.includes('Current question:\nLite no trace continue?')) {
        return '{"next_question":"Lite no trace next?","ready":false,"reason":"keep going"}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nLite no trace next?')) {
        return 'lite no trace max answer';
      }

      throw new Error(`Unexpected llm_query prompt: ${prompt}`);
    },
  }, async () => {
    const atomic = await runAOTLiteHelperFromConfig(baseConfig({
      includeTrace: false,
      maxIterations: 1,
      question: 'Lite atomic fallback?',
    }));
    assert.equal(atomic.stoppedBecause, 'lite_atomic');
    assert.deepEqual(atomic.iterations, []);

    const atomicWithTrace = await runAOTLiteHelperFromConfig(baseConfig({
      includeTrace: true,
      maxIterations: 1,
      question: 'Lite atomic fallback?',
    }));
    assert.equal(atomicWithTrace.stoppedBecause, 'lite_atomic');
    assert.match(JSON.stringify(atomicWithTrace.iterations), /Question was already atomic/u);

    const noIndependent = await runAOTLiteHelperFromConfig(baseConfig({
      includeTrace: false,
      maxIterations: 1,
      question: 'Lite no trace no-independent?',
    }));
    assert.equal(noIndependent.stoppedBecause, 'lite_no_independent_subquestion');
    assert.deepEqual(noIndependent.iterations, []);

    const ready = await runAOTLiteHelperFromConfig(baseConfig({
      includeTrace: false,
      maxIterations: 1,
      question: 'Lite no trace ready?',
    }));
    assert.equal(ready.stoppedBecause, 'lite_ready');
    assert.deepEqual(ready.iterations, []);

    const maxIterations = await runAOTLiteHelperFromConfig(baseConfig({
      includeTrace: false,
      maxIterations: 1,
      question: 'Lite no trace continue?',
    }));
    assert.equal(maxIterations.stoppedBecause, 'lite_max_iterations');
    assert.deepEqual(maxIterations.iterations, []);
  });
});

Deno.test('AoT runtime entrypoints cover lite path, hard path, and top-level dispatch', async () => {
  await withAoTRuntimeMocks({
    llm_query: async (prompt) => {
      if (prompt.includes('AOT_DECOMPOSE_JSON') && prompt.includes('Current question:\nLite ready?')) {
        return '{"atomic":false,"reason":"split","subquestions":[{"id":"q1","question":"Why?","deps":[]}]}';
      }
      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('Atomic subquestion:\nWhy?')) {
        return 'because';
      }
      if (prompt.includes('AOT_CONTRACT_JSON') && prompt.includes('Current question:\nLite ready?')) {
        return '{"next_question":"Lite final?","ready":true,"reason":"done"}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nLite final?')) {
        return 'lite answer';
      }

      if (prompt.includes('AOT_DECOMPOSE_JSON') && prompt.includes('Current question:\nHard root?')) {
        return '{"atomic":false,"reason":"split","subquestions":[{"id":"q1","question":"Why hard?","deps":[]}]}';
      }
      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('Atomic subquestion:\nWhy hard?')) {
        return 'because hard';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nHard root?')) {
        return 'hard current';
      }
      if (prompt.includes('AOT_SOLVE_GRAPH') && prompt.includes('Current Markov state:\nHard root?')) {
        return 'hard graph';
      }
      if (prompt.includes('AOT_CONTRACT_JSON') && prompt.includes('Current question:\nHard root?')) {
        return '{"next_question":"Hard final?","ready":true,"reason":"done"}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nHard final?')) {
        return 'hard final answer';
      }
      if (prompt.includes('AOT_JUDGE_JSON') && prompt.includes('Proposed next Markov state:\nHard final?')) {
        return '{"selected":"next","accept_next_state":true,"reason":"accepted","refine_next_state":false}';
      }
      throw new Error(`Unexpected llm_query prompt: ${prompt}`);
    },
    llm_query_batched: async (prompts) => prompts.map((prompt) => {
      if (prompt.includes('AOT_CONTRACT_JSON') && prompt.includes('Current question:\nHard root?')) {
        return '{"next_question":"Hard final?","ready":true,"reason":"done"}';
      }
      throw new Error(`Unexpected llm_query_batched prompt: ${prompt}`);
    }),
  }, async () => {
    const lite = await runAOTLiteHelperFromConfig(baseConfig({
      maxIterations: 1,
      question: 'Lite ready?',
    }));
    assert.equal(lite.answer, 'lite answer');
    assert.equal(lite.finalQuestion, 'Lite final?');
    assert.equal(lite.stoppedBecause, 'lite_ready');

    const hard = await runAOTHardHelperFromConfig(baseConfig({
      maxIterations: 1,
      question: 'Hard root?',
      transitionSamples: 2,
    }));
    assert.equal(hard.answer, 'hard final answer');
    assert.equal(hard.finalQuestion, 'Hard final?');
    assert.equal(hard.stoppedBecause, 'judge_selected_next_state');

    const viaHelper = await runAOTHelper({
      maxIndependentSubquestions: 1,
      maxIterations: 1,
      maxRefinements: 0,
      question: 'Lite ready?',
    });
    assert.equal(viaHelper.answer, 'lite answer');
    assert.equal(viaHelper.finalQuestion, 'Lite final?');
  });
});

Deno.test('AoT runtime entrypoints cover lite atomic, lite no-independent, hard completed fallback, and hard max-iteration fallback', async () => {
  await withAoTRuntimeMocks({
    llm_query: async (prompt) => {
      if (prompt.includes('AOT_DECOMPOSE_JSON') && prompt.includes('Current question:\nLite atomic?')) {
        return '{"atomic":true,"reason":"already atomic","subquestions":[]}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nLite atomic?')) {
        return 'lite atomic answer';
      }
      if (prompt.includes('AOT_DECOMPOSE_JSON') && prompt.includes('Current question:\nLite no-independent?')) {
        return '{"atomic":false,"reason":"cyclic","subquestions":[{"id":"q1","question":"Later one?","deps":["q2"]},{"id":"q2","question":"Later two?","deps":["q1"]}]}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nLite no-independent?')) {
        return 'lite no-independent answer';
      }
      if (prompt.includes('AOT_DECOMPOSE_JSON') && prompt.includes('Current question:\nHard completed?')) {
        return '{"atomic":true,"reason":"done","subquestions":[]}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nHard completed?')) {
        return 'hard completed answer';
      }
      if (prompt.includes('AOT_DECOMPOSE_JSON') && prompt.includes('Current question:\nHard continue?')) {
        return '{"atomic":false,"reason":"split","subquestions":[{"id":"q1","question":"Why continue?","deps":[]}]}';
      }
      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('Atomic subquestion:\nWhy continue?')) {
        return 'continue because';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nHard continue?')) {
        return 'hard current';
      }
      if (prompt.includes('AOT_SOLVE_GRAPH') && prompt.includes('Current Markov state:\nHard continue?')) {
        return 'hard graph';
      }
      if (prompt.includes('AOT_CONTRACT_JSON') && prompt.includes('Current question:\nHard continue?')) {
        return '{"next_question":"Hard next?","ready":false,"reason":"keep exploring"}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nHard next?')) {
        return 'hard next answer';
      }
      if (prompt.includes('AOT_JUDGE_JSON') && prompt.includes('Proposed next Markov state:\nHard next?')) {
        return '{"selected":"next","accept_next_state":true,"reason":"continue","refine_next_state":false}';
      }
      throw new Error(`Unexpected llm_query prompt: ${prompt}`);
    },
  }, async () => {
    const liteAtomic = await runAOTLiteHelperFromConfig(baseConfig({
      maxIterations: 1,
      question: 'Lite atomic?',
    }));
    assert.equal(liteAtomic.stoppedBecause, 'lite_atomic');

    const liteNoIndependent = await runAOTLiteHelperFromConfig(baseConfig({
      maxIterations: 1,
      question: 'Lite no-independent?',
    }));
    assert.equal(liteNoIndependent.stoppedBecause, 'lite_no_independent_subquestion');

    const hardCompleted = await runAOTHardHelperFromConfig(baseConfig({
      maxIterations: 1,
      question: 'Hard completed?',
      transitionSamples: 2,
    }));
    assert.equal(hardCompleted.answer, 'hard completed answer');
    assert.equal(hardCompleted.stoppedBecause, 'atomic');

    const hardCompletedNoTrace = await runAOTHardHelperFromConfig(baseConfig({
      includeTrace: false,
      maxIterations: 1,
      question: 'Hard completed?',
      transitionSamples: 2,
    }));
    assert.equal(hardCompletedNoTrace.answer, 'hard completed answer');
    assert.deepEqual(hardCompletedNoTrace.iterations, []);

    const hardContinue = await runAOTHardHelperFromConfig(baseConfig({
      maxIterations: 1,
      question: 'Hard continue?',
      transitionSamples: 1,
    }));
    assert.equal(hardContinue.answer, 'hard next answer');
    assert.equal(hardContinue.finalQuestion, 'Hard next?');
    assert.equal(hardContinue.stoppedBecause, 'max_iterations');

    const hardViaHelper = await runAOTHelper({
      beamWidth: 2,
      maxIterations: 1,
      maxRefinements: 1,
      question: 'Hard completed?',
      transitionSamples: 2,
    });
    assert.equal(hardViaHelper.answer, 'hard completed answer');
  });
});

Deno.test('AoT runtime entrypoints cover lite max-iterations fallback and hard best-completed fallback after the loop', async () => {
  await withAoTRuntimeMocks({
    llm_query: async (prompt) => {
      if (prompt.includes('AOT_DECOMPOSE_JSON') && prompt.includes('Current question:\nLite continue?')) {
        return '{"atomic":false,"reason":"split","subquestions":[{"id":"q1","question":"Why lite continue?","deps":[]}]}';
      }
      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('Atomic subquestion:\nWhy lite continue?')) {
        return 'because lite';
      }
      if (prompt.includes('AOT_CONTRACT_JSON') && prompt.includes('Current question:\nLite continue?')) {
        return '{"next_question":"Lite next?","ready":false,"reason":"keep going"}';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nLite next?')) {
        return 'lite next answer';
      }

      if (prompt.includes('AOT_DECOMPOSE_JSON') && prompt.includes('Current question:\nHard mixed?')) {
        return '{"atomic":false,"reason":"split","subquestions":[{"id":"q1","question":"Why hard mixed?","deps":[]}]}';
      }
      if (prompt.includes('AOT_ATOM_SOLVE') && prompt.includes('Atomic subquestion:\nWhy hard mixed?')) {
        return 'because hard mixed';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nHard mixed?')) {
        return 'hard mixed current';
      }
      if (prompt.includes('AOT_SOLVE_GRAPH') && prompt.includes('Current Markov state:\nHard mixed?')) {
        return 'hard mixed graph';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nHard done?')) {
        return 'hard done answer';
      }
      if (prompt.includes('AOT_SOLVE_STATE') && prompt.includes('Current Markov state:\nHard explore?')) {
        return 'hard explore answer';
      }
      if (prompt.includes('AOT_JUDGE_JSON') && prompt.includes('Proposed next Markov state:\nHard done?')) {
        return '{"selected":"next","accept_next_state":true,"reason":"ready now","refine_next_state":false}';
      }
      if (prompt.includes('AOT_JUDGE_JSON') && prompt.includes('Proposed next Markov state:\nHard explore?')) {
        return '{"selected":"next","accept_next_state":true,"reason":"keep exploring","refine_next_state":false}';
      }
      throw new Error(`Unexpected llm_query prompt: ${prompt}`);
    },
    llm_query_batched: async (prompts) => prompts.map((prompt) => {
      if (prompt.includes('AOT_CONTRACT_JSON') && prompt.includes('Current question:\nHard mixed?')) {
        return prompt.includes('Candidate sample: 1 / 2')
          ? '{"next_question":"Hard done?","ready":true,"reason":"done"}'
          : '{"next_question":"Hard explore?","ready":false,"reason":"explore"}';
      }
      throw new Error(`Unexpected llm_query_batched prompt: ${prompt}`);
    }),
  }, async () => {
    const lite = await runAOTLiteHelperFromConfig(baseConfig({
      maxIterations: 1,
      question: 'Lite continue?',
    }));
    assert.equal(lite.answer, 'lite next answer');
    assert.equal(lite.finalQuestion, 'Lite next?');
    assert.equal(lite.stoppedBecause, 'lite_max_iterations');

    const hard = await runAOTHardHelperFromConfig(baseConfig({
      beamWidth: 2,
      maxIterations: 1,
      question: 'Hard mixed?',
      transitionSamples: 2,
    }));
    assert.equal(hard.answer, 'hard done answer');
    assert.equal(hard.finalQuestion, 'Hard done?');
    assert.equal(hard.stoppedBecause, 'judge_selected_next_state');
  });
});
