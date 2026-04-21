import assert from 'node:assert/strict';

import {
  extractJsonCandidate,
  normalizeContraction,
  normalizeDecomposition,
  normalizeFrontierDecision,
  normalizeJudgeDecision,
  normalizeSubquestions,
  parseStrictJson,
  stripCodeFence,
} from '../plugin/aot/runtime_json.ts';
import {
  buildAtomSolvePrompt,
  buildContractionPrompt,
  buildDecompositionPrompt,
  buildFinalPrompt,
  buildFrontierPrompt,
  buildGraphSolvePrompt,
  buildJudgePrompt,
  buildReflectionPrompt,
  buildStateSolvePrompt,
  renderOriginalQuestionBlock,
} from '../plugin/aot/runtime_prompts.ts';
import {
  clampInteger,
  extractQuestionFromObject,
  isPlainObject,
  normalizeAnswerText,
  normalizeInput,
  renderSharedContext,
  renderState,
  stringifyJson,
  trimText,
  usesLiteAoTSettings,
} from '../plugin/aot/runtime_shared.ts';
import { runPingPongHelper } from '../plugin/pingpong/runtime.ts';

Deno.test('AoT shared helpers cover normalization primitives and string rendering', () => {
  assert.equal(isPlainObject({ ok: true }), true);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(['x']), false);

  assert.equal(trimText('  hi  '), 'hi');
  assert.equal(trimText(42), '');

  assert.equal(clampInteger(undefined, 3, 1, 5), 3);
  assert.equal(clampInteger(9.9, 3, 1, 5), 5);
  assert.equal(clampInteger(-2, 3, 1, 5), 1);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(stringifyJson(cyclic), '[object Object]');

  assert.equal(renderSharedContext(undefined), null);
  assert.equal(renderSharedContext('   '), null);
  assert.equal(renderSharedContext(' hello '), 'hello');
  assert.match(renderSharedContext({ alpha: 1 }) ?? '', /"alpha": 1/u);

  assert.equal(
    renderState('What happened?', {
      context: { source: 'doc' },
      goal: 'one short sentence',
    }),
    [
      'Current question:',
      'What happened?',
      '',
      'Target answer shape:',
      'one short sentence',
      '',
      'Shared context:',
      '{\n  "source": "doc"\n}',
    ].join('\n'),
  );

  assert.equal(normalizeAnswerText('  answer  '), 'answer');
  assert.equal(normalizeAnswerText(null), '');
  assert.equal(normalizeAnswerText(7), '7');
  assert.match(normalizeAnswerText({ ok: true }), /"ok": true/u);
});

Deno.test('AoT input helpers cover question extraction, lite settings, and input normalization branches', () => {
  assert.equal(extractQuestionFromObject({ task: 'Explain this' }), 'Explain this');
  assert.equal(extractQuestionFromObject({ prompt: 'Prompt form' }), 'Prompt form');
  assert.equal(extractQuestionFromObject({ query: 'Query form' }), 'Query form');
  assert.equal(extractQuestionFromObject({}), '');

  assert.equal(
    usesLiteAoTSettings({ beamWidth: 1, maxRefinements: 0, transitionSamples: 1 }),
    true,
  );
  assert.equal(
    usesLiteAoTSettings({ beamWidth: 2, maxRefinements: 0, transitionSamples: 1 }),
    false,
  );

  assert.deepEqual(normalizeInput('  Explain the sky.  '), {
    beamWidth: 1,
    context: null,
    goal: null,
    includeTrace: true,
    maxIndependentSubquestions: 4,
    maxIterations: 3,
    maxRefinements: 1,
    question: 'Explain the sky.',
    transitionSamples: 1,
  });

  assert.throws(() => normalizeInput('   '), /requires a non-empty question string/u);
  assert.throws(
    () => normalizeInput(42),
    /expects either a non-empty question string or an object/u,
  );
  assert.throws(
    () => normalizeInput({ goal: 'brief' }),
    /require a non-empty question, task, prompt, or query field/u,
  );

  assert.deepEqual(
    normalizeInput({
      beamWidth: 9,
      context: { source: 'doc' },
      goal: 'brief',
      includeTrace: false,
      maxIndependentSubquestions: 9,
      maxIterations: 0,
      maxRefinements: 9,
      question: 'Summarize this.',
      transitionSamples: 0,
    }),
    {
      beamWidth: 2,
      context: { source: 'doc' },
      goal: 'brief',
      includeTrace: false,
      maxIndependentSubquestions: 4,
      maxIterations: 1,
      maxRefinements: 2,
      question: 'Summarize this.',
      transitionSamples: 1,
    },
  );
});

Deno.test('AoT JSON helpers cover strict parsing, normalization, aliases, and validation errors', () => {
  assert.equal(stripCodeFence('```json\n{"ok":true}\n```'), '{"ok":true}');
  assert.equal(extractJsonCandidate('note\n{"ok":true}\nmore'), '{"ok":true}');
  assert.equal(extractJsonCandidate('prefix [1,2,3] suffix'), '[1,2,3]');
  assert.deepEqual(parseStrictJson('```json\n{"ok":true}\n```', 'decomposition'), { ok: true });
  assert.throws(
    () => parseStrictJson('not-json', 'judge'),
    /aot\(judge\) expected strict JSON/u,
  );

  assert.deepEqual(
    normalizeSubquestions([
      null,
      { id: 'q1', question: 'First?', deps: ['q2', 'q2', 'q1', ''] },
      { id: 'q1', subquestion: 'Second?', dependencies: ['q1', 'missing'] },
      { text: 'Third?' },
      { id: 'q4', question: '' },
    ]),
    [
      { deps: ['q2'], id: 'q1', question: 'First?' },
      { deps: ['q1'], id: 'q2', question: 'Second?' },
      { deps: [], id: 'q3', question: 'Third?' },
    ],
  );
  assert.deepEqual(normalizeSubquestions('not-an-array'), []);
  assert.deepEqual(normalizeSubquestions([]), []);

  assert.deepEqual(
    normalizeDecomposition({ atomic: false, reason: 'needs split', subquestions: [{ id: 'q1', question: 'A', deps: [] }] }),
    {
      atomic: false,
      reason: 'needs split',
      subquestions: [{ id: 'q1', question: 'A', deps: [] }],
    },
  );
  assert.deepEqual(normalizeDecomposition({ reason: 'none', subquestions: [] }), {
    atomic: true,
    reason: 'none',
    subquestions: [],
  });
  assert.deepEqual(normalizeDecomposition('not-an-object'), {
    atomic: true,
    reason: '',
    subquestions: [],
  });

  assert.deepEqual(
    normalizeContraction({ contractedQuestion: 'Reduced?', ready: 1, reason: 'shorter' }),
    { nextQuestion: 'Reduced?', ready: true, reason: 'shorter' },
  );
  assert.throws(() => normalizeContraction('oops'), /must return a JSON object/u);
  assert.throws(() => normalizeContraction({ ready: false }), /must provide next_question/u);

  assert.deepEqual(
    normalizeJudgeDecision({
      acceptNextState: 1,
      answer: 'Next answer',
      reason: 'good',
      refine_next_state: 0,
      selected: 'NEXT',
    }),
    {
      acceptNextState: true,
      answer: 'Next answer',
      reason: 'good',
      refineNextState: false,
      selected: 'next',
    },
  );
  assert.deepEqual(
    normalizeJudgeDecision({ selected: 'unsupported' }),
    {
      acceptNextState: false,
      answer: null,
      reason: '',
      refineNextState: false,
      selected: 'current',
    },
  );
  assert.throws(() => normalizeJudgeDecision(null), /aot\(judge\) must return a JSON object/u);

  assert.deepEqual(
    normalizeFrontierDecision({ reason: 'keep top two', selectedIds: ['c1', '', 'c1', 'c2'] }),
    {
      reason: 'keep top two',
      selectedIds: ['c1', 'c2'],
    },
  );
  assert.deepEqual(
    normalizeFrontierDecision({ reason: 'no explicit selection' }),
    {
      reason: 'no explicit selection',
      selectedIds: [],
    },
  );
  assert.throws(
    () => normalizeFrontierDecision([]),
    /aot\(frontier\) must return a JSON object/u,
  );
});

Deno.test('AoT prompt builders cover optional context, goal, sampling, and final prompt sections', () => {
  assert.equal(
    renderOriginalQuestionBlock('What happened?'),
    ['Original question:', 'What happened?'].join('\n'),
  );

  assert.match(
    buildDecompositionPrompt('Explain this.', { context: { doc: 'x' }, goal: null }),
    /AOT_DECOMPOSE_JSON[\s\S]*Shared context:/u,
  );
  assert.match(
    buildAtomSolvePrompt({ question: 'Why?' }, 'Explain this.', { context: 'doc excerpt' }),
    /AOT_ATOM_SOLVE[\s\S]*Parent question:[\s\S]*Shared context:/u,
  );
  assert.match(
    buildContractionPrompt(
      'Explain this.',
      { subquestions: [{ id: 'q1', question: 'Why?', deps: [] }] },
      [{ id: 'q1', question: 'Why?', answer: 'Because.' }],
      { context: { doc: 'x' } },
      { sampleIndex: 1, totalSamples: 3 },
    ),
    /Candidate sample: 2 \/ 3[\s\S]*Shared context:/u,
  );
  assert.match(
    buildContractionPrompt(
      'Explain this.',
      { subquestions: [{ id: 'q1', question: 'Why?', deps: [] }] },
      [{ id: 'q1', question: 'Why?', answer: 'Because.' }],
      { context: null },
      { totalSamples: 2 },
    ),
    /Candidate sample: 1 \/ 2/u,
  );
  assert.doesNotMatch(
    buildContractionPrompt(
      'Explain this.',
      { subquestions: [{ id: 'q1', question: 'Why?', deps: [] }] },
      [{ id: 'q1', question: 'Why?', answer: 'Because.' }],
      { context: null },
    ),
    /Candidate sample:/u,
  );
  assert.match(
    buildStateSolvePrompt('Original?', 'Reduced?', { context: { doc: 'x' }, goal: 'brief' }),
    /AOT_SOLVE_STATE[\s\S]*Target answer shape:[\s\S]*Shared context:/u,
  );
  assert.match(
    buildGraphSolvePrompt(
      'Original?',
      'Reduced?',
      { subquestions: [{ id: 'q1', question: 'Why?', deps: [] }] },
      [{ id: 'q1', question: 'Why?', answer: 'Because.' }],
      { context: { doc: 'x' }, goal: 'brief' },
    ),
    /AOT_SOLVE_GRAPH[\s\S]*Solved independent subquestions:[\s\S]*Decomposition DAG:/u,
  );
  assert.match(
    buildJudgePrompt('Original?', 'Current?', 'Next?', {
      currentAnswer: 'current',
      graphAnswer: 'graph',
      nextAnswer: 'next',
    }),
    /AOT_JUDGE_JSON[\s\S]*Candidate next-state solve:/u,
  );
  assert.match(
    buildReflectionPrompt(
      'Original?',
      'Current?',
      { subquestions: [{ id: 'q1', question: 'Why?', deps: [] }] },
      [{ id: 'q1', question: 'Why?', answer: 'Because.' }],
      'Bad next state',
      'Too vague',
      { context: { doc: 'x' }, goal: 'brief' },
    ),
    /AOT_REFINE_JSON[\s\S]*Judge feedback:[\s\S]*Target answer shape:[\s\S]*Shared context:/u,
  );
  assert.match(
    buildFrontierPrompt('Original?', [{
      answer: 'answer',
      id: 'c1',
      judgeReason: 'good',
      pathScore: 2,
      question: 'Next state',
      ready: false,
    }], 2),
    /AOT_FRONTIER_JSON[\s\S]*Select up to 2 candidate ids/u,
  );
  assert.match(
    buildFinalPrompt('Final question', { context: 'doc excerpt', goal: 'brief' }),
    /AOT_FINAL_QUESTION[\s\S]*Target answer shape:[\s\S]*Shared context:/u,
  );
});

Deno.test('ping-pong runtime helper returns the expected sentinel values', () => {
  assert.equal(runPingPongHelper('PING'), 'PONG');
  assert.equal(runPingPongHelper('HELLO'), 'UNKNOWN');
});
