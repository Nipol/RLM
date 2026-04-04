import assert from 'node:assert/strict';
import { join } from 'node:path';

import * as ollamaProvider from '../ollama.ts';

Deno.test('Ollama provider subpath entrypoint exposes provider-specific convenience helpers', () => {
  assert.equal(typeof ollamaProvider.createOllamaRLM, 'function');
  assert.equal(typeof ollamaProvider.runOllamaRLM, 'function');
  assert.equal(typeof ollamaProvider.OllamaGenerateProvider, 'function');
});

Deno.test('Ollama provider helpers resolve logger and provider-aware timeout values', () => {
  const explicitLogger = {
    append() {},
  };

  assert.equal(
    ollamaProvider.__ollamaProviderTestables.resolveProviderAwareCellTimeoutMs(undefined, 30_000),
    35_000,
  );
  assert.equal(
    ollamaProvider.__ollamaProviderTestables.resolveProviderAwareCellTimeoutMs(2_000, 30_000),
    32_000,
  );
  assert.equal(
    ollamaProvider.__ollamaProviderTestables.resolveOllamaRunLogger(explicitLogger, undefined),
    explicitLogger,
  );
  assert.equal(
    ollamaProvider.__ollamaProviderTestables.resolveOllamaRunLogger(undefined, undefined),
    undefined,
  );
  assert.notEqual(
    ollamaProvider.__ollamaProviderTestables.resolveOllamaRunLogger(
      undefined,
      join(Deno.cwd(), 'tmp', 'ollama-provider-entrypoint-test.jsonl'),
    ),
    undefined,
  );
});

Deno.test('runOllamaRLM covers the one-shot convenience path and explicit cell timeout adjustment', async () => {
  const requests: Array<{ model: string; prompt: string; url: string }> = [];
  const result = await ollamaProvider.runOllamaRLM({
    cellTimeoutMs: 1_000,
    context: {
      source: 'ollama-one-shot',
    },
    fetcher: async (input, init) => {
      const url = String(input);
      const requestInit = (init ?? {}) as RequestInit & { body?: BodyInit | null };
      const payload = JSON.parse(String(requestInit.body ?? '{}'));

      requests.push({
        model: String(payload.model ?? ''),
        prompt: String(payload.prompt ?? ''),
        url,
      });

      if (payload.model === 'one-shot-root') {
        return new Response(
          JSON.stringify({
            done: true,
            response: [
              '```repl',
              "const delegated = await rlm_query({ task: 'Return payload.answer exactly.', payload: { answer: 'PONG' }, expect: 'string' });",
              'FINAL_VAR(delegated);',
              '```',
            ].join('\n'),
          }),
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        );
      }

      if (payload.model === 'one-shot-sub') {
        return new Response(
          JSON.stringify({
            done: true,
            response: [
              '```repl',
              'FINAL_VAR(context.payload.answer);',
              '```',
            ].join('\n'),
          }),
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        );
      }

      throw new Error(`Unexpected model: ${String(payload.model)}`);
    },
    journalPath: join(Deno.cwd(), 'tmp', 'ollama-run-one-shot.jsonl'),
    maxSteps: 2,
    ollama: {
      baseUrl: 'http://localhost:11434/api',
      requestTimeoutMs: 30_000,
      rootModel: 'one-shot-root',
      subModel: 'one-shot-sub',
    },
    prompt: 'Return the delegated value.',
  });

  try {
    assert.equal(result.answer, 'PONG');
    assert.equal(result.finalValue, 'PONG');
    assert.equal(result.steps, 1);
    assert.equal(requests[0]?.model, 'one-shot-root');
    assert.equal(requests.slice(1).every((request) => request.model === 'one-shot-sub'), true);
    assert.equal(
      requests.every((request) => request.url === 'http://localhost:11434/api/generate'),
      true,
    );
  } finally {
    await result.session.close();
  }
});
