export async function runPluginSmokeScenario(
  createRLM,
  createPingPongPlugin,
  createAoTPlugin,
) {
  const pingPongPlugin = createPingPongPlugin();
  const aotPlugin = createAoTPlugin();
  const requests = [];
  const llm = {
    async complete(request) {
      requests.push(request);

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
    },
  };

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
      requestKinds: requests.map((request) => request.kind),
      steps: result.steps,
    };
  } finally {
    await result.session.close();
  }
}
