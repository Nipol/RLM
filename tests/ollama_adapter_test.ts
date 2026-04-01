import assert from 'node:assert/strict';

import {
  OllamaGenerateAdapter,
  OllamaGenerateError,
  OllamaGenerateProvider,
} from '../src/providers/ollama_adapter.ts';
import type { LLMCallerRequest } from '../src/llm_adapter.ts';

function createRequest(overrides: Partial<LLMCallerRequest> = {}): LLMCallerRequest {
  return {
    input: 'Solve the task.',
    kind: 'root_turn',
    model: 'llama3.2',
    systemPrompt: 'Use the REPL.',
    ...overrides,
  };
}

Deno.test('Ollama adapter posts model system prompt and input to the generate endpoint', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const adapter = new OllamaGenerateAdapter({
    config: {
      baseUrl: 'http://localhost:11434/api',
      requestTimeoutMs: 30_000,
      rootModel: 'llama3.2',
      subModel: 'llama3.2',
    },
    fetcher: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;

      return new Response(
        JSON.stringify({
          done: true,
          eval_count: 5,
          prompt_eval_count: 10,
          response: '```repl\nFINAL_VAR("ok")\n```',
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      );
    },
  });

  const response = await adapter.complete(createRequest());

  assert.equal(capturedUrl, 'http://localhost:11434/api/generate');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(new Headers(capturedInit?.headers).get('Content-Type'), 'application/json');

  const payload = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.equal(payload.model, 'llama3.2');
  assert.equal(payload.system, 'Use the REPL.');
  assert.equal(payload.prompt, 'Solve the task.');
  assert.equal(payload.stream, false);
  assert.equal(response.outputText, '```repl\nFINAL_VAR("ok")\n```');
  assert.equal(response.turnState, undefined);
  assert.deepEqual(response.usage, {
    cachedInputTokens: undefined,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
});

Deno.test('Ollama adapter surfaces HTTP failures with provider messages', async () => {
  const adapter = new OllamaGenerateAdapter({
    config: {
      baseUrl: 'http://localhost:11434/api',
      requestTimeoutMs: 30_000,
      rootModel: 'llama3.2',
      subModel: 'llama3.2',
    },
    fetcher: async () =>
      new Response(
        JSON.stringify({
          error: 'model unavailable',
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
    OllamaGenerateError,
  );
});

Deno.test('Ollama adapter binds the global fetch in browser-like runtimes', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async function (this: typeof globalThis) {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }

      return new Response(
        JSON.stringify({
          done: true,
          response: 'FINAL("global fetch")',
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      );
    }) as typeof fetch;

    const adapter = new OllamaGenerateAdapter({
      config: {
        baseUrl: 'http://localhost:11434/api',
        requestTimeoutMs: 30_000,
        rootModel: 'llama3.2',
        subModel: 'llama3.2',
      },
    });

    const response = await adapter.complete(createRequest());
    assert.equal(response.outputText, 'FINAL("global fetch")');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('Ollama provider builds a provider-neutral caller that reuses the shared fetcher', async () => {
  let capturedUrl = '';
  const provider = new OllamaGenerateProvider({
    fetcher: async (input) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({
          done: true,
          response: 'FINAL("provider")',
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      );
    },
  });

  const llm = provider.createCaller({
    baseUrl: 'http://localhost:11434/api',
    requestTimeoutMs: 30_000,
    rootModel: 'llama3.2',
    subModel: 'llama3.2',
  });

  const response = await llm.complete(createRequest({
    input: 'Use the provider-created caller.',
  }));

  assert.equal(capturedUrl, 'http://localhost:11434/api/generate');
  assert.equal(response.outputText, 'FINAL("provider")');
});
