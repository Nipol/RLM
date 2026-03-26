import assert from 'node:assert/strict';

import {
  createOpenAIRLM,
  createRLM,
  InMemoryRLMLogger,
  JsonlFileLogger,
  NullRLMLogger,
  ReplSession,
  runOpenAIRLM,
  runRLM,
  WorkerExecutionBackend,
} from '../mod.ts';

Deno.test('root mod entrypoint re-exports the library surface used by JSR consumers', () => {
  assert.equal(typeof createRLM, 'function');
  assert.equal(typeof createOpenAIRLM, 'function');
  assert.equal(typeof runRLM, 'function');
  assert.equal(typeof runOpenAIRLM, 'function');
  assert.equal(typeof ReplSession.open, 'function');
  assert.equal(typeof InMemoryRLMLogger, 'function');
  assert.equal(typeof NullRLMLogger, 'function');
  assert.equal(typeof JsonlFileLogger, 'function');
  assert.equal(typeof WorkerExecutionBackend, 'function');
});

Deno.test('deno.json contains the metadata needed for JSR publishing', async () => {
  const configText = await Deno.readTextFile(new URL('../deno.json', import.meta.url));
  const config = JSON.parse(configText) as {
    exports?: string;
    license?: string;
    name?: string;
    publish?: {
      include?: string[];
    };
    version?: string;
  };

  assert.equal(config.name, '@yoonsung/rlm');
  assert.match(config.version ?? '', /^\d+\.\d+\.\d+$/u);
  assert.equal(config.license, 'LGPL-3.0-only');
  assert.equal(config.exports, './mod.ts');
  assert.deepEqual(config.publish?.include, [
    'LICENSE',
    'README.md',
    'mod.ts',
    'src/**/*.ts',
    '.env.example',
  ]);
});
