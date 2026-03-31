export async function runOllamaProviderSmokeScenario(createOllamaRLM) {
  const requests = [];
  const client = createOllamaRLM({
    defaults: {
      maxSteps: 1,
      maxSubcallDepth: 2,
      outputCharLimit: 512,
    },
    fetcher: async (input, init) => {
      const url = String(input);
      const requestInit = init ?? {};
      const payload = JSON.parse(String(requestInit.body ?? '{}'));

      requests.push({
        model: String(payload.model ?? ''),
        prompt: String(payload.prompt ?? ''),
        system: String(payload.system ?? ''),
        url,
      });

      if (payload.model === 'smoke-root') {
        return new Response(
          JSON.stringify({
            done: true,
            response: [
              '```repl',
              "const delegated = await rlm_query({ task: 'Return payload.answer exactly.', payload: { answer: 'PONG' }, expect: 'string' });",
              "const plain = await llm_query('ping');",
              'FINAL_VAR(`${delegated}:${plain}`);',
              '```',
            ].join('\n'),
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          },
        );
      }

      if (payload.model === 'smoke-sub') {
        if (payload.prompt === 'ping') {
          return new Response(
            JSON.stringify({
              done: true,
              response: 'PONG',
            }),
            {
              headers: { 'Content-Type': 'application/json' },
              status: 200,
            },
          );
        }

        return new Response(
          JSON.stringify({
            done: true,
            response: [
              '```repl',
              'FINAL_VAR(context.payload.answer);',
              '```',
            ].join('\n'),
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          },
        );
      }

      throw new Error(`Unexpected smoke provider model: ${String(payload.model)}`);
    },
    ollama: {
      baseUrl: 'http://localhost:11434/api',
      requestTimeoutMs: 30_000,
      rootModel: 'smoke-root',
      subModel: 'smoke-sub',
    },
  });

  const result = await client.run({
    context: {
      source: 'smoke-ollama-provider',
    },
    prompt: 'Return the delegated and plain-query smoke results.',
  });

  try {
    return {
      answer: result.answer,
      finalValue: result.finalValue,
      requestKinds: requests.map((request) =>
        request.model === 'smoke-root'
          ? 'root_turn'
          : request.prompt === 'ping'
          ? 'plain_query'
          : 'child_turn'
      ),
      steps: result.steps,
      urls: requests.map((request) => request.url),
    };
  } finally {
    await result.session.close();
  }
}
