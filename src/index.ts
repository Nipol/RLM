/**
 * Internal unified re-export surface used by the published package entrypoint.
 *
 * @module
 *
 * @example
 * ```ts
 * import { createRLM } from './index.ts';
 * ```
 */
export { ReplSession } from './repl_session.ts';
export { createDefaultExecutionBackend, WorkerExecutionBackend } from './execution_backend.ts';
export {
  createSubqueryLogger,
  getLoggerJournalPath,
  InMemoryRLMLogger,
  JsonlFileLogger,
  NullRLMLogger,
  resolveRLMLogger,
} from './logger.ts';
export {
  buildLLMQuerySystemPrompt,
  createLLMQueryHandler,
  createRLMQueryHandler,
  createSubqueryJournalPath,
  RLMSubqueryDepthError,
  RLMSubqueryResultError,
} from './llm_query.ts';
export { extractFinalSignal, extractReplCodeBlocks } from './repl_protocol.ts';
export {
  buildRLMSystemPrompt,
  buildRLMTurnInput,
  loadDefaultRLMSystemPromptMarkdown,
} from './rlm_prompt.ts';
export {
  assertRuntimeHelperDefinition,
  assertRuntimeHelperName,
  buildRuntimeHelperPromptBlock,
  resolveRuntimeHelperPromptBlocks,
  resolveRuntimeHelpers,
  serializeRuntimeHelperSource,
} from './plugin.ts';
export { createRLM, RLMMaxStepsError, RLMProtocolError, runRLM } from './rlm_runner.ts';
export { formatLLMCallerMessagesAsText, resolveLLMCallerInputText } from './llm_adapter.ts';
export type {
  RLMClient,
  RLMClientOptions,
  RLMDefaults,
  RLMEvaluatorOptions,
  RLMModels,
  RLMRunInput,
} from './library_entrypoint.ts';
export type {
  LLMQueryBridgeOptions,
  NestedRLMRunner,
  NestedRLMRunRequest,
  NestedRLMRunResult,
  PlainLLMQueryCompletion,
  RLMQueryBridgeOptions,
} from './llm_query.ts';
export type { RLMPlugin, RuntimeHelperSourceSerializationOptions } from './plugin.ts';
export type {
  LLMAdapter,
  LLMCaller,
  LLMCallerMessage,
  LLMCallerRequest,
  LLMCallerResponse,
  LLMCallKind,
  LLMCallMetadata,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMProvider,
  LLMUsage,
} from './llm_adapter.ts';
export type { FinalSignal, ReplCodeBlock } from './repl_protocol.ts';
export type { RLMRunOptions, RLMRunResult } from './rlm_runner.ts';
export type {
  AssistantTurnEntry,
  CellEntry,
  CellStatus,
  ExecuteOptions,
  ExecuteResult,
  ExecutionBackend,
  ExecutionErrorSnapshot,
  JsonValue,
  LLMQueryHandler,
  LLMQueryResult,
  LoadedJournal,
  ModelUsageSummary,
  PersistentRuntimeLike,
  QueryTraceEntry,
  ReplSessionOptions,
  RLMDelegationRequest,
  RLMLogger,
  RLMQueryHandler,
  RLMQueryInput,
  RLMQueryResult,
  RLMRuntimeHelper,
  RLMRuntimeHelperGlobals,
  RLMRuntimeHelperInputKind,
  RLMUsageSummary,
  SessionEntry,
  SubqueryEntry,
  ValueSignal,
  ValueSnapshot,
} from './types.ts';
