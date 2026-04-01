/**
 * Shared runtime, journal, query, and execution types used across the published RLM package.
 *
 * @module
 *
 * @example
 * ```ts
 * import type { JsonValue, RLMLogger } from './types.ts';
 * ```
 */
/**
 * Describes one JSON scalar value accepted by the runtime.
 */
export type JsonPrimitive = boolean | null | number | string;

/**
 * Describes any JSON value accepted by the runtime.
 */
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

/**
 * Describes a JSON array whose elements are also JSON values.
 */
export interface JsonArray extends Array<JsonValue> {}

/**
 * Describes a JSON object with string keys and JSON-compatible values.
 */
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * Enumerates the scalar and structural value kinds supported by delegation contracts.
 */
export type RLMExpectValueKind =
  | 'array'
  | 'boolean'
  | 'null'
  | 'number'
  | 'object'
  | 'string';

/**
 * Describes a scalar expectation contract for a delegated child result.
 */
export interface RLMScalarExpectContract {
  field?: string;
  type: 'boolean' | 'null' | 'number' | 'string';
}

/**
 * Describes an object expectation contract for a delegated child result.
 */
export interface RLMObjectExpectContract {
  fields?: Record<string, RLMExpectValueKind>;
  requiredKeys?: string[];
  type: 'object';
}

/**
 * Describes an array expectation contract for a delegated child result.
 */
export interface RLMArrayExpectContract {
  minItems?: number;
  type: 'array';
}

/**
 * Describes any supported delegated-child expectation contract.
 */
export type RLMExpectContract =
  | RLMArrayExpectContract
  | RLMObjectExpectContract
  | RLMScalarExpectContract;

/**
 * Describes the shorthand object form used to request one-field or multi-field outputs.
 */
export type RLMExpectShorthand = Record<string, RLMExpectValueKind>;

/**
 * Describes all accepted input shapes for a delegated-child expectation.
 */
export type RLMExpectInput = RLMExpectContract | RLMExpectShorthand | string;

/**
 * Describes a structured child-task delegation request passed to `rlm_query(...)`.
 */
export interface RLMDelegationRequest {
  expect?: RLMExpectInput;
  payload?: JsonValue;
  task: string;
}

/**
 * Describes one typed signal extracted from a runtime value snapshot.
 */
export interface ValueSignal {
  kind:
    | 'bigint'
    | 'boolean'
    | 'null'
    | 'number'
    | 'string'
    | 'undefined';
  path: string;
  preview: string;
}

/**
 * Captures a previewable snapshot of a runtime value emitted by the REPL.
 */
export interface ValueSnapshot {
  json?: JsonValue;
  kind:
    | 'array'
    | 'bigint'
    | 'boolean'
    | 'function'
    | 'null'
    | 'number'
    | 'object'
    | 'string'
    | 'symbol'
    | 'undefined';
  preview: string;
  signals?: ValueSignal[];
}

/**
 * Summarizes token usage for one concrete model id.
 */
export interface ModelUsageSummary {
  cachedInputTokens: number;
  inputTokens: number;
  model: string;
  outputTokens: number;
  reportedRequests: number;
  requests: number;
  totalTokens: number;
}

/**
 * Aggregates token usage across one RLM run.
 */
export interface RLMUsageSummary {
  byModel: ModelUsageSummary[];
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reportedRequests: number;
  requests: number;
  totalTokens: number;
}

/**
 * Captures a structured execution error emitted by a REPL cell.
 */
export interface ExecutionErrorSnapshot {
  message: string;
  name: string;
  stack?: string;
}

/**
 * Enumerates the completion states recorded for one REPL cell.
 */
export type CellStatus = 'error' | 'success' | 'timeout';

/**
 * Describes the session header entry written at the start of one journal.
 */
export interface SessionEntry {
  context: JsonValue | null;
  createdAt: string;
  defaultTimeoutMs: number;
  sessionId: string;
  type: 'session';
}

/**
 * Describes one executed REPL cell stored in the journal.
 */
export interface CellEntry {
  cellId: string;
  code: string;
  durationMs: number;
  endedAt: string;
  error: ExecutionErrorSnapshot | null;
  finalAnswer: string | null;
  finalResult?: ValueSnapshot | null;
  replayedCellIds: string[];
  result: ValueSnapshot;
  startedAt: string;
  status: CellStatus;
  stderr: string;
  stdout: string;
  type: 'cell';
}

/**
 * Describes one assistant turn emitted by the orchestration loop.
 */
export interface AssistantTurnEntry {
  assistantText: string;
  createdAt: string;
  model: string;
  step: number;
  type: 'assistant_turn';
}

/**
 * Describes one evaluator-feedback entry emitted during a run.
 */
export interface EvaluatorFeedbackEntry {
  createdAt: string;
  feedback: string;
  model: string;
  step: number;
  type: 'evaluator_feedback';
}

/**
 * Describes one nested subquery summary written to the journal.
 */
export interface SubqueryEntry {
  answer: JsonValue | null;
  createdAt: string;
  depth: number;
  journalPath?: string;
  model: string;
  prompt: string;
  steps: number;
  type: 'subquery';
}

/**
 * Describes one standalone-stage failure persisted for later inspection.
 */
export interface StandaloneErrorEntry {
  createdAt: string;
  message: string;
  stage: 'login' | 'models' | 'render' | 'run';
  type: 'standalone_error';
}

/**
 * Describes every append-only journal entry shape used by the runtime.
 */
export type JournalEntry =
  | AssistantTurnEntry
  | CellEntry
  | EvaluatorFeedbackEntry
  | SessionEntry
  | StandaloneErrorEntry
  | SubqueryEntry;

/**
 * Describes the logger surface used by the runtime to persist journals.
 */
export interface RLMLogger {
  append(entry: JournalEntry): Promise<void> | void;
  close?(): Promise<void> | void;
  load?(): Promise<LoadedJournal> | LoadedJournal;
}

/**
 * Describes one optional timeout override for a single REPL execution.
 */
export interface ExecuteOptions {
  timeoutMs?: number;
}

/**
 * Extends a recorded cell entry with the visible history length after execution.
 */
export interface ExecuteResult extends CellEntry {
  historyLength: number;
}

/**
 * Describes the JSON-compatible value returned by `llm_query(...)`.
 */
export type LLMQueryResult = JsonValue;

/**
 * Describes shared invocation options accepted by REPL query bridges.
 */
export interface QueryInvocationOptions {
  signal?: AbortSignal;
}

/**
 * Describes the host-side bridge used by `llm_query(...)`.
 */
export type LLMQueryHandler = (
  prompt: string,
  options?: QueryInvocationOptions,
) => LLMQueryResult | Promise<LLMQueryResult>;

/**
 * Describes the accepted prompt shapes for `rlm_query(...)`.
 */
export type RLMQueryInput = RLMDelegationRequest | string;

/**
 * Describes the JSON-compatible value returned by `rlm_query(...)`.
 */
export type RLMQueryResult = JsonValue;

/**
 * Describes the host-side bridge used by `rlm_query(...)`.
 */
export type RLMQueryHandler = (
  prompt: RLMQueryInput,
  options?: QueryInvocationOptions,
) => RLMQueryResult | Promise<RLMQueryResult>;

/**
 * Describes the optional wiring used to create one `ReplSession`.
 */
export interface ReplSessionOptions {
  clock?: () => Date;
  context?: JsonValue | null;
  defaultTimeoutMs?: number;
  executionBackend?: ExecutionBackend;
  idGenerator?: () => string;
  journalPath?: string;
  llmQueryHandler?: LLMQueryHandler;
  rlmQueryHandler?: RLMQueryHandler;
  logger?: RLMLogger;
}

/**
 * Describes the replayable subset reconstructed from a journal load.
 */
export interface LoadedJournal {
  cells: CellEntry[];
  session: SessionEntry | null;
}

/**
 * Describes a persistent runtime that can execute cells and optionally close itself.
 */
export interface PersistentRuntimeLike {
  close?(): Promise<void> | void;
  execute(input: {
    code: string;
    history: CellEntry[];
    timeoutMs: number;
  }): Promise<{
    error: ExecutionErrorSnapshot | null;
    finalAnswer: string | null;
    finalResult?: ValueSnapshot | null;
    result: ValueSnapshot;
    status: 'error' | 'success';
    stderr: string;
    stdout: string;
  }>;
}

/**
 * Describes the factory surface that creates one persistent execution runtime.
 */
export interface ExecutionBackend {
  createRuntime(options: {
    context: JsonValue | null;
    llmQueryHandler?: LLMQueryHandler;
    rlmQueryHandler?: RLMQueryHandler;
  }): PersistentRuntimeLike;
}
