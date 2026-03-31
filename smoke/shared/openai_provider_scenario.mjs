export async function runOpenAIProviderSmokeScenario(createOpenAIRLM) {
  const requests = [];
  const client = createOpenAIRLM({
    defaults: {
      maxSteps: 1,
      maxSubcallDepth: 2,
      outputCharLimit: 512,
    },
    fetcher: async (input, init) => {
      const url = String(input);
      const requestInit = init ?? {};
      const headers = new Headers(requestInit.headers);
      const payload = JSON.parse(String(requestInit.body ?? '{}'));

      requests.push({
        authorization: headers.get('authorization') ?? headers.get('Authorization') ?? '',
        input: String(payload.input ?? ''),
        instructions: String(payload.instructions ?? ''),
        model: String(payload.model ?? ''),
        url,
      });

      if (payload.model === 'smoke-root') {
        return new Response(
          JSON.stringify({
            id: 'resp_root_1',
            output_text: [
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
        if (payload.input === 'ping') {
          return new Response(
            JSON.stringify({
              id: 'resp_plain_1',
              output_text: 'PONG',
            }),
            {
              headers: { 'Content-Type': 'application/json' },
              status: 200,
            },
          );
        }

        return new Response(
          JSON.stringify({
            id: 'resp_child_1',
            output_text: [
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
    openAI: {
      apiKey: 'sk-smoke',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'smoke-root',
      subModel: 'smoke-sub',
    },
  });

  const result = await client.run({
    context: {
      source: 'smoke-openai-provider',
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
          : request.input === 'ping'
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
