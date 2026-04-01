/**
 * Bridges plain and recursive subqueries from the REPL into provider-backed execution.
 *
 * @module
 *
 * @example
 * ```ts
 * import { createRLMQueryHandler } from './llm_query.ts';
 * ```
 */
import type { LLMCaller, LLMCallKind, LLMUsage } from './llm_adapter.ts';
import { NullRLMLogger } from './logger.ts';
import { createSubqueryJournalPath } from './subquery_path.ts';
import type {
  JsonObject,
  JsonValue,
  LLMQueryHandler,
  RLMDelegationRequest,
  RLMExpectContract,
  RLMExpectInput,
  RLMExpectValueKind,
  RLMLogger,
  RLMQueryHandler,
  RLMQueryInput,
  RLMUsageSummary,
} from './types.ts';

export { createSubqueryJournalPath } from './subquery_path.ts';

/**
 * Describes the nested RLM run invoked by `rlm_query(...)`.
 *
 * @example
 * ```ts
 * const request: NestedRLMRunRequest = {
 *   context: { task: 'Return the vault key.' },
 *   depth: 1,
 *   logger,
 *   maxSteps: 12,
 *   maxSubcallDepth: 1,
 *   outputCharLimit: 4_000,
 *   prompt: 'Return the vault key.',
 *   rootModel: 'gpt-5-mini',
 *   subModel: 'gpt-5-mini',
 * };
 * ```
 */
export interface NestedRLMRunRequest {
  context: JsonValue;
  depth: number;
  logger: RLMLogger;
  maxSteps: number;
  maxSubcallDepth: number;
  outputCharLimit: number;
  prompt: string;
  rootModel: string;
  signal?: AbortSignal;
  subModel: string;
}

/**
 * Describes the minimum information a nested run must return to the parent REPL.
 *
 * @example
 * ```ts
 * const result: NestedRLMRunResult = {
 *   answer: 'V-554',
 *   steps: 2,
 *   usage: { byModel: [], reportedRequests: 0, totalInputTokens: 0, totalOutputTokens: 0 },
 *   value: 'V-554',
 * };
 * ```
 */
export interface NestedRLMRunResult {
  answer: string | null;
  steps: number;
  stdout?: string;
  usage: RLMUsageSummary;
  value: JsonValue | null;
}

interface InternalRLMQueryResultEnvelope {
  __rlmQueryResultEnvelope: true;
  stdout?: string;
  value: JsonValue;
}

function createInternalRLMQueryResultEnvelope(
  value: JsonValue,
  stdout: string | undefined,
): InternalRLMQueryResultEnvelope {
  return {
    __rlmQueryResultEnvelope: true,
    stdout,
    value,
  };
}

/**
 * Describes the function used to execute recursive subqueries.
 */
export type NestedRLMRunner = (
  request: NestedRLMRunRequest,
) => Promise<NestedRLMRunResult>;

/**
 * Describes one completed plain-language-model `llm_query(...)` request.
 *
 * @example
 * ```ts
 * const completion: PlainLLMQueryCompletion = {
 *   model: 'gpt-5-mini',
 *   turnState: { cursor: 'opaque-provider-state' },
 * };
 * ```
 */
export interface PlainLLMQueryCompletion {
  model: string;
  turnState?: unknown;
  usage?: LLMUsage;
}

/**
 * Groups the host-side state needed to turn `llm_query(...)` into plain model calls.
 *
 * @example
 * ```ts
 * const options: LLMQueryBridgeOptions = {
 *   llm,
 *   subModel: 'gpt-5-mini',
 * };
 * ```
 */
export interface LLMQueryBridgeOptions {
  currentDepth?: number;
  llm: LLMCaller;
  onComplete?: (completion: PlainLLMQueryCompletion) => void | Promise<void>;
  subModel: string;
}

/**
 * Groups the host-side state needed to turn `rlm_query(...)` into nested RLM runs.
 *
 * @example
 * ```ts
 * const options: RLMQueryBridgeOptions = {
 *   maxSteps: 12,
 *   maxSubcallDepth: 1,
 *   outputCharLimit: 4_000,
 *   runNestedRLM,
 *   subModel: 'gpt-5-mini',
 * };
 * ```
 */
export interface RLMQueryBridgeOptions {
  createChildLogger?: (depth: number, queryIndex: number) => RLMLogger;
  currentDepth?: number;
  maxSteps: number;
  maxSubcallDepth: number;
  outputCharLimit: number;
  runNestedRLM: NestedRLMRunner;
  subModel: string;
}

function createAbortError(): Error {
  const error = new Error('The query was aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw createAbortError();
  }
}

/**
 * Raised when a recursive subquery would exceed the configured nesting limit.
 *
 * @example
 * ```ts
 * throw new RLMSubqueryDepthError(2, 1);
 * ```
 */
export class RLMSubqueryDepthError extends Error {
  /**
   * Formats a depth-limit error with both the attempted and maximum depths.
   */
  constructor(attemptedDepth: number, maxDepth: number) {
    super(
      `rlm_query depth ${attemptedDepth} exceeds the configured maximum depth ${maxDepth}.`,
    );
    this.name = 'RLMSubqueryDepthError';
  }
}

/**
 * Raised when a nested run completes without producing a final answer string.
 *
 * @example
 * ```ts
 * throw new RLMSubqueryResultError('Return the vault key.');
 * ```
 */
export class RLMSubqueryResultError extends Error {
  /**
   * Points at the delegated prompt whose nested run completed without a usable answer.
   */
  constructor(prompt: string) {
    super(`rlm_query completed without a final answer for prompt: ${prompt}`);
    this.name = 'RLMSubqueryResultError';
  }
}

interface DelegatedChildContext {
  expect?: RLMExpectContract;
  payload?: JsonValue;
  selectionHints?: {
    positiveSelectors: string[];
  };
  task: string;
  type: 'rlm_delegated_task';
}

/**
 * Raised when a nested run returns a value that does not satisfy the delegated `expect` contract.
 *
 * @example
 * ```ts
 * throw new RLMSubqueryContractError('Return the vault key.', 'expected string but received object.');
 * ```
 */
export class RLMSubqueryContractError extends Error {
  /**
   * Formats a contract mismatch with the delegated task and the violated shape expectation.
   */
  constructor(task: string, message: string) {
    super(`rlm_query contract mismatch for "${task}": ${message}`);
    this.name = 'RLMSubqueryContractError';
  }
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExpectValueKind(value: string): value is RLMExpectValueKind {
  return value === 'array' ||
    value === 'boolean' ||
    value === 'null' ||
    value === 'number' ||
    value === 'object' ||
    value === 'string';
}

function isDelegationRequest(value: unknown): value is RLMDelegationRequest {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'task' in value &&
    typeof value.task === 'string';
}

function parseDelegatedPayload(prompt: string): JsonValue | undefined {
  try {
    return JSON.parse(prompt) as JsonValue;
  } catch (_) {
    return undefined;
  }
}

function buildDelegatedChildPayload(
  explicitPayload: JsonValue | undefined,
  rest: Record<string, JsonValue>,
): JsonValue | undefined {
  if (Object.keys(rest).length === 0) {
    return explicitPayload;
  }

  if (explicitPayload === undefined) {
    return rest;
  }

  return {
    ...rest,
    payload: explicitPayload,
  };
}

function inferSelectionHints(
  payload: JsonValue | undefined,
): DelegatedChildContext['selectionHints'] {
  if (!Array.isArray(payload) || payload.length < 2) {
    return undefined;
  }

  const rows = payload.filter((value): value is JsonObject => isJsonObject(value));
  if (rows.length < 2) {
    return undefined;
  }

  const candidateKeys = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      candidateKeys.add(key);
    }
  }

  const positiveSelectors = [...candidateKeys].filter((key) => {
    let sawFalse = false;
    let sawTrue = false;

    for (const row of rows) {
      const value = row[key];
      if (value === true) {
        sawTrue = true;
      } else if (value === false) {
        sawFalse = true;
      }
    }

    return sawTrue && sawFalse;
  });

  if (positiveSelectors.length === 0) {
    return undefined;
  }

  return { positiveSelectors };
}

function normalizeExpectContract(
  task: string,
  expect: RLMExpectInput | undefined,
): RLMExpectContract | undefined {
  if (expect === undefined) {
    return undefined;
  }

  if (typeof expect === 'string') {
    if (expect.trim().length === 0) {
      throw new RLMSubqueryContractError(task, 'invalid expect contract.');
    }

    if (isExpectValueKind(expect)) {
      return { type: expect };
    }

    return {
      field: expect,
      type: 'string',
    };
  }

  if (typeof expect !== 'object' || expect === null || Array.isArray(expect)) {
    throw new RLMSubqueryContractError(task, 'invalid expect contract.');
  }

  if ('type' in expect && typeof expect.type === 'string' && isExpectValueKind(expect.type)) {
    if (expect.type === 'object') {
      const objectExpect = expect as {
        fields?: JsonValue;
        requiredKeys?: JsonValue;
        type: 'object';
      };
      const normalized: RLMExpectContract = { type: 'object' };

      if (Array.isArray(objectExpect.requiredKeys)) {
        normalized.requiredKeys = objectExpect.requiredKeys.filter((key): key is string =>
          typeof key === 'string'
        );
      }

      if (objectExpect.fields !== undefined) {
        if (!isJsonObject(objectExpect.fields)) {
          throw new RLMSubqueryContractError(task, 'invalid expect contract.');
        }

        const fieldEntries = Object.entries(objectExpect.fields).map(([key, value]) => {
          if (typeof value !== 'string' || !isExpectValueKind(value)) {
            throw new RLMSubqueryContractError(task, 'invalid expect contract.');
          }
          return [key, value] as const;
        });

        normalized.fields = Object.fromEntries(fieldEntries);
      }

      return normalized;
    }

    if (expect.type === 'array') {
      return {
        minItems: typeof (expect as { minItems?: JsonValue }).minItems === 'number'
          ? (expect as { minItems?: number }).minItems
          : undefined,
        type: 'array',
      };
    }

    return {
      field: typeof (expect as { field?: JsonValue }).field === 'string'
        ? (expect as { field?: string }).field
        : undefined,
      type: expect.type,
    };
  }

  const shorthandEntries = Object.entries(expect).map(([key, value]) => {
    if (typeof value !== 'string' || !isExpectValueKind(value)) {
      throw new RLMSubqueryContractError(task, 'invalid expect contract.');
    }

    return [key, value] as const;
  });

  if (shorthandEntries.length === 0) {
    throw new RLMSubqueryContractError(task, 'invalid expect contract.');
  }

  return {
    fields: Object.fromEntries(shorthandEntries),
    requiredKeys: shorthandEntries.map(([key]) => key),
    type: 'object',
  };
}

function describeJsonValueType(value: JsonValue): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  return typeof value;
}

function validateScalarFieldValue(
  task: string,
  field: string,
  expectedType: 'boolean' | 'null' | 'number' | 'string',
  value: JsonValue,
): JsonValue {
  if (!isJsonObject(value)) {
    throw new RLMSubqueryContractError(
      task,
      `expected ${expectedType} or an object containing field ${field}, but received ${
        describeJsonValueType(value)
      }.`,
    );
  }

  if (!(field in value)) {
    throw new RLMSubqueryContractError(
      task,
      `missing required field ${field}.`,
    );
  }

  const fieldValue = value[field] ?? null;
  if (expectedType === 'null') {
    if (fieldValue !== null) {
      throw new RLMSubqueryContractError(
        task,
        `expected field ${field} to be null but received ${describeJsonValueType(fieldValue)}.`,
      );
    }
    return null;
  }

  if (typeof fieldValue !== expectedType) {
    throw new RLMSubqueryContractError(
      task,
      `expected field ${field} to be ${expectedType} but received ${
        describeJsonValueType(fieldValue)
      }.`,
    );
  }

  return fieldValue;
}

function buildSingleFieldObject(
  field: string,
  value: JsonValue,
): JsonObject {
  return {
    [field]: value,
  };
}

function extractSelectionIdentifier(
  expect: RLMExpectContract | undefined,
  value: JsonValue,
): { field: string; value: JsonValue } | null {
  if (expect === undefined) {
    return null;
  }

  if (
    (expect.type === 'string' || expect.type === 'number' || expect.type === 'boolean' ||
      expect.type === 'null') &&
    expect.field !== undefined
  ) {
    return {
      field: expect.field,
      value,
    };
  }

  if (expect.type !== 'object' || !isJsonObject(value)) {
    return null;
  }

  const keys = expect.requiredKeys ?? Object.keys(expect.fields ?? {});
  if (keys.length !== 1) {
    return null;
  }

  const [field] = keys;
  if (field === undefined || !(field in value)) {
    return null;
  }

  return {
    field,
    value: value[field] ?? null,
  };
}

function validateSelectionHints(
  task: string,
  payload: JsonValue | undefined,
  selectionHints: DelegatedChildContext['selectionHints'],
  expect: RLMExpectContract | undefined,
  value: JsonValue,
): void {
  if (selectionHints === undefined || !Array.isArray(payload) || payload.length < 2) {
    return;
  }

  const identifier = extractSelectionIdentifier(expect, value);
  if (identifier === null) {
    return;
  }

  const rows = payload.filter((entry): entry is JsonObject => isJsonObject(entry));
  if (rows.length < 2) {
    return;
  }

  const chosenRow = rows.find((row) => row[identifier.field] === identifier.value);
  if (chosenRow === undefined) {
    return;
  }

  const preferredRows = rows.filter((row) =>
    selectionHints.positiveSelectors.every((field) => row[field] === true)
  );
  if (preferredRows.length !== 1) {
    return;
  }

  const preferredRow = preferredRows[0]!;
  if (preferredRow[identifier.field] === identifier.value) {
    return;
  }

  throw new RLMSubqueryContractError(
    task,
    `selected ${identifier.field}=${
      String(identifier.value)
    } but the payload contains a unique positive selector row.`,
  );
}

function normalizeDelegatedValue(
  task: string,
  payload: JsonValue | undefined,
  selectionHints: DelegatedChildContext['selectionHints'],
  expect: RLMExpectContract | undefined,
  value: JsonValue,
): JsonValue {
  if (expect === undefined) {
    return value;
  }

  switch (expect.type) {
    case 'string':
    case 'number':
    case 'boolean':
      if (typeof value === expect.type) {
        validateSelectionHints(task, payload, selectionHints, expect, value);
        return value;
      }

      if (expect.field !== undefined) {
        const normalizedValue = validateScalarFieldValue(task, expect.field, expect.type, value);
        validateSelectionHints(task, payload, selectionHints, expect, normalizedValue);
        return normalizedValue;
      }

      throw new RLMSubqueryContractError(
        task,
        `expected ${expect.type} but received ${describeJsonValueType(value)}.`,
      );
    case 'null':
      if (value === null) {
        validateSelectionHints(task, payload, selectionHints, expect, value);
        return null;
      }

      if (expect.field !== undefined) {
        const normalizedValue = validateScalarFieldValue(task, expect.field, 'null', value);
        validateSelectionHints(task, payload, selectionHints, expect, normalizedValue);
        return normalizedValue;
      }

      throw new RLMSubqueryContractError(
        task,
        `expected null but received ${describeJsonValueType(value)}.`,
      );
    case 'array':
      if (!Array.isArray(value)) {
        throw new RLMSubqueryContractError(
          task,
          `expected array but received ${describeJsonValueType(value)}.`,
        );
      }
      if (expect.minItems !== undefined && value.length < expect.minItems) {
        throw new RLMSubqueryContractError(
          task,
          `expected at least ${expect.minItems} array items but received ${value.length}.`,
        );
      }
      validateSelectionHints(task, payload, selectionHints, expect, value);
      return value;
    case 'object':
      let normalizedValue = value;
      const objectFields = expect.fields ?? {};
      const requiredKeys = expect.requiredKeys ?? [];
      const canWrapSingleScalar = requiredKeys.length === 1 &&
        Object.keys(objectFields).length === 1 &&
        requiredKeys[0] === Object.keys(objectFields)[0];

      if (!isJsonObject(normalizedValue)) {
        if (!canWrapSingleScalar) {
          throw new RLMSubqueryContractError(
            task,
            `expected object but received ${describeJsonValueType(normalizedValue)}.`,
          );
        }

        const [field, fieldType] = Object.entries(objectFields)[0]!;
        if (
          (fieldType === 'null' && normalizedValue === null) ||
          (fieldType === 'array' && Array.isArray(normalizedValue)) ||
          (fieldType === 'object' && isJsonObject(normalizedValue)) ||
          (fieldType !== 'null' &&
            fieldType !== 'array' &&
            fieldType !== 'object' &&
            typeof normalizedValue === fieldType)
        ) {
          normalizedValue = buildSingleFieldObject(field, normalizedValue);
        } else {
          throw new RLMSubqueryContractError(
            task,
            `expected object but received ${describeJsonValueType(normalizedValue)}.`,
          );
        }
      }

      if (requiredKeys.length === 0) {
        return normalizedValue;
      }

      {
        const missingKeys = requiredKeys.filter((key) => !(key in normalizedValue));
        if (missingKeys.length > 0) {
          throw new RLMSubqueryContractError(
            task,
            `missing required keys: ${missingKeys.join(', ')}.`,
          );
        }
      }

      if (expect.fields !== undefined) {
        for (const [key, fieldType] of Object.entries(expect.fields)) {
          if (!(key in normalizedValue)) {
            continue;
          }

          const fieldValue = (normalizedValue as JsonObject)[key] ?? null;
          if (fieldType === 'null') {
            if (fieldValue !== null) {
              throw new RLMSubqueryContractError(
                task,
                `expected field ${key} to be null but received ${
                  describeJsonValueType(fieldValue)
                }.`,
              );
            }
            continue;
          }

          if (fieldType === 'array') {
            if (!Array.isArray(fieldValue)) {
              throw new RLMSubqueryContractError(
                task,
                `expected field ${key} to be array but received ${
                  describeJsonValueType(fieldValue)
                }.`,
              );
            }
            continue;
          }

          if (fieldType === 'object') {
            if (!isJsonObject(fieldValue)) {
              throw new RLMSubqueryContractError(
                task,
                `expected field ${key} to be object but received ${
                  describeJsonValueType(fieldValue)
                }.`,
              );
            }
            continue;
          }

          if (typeof fieldValue !== fieldType) {
            throw new RLMSubqueryContractError(
              task,
              `expected field ${key} to be ${fieldType} but received ${
                describeJsonValueType(fieldValue)
              }.`,
            );
          }
        }
      }
      validateSelectionHints(task, payload, selectionHints, expect, normalizedValue);
      return normalizedValue;
  }
}

/**
 * Builds the narrowed child context used for one delegated recursive task.
 *
 * @example
 * ```ts
 * const context = buildDelegatedChildContext({
 *   task: 'Return the vault key.',
 *   payload: [{ vaultKey: 'V-554' }],
 *   expect: 'vaultKey',
 * });
 * ```
 */
export function buildDelegatedChildContext(prompt: RLMQueryInput): DelegatedChildContext {
  const rawDelegated = typeof prompt === 'string' ? parseDelegatedPayload(prompt) : prompt;
  if (rawDelegated === undefined) {
    return {
      task: String(prompt),
      type: 'rlm_delegated_task',
    };
  }

  if (isDelegationRequest(rawDelegated)) {
    const { expect, payload, task, ...rest } = rawDelegated;
    const delegated: DelegatedChildContext = {
      task,
      type: 'rlm_delegated_task',
    };
    const delegatedPayload = buildDelegatedChildPayload(payload, rest);
    if (delegatedPayload !== undefined) {
      delegated.payload = delegatedPayload;
      const selectionHints = inferSelectionHints(
        Array.isArray(delegatedPayload) ? delegatedPayload : payload,
      );
      if (selectionHints !== undefined) {
        delegated.selectionHints = selectionHints;
      }
    }
    const normalizedExpect = normalizeExpectContract(task, expect);
    if (normalizedExpect !== undefined) {
      delegated.expect = normalizedExpect;
    }

    return delegated;
  }

  return {
    payload: rawDelegated,
    task: typeof prompt === 'string' ? prompt : prompt.task,
    type: 'rlm_delegated_task',
  };
}

/**
 * Describes the fixed instructions used for plain `llm_query(...)` completions.
 *
 * @example
 * ```ts
 * const systemPrompt = buildLLMQuerySystemPrompt();
 * ```
 */
export function buildLLMQuerySystemPrompt(): string {
  return [
    '당신은 일반 언어 모델 하위 호출을 처리하고 있습니다.',
    '사용자 프롬프트에 가장 직접적인 답을 반환하십시오.',
    '사용자 프롬프트가 명시적으로 코드를 요구하지 않으면 repl fence, 도구 호출, 코드를 출력하지 마십시오.',
    '답변은 간결하게 유지하고 요청된 결과에만 집중하십시오.',
  ].join('\n');
}

/**
 * Adapts `llm_query(...)` into a plain language-model completion on the sub-model.
 *
 * @example
 * ```ts
 * const llmQuery = createLLMQueryHandler({
 *   llm,
 *   subModel: 'gpt-5-mini',
 * });
 *
 * const answer = await llmQuery('Summarize the excerpt.');
 * ```
 */
export function createLLMQueryHandler(options: LLMQueryBridgeOptions): LLMQueryHandler {
  let queryCount = 0;

  return async (prompt: string, invocationOptions = {}) => {
    throwIfAborted(invocationOptions.signal);
    const queryIndex = queryCount++;
    const completion = await options.llm.complete({
      input: String(prompt),
      kind: 'plain_query' satisfies LLMCallKind,
      metadata: {
        depth: options.currentDepth ?? 0,
        queryIndex,
      },
      model: options.subModel,
      signal: invocationOptions.signal,
      systemPrompt: buildLLMQuerySystemPrompt(),
    });
    throwIfAborted(invocationOptions.signal);

    await options.onComplete?.({
      model: options.subModel,
      turnState: completion.turnState,
      usage: completion.usage,
    });

    return completion.outputText;
  };
}

/**
 * Adapts `rlm_query(...)` into a nested child RLM run over a narrowed delegated prompt.
 *
 * @example
 * ```ts
 * const rlmQuery = createRLMQueryHandler({
 *   maxSteps: 12,
 *   maxSubcallDepth: 1,
 *   outputCharLimit: 4_000,
 *   runNestedRLM,
 *   subModel: 'gpt-5-mini',
 * });
 *
 * const result = await rlmQuery({
 *   task: 'Return the vault key.',
 *   payload: [{ active: true, vaultKey: 'V-554' }],
 *   expect: 'vaultKey',
 * });
 * ```
 */
export function createRLMQueryHandler(options: RLMQueryBridgeOptions): RLMQueryHandler {
  let queryCount = 0;
  let pendingRun = Promise.resolve();

  return async (prompt: RLMQueryInput, invocationOptions = {}) => {
    const run = async () => {
      throwIfAborted(invocationOptions.signal);

      const nextDepth = (options.currentDepth ?? 0) + 1;
      if (nextDepth > options.maxSubcallDepth) {
        throw new RLMSubqueryDepthError(nextDepth, options.maxSubcallDepth);
      }
      const queryIndex = queryCount++;

      const delegatedContext = buildDelegatedChildContext(prompt);
      const result = await options.runNestedRLM({
        context: delegatedContext as unknown as JsonValue,
        depth: nextDepth,
        logger: options.createChildLogger?.(nextDepth, queryIndex) ?? new NullRLMLogger(),
        maxSteps: options.maxSteps,
        maxSubcallDepth: options.maxSubcallDepth,
        outputCharLimit: options.outputCharLimit,
        prompt: delegatedContext.task,
        rootModel: options.subModel,
        signal: invocationOptions.signal,
        subModel: options.subModel,
      });
      throwIfAborted(invocationOptions.signal);

      if (result.value === null) {
        throw new RLMSubqueryResultError(delegatedContext.task);
      }

      return createInternalRLMQueryResultEnvelope(
        normalizeDelegatedValue(
          delegatedContext.task,
          delegatedContext.payload,
          delegatedContext.selectionHints,
          delegatedContext.expect,
          result.value,
        ),
        result.stdout,
      ) as unknown as JsonValue;
    };

    const previousRun = pendingRun;
    const currentRun = previousRun.catch(() => undefined).then(run);
    pendingRun = currentRun.then(() => undefined, () => undefined);
    return await currentRun;
  };
}

/**
 * Exposes query-construction helpers for isolated tests.
 */
export const __llmQueryTestables = {
  createInternalRLMQueryResultEnvelope,
  buildDelegatedChildContext,
  buildDelegatedChildPayload,
  createAbortError,
  describeJsonValueType,
  extractSelectionIdentifier,
  inferSelectionHints,
  isDelegationRequest,
  isExpectValueKind,
  isJsonObject,
  normalizeDelegatedValue,
  normalizeExpectContract,
  parseDelegatedPayload,
  throwIfAborted,
  validateScalarFieldValue,
  validateSelectionHints,
};
