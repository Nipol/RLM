import assert from 'node:assert/strict';

import {
  __openAIAdapterTestables,
  OpenAIResponsesAdapter,
  OpenAIResponsesError,
} from '../src/openai_adapter.ts';

Deno.test('OpenAI adapter posts model instructions and input to the Responses API', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const adapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    fetcher: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;

      return new Response(
        JSON.stringify({
          id: 'resp_123',
          output: [
            {
              content: [
                {
                  text: '```repl\nFINAL_VAR(42)\n```',
                  type: 'output_text',
                },
              ],
              role: 'assistant',
              type: 'message',
            },
          ],
          usage: {
            input_tokens: 10,
            input_tokens_details: {
              cached_tokens: 4,
            },
            output_tokens: 5,
            total_tokens: 15,
          },
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      );
    },
  });

  const response = await adapter.complete({
    input: 'Solve the task.',
    model: 'gpt-5-nano',
    systemPrompt: 'Use the REPL.',
  });

  assert.equal(capturedUrl, 'https://api.openai.com/v1/responses');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(
    new Headers(capturedInit?.headers).get('Authorization'),
    'Bearer sk-test',
  );

  const payload = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.equal(payload.model, 'gpt-5-nano');
  assert.equal(payload.instructions, 'Use the REPL.');
  assert.equal(payload.input, 'Solve the task.');
  assert.equal(response.outputText, '```repl\nFINAL_VAR(42)\n```');
  assert.equal(response.responseId, 'resp_123');
  assert.deepEqual(response.usage, {
    cachedInputTokens: 4,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
});

Deno.test('OpenAI adapter surfaces API failures with the provider message intact', async () => {
  const adapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    fetcher: async () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'model unavailable',
          },
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 503,
        },
      ),
  });

  await assert.rejects(
    async () => {
      await adapter.complete({
        input: 'Solve the task.',
        model: 'gpt-5-nano',
        systemPrompt: 'Use the REPL.',
      });
    },
    OpenAIResponsesError,
  );
});

Deno.test('OpenAI adapter accepts direct output_text payloads and forwards previous response ids', async () => {
  let capturedInit: RequestInit | undefined;
  const adapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    fetcher: async (_input, init) => {
      capturedInit = init;

      return new Response(
        JSON.stringify({
          id: 'resp_456',
          output_text: 'FINAL("done")',
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      );
    },
  });

  const response = await adapter.complete({
    input: 'Continue the conversation.',
    model: 'gpt-5-nano',
    previousResponseId: 'resp_prev',
    systemPrompt: 'Use the REPL.',
  });

  const payload = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.equal(payload.previous_response_id, 'resp_prev');
  assert.equal(response.outputText, 'FINAL("done")');
  assert.equal(response.usage, undefined);
});

Deno.test('OpenAI adapter rejects responses that never contain assistant text', async () => {
  const adapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    fetcher: async () =>
      new Response(
        JSON.stringify({
          id: 'resp_789',
          output: [
            {
              type: 'reasoning',
            },
          ],
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      ),
  });

  await assert.rejects(
    async () => {
      await adapter.complete({
        input: 'Solve the task.',
        model: 'gpt-5-nano',
        systemPrompt: 'Use the REPL.',
      });
    },
    OpenAIResponsesError,
  );
});

Deno.test('OpenAI adapter maps aborts and unexpected transport failures into stable provider errors', async () => {
  const timeoutAdapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    fetcher: async () => {
      throw new DOMException('aborted', 'AbortError');
    },
  });

  const transportAdapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    fetcher: async () => {
      throw new Error('socket closed');
    },
  });

  await assert.rejects(
    async () => {
      await timeoutAdapter.complete({
        input: 'Solve the task.',
        model: 'gpt-5-nano',
        systemPrompt: 'Use the REPL.',
      });
    },
    /timed out/u,
  );
  await assert.rejects(
    async () => {
      await transportAdapter.complete({
        input: 'Solve the task.',
        model: 'gpt-5-nano',
        systemPrompt: 'Use the REPL.',
      });
    },
    /socket closed/u,
  );
});

Deno.test('OpenAI adapter forwards already-aborted external signals into the provider request path', async () => {
  let sawAbortedSignal = false;
  const controller = new AbortController();
  controller.abort();

  const adapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    fetcher: async (_input, init) => {
      sawAbortedSignal = (init as RequestInit | undefined)?.signal?.aborted === true;
      throw new DOMException('aborted', 'AbortError');
    },
  });

  await assert.rejects(
    async () => {
      await adapter.complete({
        input: 'Solve the task.',
        model: 'gpt-5-nano',
        signal: controller.signal,
        systemPrompt: 'Use the REPL.',
      });
    },
    /timed out/u,
  );
  assert.equal(sawAbortedSignal, true);
});

Deno.test('OpenAI adapter reacts to an external abort that fires after the request has started', async () => {
  const controller = new AbortController();
  let sawAbort = false;

  const adapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    fetcher: async (_input, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            sawAbort = true;
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    },
  });

  const pending = adapter.complete({
    input: 'Solve the task.',
    model: 'gpt-5-nano',
    signal: controller.signal,
    systemPrompt: 'Use the REPL.',
  });
  controller.abort();

  await assert.rejects(async () => await pending, /timed out/u);
  assert.equal(sawAbort, true);
});

Deno.test('OpenAI adapter reads plain text message content and falls back to default status messages', async () => {
  const defaultStatusAdapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    fetcher: async () =>
      new Response(
        JSON.stringify({
          error: {},
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 500,
        },
      ),
  });

  const textContentAdapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    fetcher: async () =>
      new Response(
        JSON.stringify({
          id: 'resp_text_1',
          output: [
            {
              content: [
                {
                  text: 'FINAL("text path")',
                  type: 'text',
                },
              ],
              type: 'message',
            },
          ],
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      ),
  });

  const nonErrorAdapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    fetcher: async () => {
      throw 'transport exploded';
    },
  });

  const response = await textContentAdapter.complete({
    input: 'Solve the task.',
    model: 'gpt-5-nano',
    systemPrompt: 'Use the REPL.',
  });

  assert.equal(response.outputText, 'FINAL("text path")');
  await assert.rejects(
    async () => {
      await defaultStatusAdapter.complete({
        input: 'Solve the task.',
        model: 'gpt-5-nano',
        systemPrompt: 'Use the REPL.',
      });
    },
    /status 500/u,
  );
  await assert.rejects(
    async () => {
      await nonErrorAdapter.complete({
        input: 'Solve the task.',
        model: 'gpt-5-nano',
        systemPrompt: 'Use the REPL.',
      });
    },
    /transport exploded/u,
  );
});

Deno.test('OpenAI adapter falls back from empty output_text and treats payload-level errors as failures', async () => {
  const fallbackAdapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    fetcher: async () =>
      new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: 'reasoning',
                },
                {
                  type: 'output_text',
                },
                {
                  text: 'FINAL("fallback")',
                  type: 'output_text',
                },
              ],
              type: 'message',
            },
          ],
          output_text: '',
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      ),
  });

  const payloadErrorAdapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    fetcher: async () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'payload says no',
          },
          output: [],
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      ),
  });

  const missingIdResponse = await fallbackAdapter.complete({
    input: 'Solve the task.',
    model: 'gpt-5-nano',
    systemPrompt: 'Use the REPL.',
  });

  assert.equal(missingIdResponse.outputText, 'FINAL("fallback")');
  assert.equal(missingIdResponse.responseId, null);
  await assert.rejects(
    async () => {
      await payloadErrorAdapter.complete({
        input: 'Solve the task.',
        model: 'gpt-5-nano',
        systemPrompt: 'Use the REPL.',
      });
    },
    /payload says no/u,
  );
});

Deno.test('OpenAI adapter can use the global fetch and skip message items without content', async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: 'resp_global_1',
          output: [
            {
              type: 'message',
            },
            {
              content: [
                {
                  text: 'FINAL("global fetch")',
                  type: 'output_text',
                },
              ],
              type: 'message',
            },
          ],
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      );

    const adapter = new OpenAIResponsesAdapter({
      config: {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        requestTimeoutMs: 30_000,
        rootModel: 'gpt-5-nano',
        subModel: 'gpt-5-mini',
      },
    });

    const response = await adapter.complete({
      input: 'Solve the task.',
      model: 'gpt-5-nano',
      systemPrompt: 'Use the REPL.',
    });

    assert.equal(response.outputText, 'FINAL("global fetch")');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('OpenAI adapter treats non-timeout DOMExceptions like ordinary transport failures', async () => {
  const adapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    fetcher: async () => {
      throw new DOMException('dns failed', 'NetworkError');
    },
  });

  await assert.rejects(
    async () => {
      await adapter.complete({
        input: 'Solve the task.',
        model: 'gpt-5-nano',
        systemPrompt: 'Use the REPL.',
      });
    },
    /dns failed/u,
  );
});

Deno.test('OpenAI adapter falls back to a default HTTP status message when the provider omits one', async () => {
  const adapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    fetcher: async () =>
      new Response(
        JSON.stringify({
          error: {},
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 502,
        },
      ),
  });

  await assert.rejects(
    async () => {
      await adapter.complete({
        input: 'Solve the task.',
        model: 'gpt-5-nano',
        systemPrompt: 'Use the REPL.',
      });
    },
    /status 502/u,
  );
});

Deno.test('OpenAI adapter returns a null response id and ignores non-string content chunks', async () => {
  const adapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    fetcher: async () =>
      new Response(
        JSON.stringify({
          output: [
            {
              content: [
                { text: 42, type: 'output_text' },
                { text: 'FINAL("fallback text")', type: 'text' },
              ],
              type: 'message',
            },
          ],
          usage: {},
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      ),
  });

  const response = await adapter.complete({
    input: 'Solve the task.',
    model: 'gpt-5-nano',
    systemPrompt: 'Use the REPL.',
  });

  assert.equal(response.responseId, null);
  assert.equal(response.outputText, 'FINAL("fallback text")');
  assert.deepEqual(response.usage, {
    cachedInputTokens: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
  });
});

Deno.test('OpenAI adapter rejects payloads whose output container is not an array', async () => {
  const adapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5-nano',
      subModel: 'gpt-5-mini',
    },
    fetcher: async () =>
      new Response(
        JSON.stringify({
          id: 'resp_invalid_output',
          output: {
            content: [{ text: 'ignored', type: 'output_text' }],
            type: 'message',
          },
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      ),
  });

  await assert.rejects(
    async () => {
      await adapter.complete({
        input: 'Solve the task.',
        model: 'gpt-5-nano',
        systemPrompt: 'Use the REPL.',
      });
    },
    /did not contain assistant text/u,
  );
});

Deno.test('OpenAI adapter helper detaches abort listeners only when a signal exists', () => {
  const controller = new AbortController();
  let calls = 0;
  const original = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.removeEventListener =
    ((...args: Parameters<AbortSignal['removeEventListener']>) => {
      calls += 1;
      return original(...args);
    }) as AbortSignal['removeEventListener'];

  __openAIAdapterTestables.detachAbortListener(controller.signal, () => {});
  __openAIAdapterTestables.detachAbortListener(undefined, () => {});

  assert.equal(calls, 1);
});

Deno.test('OpenAI adapter helper attaches abort listeners for active signals and aborts immediately for aborted ones', () => {
  let attachedCalls = 0;
  const activeSignal = {
    aborted: false,
    addEventListener() {
      attachedCalls += 1;
    },
  } as unknown as AbortSignal;
  const activeController = new AbortController();

  __openAIAdapterTestables.attachAbortListener(activeSignal, activeController, () => {});
  assert.equal(attachedCalls, 1);
  assert.equal(activeController.signal.aborted, false);

  const abortedController = new AbortController();
  const abortedSignal = {
    aborted: true,
    addEventListener() {
      throw new Error('should not attach to an aborted signal');
    },
  } as unknown as AbortSignal;
  __openAIAdapterTestables.attachAbortListener(abortedSignal, abortedController, () => {});
  assert.equal(abortedController.signal.aborted, true);

  const undefinedSignalController = new AbortController();
  __openAIAdapterTestables.attachAbortListener(undefined, undefinedSignalController, () => {});
  assert.equal(undefinedSignalController.signal.aborted, false);
});
