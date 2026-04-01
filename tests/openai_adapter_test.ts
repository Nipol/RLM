import assert from 'node:assert/strict';

import {
  __openAIAdapterTestables,
  OpenAIResponsesAdapter,
  OpenAIResponsesError,
  OpenAIResponsesProvider,
} from '../src/providers/openai_adapter.ts';
import type { LLMCallerRequest } from '../src/llm_adapter.ts';

function createRequest(overrides: Partial<LLMCallerRequest> = {}): LLMCallerRequest {
  return {
    input: 'Solve the task.',
    kind: 'root_turn',
    model: 'gpt-5-nano',
    systemPrompt: 'Use the REPL.',
    ...overrides,
  };
}

function readRequestBody(init: unknown): Record<string, unknown> {
  if (typeof init !== 'object' || init === null) {
    return {};
  }

  return JSON.parse(String((init as { body?: BodyInit | null }).body ?? '{}')) as Record<string, unknown>;
}

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

  const response = await adapter.complete(createRequest());

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
  assert.equal(response.turnState, 'resp_123');
  assert.deepEqual(response.usage, {
    cachedInputTokens: 4,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
});

Deno.test('OpenAI adapter forwards root and sub reasoning effort based on the request kind', async () => {
  const payloads: Array<Record<string, unknown>> = [];
  const adapter = new OpenAIResponsesAdapter({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      requestTimeoutMs: 30_000,
      rootModel: 'gpt-5',
      rootReasoningEffort: 'high',
      subModel: 'gpt-5-mini',
      subReasoningEffort: 'minimal',
    },
    fetcher: async (_input, init) => {
      payloads.push(readRequestBody(init));

      return new Response(
        JSON.stringify({
          id: 'resp_reasoning_1',
          output_text: 'FINAL("ok")',
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      );
    },
  });

  await adapter.complete(createRequest({
    kind: 'root_turn',
    model: 'gpt-5',
  }));
  await adapter.complete(createRequest({
    kind: 'child_turn',
    model: 'gpt-5-mini',
  }));
  await adapter.complete(createRequest({
    input: 'ping',
    kind: 'plain_query',
    model: 'gpt-5-mini',
  }));

  assert.deepEqual(payloads, [
    {
      input: 'Solve the task.',
      instructions: 'Use the REPL.',
      model: 'gpt-5',
      reasoning: {
        effort: 'high',
      },
    },
    {
      input: 'Solve the task.',
      instructions: 'Use the REPL.',
      model: 'gpt-5-mini',
      reasoning: {
        effort: 'minimal',
      },
    },
    {
      input: 'ping',
      instructions: 'Use the REPL.',
      model: 'gpt-5-mini',
      reasoning: {
        effort: 'minimal',
      },
    },
  ]);
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
      await adapter.complete(createRequest());
    },
    OpenAIResponsesError,
  );
});

Deno.test('OpenAI adapter accepts direct output_text payloads and forwards opaque turn state to provider continuation state', async () => {
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

  const response = await adapter.complete(createRequest({
    input: 'Continue the conversation.',
    turnState: 'resp_prev',
  }));

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
      await adapter.complete(createRequest());
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
      await timeoutAdapter.complete(createRequest());
    },
    /timed out/u,
  );
  await assert.rejects(
    async () => {
      await transportAdapter.complete(createRequest());
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
      await adapter.complete(createRequest({
        signal: controller.signal,
      }));
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

  const pending = adapter.complete(createRequest({
    signal: controller.signal,
  }));
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

  const response = await textContentAdapter.complete(createRequest());

  assert.equal(response.outputText, 'FINAL("text path")');
  await assert.rejects(
    async () => {
      await defaultStatusAdapter.complete(createRequest());
    },
    /status 500/u,
  );
  await assert.rejects(
    async () => {
      await nonErrorAdapter.complete(createRequest());
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

  const missingIdResponse = await fallbackAdapter.complete(createRequest());

  assert.equal(missingIdResponse.outputText, 'FINAL("fallback")');
  assert.equal(missingIdResponse.turnState, undefined);
  await assert.rejects(
    async () => {
      await payloadErrorAdapter.complete(createRequest());
    },
    /payload says no/u,
  );
});

Deno.test('OpenAI adapter binds the global fetch in browser-like runtimes and skips message items without content', async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async function (this: typeof globalThis) {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }

      return new Response(
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
    }) as typeof fetch;

    const adapter = new OpenAIResponsesAdapter({
      config: {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        requestTimeoutMs: 30_000,
        rootModel: 'gpt-5-nano',
        subModel: 'gpt-5-mini',
      },
    });

    const response = await adapter.complete(createRequest());

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
      await adapter.complete(createRequest());
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
      await adapter.complete(createRequest());
    },
    /status 502/u,
  );
});

Deno.test('OpenAI adapter returns an undefined turn state and ignores non-string content chunks', async () => {
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

  const response = await adapter.complete(createRequest());

  assert.equal(response.turnState, undefined);
  assert.equal(response.outputText, 'FINAL("fallback text")');
  assert.deepEqual(response.usage, {
    cachedInputTokens: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
  });
});

Deno.test('OpenAI provider builds a provider-neutral caller that reuses the shared fetcher', async () => {
  let capturedAuthorization = '';
  const provider = new OpenAIResponsesProvider({
    fetcher: async (_input, init) => {
      const requestInit = init as globalThis.RequestInit | undefined;
      capturedAuthorization = new Headers(requestInit?.headers).get('Authorization') ?? '';

      return new Response(
        JSON.stringify({
          id: 'resp_provider_1',
          output_text: 'FINAL("provider")',
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      );
    },
  });

  const llm = provider.createCaller({
    apiKey: 'sk-provider',
    baseUrl: 'https://api.openai.com/v1',
    requestTimeoutMs: 30_000,
    rootModel: 'gpt-5-nano',
    subModel: 'gpt-5-mini',
  });

  const response = await llm.complete(createRequest({
    input: 'Use the provider-created caller.',
  }));

  assert.equal(capturedAuthorization, 'Bearer sk-provider');
  assert.equal(response.outputText, 'FINAL("provider")');
  assert.equal(response.turnState, 'resp_provider_1');
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
      await adapter.complete(createRequest());
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
