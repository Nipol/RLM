import assert from 'node:assert/strict';

import * as root from '../mod.ts';
import * as codexOAuthProvider from '../codex-oauth.ts';
import * as ollamaProvider from '../ollama.ts';
import * as openAIProvider from '../openai.ts';

Deno.test('root mod entrypoint re-exports the library surface used by JSR consumers', () => {
  assert.equal(typeof root.createRLM, 'function');
  assert.equal(typeof root.runRLM, 'function');
  assert.equal(typeof root.ReplSession.open, 'function');
  assert.equal(typeof root.InMemoryRLMLogger, 'function');
  assert.equal(typeof root.NullRLMLogger, 'function');
  assert.equal(typeof root.JsonlFileLogger, 'function');
  assert.equal(typeof root.WorkerExecutionBackend, 'function');
  assert.equal('createOpenAIRLM' in root, false);
  assert.equal('runOpenAIRLM' in root, false);
  assert.equal('OpenAIResponsesProvider' in root, false);
});

Deno.test('provider subpath entrypoints expose provider-specific helpers without going through the root mod', () => {
  assert.equal(typeof openAIProvider.createOpenAIRLM, 'function');
  assert.equal(typeof openAIProvider.runOpenAIRLM, 'function');
  assert.equal(typeof openAIProvider.OpenAIResponsesProvider, 'function');
  assert.equal(typeof ollamaProvider.createOllamaRLM, 'function');
  assert.equal(typeof ollamaProvider.runOllamaRLM, 'function');
  assert.equal(typeof ollamaProvider.OllamaGenerateProvider, 'function');
  assert.equal(typeof codexOAuthProvider.CodexOAuthProvider, 'function');
});

Deno.test('deno.json contains the metadata needed for JSR publishing', async () => {
  const configText = await Deno.readTextFile(new URL('../deno.json', import.meta.url));
  const config = JSON.parse(configText) as {
    exports?: {
      '.': string;
      './core': string;
      './providers/codex-oauth': string;
      './providers/ollama': string;
      './providers/openai': string;
    };
    license?: string;
    name?: string;
    publish?: {
      include?: string[];
    };
    tasks?: {
      'build:core'?: string;
      'smoke:browser'?: string;
      'smoke:build'?: string;
      'smoke:node'?: string;
      standalone?: string;
    };
    version?: string;
  };

  assert.equal(config.name, '@yoonsung/rlm');
  assert.match(config.version ?? '', /^\d+\.\d+\.\d+$/u);
  assert.equal(config.license, 'LGPL-3.0-only');
  assert.deepEqual(config.exports, {
    '.': './mod.ts',
    './core': './core.ts',
    './providers/codex-oauth': './codex-oauth.ts',
    './providers/ollama': './ollama.ts',
    './providers/openai': './openai.ts',
  });
  assert.deepEqual(config.publish?.include, [
    'LICENSE',
    'README.md',
    'codex-oauth.ts',
    'core.ts',
    'mod.ts',
    'ollama.ts',
    'openai.ts',
    'prompts/rlm_system.ts',
    'src/**/*.ts',
    '.env.example',
  ]);
  assert.equal(
    config.tasks?.['build:core'],
    'deno run --allow-read --allow-write --allow-run scripts/build_core_bundle.ts',
  );
  assert.equal(
    config.tasks?.standalone,
    'deno run --allow-read --allow-write --allow-net=api.openai.com,auth.openai.com,chatgpt.com src/standalone/main.ts',
  );
  assert.equal(
    config.tasks?.['smoke:build'],
    'deno task build:core && docker compose -f smoke/compose.yml build node-smoke browser-smoke',
  );
  assert.equal(
    config.tasks?.['smoke:node'],
    'deno task build:core && docker compose -f smoke/compose.yml run --rm node-smoke',
  );
  assert.equal(
    config.tasks?.['smoke:browser'],
    'deno task build:core && docker compose -f smoke/compose.yml run --rm browser-smoke',
  );
});
