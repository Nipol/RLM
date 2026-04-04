/**
 * Authoring-only types used to structure the AoT plugin implementation.
 *
 * @module
 *
 * @example
 * ```ts
 * import type { AoTNormalizedInput } from './types.ts';
 * ```
 */

/**
 * Describes one normalized AoT input after user input parsing.
 */
export interface AoTNormalizedInput {
  beamWidth: number;
  context: unknown;
  goal: string | null;
  includeTrace: boolean;
  maxIndependentSubquestions: number;
  maxIterations: number;
  maxRefinements: number;
  question: string;
  transitionSamples: number;
}

/**
 * Describes one normalized AoT DAG node.
 */
export interface AoTSubquestion {
  deps: string[];
  id: string;
  question: string;
}

/**
 * Describes one normalized decomposition step.
 */
export interface AoTDecomposition {
  atomic: boolean;
  reason: string;
  subquestions: AoTSubquestion[];
}

/**
 * Describes one normalized contraction step.
 */
export interface AoTContraction {
  nextQuestion: string;
  ready: boolean;
  reason: string;
}

/**
 * Describes one solved independent atomic subquestion.
 */
export interface AoTSolvedSubquestion {
  answer: string;
  id: string;
  question: string;
}

/**
 * Describes one normalized answer candidate evaluated during a transition.
 */
export interface AoTAnswerCandidate {
  answer: string;
  kind: 'current' | 'graph' | 'next';
  question: string;
}

/**
 * Describes the normalized judge output for one AoT transition.
 */
export interface AoTJudgeDecision {
  acceptNextState: boolean;
  answer: string | null;
  reason: string;
  refineNextState: boolean;
  selected: 'current' | 'graph' | 'next';
}

/**
 * Describes the normalized frontier-pruning decision for one AoT depth.
 */
export interface AoTFrontierDecision {
  reason: string;
  selectedIds: string[];
}
