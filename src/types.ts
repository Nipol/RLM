export type JsonPrimitive = boolean | null | number | string;

export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

export interface JsonArray extends Array<JsonValue> {}

export interface JsonObject {
  [key: string]: JsonValue;
}

export type RLMExpectValueKind =
  | 'array'
  | 'boolean'
  | 'null'
  | 'number'
  | 'object'
  | 'string';

export interface RLMScalarExpectContract {
  field?: string;
  type: 'boolean' | 'null' | 'number' | 'string';
}

export interface RLMObjectExpectContract {
  fields?: Record<string, RLMExpectValueKind>;
  requiredKeys?: string[];
  type: 'object';
}

export interface RLMArrayExpectContract {
  minItems?: number;
  type: 'array';
}

export type RLMExpectContract =
  | RLMArrayExpectContract
  | RLMObjectExpectContract
  | RLMScalarExpectContract;

export type RLMExpectShorthand = Record<string, RLMExpectValueKind>;

export type RLMExpectInput = RLMExpectContract | RLMExpectShorthand | string;

export interface RLMDelegationRequest {
  expect?: RLMExpectInput;
  payload?: JsonValue;
  task: string;
}

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

export interface ModelUsageSummary {
  cachedInputTokens: number;
  inputTokens: number;
  model: string;
  outputTokens: number;
  reportedRequests: number;
  requests: number;
  totalTokens: number;
}

export interface RLMUsageSummary {
  byModel: ModelUsageSummary[];
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reportedRequests: number;
  requests: number;
  totalTokens: number;
}

export interface ExecutionErrorSnapshot {
  message: string;
  name: string;
  stack?: string;
}

export type CellStatus = 'error' | 'success' | 'timeout';

export interface SessionEntry {
  context: JsonValue | null;
  createdAt: string;
  defaultTimeoutMs: number;
  sessionId: string;
  type: 'session';
}

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

export interface AssistantTurnEntry {
  assistantText: string;
  createdAt: string;
  model: string;
  responseId: string | null;
  step: number;
  type: 'assistant_turn';
}

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

export type JournalEntry = AssistantTurnEntry | CellEntry | SessionEntry | SubqueryEntry;

export interface RLMLogger {
  append(entry: JournalEntry): Promise<void> | void;
  close?(): Promise<void> | void;
  load?(): Promise<LoadedJournal> | LoadedJournal;
}

export interface ExecuteOptions {
  timeoutMs?: number;
}

export interface ExecuteResult extends CellEntry {
  historyLength: number;
}

export type LLMQueryResult = JsonValue;

export interface QueryInvocationOptions {
  signal?: AbortSignal;
}

export type LLMQueryHandler = (
  prompt: string,
  options?: QueryInvocationOptions,
) => LLMQueryResult | Promise<LLMQueryResult>;

export type RLMQueryInput = RLMDelegationRequest | string;

export type RLMQueryResult = JsonValue;

export type RLMQueryHandler = (
  prompt: RLMQueryInput,
  options?: QueryInvocationOptions,
) => RLMQueryResult | Promise<RLMQueryResult>;

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

export interface LoadedJournal {
  cells: CellEntry[];
  session: SessionEntry | null;
}

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

export interface ExecutionBackend {
  createRuntime(options: {
    context: JsonValue | null;
    llmQueryHandler?: LLMQueryHandler;
    rlmQueryHandler?: RLMQueryHandler;
  }): PersistentRuntimeLike;
}
