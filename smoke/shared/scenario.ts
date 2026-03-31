import type { LLMCaller, LLMCallerRequest, RLMClient, RLMClientOptions } from '../../mod.ts';

/**
 * Captures the observable result of the cross-runtime smoke scenario.
 */
export interface SmokeScenarioResult {
  answer: string;
  finalValue: unknown;
  kinds: string[];
  steps: number;
}

/**
 * Represents the stable public `createRLM(...)` shape exercised by the smoke tests.
 */
export type CreateRLMFn = (options: RLMClientOptions) => RLMClient;

class SmokeCaller implements LLMCaller {
  readonly requests: LLMCallerRequest[] = [];

  async complete(request: LLMCallerRequest) {
    this.requests.push(request);

    if (request.kind === 'root_turn') {
      return {
        outputText: [
          '```repl',
          "const delegated = await rlm_query({ task: 'Return payload.answer exactly.', payload: { answer: 'PONG' }, expect: 'string' });",
          "const plain = await llm_query('ping');",
          'FINAL_VAR(`${delegated}:${plain}`);',
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
      if (request.input !== 'ping') {
        throw new Error(`Unexpected smoke plain_query input: ${request.input}`);
      }

      return { outputText: 'PONG' };
    }

    throw new Error(`Unsupported smoke request kind: ${(request as { kind?: string }).kind}`);
  }
}

/**
 * Runs one public-interface smoke scenario that exercises the root loop,
 * a delegated child RLM, and a plain `llm_query(...)` call.
 *
 * @example
 * ```ts
 * import { createRLM } from '../../mod.ts';
 *
 * const result = await runSmokeScenario(createRLM);
 * console.log(result.answer); // "PONG:PONG"
 * ```
 */
export async function runSmokeScenario(createRLM: CreateRLMFn): Promise<SmokeScenarioResult> {
  const llm = new SmokeCaller();
  const client = createRLM({
    defaults: {
      maxSteps: 1,
      maxSubcallDepth: 2,
      outputCharLimit: 512,
    },
    llm,
    models: {
      root: 'smoke-root',
      sub: 'smoke-sub',
    },
  });

  const result = await client.run({
    context: {
      source: 'smoke',
    },
    prompt: 'Return the delegated and plain-query smoke results.',
  });

  try {
    return {
      answer: result.answer,
      finalValue: result.finalValue,
      kinds: llm.requests.map((request) => request.kind),
      steps: result.steps,
    };
  } finally {
    await result.session.close();
  }
}
