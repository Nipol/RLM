/**
 * Prompt builders for AoT runtime helper authoring.
 *
 * @module
 *
 * @example
 * ```ts
 * import { buildFinalPrompt } from './runtime_prompts.ts';
 * ```
 */
import { renderSharedContext, renderState, stringifyJson } from './runtime_shared.ts';

/**
 * Renders the original-question block reused across AoT prompts.
 */
export function renderOriginalQuestionBlock(originalQuestion: string): string {
  return [
    'Original question:',
    originalQuestion,
  ].join('\n');
}

/**
 * Builds the decomposition prompt for the current AoT state.
 */
export function buildDecompositionPrompt(question: string, config: {
  context: unknown;
  goal: string | null;
}): string {
  return [
    'AOT_DECOMPOSE_JSON',
    'Return strict JSON only.',
    'Decompose the current question into a dependency DAG of short, self-contained subquestions.',
    'If shared context or the document does not contain a direct lookup answer, decompose the question into informative atomic questions that help build the richest helpful response.',
    'Schema: {"atomic": boolean, "reason": string, "subquestions": [{"id": "q1", "question": "...", "deps": []}]}',
    'Set atomic=true and return an empty subquestions array when the question is already directly answerable as one atomic state.',
    'Dependencies must reference only earlier subquestion ids.',
    '',
    renderState(question, config),
  ].join('\n');
}

/**
 * Builds the prompt used to solve one independent atomic subquestion.
 */
export function buildAtomSolvePrompt(
  subquestion: { question: string },
  parentQuestion: string,
  config: { context: unknown },
): string {
  const lines = [
    'AOT_ATOM_SOLVE',
    'Return only the answer to the atomic subquestion. Do not include chain-of-thought.',
    '',
    'Atomic subquestion:',
    subquestion.question,
    '',
    'Parent question:',
    parentQuestion,
  ];

  const sharedContext = renderSharedContext(config.context);
  if (sharedContext !== null) {
    lines.push('', 'Shared context:', sharedContext);
  }

  return lines.join('\n');
}

/**
 * Builds the prompt used to contract solved atomic answers into the next state.
 */
export function buildContractionPrompt(
  question: string,
  decomposition: { subquestions: unknown },
  solvedIndependentSubquestions: unknown,
  config: { context: unknown },
  options: {
    sampleIndex?: number;
    totalSamples?: number;
  } = {},
): string {
  const lines = [
    'AOT_CONTRACT_JSON',
    'Return strict JSON only.',
    'Contract the current question into the next self-contained question state by folding solved atomic answers into the question.',
    'Schema: {"ready": boolean, "next_question": string, "reason": string}',
    'Set ready=true when next_question is already a directly answerable final contracted state.',
    '',
    'Current question:',
    question,
    '',
    'Solved independent subquestions:',
    stringifyJson(solvedIndependentSubquestions),
    '',
    'Decomposition DAG:',
    stringifyJson(decomposition.subquestions),
  ];

  if ((options.totalSamples ?? 1) > 1) {
    lines.push(
      '',
      `Candidate sample: ${String((options.sampleIndex ?? 0) + 1)} / ${
        String(options.totalSamples)
      }`,
      'Produce a distinct but still answer-equivalent contracted state when possible.',
    );
  }

  const sharedContext = renderSharedContext(config.context);
  if (sharedContext !== null) {
    lines.push('', 'Shared context:', sharedContext);
  }

  return lines.join('\n');
}

/**
 * Builds the direct state-solving prompt routed through `rlm_query(...)`.
 */
export function buildStateSolvePrompt(
  originalQuestion: string,
  question: string,
  config: {
    context: unknown;
    goal: string | null;
  },
): string {
  const lines = [
    'AOT_SOLVE_STATE',
    'Solve the original question by reasoning from the provided Markov state.',
    'Return only the final answer to the original question, without chain-of-thought.',
    '',
    renderOriginalQuestionBlock(originalQuestion),
    '',
    'Current Markov state:',
    question,
  ];

  if (config.goal !== null) {
    lines.push('', 'Target answer shape:', config.goal);
  }

  const sharedContext = renderSharedContext(config.context);
  if (sharedContext !== null) {
    lines.push('', 'Shared context:', sharedContext);
  }

  return lines.join('\n');
}

/**
 * Builds the graph-solving prompt routed through `rlm_query(...)`.
 */
export function buildGraphSolvePrompt(
  originalQuestion: string,
  question: string,
  decomposition: { subquestions: unknown },
  solvedIndependentSubquestions: unknown,
  config: { context: unknown; goal: string | null },
): string {
  const lines = [
    'AOT_SOLVE_GRAPH',
    'Solve the original question by using the decomposition DAG and the solved independent atomic subquestions.',
    'Return only the final answer to the original question, without chain-of-thought.',
    '',
    renderOriginalQuestionBlock(originalQuestion),
    '',
    'Current Markov state:',
    question,
    '',
    'Solved independent subquestions:',
    stringifyJson(solvedIndependentSubquestions),
    '',
    'Decomposition DAG:',
    stringifyJson(decomposition.subquestions),
  ];

  if (config.goal !== null) {
    lines.push('', 'Target answer shape:', config.goal);
  }

  const sharedContext = renderSharedContext(config.context);
  if (sharedContext !== null) {
    lines.push('', 'Shared context:', sharedContext);
  }

  return lines.join('\n');
}

/**
 * Builds the judge prompt used to compare solve(Qi), solve(Gi), and solve(Qi+1).
 */
export function buildJudgePrompt(
  originalQuestion: string,
  currentQuestion: string,
  nextQuestion: string,
  candidates: {
    currentAnswer: string;
    graphAnswer: string;
    nextAnswer: string;
  },
): string {
  return [
    'AOT_JUDGE_JSON',
    'Return strict JSON only.',
    'Choose the best answer to the original question from the three candidates.',
    'Judge whether the proposed next Markov state should be accepted.',
    'Accept the next state only if it preserves answer equivalence with the original question and plausibly reduces test-time reasoning complexity.',
    'If the next state is close but underspecified or low quality, request reflective refinement.',
    'Schema: {"selected": "current|graph|next", "answer": "...", "reason": "...", "accept_next_state": boolean, "refine_next_state": boolean}',
    '',
    renderOriginalQuestionBlock(originalQuestion),
    '',
    'Current Markov state:',
    currentQuestion,
    '',
    'Proposed next Markov state:',
    nextQuestion,
    '',
    'Candidate current solve:',
    candidates.currentAnswer,
    '',
    'Candidate graph solve:',
    candidates.graphAnswer,
    '',
    'Candidate next-state solve:',
    candidates.nextAnswer,
  ].join('\n');
}

/**
 * Builds the reflective refinement prompt for one rejected next state.
 */
export function buildReflectionPrompt(
  originalQuestion: string,
  currentQuestion: string,
  decomposition: { subquestions: unknown },
  solvedIndependentSubquestions: unknown,
  rejectedNextQuestion: string,
  judgeReason: string,
  config: { context: unknown; goal: string | null },
): string {
  const lines = [
    'AOT_REFINE_JSON',
    'Return strict JSON only.',
    'Refine the rejected next Markov state into a better answer-equivalent and lower-complexity self-contained state.',
    'Do not restate the original question verbatim unless that is truly the best reduced state.',
    'Schema: {"next_question": string, "ready": boolean, "reason": string}',
    '',
    renderOriginalQuestionBlock(originalQuestion),
    '',
    'Current Markov state:',
    currentQuestion,
    '',
    'Rejected next Markov state:',
    rejectedNextQuestion,
    '',
    'Judge feedback:',
    judgeReason,
    '',
    'Solved independent subquestions:',
    stringifyJson(solvedIndependentSubquestions),
    '',
    'Decomposition DAG:',
    stringifyJson(decomposition.subquestions),
  ];

  if (config.goal !== null) {
    lines.push('', 'Target answer shape:', config.goal);
  }

  const sharedContext = renderSharedContext(config.context);
  if (sharedContext !== null) {
    lines.push('', 'Shared context:', sharedContext);
  }

  return lines.join('\n');
}

/**
 * Builds the frontier-ranking prompt used to prune multiple accepted next states.
 */
export function buildFrontierPrompt(
  originalQuestion: string,
  candidates: Array<{
    answer: string;
    id: string;
    judgeReason: string;
    pathScore: number;
    question: string;
    ready: boolean;
  }>,
  beamWidth: number,
): string {
  return [
    'AOT_FRONTIER_JSON',
    'Return strict JSON only.',
    `Select up to ${String(beamWidth)} candidate ids to continue exploring at this depth.`,
    'Prefer candidates that remain answer-equivalent to the original question, reduce complexity, preserve more useful information, and continue stronger accumulated search paths when path_score suggests they are outperforming weaker branches.',
    'Schema: {"selected_ids": ["c1"], "reason": "..."}',
    '',
    renderOriginalQuestionBlock(originalQuestion),
    '',
    'Accepted next-state candidates:',
    stringifyJson(candidates),
  ].join('\n');
}

/**
 * Builds the final contracted-question prompt routed through `rlm_query(...)`.
 */
export function buildFinalPrompt(question: string, config: {
  context: unknown;
  goal: string | null;
}): string {
  return [
    'AOT_FINAL_QUESTION',
    'Solve the following contracted atomic question directly.',
    'Return only the final answer, without chain-of-thought.',
    'Prefer direct reasoning from the contracted question instead of decomposing again unless absolutely necessary.',
    'If the document or shared context lacks a direct lookup answer, still provide the richest helpful answer you can from the contracted question, shared context, and general reasoning.',
    '',
    renderState(question, config),
  ].join('\n');
}
