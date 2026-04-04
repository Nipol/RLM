import type {
  LLMCaller,
  LLMCallerRequest,
  RLMClient,
  RLMClientOptions,
  RLMPlugin,
} from '../../mod.ts';

/**
 * Captures the observable result of the cross-runtime plugin smoke scenario.
 */
export interface PluginSmokeScenarioResult {
  answer: string;
  aotHelperName: string | null;
  finalValue: unknown;
  helperNames: string[];
  pluginNames: string[];
  steps: number;
}

/**
 * Represents the stable public `createRLM(...)` shape exercised by the plugin smoke tests.
 */
export type CreateRLMFn = (options: RLMClientOptions) => RLMClient;

/**
 * Represents the stable public repository plugin factories exercised by the smoke tests.
 */
export type CreatePluginFn = () => RLMPlugin;

class PluginSmokeCaller implements LLMCaller {
  readonly requests: LLMCallerRequest[] = [];

  async complete(request: LLMCallerRequest) {
    this.requests.push(request);

    if (request.kind === 'root_turn') {
      return {
        outputText: [
          '```repl',
          'const answer = await ping_pong("PING");',
          'FINAL_VAR(answer);',
          '```',
        ].join('\n'),
      };
    }

    throw new Error(`Unsupported plugin smoke request kind: ${request.kind}`);
  }
}

/**
 * Runs one public-interface plugin smoke scenario that exercises repository plugin imports
 * and a runtime helper call through the public `createRLM(...)` surface.
 *
 * @example
 * ```ts
 * import { createRLM } from '../../mod.ts';
 * import { createAoTPlugin } from '../../plugin/aot/mod.ts';
 * import { createPingPongPlugin } from '../../plugin/pingpong/mod.ts';
 *
 * const result = await runPluginSmokeScenario(
 *   createRLM,
 *   createPingPongPlugin,
 *   createAoTPlugin,
 * );
 * console.log(result.answer); // "PONG"
 * ```
 */
export async function runPluginSmokeScenario(
  createRLM: CreateRLMFn,
  createPingPongPlugin: CreatePluginFn,
  createAoTPlugin: CreatePluginFn,
): Promise<PluginSmokeScenarioResult> {
  const llm = new PluginSmokeCaller();
  const pingPongPlugin = createPingPongPlugin();
  const aotPlugin = createAoTPlugin();
  const client = createRLM({
    defaults: {
      maxSteps: 1,
      maxSubcallDepth: 1,
      outputCharLimit: 512,
    },
    llm,
    models: {
      root: 'plugin-smoke-root',
      sub: 'plugin-smoke-sub',
    },
    plugins: [pingPongPlugin, aotPlugin],
  });

  const result = await client.run({
    context: {
      source: 'plugin-smoke',
    },
    prompt: 'Return the ping-pong plugin result.',
  });

  try {
    return {
      answer: result.answer,
      aotHelperName: aotPlugin.runtimeHelpers?.[0]?.name ?? null,
      finalValue: result.finalValue,
      helperNames: [
        ...(pingPongPlugin.runtimeHelpers?.map((helper) => helper.name) ?? []),
        ...(aotPlugin.runtimeHelpers?.map((helper) => helper.name) ?? []),
      ],
      pluginNames: [pingPongPlugin.name, aotPlugin.name],
      steps: result.steps,
    };
  } finally {
    await result.session.close();
  }
}
