import type {
  OpenAIRLMClientOptions,
  RLMClient,
  RLMClientOptions,
  RLMDefaults,
  RLMRunInput,
} from './library_entrypoint.ts';
import { loadRLMConfig } from './env.ts';
import type { OpenAIProviderConfig, RLMConfig } from './env.ts';
import { createDefaultExecutionBackend } from './execution_backend.ts';
import { createSubqueryLogger, getLoggerJournalPath, resolveRLMLogger } from './logger.ts';
import { createLLMQueryHandler, createRLMQueryHandler } from './llm_query.ts';
import type { LLMAdapter, LLMCaller, LLMCallerResponse } from './llm_adapter.ts';
import { OpenAIResponsesProvider } from './openai_adapter.ts';
import { buildRLMSystemPrompt, buildRLMTurnInput } from './rlm_prompt.ts';
import { extractFinalSignal, extractReplCodeBlocks } from './repl_protocol.ts';
import type { FinalSignal, ReplCodeBlock } from './repl_protocol.ts';
import { ReplSession } from './repl_session.ts';
import {
  cloneUsageSummary,
  createUsageSummary,
  mergeUsageSummaries,
  recordUsage,
} from './usage_summary.ts';
import type {
  AssistantTurnEntry,
  ExecutionBackend,
  JsonValue,
  RLMLogger,
  RLMUsageSummary,
  SubqueryEntry,
  ValueSnapshot,
} from './types.ts';

const DEFAULT_CELL_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_STEPS = 12;
const DEFAULT_MAX_SUBCALL_DEPTH = 3;
const DEFAULT_OUTPUT_CHAR_LIMIT = 4_000;

interface InternalRLMRunOptions extends
  Omit<
    RLMRunOptions,
    'depth' | 'journalPath' | 'logger' | 'maxSteps' | 'maxSubcallDepth' | 'outputCharLimit'
  > {
  depth: number;
  executionBackend: ExecutionBackend;
  logger: RLMLogger;
  maxSteps: number;
  maxSubcallDepth: number;
  outputCharLimit: number;
  signal?: AbortSignal;
}

/**
 * Describes the inputs required to execute one complete RLM loop.
 *
 * This is the low-level one-shot runner interface.
 * Library consumers normally reach the same behavior through `createRLM(...)`.
 *
 * @example
 * ```ts
 * const options: RLMRunOptions = {
 *   llm,
 *   context: { document: 'Chapter 1\\nThe answer is 42.' },
 *   prompt: 'Extract the answer.',
 *   rootModel: 'gpt-5-nano',
 *   subModel: 'gpt-5-mini',
 * };
 * ```
 */
export interface RLMRunOptions extends RLMRunInput {
  adapter?: LLMAdapter;
  clock?: () => Date;
  depth?: number;
  executionBackend?: ExecutionBackend;
  idGenerator?: () => string;
  journalPath?: string;
  llm?: LLMCaller;
  logger?: RLMLogger;
  rootModel: string;
  subModel: string;
}

/**
 * Describes the terminal result of a completed RLM loop.
 *
 * The returned session is kept so callers can inspect execution history
 * or continue working with the resulting REPL state.
 *
 * @example
 * ```ts
 * const result: RLMRunResult = await runRLM(options);
 * console.log(result.answer);
 * console.log(result.usage.totalInputTokens);
 * ```
 */
export interface RLMRunResult {
  answer: string;
  finalValue: JsonValue | null;
  session: ReplSession;
  steps: number;
  usage: RLMUsageSummary;
}

/**
 * Describes the convenience wrapper inputs for OpenAI-backed RLM runs.
 *
 * Explicit `openAI` configuration is the preferred library path.
 * `config` or implicit `.env` loading remain available for standalone convenience.
 * In this provider-backed path, `cellTimeoutMs` is interpreted as additional REPL
 * cell budget on top of the provider request timeout.
 *
 * @example
 * ```ts
 * const options: RunOpenAIRLMOptions = {
 *   context: { document: 'Chapter 1\\nThe answer is 42.' },
 *   openAI: {
 *     apiKey: 'sk-test',
 *     baseUrl: 'https://api.openai.com/v1',
 *     requestTimeoutMs: 30_000,
 *     rootModel: 'gpt-5-nano',
 *     subModel: 'gpt-5-mini',
 *   },
 *   prompt: 'Extract the answer.',
 * };
 * ```
 */
export interface RunOpenAIRLMOptions extends RLMRunInput {
  clock?: () => Date;
  config?: RLMConfig;
  executionBackend?: ExecutionBackend;
  fetcher?: typeof fetch;
  idGenerator?: () => string;
  journalPath?: string;
  logger?: RLMLogger;
  openAI?: OpenAIProviderConfig;
}

/**
 * Raised when the assistant fails to follow the REPL control protocol.
 *
 * @example
 * ```ts
 * throw new RLMProtocolError('Assistant response did not contain a repl block.');
 * ```
 */
export class RLMProtocolError extends Error {
  /**
   * Formats a protocol-level failure with a user-readable explanation.
   */
  constructor(message: string) {
    super(message);
    this.name = 'RLMProtocolError';
  }
}

/**
 * Raised when an RLM loop exhausts its turn budget before producing a final answer.
 *
 * @example
 * ```ts
 * throw new RLMMaxStepsError(12);
 * ```
 */
export class RLMMaxStepsError extends Error {
  /**
   * Formats a max-step failure using the configured turn cap.
   */
  constructor(maxSteps: number) {
    super(`RLM run exceeded the configured max steps (${maxSteps}) without FINAL.`);
    this.name = 'RLMMaxStepsError';
  }
}

/**
 * Resolves one integer limit by preferring an explicit override and otherwise falling back.
 *
 * @param value The per-call override value.
 * @param fallback The default value to use when no override is present.
 * @returns The resolved integer limit.
 */
function resolveRunLimit(value: number | undefined, fallback: number): number {
  return value ?? fallback;
}

function resolveProviderAwareCellTimeoutMs(
  additionalTimeoutMs: number | undefined,
  providerRequestTimeoutMs: number,
  defaultAdditionalTimeoutMs = DEFAULT_CELL_TIMEOUT_MS,
): number {
  return providerRequestTimeoutMs + (additionalTimeoutMs ?? defaultAdditionalTimeoutMs);
}

function resolveOpenAIRunLogger(
  logger: RLMLogger | undefined,
  journalPath: string | undefined,
): RLMLogger | undefined {
  return logger ?? (journalPath === undefined ? undefined : resolveRLMLogger({
    journalPath,
  }));
}

function resolveRLMCaller(
  llm: LLMCaller | undefined,
  adapter: LLMAdapter | undefined,
): LLMCaller {
  const resolved = llm ?? adapter;
  if (resolved !== undefined) {
    return resolved;
  }

  throw new Error('RLM requires an llm caller or legacy adapter.');
}

function resolveControllerRole(depth: number | undefined): 'child' | 'root' {
  return (depth ?? 0) > 0 ? 'child' : 'root';
}

function resolveSubqueryAnswerValue(
  nested: Pick<RLMRunResult, 'answer' | 'finalValue'>,
): JsonValue {
  return nested.finalValue ?? nested.answer;
}

/**
 * Accepts only terminal values that represent a successful, usable final answer.
 *
 * A cell that errored after calling `FINAL(...)` must not terminate the run, and
 * `FINAL_VAR(undefined)` should be treated as an unfinished attempt rather than a
 * valid answer.
 */
function shouldAcceptExecutionFinalAnswer(
  status: 'error' | 'success' | 'timeout',
  finalAnswer: string | null,
): boolean {
  if (status !== 'success') {
    return false;
  }

  if (finalAnswer === null) {
    return false;
  }

  return finalAnswer !== 'undefined';
}

function extractFinalJsonValue(result: ValueSnapshot | null | undefined): JsonValue | null {
  if (result === undefined || result === null) {
    return null;
  }

  return result.json ?? null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }

  const error = new Error('RLM execution was aborted.');
  error.name = 'AbortError';
  throw error;
}

/**
 * Appends one assistant turn entry to the configured logger.
 *
 * @param logger The logger that owns the current root session.
 * @param entry The assistant turn summary to append.
 */
async function appendAssistantTurnEntry(
  logger: RLMLogger,
  entry: AssistantTurnEntry,
): Promise<void> {
  await logger.append(entry);
}

/**
 * Appends one nested subquery summary entry to the parent logger.
 *
 * @param logger The parent logger that should receive the summary.
 * @param entry The derived subquery summary entry.
 */
async function appendSubqueryEntry(
  logger: RLMLogger,
  entry: SubqueryEntry,
): Promise<void> {
  await logger.append(entry);
}

/**
 * Builds the reusable client-style library entry point.
 *
 * The resulting client captures long-lived dependencies once and exposes
 * a small `run(...)` method for task-specific inputs.
 *
 * @param options The shared caller, model, logger, backend, and default limits.
 * @returns A stable library client that can execute many RLM runs over time.
 *
 * @example
 * ```ts
 * const client = createRLM({
 *   llm,
 *   models: { root: 'gpt-5-nano', sub: 'gpt-5-mini' },
 * });
 *
 * const result = await client.run({
 *   context: { document: 'Chapter 1\\nThe answer is 42.' },
 *   prompt: 'Extract the answer.',
 * });
 * ```
 */
export function createRLM(options: RLMClientOptions): RLMClient {
  const defaults: RLMDefaults = {
    cellTimeoutMs: options.defaults?.cellTimeoutMs,
    maxSteps: options.defaults?.maxSteps ?? DEFAULT_MAX_STEPS,
    maxSubcallDepth: options.defaults?.maxSubcallDepth ?? DEFAULT_MAX_SUBCALL_DEPTH,
    outputCharLimit: options.defaults?.outputCharLimit ?? DEFAULT_OUTPUT_CHAR_LIMIT,
  };

  return {
    run: async (input: RLMRunInput) =>
      await runRLM({
        adapter: options.adapter,
        cellTimeoutMs: input.cellTimeoutMs ?? defaults.cellTimeoutMs,
        clock: options.clock,
        context: input.context,
        executionBackend: options.executionBackend,
        idGenerator: options.idGenerator,
        llm: options.llm,
        logger: options.logger,
        maxSteps: resolveRunLimit(input.maxSteps, defaults.maxSteps!),
        maxSubcallDepth: resolveRunLimit(input.maxSubcallDepth, defaults.maxSubcallDepth!),
        outputCharLimit: resolveRunLimit(input.outputCharLimit, defaults.outputCharLimit!),
        prompt: input.prompt,
        rootModel: options.models.root,
        subModel: options.models.sub,
        systemPromptExtension: input.systemPromptExtension,
      }),
  };
}

/**
 * Builds the OpenAI-backed convenience client from explicit provider arguments.
 *
 * This helper is meant for library consumers who want explicit provider configuration
 * without manually constructing a caller.
 * In this provider-backed path, `defaults.cellTimeoutMs` is interpreted as additional
 * REPL cell budget on top of the provider request timeout.
 *
 * @param options Explicit OpenAI configuration plus optional logger, backend, and defaults.
 * @returns An `RLMClient` configured to use the OpenAI Responses API.
 *
 * @example
 * ```ts
 * const client = createOpenAIRLM({
 *   openAI: {
 *     apiKey: 'sk-test',
 *     baseUrl: 'https://api.openai.com/v1',
 *     requestTimeoutMs: 30_000,
 *     rootModel: 'gpt-5-nano',
 *     subModel: 'gpt-5-mini',
 *   },
 * });
 * ```
 */
export function createOpenAIRLM(options: OpenAIRLMClientOptions): RLMClient {
  const provider = new OpenAIResponsesProvider({
    fetcher: options.fetcher,
  });
  const defaultAdditionalCellTimeoutMs = options.defaults?.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS;
  const baseClient = createRLM({
    llm: provider.createCaller(options.openAI),
    clock: options.clock,
    defaults: {
      cellTimeoutMs: resolveProviderAwareCellTimeoutMs(
        undefined,
        options.openAI.requestTimeoutMs,
        defaultAdditionalCellTimeoutMs,
      ),
      maxSteps: options.defaults?.maxSteps,
      maxSubcallDepth: options.defaults?.maxSubcallDepth,
      outputCharLimit: options.defaults?.outputCharLimit,
    },
    executionBackend: options.executionBackend,
    idGenerator: options.idGenerator,
    logger: options.logger,
    models: {
      root: options.openAI.rootModel,
      sub: options.openAI.subModel,
    },
  });

  return {
    run: async (input) =>
      await baseClient.run({
        ...input,
        cellTimeoutMs: input.cellTimeoutMs === undefined
          ? undefined
          : resolveProviderAwareCellTimeoutMs(
            input.cellTimeoutMs,
            options.openAI.requestTimeoutMs,
            defaultAdditionalCellTimeoutMs,
          ),
      }),
  };
}

/**
 * Executes one RLM loop, including nested `llm_query(...)` runs.
 *
 * This is the low-level one-shot helper that powers `createRLM(...).run(...)`.
 *
 * @param options One-shot execution inputs, models, limits, and optional persistence hooks.
 * @returns The final answer and resulting REPL session.
 *
 * @example
 * ```ts
 * const result = await runRLM({
 *   llm,
 *   context: { document: 'Chapter 1\\nThe answer is 42.' },
 *   prompt: 'Extract the answer.',
 *   rootModel: 'gpt-5-nano',
 *   subModel: 'gpt-5-mini',
 * });
 * ```
 */
export async function runRLM(options: RLMRunOptions): Promise<RLMRunResult> {
  return await runRLMInternal({
    ...options,
    depth: options.depth ?? 0,
    executionBackend: options.executionBackend ?? createDefaultExecutionBackend(),
    logger: resolveRLMLogger({
      journalPath: options.journalPath,
      logger: options.logger,
    }),
    maxSteps: resolveRunLimit(options.maxSteps, DEFAULT_MAX_STEPS),
    maxSubcallDepth: resolveRunLimit(options.maxSubcallDepth, DEFAULT_MAX_SUBCALL_DEPTH),
    outputCharLimit: resolveRunLimit(options.outputCharLimit, DEFAULT_OUTPUT_CHAR_LIMIT),
  });
}

/**
 * Runs one OpenAI-backed RLM loop while keeping explicit provider args library-safe.
 *
 * When `openAI` is supplied, this function behaves as a pure library helper.
 * When `config` is supplied, it uses the already-loaded repository config.
 * When neither is supplied, it falls back to `.env` loading for standalone usage.
 *
 * @param options OpenAI configuration or config loader inputs plus one-shot run inputs.
 * @returns The final answer and resulting REPL session.
 *
 * @example
 * ```ts
 * const result = await runOpenAIRLM({
 *   context: { document: 'Chapter 1\\nThe answer is 42.' },
 *   openAI: {
 *     apiKey: 'sk-test',
 *     baseUrl: 'https://api.openai.com/v1',
 *     requestTimeoutMs: 30_000,
 *     rootModel: 'gpt-5-nano',
 *     subModel: 'gpt-5-mini',
 *   },
 *   prompt: 'Extract the answer.',
 * });
 * ```
 */
export async function runOpenAIRLM(options: RunOpenAIRLMOptions): Promise<RLMRunResult> {
  const loaded = options.config ??
    (options.openAI === undefined ? loadRLMConfig() : {
      openAI: options.openAI,
      runtime: {
        cellTimeoutMs: DEFAULT_CELL_TIMEOUT_MS,
        maxSteps: DEFAULT_MAX_STEPS,
        maxSubcallDepth: DEFAULT_MAX_SUBCALL_DEPTH,
        outputCharLimit: DEFAULT_OUTPUT_CHAR_LIMIT,
      },
    });

  const client = createOpenAIRLM({
    clock: options.clock,
    defaults: {
      cellTimeoutMs: loaded.runtime.cellTimeoutMs,
      maxSteps: options.maxSteps ?? loaded.runtime.maxSteps,
      maxSubcallDepth: options.maxSubcallDepth ?? loaded.runtime.maxSubcallDepth,
      outputCharLimit: options.outputCharLimit ?? loaded.runtime.outputCharLimit,
    },
    executionBackend: options.executionBackend,
    fetcher: options.fetcher,
    idGenerator: options.idGenerator,
    logger: resolveOpenAIRunLogger(options.logger, options.journalPath),
    openAI: loaded.openAI,
  });

  return await client.run({
    cellTimeoutMs: options.cellTimeoutMs,
    context: options.context,
    maxSteps: options.maxSteps,
    maxSubcallDepth: options.maxSubcallDepth,
    outputCharLimit: options.outputCharLimit,
    prompt: options.prompt,
    systemPromptExtension: options.systemPromptExtension,
  });
}

/**
 * Executes one loop instance with explicit depth so subqueries can recurse safely.
 *
 * This function owns the actual controller loop:
 * request a completion, extract `repl` blocks, execute them, append transcript
 * feedback, and finish when either `FINAL(...)` or `FINAL_VAR(...)` is reached.
 *
 * @param options A fully resolved internal run configuration with concrete defaults.
 * @returns The final answer and resulting REPL session for this loop instance.
 */
async function runRLMInternal(options: InternalRLMRunOptions): Promise<RLMRunResult> {
  throwIfAborted(options.signal);
  const llm = resolveRLMCaller(options.llm, options.adapter);
  const clock = options.clock ?? (() => new Date());
  const transcript: Parameters<typeof buildRLMTurnInput>[0]['transcript'] = [];
  const role = resolveControllerRole(options.depth);
  const baseSystemPrompt = buildRLMSystemPrompt({ role });
  const systemPrompt = options.systemPromptExtension === undefined ||
      options.systemPromptExtension.trim().length === 0
    ? baseSystemPrompt
    : `${baseSystemPrompt}\n\n${options.systemPromptExtension.trim()}`;
  const usageSummary = createUsageSummary();

  const session = await ReplSession.open({
    clock,
    context: options.context,
    defaultTimeoutMs: options.cellTimeoutMs,
    executionBackend: options.executionBackend,
    idGenerator: options.idGenerator,
    logger: options.logger,
    llmQueryHandler: createLLMQueryHandler({
      currentDepth: options.depth,
      llm,
      onComplete: ({ usage }) => {
        recordUsage(usageSummary, options.subModel, usage);
      },
      subModel: options.subModel,
    }),
    rlmQueryHandler: createRLMQueryHandler({
      createChildLogger: (depth, queryIndex) =>
        createSubqueryLogger(options.logger, depth, queryIndex),
      currentDepth: options.depth,
      maxSteps: options.maxSteps,
      maxSubcallDepth: options.maxSubcallDepth,
      outputCharLimit: options.outputCharLimit,
      runNestedRLM: async (request) => {
        const nested = await runRLMInternal({
          ...options,
          context: request.context,
          depth: request.depth,
          logger: request.logger,
          prompt: request.prompt,
          rootModel: request.rootModel,
          signal: request.signal,
          subModel: request.subModel,
        });
        try {
          mergeUsageSummaries(usageSummary, nested.usage);

          await appendSubqueryEntry(options.logger, {
            answer: resolveSubqueryAnswerValue(nested),
            createdAt: clock().toISOString(),
            depth: request.depth,
            journalPath: getLoggerJournalPath(request.logger),
            model: request.rootModel,
            prompt: request.prompt,
            steps: nested.steps,
            type: 'subquery',
          });

          return {
            answer: nested.answer,
            steps: nested.steps,
            usage: nested.usage,
            value: nested.finalValue,
          };
        } finally {
          await nested.session.close();
        }
      },
      subModel: options.subModel,
    }),
  });
  let turnState: unknown = undefined;

  for (let index = 0; index < options.maxSteps; index += 1) {
    throwIfAborted(options.signal);
    const step = index + 1;
    const baseInput = buildRLMTurnInput({
      context: options.context,
      currentStep: step,
      outputCharLimit: options.outputCharLimit,
      prompt: options.prompt,
      role,
      totalSteps: options.maxSteps,
      transcript,
    });
    let completion: LLMCallerResponse | null = null;
    let codeBlocks: ReplCodeBlock[] = [];
    let finalSignal: FinalSignal | null = null;

    const recoveryPrompts = [
      baseInput,
      `${baseInput}\n\nProtocol recovery:\nRespond with one or more \`\`\`repl blocks that advance the task, or return an explicit FINAL signal if the answer is already verified.`,
      `${baseInput}\n\nProtocol recovery:\nStart immediately with a \`\`\`repl block. A valid next response contains one or more \`\`\`repl blocks that advance the task, or an explicit FINAL signal if the answer is already verified.`,
    ];

    for (let attempt = 0; attempt < recoveryPrompts.length; attempt += 1) {
      const input = recoveryPrompts[attempt]!;
      completion = await llm.complete({
        input,
        kind: role === 'root' ? 'root_turn' : 'child_turn',
        metadata: {
          depth: options.depth,
          step,
        },
        model: options.rootModel,
        signal: options.signal,
        systemPrompt,
        turnState,
      });
      throwIfAborted(options.signal);
      recordUsage(usageSummary, options.rootModel, completion.usage);
      turnState = completion.turnState;

      await appendAssistantTurnEntry(options.logger, {
        assistantText: completion.outputText,
        createdAt: clock().toISOString(),
        model: options.rootModel,
        step,
        type: 'assistant_turn',
      });

      codeBlocks = extractReplCodeBlocks(completion.outputText);
      if (codeBlocks.length > 0) {
        break;
      }

      finalSignal = extractFinalSignal(completion.outputText);
      if (finalSignal !== null) {
        return {
          answer: finalSignal.value,
          finalValue: finalSignal.value,
          session,
          steps: step,
          usage: cloneUsageSummary(usageSummary),
        };
      }
    }

    if (completion === null || codeBlocks.length === 0) {
      throw new RLMProtocolError(
        'Assistant turn did not contain a ```repl``` block or an explicit FINAL signal.',
      );
    }

    const executions = [];
    for (const block of codeBlocks) {
      throwIfAborted(options.signal);
      const execution = await session.execute(block.code);
      executions.push({
        code: block.code,
        finalAnswer: execution.finalAnswer,
        resultPreview: execution.result.preview,
        resultSignals: execution.result.signals,
        status: execution.status,
        stderr: execution.stderr,
        stdout: execution.stdout,
      });

      if (execution.finalAnswer !== null) {
        if (!shouldAcceptExecutionFinalAnswer(execution.status, execution.finalAnswer)) {
          continue;
        }

        transcript.push({
          assistantText: completion.outputText,
          executions,
          step,
        });

        return {
          answer: execution.finalAnswer,
          finalValue: extractFinalJsonValue(execution.finalResult),
          session,
          steps: step,
          usage: cloneUsageSummary(usageSummary),
        };
      }

      if (execution.status !== 'success') {
        break;
      }
    }

    transcript.push({
      assistantText: completion.outputText,
      executions,
      step,
    });
  }

  throw new RLMMaxStepsError(options.maxSteps);
}

export const __rlmRunnerTestables = {
  extractFinalJsonValue,
  resolveControllerRole,
  resolveProviderAwareCellTimeoutMs,
  resolveRLMCaller,
  resolveOpenAIRunLogger,
  resolveRunLimit,
  resolveSubqueryAnswerValue,
  shouldAcceptExecutionFinalAnswer,
  throwIfAborted,
};
