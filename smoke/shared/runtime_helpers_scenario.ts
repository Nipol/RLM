import type { LLMCaller, LLMCallerRequest, RLMClient, RLMClientOptions } from '../../mod.ts';

/**
 * Captures the observable result of the cross-runtime runtime-helper smoke scenario.
 */
export interface RuntimeHelpersSmokeScenarioResult {
  finalValue: {
    delegated: string;
    delegatedBatch: string[];
    grepPreview: Array<{
      contextText: string;
      line: string;
      lineNumber: number;
    }>;
    plain: string;
    plainBatch: string[];
  };
  kindCounts: {
    child_turn: number;
    plain_query: number;
    root_turn: number;
  };
  steps: number;
}

/**
 * Represents the stable public `createRLM(...)` shape exercised by the runtime-helper smoke tests.
 */
export type CreateRLMFn = (options: RLMClientOptions) => RLMClient;

class RuntimeHelpersSmokeCaller implements LLMCaller {
  readonly requests: LLMCallerRequest[] = [];

  async complete(request: LLMCallerRequest) {
    this.requests.push(request);

    if (request.kind === 'root_turn') {
      return {
        outputText: [
          '```repl',
          "const plain = await llm_query('plain:ping');",
          "const plainBatch = await llm_query_batched(['batch:alpha', 'batch:beta']);",
          "const delegated = await rlm_query({ task: 'Return payload.answer exactly.', payload: { answer: 'PONG' }, expect: 'string' });",
          'const delegatedBatch = await rlm_query_batched([',
          "  { task: 'Return payload.answer exactly.', payload: { answer: 'LEFT' }, expect: 'string' },",
          "  { task: 'Return payload.answer exactly.', payload: { answer: 'RIGHT' }, expect: 'string' },",
          ']);',
          "const grepPreview = grep(context.document, 'beta', { before: 1, after: 1, limit: 1 }).map((entry) => ({",
          '  contextText: entry.contextText,',
          '  line: entry.line,',
          '  lineNumber: entry.lineNumber,',
          '}));',
          'FINAL_VAR({ delegated, delegatedBatch, grepPreview, plain, plainBatch });',
          '```',
        ].join('\n'),
      };
    }

    if (request.kind === 'child_turn') {
      return {
        outputText: [
          '```repl',
          'FINAL_VAR(context.payload.answer);',
          '```',
        ].join('\n'),
      };
    }

    if (request.kind === 'plain_query') {
      if (request.input === 'plain:ping') {
        return { outputText: 'PONG' };
      }

      if (request.input === 'batch:alpha') {
        return { outputText: 'ALPHA' };
      }

      if (request.input === 'batch:beta') {
        return { outputText: 'BETA' };
      }

      throw new Error(`Unexpected runtime helper smoke plain_query input: ${request.input}`);
    }

    throw new Error(`Unsupported runtime helper smoke request kind: ${request.kind}`);
  }
}

/**
 * Runs one public-interface smoke scenario that verifies each built-in runtime helper path
 * through the public `createRLM(...)` surface.
 *
 * @example
 * ```ts
 * import { createRLM } from '../../mod.ts';
 *
 * const result = await runRuntimeHelpersSmokeScenario(createRLM);
 * console.log(result.finalValue.plain); // "PONG"
 * ```
 */
export async function runRuntimeHelpersSmokeScenario(
  createRLM: CreateRLMFn,
): Promise<RuntimeHelpersSmokeScenarioResult> {
  const llm = new RuntimeHelpersSmokeCaller();
  const client = createRLM({
    defaults: {
      maxSteps: 1,
      maxSubcallDepth: 2,
      outputCharLimit: 512,
    },
    llm,
    models: {
      root: 'runtime-helper-smoke-root',
      sub: 'runtime-helper-smoke-sub',
    },
  });

  const result = await client.run({
    context: {
      document: ['alpha', 'beta', 'gamma'].join('\n'),
      source: 'runtime-helper-smoke',
    },
    prompt: 'Exercise each runtime helper path exactly once.',
  });

  try {
    return {
      finalValue: result.finalValue as RuntimeHelpersSmokeScenarioResult['finalValue'],
      kindCounts: {
        child_turn: llm.requests.filter((request) => request.kind === 'child_turn').length,
        plain_query: llm.requests.filter((request) => request.kind === 'plain_query').length,
        root_turn: llm.requests.filter((request) => request.kind === 'root_turn').length,
      },
      steps: result.steps,
    };
  } finally {
    await result.session.close();
  }
}
