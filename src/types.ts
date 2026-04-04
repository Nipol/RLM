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
  /**
   * Overrides the child run step budget for this one delegated `rlm_query(...)`
   * request. Finite values must be positive integers.
   */
  maxSteps?: number;
  /**
   * Narrows the maximum recursive `rlm_query(...)` depth allowed for this one
   * delegated child run. The effective limit is still capped by the parent
   * bridge's configured `maxSubcallDepth`.
   */
  maxSubcallDepth?: number;
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
 * Describes one debug trace emitted for `llm_query(...)` or `rlm_query(...)`.
 */
export interface QueryTraceEntry {
  createdAt: string;
  depth: number;
  durationMs: number;
  kind: 'llm_query' | 'rlm_query';
  maxSteps?: number | 'unbounded';
  maxSubcallDepth?: number;
  model: string;
  promptPreview: string;
  promptTag?: string;
  queryIndex: number;
  status: 'error' | 'success';
  steps?: number;
  type: 'query_trace';
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
  | QueryTraceEntry
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
  /**
   * Overrides the delegated child run step budget for one `rlm_query(...)`
   * call. Runtime-helper wrappers use `Number.POSITIVE_INFINITY` here so
   * plugin-internal child runs are not forced to share the root step cap.
   */
  maxSteps?: number;
  /**
   * Optionally narrows the recursive `rlm_query(...)` depth limit for a single
   * delegated call path. This is primarily used by runtime-helper wrappers.
   */
  maxSubcallDepth?: number;
  signal?: AbortSignal;
}

/**
 * Describes one runtime helper injected into the REPL surface.
 */
export type RLMRuntimeHelperInputKind = 'array' | 'object' | 'repl_code' | 'source' | 'text';

/**
 * Describes one runtime helper injected into the REPL surface.
 */
export interface RLMRuntimeHelper {
  description: string;
  examples?: string[];
  /**
   * Declares which input kinds this helper accepts.
   * Every helper input must be non-null and non-undefined.
   * String-like kinds require a non-empty string. Object/array kinds are only
   * accepted when declared explicitly here.
   * Defaults to `['text']`.
   */
  inputKinds?: RLMRuntimeHelperInputKind[];
  name: string;
  promptBlock?: string;
  /**
   * Sets the default `maxSteps` applied to `rlm_query(...)` and
   * `rlm_query_batched(...)` calls made from inside this helper body when the
   * helper code does not pass one explicitly. Defaults to
   * `Number.POSITIVE_INFINITY`, so plugin-internal child runs are not forced to
   * share the root run's step budget unless the helper opts into a finite cap.
   */
  rlmQueryMaxSteps?: number;
  /**
   * Sets the default `maxSubcallDepth` applied to `rlm_query(...)` and
   * `rlm_query_batched(...)` calls made from inside this helper body when the
   * helper code does not pass one explicitly. Defaults to `1`.
   */
  rlmQueryMaxSubcallDepth?: number;
  returns?: string;
  signature?: string;
  /**
   * Pure JavaScript helper source executed inside the sandboxed REPL worker.
   * The source must not use import/export syntax and receives its input through
   * the reserved `input` binding. Built-in runtime helpers such as
   * `llm_query(...)`, `rlm_query(...)`, `grep(...)`, `context`, and `history`
   * remain available inside this helper body. Helper calls only accept inputs
   * whose runtime type matches the declared `inputKinds`.
   */
  source: string;
  timeoutMs?: number;
}

/**
 * Describes the built-in bindings visible while authoring runtime-helper source.
 * Plugin authors can use this as a type-only view over `globalThis` while still
 * emitting pure JavaScript helper source into the sandbox.
 */
export interface RLMRuntimeHelperGlobals {
  FINAL: (value: unknown) => unknown;
  FINAL_VAR: (value: unknown) => unknown;
  SHOW_VARS: () => string[];
  context: JsonValue | null;
  grep: (
    input: string,
    pattern: RegExp | string,
    options?: {
      after?: number;
      before?: number;
      limit?: number;
    },
  ) => string[];
  history: readonly unknown[];
  llm_query: (prompt: string) => Promise<LLMQueryResult>;
  llm_query_batched: (prompts: string[]) => Promise<LLMQueryResult[]>;
  rlm_query: (
    prompt: RLMQueryInput,
    options?: QueryInvocationOptions,
  ) => Promise<RLMQueryResult>;
  rlm_query_batched: (
    prompts: RLMQueryInput[],
    options?: QueryInvocationOptions,
  ) => Promise<RLMQueryResult[]>;
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
  runtimeHelpers?: RLMRuntimeHelper[];
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
    runtimeHelpers?: RLMRuntimeHelper[];
  }): PersistentRuntimeLike;
}
