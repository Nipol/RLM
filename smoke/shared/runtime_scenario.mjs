export async function runSmokeScenario(createRLM) {
  const requests = [];
  const llm = {
    async complete(request) {
      requests.push(request);

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

      throw new Error(`Unsupported smoke request kind: ${request.kind}`);
    },
  };

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
      kinds: requests.map((request) => request.kind),
      steps: result.steps,
    };
  } finally {
    await result.session.close();
  }
}
