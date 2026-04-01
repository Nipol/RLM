import assert from 'node:assert/strict';

import { listModelsForDraft } from './provider_catalog.ts';

function readAuthorizationHeader(init: unknown): string {
  if (typeof init !== 'object' || init === null) {
    return '';
  }

  const headers = (init as { headers?: HeadersInit }).headers;
  return new Headers(headers).get('Authorization') ?? '';
}

Deno.test('listModelsForDraft loads the OpenAI catalog with bearer auth and filters non-chat models', async () => {
  let requestedUrl = '';
  let authorization = '';

  const result = await listModelsForDraft({
    apiKey: 'sk-openai',
    availableModels: [],
    baseUrl: 'https://api.openai.com',
    kind: 'openai',
    rootModel: '',
    subModel: '',
  }, async (input, init) => {
    requestedUrl = String(input);
    authorization = readAuthorizationHeader(init);

    return new Response(
      JSON.stringify({
        data: [
          { id: 'gpt-5' },
          { id: 'gpt-5-mini' },
          { id: 'text-embedding-3-large' },
        ],
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      },
    );
  });

  assert.equal(requestedUrl, 'https://api.openai.com/v1/models');
  assert.equal(authorization, 'Bearer sk-openai');
  assert.deepEqual(result.availableModels, ['gpt-5', 'gpt-5-mini']);
});

Deno.test('listModelsForDraft normalizes the Ollama Local base URL and reads /tags', async () => {
  let requestedUrl = '';

  const result = await listModelsForDraft({
    apiKey: '',
    availableModels: [],
    baseUrl: 'localhost:11434',
    kind: 'ollama-local',
    rootModel: '',
    subModel: '',
  }, async (input) => {
    requestedUrl = String(input);

    return new Response(
      JSON.stringify({
        models: [{ name: 'llama3.2:3b' }, { name: 'qwen3:8b' }],
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      },
    );
  });

  assert.equal(requestedUrl, 'http://localhost:11434/api/tags');
  assert.deepEqual(result.availableModels, ['llama3.2:3b', 'qwen3:8b']);
});

Deno.test('listModelsForDraft uses the fixed Ollama Cloud endpoint with bearer auth', async () => {
  let requestedUrl = '';
  let authorization = '';

  await listModelsForDraft({
    apiKey: 'ollama-cloud-key',
    availableModels: [],
    baseUrl: '',
    kind: 'ollama-cloud',
    rootModel: '',
    subModel: '',
  }, async (input, init) => {
    requestedUrl = String(input);
    authorization = readAuthorizationHeader(init);

    return new Response(
      JSON.stringify({
        models: [{ name: 'gpt-oss:120b' }],
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      },
    );
  });

  assert.equal(requestedUrl, 'https://ollama.com/api/tags');
  assert.equal(authorization, 'Bearer ollama-cloud-key');
});

Deno.test('listModelsForDraft surfaces provider error messages from failed requests', async () => {
  await assert.rejects(
    () =>
      listModelsForDraft({
        apiKey: 'sk-openai',
        availableModels: [],
        baseUrl: '',
        kind: 'openai',
        rootModel: '',
        subModel: '',
      }, async () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'invalid api key',
            },
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 401,
          },
        )),
    /invalid api key/u,
  );
});

Deno.test('listModelsForDraft applies the configured OpenAI request timeout', async () => {
  await assert.rejects(
    () =>
      listModelsForDraft({
        apiKey: 'sk-openai',
        availableModels: [],
        baseUrl: '',
        kind: 'openai',
        requestTimeoutMs: 1,
        rootModel: '',
        subModel: '',
      }, async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })),
    /OpenAI 모델 목록 요청이 1ms 뒤에 시간 초과/u,
  );
});
