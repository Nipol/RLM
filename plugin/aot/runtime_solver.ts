/**
 * Runtime-calling AoT functions that become the serialized helper body.
 *
 * @module
 *
 * @example
 * ```ts
 * import { runAOTHelper } from './runtime_solver.ts';
 * ```
 */
import type { RLMRuntimeHelperGlobals } from '../../src/index.ts';
import type {
  AoTContraction,
  AoTDecomposition,
  AoTJudgeDecision,
  AoTNormalizedInput,
  AoTSolvedSubquestion,
} from './types.ts';
import {
  normalizeContraction,
  normalizeDecomposition,
  normalizeFrontierDecision,
  normalizeJudgeDecision,
  parseStrictJson,
} from './runtime_json.ts';
import { normalizeAnswerText, normalizeInput, usesLiteAoTSettings } from './runtime_shared.ts';
import {
  buildAtomSolvePrompt,
  buildContractionPrompt,
  buildDecompositionPrompt,
  buildFrontierPrompt,
  buildGraphSolvePrompt,
  buildJudgePrompt,
  buildReflectionPrompt,
  buildStateSolvePrompt,
} from './runtime_prompts.ts';

declare const llm_query: RLMRuntimeHelperGlobals['llm_query'];
declare const llm_query_batched: RLMRuntimeHelperGlobals['llm_query_batched'];

interface AoTFrontierNode {
  path: unknown[];
  question: string;
  score: number;
}

interface AoTAcceptedCandidate {
  answer: string;
  id: string;
  parentPath: unknown[];
  parentScore: number;
  question: string;
  ready: boolean;
  traceEntry: Record<string, unknown>;
}

interface AoTCompletedCandidate {
  answer: string;
  path: unknown[];
  priority: number;
  question: string;
  score: number;
  stoppedBecause: string;
}

interface AoTTransitionEvaluation {
  judgeDecision: AoTJudgeDecision;
  nextAnswer: string;
}

interface AoTFinalizedAcceptedCandidate {
  answer: string;
  path: unknown[];
  question: string;
  ready: boolean;
  score: number;
  traceEntry: Record<string, unknown>;
}

interface AoTHelperResult {
  answer: string;
  finalQuestion: string;
  iterations: unknown[];
  maxIterations: number;
  originalQuestion: string;
  stoppedBecause: string;
}

interface AoTExpandedFrontierNode {
  acceptedCandidates: Array<{
    answer: string;
    parentPath: unknown[];
    parentScore: number;
    question: string;
    ready: boolean;
    traceEntry: Record<string, unknown>;
  }>;
  completedCandidates: AoTCompletedCandidate[];
}

/**
 * Solves the currently independent AoT subquestions with runtime query helpers.
 */
export async function solveIndependentSubquestions(
  independentSubquestions: Array<{ id: string; question: string }>,
  parentQuestion: string,
  config: { context: unknown },
): Promise<AoTSolvedSubquestion[]> {
  const prompts = independentSubquestions.map((subquestion) =>
    buildAtomSolvePrompt(subquestion, parentQuestion, config)
  );
  const rawAnswers = prompts.length === 1
    ? [await llm_query(prompts[0])]
    : await llm_query_batched(prompts);

  return independentSubquestions.map((subquestion, index) => ({
    answer: normalizeAnswerText(rawAnswers[index]),
    id: subquestion.id,
    question: subquestion.question,
  }));
}

/**
 * Solves the original question from one answer-equivalent Markov state.
 */
export async function solveStateAnswer(
  originalQuestion: string,
  stateQuestion: string,
  config: { context: unknown; goal: string | null },
): Promise<string> {
  return normalizeAnswerText(
    await llm_query(buildStateSolvePrompt(originalQuestion, stateQuestion, config)),
  );
}

/**
 * Solves the original question from the temporary DAG state `G_i`.
 */
export async function solveGraphAnswer(
  originalQuestion: string,
  currentQuestion: string,
  decomposition: AoTDecomposition,
  solvedIndependentSubquestions: AoTSolvedSubquestion[],
  config: { context: unknown; goal: string | null },
): Promise<string> {
  return normalizeAnswerText(
    await llm_query(
      buildGraphSolvePrompt(
        originalQuestion,
        currentQuestion,
        decomposition,
        solvedIndependentSubquestions,
        config,
      ),
    ),
  );
}

/**
 * Samples one or more contracted next-state candidates for the current transition.
 */
export async function buildContractionCandidates(
  currentQuestion: string,
  decomposition: AoTDecomposition,
  solvedIndependentSubquestions: AoTSolvedSubquestion[],
  config: { context: unknown; transitionSamples: number },
): Promise<AoTContraction[]> {
  const prompts = Array.from(
    { length: config.transitionSamples },
    (_value, index) =>
      buildContractionPrompt(
        currentQuestion,
        decomposition,
        solvedIndependentSubquestions,
        config,
        {
          sampleIndex: index,
          totalSamples: config.transitionSamples,
        },
      ),
  );
  const rawContractions = prompts.length === 1
    ? [await llm_query(prompts[0])]
    : await llm_query_batched(prompts);
  const seenQuestions = new Set<string>();
  const candidates: AoTContraction[] = [];

  for (const rawContraction of rawContractions) {
    const candidate = normalizeContraction(parseStrictJson(rawContraction, 'contraction'));
    if (seenQuestions.has(candidate.nextQuestion)) {
      continue;
    }

    seenQuestions.add(candidate.nextQuestion);
    candidates.push(candidate);
  }

  return candidates;
}

/**
 * Runs the LLM-as-a-judge step for one candidate transition.
 */
export async function judgeTransition(
  originalQuestion: string,
  currentQuestion: string,
  nextQuestion: string,
  candidates: {
    currentAnswer: string;
    graphAnswer: string;
    nextAnswer: string;
  },
): Promise<AoTJudgeDecision> {
  return normalizeJudgeDecision(
    parseStrictJson(
      await llm_query(
        buildJudgePrompt(originalQuestion, currentQuestion, nextQuestion, candidates),
      ),
      'judge',
    ),
  );
}

/**
 * Returns the answer chosen by the judge from the current, graph, or next candidate.
 */
export function selectJudgeAnswer(
  judgeDecision: AoTJudgeDecision,
  candidates: {
    currentAnswer: string;
    graphAnswer: string;
    nextAnswer: string;
  },
): string {
  if (judgeDecision.answer !== null) {
    return judgeDecision.answer;
  }

  if (judgeDecision.selected === 'graph') {
    return candidates.graphAnswer;
  }

  if (judgeDecision.selected === 'next') {
    return candidates.nextAnswer;
  }

  return candidates.currentAnswer;
}

/**
 * Evaluates one next-state candidate by solving and judging it.
 */
export async function evaluateNextStateCandidate(
  originalQuestion: string,
  currentQuestion: string,
  currentAnswer: string,
  graphAnswer: string,
  contraction: AoTContraction,
  config: { context: unknown; goal: string | null },
): Promise<AoTTransitionEvaluation> {
  const nextAnswer = await solveStateAnswer(originalQuestion, contraction.nextQuestion, config);
  const judgeDecision = await judgeTransition(
    originalQuestion,
    currentQuestion,
    contraction.nextQuestion,
    {
      currentAnswer,
      graphAnswer,
      nextAnswer,
    },
  );

  return {
    judgeDecision,
    nextAnswer,
  };
}

/**
 * Attempts one reflective refinement for a rejected candidate state.
 */
export async function refineRejectedState(
  originalQuestion: string,
  currentQuestion: string,
  decomposition: AoTDecomposition,
  solvedIndependentSubquestions: AoTSolvedSubquestion[],
  rejectedNextQuestion: string,
  judgeReason: string,
  config: { context: unknown; goal: string | null },
): Promise<AoTContraction> {
  return normalizeContraction(
    parseStrictJson(
      await llm_query(
        buildReflectionPrompt(
          originalQuestion,
          currentQuestion,
          decomposition,
          solvedIndependentSubquestions,
          rejectedNextQuestion,
          judgeReason,
          config,
        ),
      ),
      'refine',
    ),
  );
}

/**
 * Ranks accepted next-state candidates at the current depth and selects a beam.
 */
export async function rankFrontierCandidates(
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
): Promise<{ reason: string; selectedIds: string[] }> {
  if (candidates.length <= beamWidth) {
    return {
      reason: 'All accepted candidates fit within the current beam width.',
      selectedIds: candidates.map((candidate) => candidate.id),
    };
  }

  const decision = normalizeFrontierDecision(
    parseStrictJson(
      await llm_query(buildFrontierPrompt(originalQuestion, candidates, beamWidth)),
      'frontier',
    ),
  );
  const fallbackIds = candidates.slice(0, beamWidth).map((candidate) => candidate.id);
  const selectedIds = decision.selectedIds.filter((id) =>
    candidates.some((candidate) => candidate.id === id)
  );

  return {
    reason: decision.reason,
    selectedIds: selectedIds.length > 0 ? selectedIds.slice(0, beamWidth) : fallbackIds,
  };
}

/**
 * Appends one trace entry to a frontier path when trace recording is enabled.
 */
export function appendTracePath(
  path: unknown[],
  traceEntry: Record<string, unknown>,
  includeTrace: boolean,
): unknown[] {
  return includeTrace ? path.concat([traceEntry]) : path;
}

/**
 * Keeps the highest-priority completed candidate seen so far.
 */
export function chooseBestCompletedCandidate(
  currentBest: AoTCompletedCandidate | null,
  candidate: AoTCompletedCandidate,
): AoTCompletedCandidate {
  if (currentBest === null) {
    return candidate;
  }

  if (candidate.priority > currentBest.priority) {
    return candidate;
  }

  if (candidate.priority === currentBest.priority && candidate.score > currentBest.score) {
    return candidate;
  }

  return currentBest;
}

/**
 * Orders accepted depth candidates according to the frontier-ranking decision.
 */
export function orderSelectedAcceptedCandidates(
  candidates: AoTAcceptedCandidate[],
  selectedIds: string[],
): AoTAcceptedCandidate[] {
  const candidatesById = new Map(
    candidates.map((candidate) => [candidate.id, candidate] as const),
  );

  return selectedIds
    .map((id) => candidatesById.get(id) ?? null)
    .filter((candidate): candidate is AoTAcceptedCandidate => candidate !== null);
}

/**
 * Finalizes one selected accepted candidate after frontier-level pruning.
 */
export function finalizeSelectedAcceptedCandidate(
  candidate: AoTAcceptedCandidate,
  options: {
    beamWidth: number;
    frontierReason: string;
    frontierSelected: boolean;
    frontierRank: number;
    includeTrace: boolean;
    shouldAnnotateFrontier: boolean;
  },
): AoTFinalizedAcceptedCandidate {
  const frontierScore = candidate.parentScore +
    Math.max(1, options.beamWidth - options.frontierRank);
  const traceEntry = {
    ...candidate.traceEntry,
    frontierRank: options.frontierRank + 1,
    frontierScore,
    ...(options.shouldAnnotateFrontier
      ? {
        frontierReason: options.frontierReason,
        frontierSelected: options.frontierSelected,
      }
      : {}),
  };

  return {
    answer: candidate.answer,
    path: appendTracePath(candidate.parentPath, traceEntry, options.includeTrace),
    question: candidate.question,
    ready: candidate.ready,
    score: frontierScore,
    traceEntry,
  };
}

/**
 * Expands one frontier node into accepted next-state candidates and completed states.
 */
export async function expandFrontierNode(
  node: AoTFrontierNode,
  iteration: number,
  config: AoTNormalizedInput,
): Promise<AoTExpandedFrontierNode> {
  const currentQuestion = node.question;
  const decomposition: AoTDecomposition = normalizeDecomposition(
    parseStrictJson(
      await llm_query(buildDecompositionPrompt(currentQuestion, config)),
      'decomposition',
    ),
  );

  if (decomposition.atomic) {
    const answer = await solveStateAnswer(config.question, currentQuestion, config);
    const traceEntry = {
      contractedQuestion: currentQuestion,
      contractedQuestionAnswer: answer,
      currentStateAnswer: answer,
      decompositionReason: decomposition.reason,
      graphAnswer: answer,
      independentSubquestions: [],
      iteration,
      judgeAcceptedNextState: false,
      judgeReason: decomposition.reason || 'Question was already atomic.',
      judgeSelection: 'current',
      question: currentQuestion,
      ready: true,
      refinement: null,
      reason: decomposition.reason || 'Question was already atomic.',
      subquestions: decomposition.subquestions,
    };

    return {
      acceptedCandidates: [],
      completedCandidates: [{
        answer,
        path: appendTracePath(node.path, traceEntry, config.includeTrace),
        priority: 3,
        question: currentQuestion,
        score: node.score,
        stoppedBecause: 'atomic',
      }],
    };
  }

  const independentSubquestions = decomposition.subquestions
    .filter((subquestion) => subquestion.deps.length === 0)
    .slice(0, config.maxIndependentSubquestions);
  const currentStateAnswer = await solveStateAnswer(config.question, currentQuestion, config);

  if (independentSubquestions.length === 0) {
    const traceEntry = {
      contractedQuestion: currentQuestion,
      contractedQuestionAnswer: currentStateAnswer,
      currentStateAnswer,
      decompositionReason: decomposition.reason,
      graphAnswer: currentStateAnswer,
      independentSubquestions: [],
      iteration,
      judgeAcceptedNextState: false,
      judgeReason: 'No independent subquestions were available for contraction.',
      judgeSelection: 'current',
      question: currentQuestion,
      ready: true,
      refinement: null,
      reason: 'No independent subquestions were available for contraction.',
      subquestions: decomposition.subquestions,
    };

    return {
      acceptedCandidates: [],
      completedCandidates: [{
        answer: currentStateAnswer,
        path: appendTracePath(node.path, traceEntry, config.includeTrace),
        priority: 2,
        question: currentQuestion,
        score: node.score,
        stoppedBecause: 'no_independent_subquestion',
      }],
    };
  }

  const solvedIndependentSubquestions = await solveIndependentSubquestions(
    independentSubquestions,
    currentQuestion,
    config,
  );
  const graphAnswer = await solveGraphAnswer(
    config.question,
    currentQuestion,
    decomposition,
    solvedIndependentSubquestions,
    config,
  );
  const contractionCandidates = await buildContractionCandidates(
    currentQuestion,
    decomposition,
    solvedIndependentSubquestions,
    config,
  );
  const acceptedCandidates: Array<{
    answer: string;
    parentPath: unknown[];
    parentScore: number;
    question: string;
    ready: boolean;
    traceEntry: Record<string, unknown>;
  }> = [];
  const completedCandidates: AoTCompletedCandidate[] = [];
  let refinementBudget = config.maxRefinements;

  for (const contraction of contractionCandidates) {
    const evaluated = await evaluateNextStateCandidate(
      config.question,
      currentQuestion,
      currentStateAnswer,
      graphAnswer,
      contraction,
      config,
    );
    const selectedAnswer = selectJudgeAnswer(evaluated.judgeDecision, {
      currentAnswer: currentStateAnswer,
      graphAnswer,
      nextAnswer: evaluated.nextAnswer,
    });
    let accepted = evaluated.judgeDecision.selected === 'next' &&
      evaluated.judgeDecision.acceptNextState;
    let finalContraction = contraction;
    let finalEvaluation = evaluated;
    let refinementTrace: null | {
      judgeAcceptedNextState: boolean;
      judgeReason: string;
      judgeSelection: 'current' | 'graph' | 'next';
      nextQuestion: string;
      nextQuestionAnswer: string;
      reason: string;
    } = null;

    if (!accepted && evaluated.judgeDecision.refineNextState && refinementBudget > 0) {
      refinementBudget -= 1;
      const refinedContraction = await refineRejectedState(
        config.question,
        currentQuestion,
        decomposition,
        solvedIndependentSubquestions,
        contraction.nextQuestion,
        evaluated.judgeDecision.reason,
        config,
      );
      const refinedEvaluated = await evaluateNextStateCandidate(
        config.question,
        currentQuestion,
        currentStateAnswer,
        graphAnswer,
        refinedContraction,
        config,
      );
      refinementTrace = {
        judgeAcceptedNextState: refinedEvaluated.judgeDecision.acceptNextState,
        judgeReason: refinedEvaluated.judgeDecision.reason,
        judgeSelection: refinedEvaluated.judgeDecision.selected,
        nextQuestion: refinedContraction.nextQuestion,
        nextQuestionAnswer: refinedEvaluated.nextAnswer,
        reason: refinedContraction.reason,
      };
      accepted = refinedEvaluated.judgeDecision.selected === 'next' &&
        refinedEvaluated.judgeDecision.acceptNextState;
      finalContraction = refinedContraction;
      finalEvaluation = refinedEvaluated;
    }

    const finalSelectedAnswer = selectJudgeAnswer(finalEvaluation.judgeDecision, {
      currentAnswer: currentStateAnswer,
      graphAnswer,
      nextAnswer: finalEvaluation.nextAnswer,
    });
    const traceEntry = {
      contractedQuestion: finalContraction.nextQuestion,
      contractedQuestionAnswer: accepted ? finalEvaluation.nextAnswer : finalSelectedAnswer,
      currentStateAnswer,
      decompositionReason: decomposition.reason,
      graphAnswer,
      independentSubquestions: solvedIndependentSubquestions,
      iteration,
      judgeAcceptedNextState: finalEvaluation.judgeDecision.acceptNextState,
      judgeReason: finalEvaluation.judgeDecision.reason,
      judgeSelection: finalEvaluation.judgeDecision.selected,
      question: currentQuestion,
      ready: finalContraction.ready,
      refinement: refinementTrace,
      reason: finalContraction.reason,
      subquestions: decomposition.subquestions,
    };

    if (accepted) {
      acceptedCandidates.push({
        answer: finalContraction.ready ? finalSelectedAnswer : finalEvaluation.nextAnswer,
        parentPath: node.path,
        parentScore: node.score,
        question: finalContraction.nextQuestion,
        ready: finalContraction.ready,
        traceEntry,
      });
      continue;
    }

    completedCandidates.push({
      answer: finalSelectedAnswer,
      path: appendTracePath(node.path, traceEntry, config.includeTrace),
      priority: 1,
      question: currentQuestion,
      score: node.score,
      stoppedBecause: 'judge_terminated',
    });
  }

  return {
    acceptedCandidates,
    completedCandidates,
  };
}

/**
 * Runs a lightweight AoT pass that follows a single decomposition-contraction path.
 */
export async function runAOTLiteHelperFromConfig(
  config: AoTNormalizedInput,
): Promise<AoTHelperResult> {
  let currentQuestion = config.question;
  let tracePath: unknown[] = [];

  for (let iteration = 1; iteration <= config.maxIterations; iteration += 1) {
    const decomposition: AoTDecomposition = normalizeDecomposition(
      parseStrictJson(
        await llm_query(buildDecompositionPrompt(currentQuestion, config)),
        'decomposition',
      ),
    );

    if (decomposition.atomic) {
      const answer = await solveStateAnswer(config.question, currentQuestion, config);
      return {
        answer,
        finalQuestion: currentQuestion,
        iterations: config.includeTrace
          ? appendTracePath(tracePath, {
            contractedQuestion: currentQuestion,
            decompositionReason: decomposition.reason,
            independentSubquestions: [],
            iteration,
            mode: 'lite',
            question: currentQuestion,
            ready: true,
            reason: decomposition.reason || 'Question was already atomic.',
            subquestions: decomposition.subquestions,
          }, true)
          : [],
        maxIterations: config.maxIterations,
        originalQuestion: config.question,
        stoppedBecause: 'lite_atomic',
      };
    }

    const independentSubquestions = decomposition.subquestions
      .filter((subquestion) => subquestion.deps.length === 0)
      .slice(0, config.maxIndependentSubquestions);

    if (independentSubquestions.length === 0) {
      const answer = await solveStateAnswer(config.question, currentQuestion, config);
      return {
        answer,
        finalQuestion: currentQuestion,
        iterations: config.includeTrace
          ? appendTracePath(tracePath, {
            contractedQuestion: currentQuestion,
            decompositionReason: decomposition.reason,
            independentSubquestions: [],
            iteration,
            mode: 'lite',
            question: currentQuestion,
            ready: true,
            reason: 'No independent subquestions were available for contraction.',
            subquestions: decomposition.subquestions,
          }, true)
          : [],
        maxIterations: config.maxIterations,
        originalQuestion: config.question,
        stoppedBecause: 'lite_no_independent_subquestion',
      };
    }

    const solvedIndependentSubquestions = await solveIndependentSubquestions(
      independentSubquestions,
      currentQuestion,
      config,
    );
    const contractionCandidates = await buildContractionCandidates(
      currentQuestion,
      decomposition,
      solvedIndependentSubquestions,
      {
        ...config,
        transitionSamples: 1,
      },
    );
    const selectedContraction = contractionCandidates[0]!;
    const traceEntry = {
      contractedQuestion: selectedContraction.nextQuestion,
      decompositionReason: decomposition.reason,
      independentSubquestions: solvedIndependentSubquestions,
      iteration,
      mode: 'lite',
      question: currentQuestion,
      ready: selectedContraction.ready,
      reason: selectedContraction.reason,
      subquestions: decomposition.subquestions,
    };
    tracePath = appendTracePath(tracePath, traceEntry, config.includeTrace);

    if (selectedContraction.ready) {
      return {
        answer: await solveStateAnswer(config.question, selectedContraction.nextQuestion, config),
        finalQuestion: selectedContraction.nextQuestion,
        iterations: config.includeTrace ? tracePath : [],
        maxIterations: config.maxIterations,
        originalQuestion: config.question,
        stoppedBecause: 'lite_ready',
      };
    }

    currentQuestion = selectedContraction.nextQuestion;
  }

  return {
    answer: await solveStateAnswer(config.question, currentQuestion, config),
    finalQuestion: currentQuestion,
    iterations: config.includeTrace ? tracePath : [],
    maxIterations: config.maxIterations,
    originalQuestion: config.question,
    stoppedBecause: 'lite_max_iterations',
  };
}

/**
 * Runs the full AoT search loop over one normalized input using runtime query helpers only.
 */
export async function runAOTHardHelperFromConfig(
  config: AoTNormalizedInput,
): Promise<AoTHelperResult> {
  let frontier: AoTFrontierNode[] = [{
    path: [],
    question: config.question,
    score: 0,
  }];
  let bestCompletedCandidate: AoTCompletedCandidate | null = null;
  let finalCandidate:
    | {
      answer: string;
      path: unknown[];
      question: string;
      stoppedBecause: string;
    }
    | null = null;

  for (let iteration = 1; iteration <= config.maxIterations; iteration += 1) {
    const nextFrontier: AoTFrontierNode[] = [];
    const acceptedCandidates: AoTAcceptedCandidate[] = [];
    let candidateCounter = 1;

    for (const node of frontier) {
      const expanded = await expandFrontierNode(node, iteration, config);
      for (const completedCandidate of expanded.completedCandidates) {
        bestCompletedCandidate = chooseBestCompletedCandidate(
          bestCompletedCandidate,
          completedCandidate,
        );
      }

      for (const acceptedCandidate of expanded.acceptedCandidates) {
        acceptedCandidates.push({
          ...acceptedCandidate,
          id: `c${String(candidateCounter)}`,
        });
        candidateCounter += 1;
      }
    }

    if (acceptedCandidates.length === 0) {
      finalCandidate = {
        answer: bestCompletedCandidate!.answer,
        path: bestCompletedCandidate!.path,
        question: bestCompletedCandidate!.question,
        stoppedBecause: bestCompletedCandidate!.stoppedBecause,
      };
      break;
    }

    const frontierWasRanked = acceptedCandidates.length > config.beamWidth;
    const frontierDecision = await rankFrontierCandidates(
      config.question,
      acceptedCandidates.map((candidate) => ({
        answer: candidate.answer,
        id: candidate.id,
        judgeReason: String(candidate.traceEntry.judgeReason ?? ''),
        pathScore: candidate.parentScore,
        question: candidate.question,
        ready: candidate.ready,
      })),
      config.beamWidth,
    );
    const selectedCandidates = orderSelectedAcceptedCandidates(
      acceptedCandidates,
      frontierDecision.selectedIds,
    );

    for (let index = 0; index < selectedCandidates.length; index += 1) {
      const candidate = selectedCandidates[index]!;
      const finalizedCandidate = finalizeSelectedAcceptedCandidate(candidate, {
        beamWidth: config.beamWidth,
        frontierReason: frontierDecision.reason,
        frontierSelected: true,
        frontierRank: index,
        includeTrace: config.includeTrace,
        shouldAnnotateFrontier: acceptedCandidates.length > 1,
      });

      if (candidate.ready) {
        bestCompletedCandidate = chooseBestCompletedCandidate(
          bestCompletedCandidate,
          {
            answer: finalizedCandidate.answer,
            path: finalizedCandidate.path,
            priority: 4,
            question: finalizedCandidate.question,
            score: finalizedCandidate.score,
            stoppedBecause: 'judge_selected_next_state',
          },
        );
        continue;
      }

      nextFrontier.push({
        path: finalizedCandidate.path,
        question: finalizedCandidate.question,
        score: finalizedCandidate.score,
      });
    }

    if (nextFrontier.length === 0) {
      finalCandidate = {
        answer: bestCompletedCandidate!.answer,
        path: bestCompletedCandidate!.path,
        question: bestCompletedCandidate!.question,
        stoppedBecause: bestCompletedCandidate!.stoppedBecause,
      };
      break;
    }

    frontier = nextFrontier;
  }

  if (finalCandidate === null) {
    if (bestCompletedCandidate !== null) {
      finalCandidate = {
        answer: bestCompletedCandidate.answer,
        path: bestCompletedCandidate.path,
        question: bestCompletedCandidate.question,
        stoppedBecause: bestCompletedCandidate.stoppedBecause,
      };
    } else {
      const question = frontier[0]?.question ?? config.question;
      finalCandidate = {
        answer: await solveStateAnswer(config.question, question, config),
        path: frontier[0]?.path ?? [],
        question,
        stoppedBecause: 'max_iterations',
      };
    }
  }

  return {
    answer: finalCandidate.answer,
    finalQuestion: finalCandidate.question,
    iterations: config.includeTrace ? finalCandidate.path : [],
    maxIterations: config.maxIterations,
    originalQuestion: config.question,
    stoppedBecause: finalCandidate.stoppedBecause,
  };
}

/**
 * Runs the AoT helper over one input using either the lightweight single-path
 * configuration or the full hard-search configuration.
 */
export async function runAOTHelper(input: unknown): Promise<AoTHelperResult> {
  const config: AoTNormalizedInput = normalizeInput(input);
  if (usesLiteAoTSettings(config)) {
    return await runAOTLiteHelperFromConfig(config);
  }

  return await runAOTHardHelperFromConfig(config);
}
