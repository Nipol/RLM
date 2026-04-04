/**
 * Serialized AoT runtime-helper source derived from small authoring functions.
 *
 * @module
 *
 * @example
 * ```ts
 * import { AOT_HELPER_SOURCE } from './source.ts';
 * ```
 */
import { serializeRuntimeHelperSource } from '../../src/index.ts';
import {
  extractJsonCandidate,
  normalizeContraction,
  normalizeDecomposition,
  normalizeFrontierDecision,
  normalizeJudgeDecision,
  normalizeSubquestions,
  parseStrictJson,
  stripCodeFence,
} from './runtime_json.ts';
import {
  buildAtomSolvePrompt,
  buildContractionPrompt,
  buildDecompositionPrompt,
  buildFrontierPrompt,
  buildGraphSolvePrompt,
  buildJudgePrompt,
  buildReflectionPrompt,
  buildStateSolvePrompt,
  renderOriginalQuestionBlock,
} from './runtime_prompts.ts';
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
} from './runtime_shared.ts';
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
} from './runtime_solver.ts';

const AOT_HELPER_FUNCTIONS = [
  isPlainObject,
  trimText,
  clampInteger,
  stringifyJson,
  renderSharedContext,
  renderState,
  normalizeAnswerText,
  extractQuestionFromObject,
  usesLiteAoTSettings,
  normalizeInput,
  stripCodeFence,
  extractJsonCandidate,
  parseStrictJson,
  normalizeSubquestions,
  normalizeDecomposition,
  normalizeContraction,
  normalizeFrontierDecision,
  normalizeJudgeDecision,
  buildDecompositionPrompt,
  renderOriginalQuestionBlock,
  buildAtomSolvePrompt,
  buildContractionPrompt,
  buildFrontierPrompt,
  buildStateSolvePrompt,
  buildGraphSolvePrompt,
  buildJudgePrompt,
  buildReflectionPrompt,
  appendTracePath,
  chooseBestCompletedCandidate,
  solveIndependentSubquestions,
  solveStateAnswer,
  solveGraphAnswer,
  buildContractionCandidates,
  judgeTransition,
  orderSelectedAcceptedCandidates,
  rankFrontierCandidates,
  selectJudgeAnswer,
  evaluateNextStateCandidate,
  refineRejectedState,
  finalizeSelectedAcceptedCandidate,
  expandFrontierNode,
  runAOTLiteHelperFromConfig,
  runAOTHardHelperFromConfig,
  runAOTHelper,
];

/**
 * Exposes the final pure-JavaScript helper body registered with the runtime.
 */
export const AOT_HELPER_SOURCE: string = serializeRuntimeHelperSource({
  entrypoint: 'runAOTHelper',
  functions: AOT_HELPER_FUNCTIONS,
});
