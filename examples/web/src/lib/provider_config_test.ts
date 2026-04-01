import assert from 'node:assert/strict';

import {
  coerceStoredProviderRequestTimeoutMs,
  createProviderSettings,
  extractOllamaModelIds,
  extractOpenAIModelIds,
  normalizeCatalogModelIds,
  normalizeProviderBaseUrl,
  normalizeProviderRequestTimeoutMs,
  resolveModelSelection,
} from './provider_config.ts';

Deno.test('normalizeProviderBaseUrl applies OpenAI defaults and preserves v1', () => {
  assert.equal(normalizeProviderBaseUrl('openai', ''), 'https://api.openai.com/v1');
  assert.equal(
    normalizeProviderBaseUrl('openai', 'https://api.openai.com/'),
    'https://api.openai.com/v1',
  );
});

Deno.test('normalizeProviderBaseUrl appends the Ollama API path for local hosts', () => {
  assert.equal(
    normalizeProviderBaseUrl('ollama-local', 'localhost:11434'),
    'http://localhost:11434/api',
  );
  assert.equal(
    normalizeProviderBaseUrl('ollama-local', 'http://127.0.0.1:11434/api/'),
    'http://127.0.0.1:11434/api',
  );
});

Deno.test('normalizeProviderBaseUrl fixes Ollama Cloud to the official API base URL', () => {
  assert.equal(
    normalizeProviderBaseUrl('ollama-cloud', 'https://ignored.example.com'),
    'https://ollama.com/api',
  );
});

Deno.test('extractOpenAIModelIds reads model ids from the API payload and filters non-chat entries', () => {
  const extracted = extractOpenAIModelIds({
    data: [
      { id: 'gpt-5' },
      { id: 'text-embedding-3-large' },
      { id: 'gpt-4o-mini' },
      { id: 'gpt-image-1' },
      { invalid: true },
    ],
  });

  assert.deepEqual(
    normalizeCatalogModelIds('openai', extracted),
    ['gpt-4o-mini', 'gpt-5'],
  );
});

Deno.test('extractOllamaModelIds reads model names from the tags payload', () => {
  assert.deepEqual(
    extractOllamaModelIds({
      models: [
        { name: 'llama3.2:3b' },
        { model: 'qwen3:8b' },
        { broken: true },
      ],
    }),
    ['llama3.2:3b', 'qwen3:8b'],
  );
});

Deno.test('resolveModelSelection preserves preferred models when still available', () => {
  assert.deepEqual(
    resolveModelSelection(['gpt-5', 'gpt-5-mini'], 'gpt-5-mini', 'gpt-5'),
    { rootModel: 'gpt-5-mini', subModel: 'gpt-5' },
  );
});

Deno.test('createProviderSettings rejects missing API keys for remote providers', () => {
  assert.throws(
    () =>
      createProviderSettings({
        apiKey: '',
        availableModels: ['gpt-5'],
        baseUrl: '',
        kind: 'openai',
        rootModel: 'gpt-5',
        subModel: 'gpt-5',
      }),
    /API 키/u,
  );
});

Deno.test('createProviderSettings normalizes and stores the selected models', () => {
  const settings = createProviderSettings({
    apiKey: 'sk-test',
    availableModels: ['gpt-5-mini', 'gpt-5'],
    baseUrl: 'https://api.openai.com',
    kind: 'openai',
    requestTimeoutMs: 60_000,
    rootModel: 'gpt-5',
    rootReasoningEffort: 'high',
    subModel: 'gpt-5-mini',
    subReasoningEffort: 'minimal',
  }, new Date('2026-03-31T00:00:00.000Z'));

  assert.deepEqual(settings.availableModels, ['gpt-5', 'gpt-5-mini']);
  assert.equal(settings.baseUrl, 'https://api.openai.com/v1');
  assert.equal(settings.requestTimeoutMs, 60_000);
  assert.equal(settings.rootModel, 'gpt-5');
  assert.equal(settings.rootReasoningEffort, 'high');
  assert.equal(settings.subModel, 'gpt-5-mini');
  assert.equal(settings.subReasoningEffort, 'minimal');
  assert.equal(settings.updatedAt, '2026-03-31T00:00:00.000Z');
});

Deno.test('normalizeProviderRequestTimeoutMs defaults when draft value is omitted', () => {
  assert.equal(normalizeProviderRequestTimeoutMs(undefined), 30_000);
});

Deno.test('normalizeProviderRequestTimeoutMs rejects non-positive values', () => {
  assert.throws(() => normalizeProviderRequestTimeoutMs(0), /요청 제한 시간/u);
  assert.throws(() => normalizeProviderRequestTimeoutMs(-1), /요청 제한 시간/u);
});

Deno.test('coerceStoredProviderRequestTimeoutMs restores the default for older snapshots', () => {
  assert.equal(coerceStoredProviderRequestTimeoutMs(undefined), 30_000);
  assert.equal(coerceStoredProviderRequestTimeoutMs('broken'), 30_000);
  assert.equal(coerceStoredProviderRequestTimeoutMs(45_000), 45_000);
});
