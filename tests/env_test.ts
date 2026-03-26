import assert from 'node:assert/strict';

import {
  loadDotEnvFile,
  loadOpenAIProviderConfig,
  loadRLMConfig,
  parseDotEnv,
} from '../src/env.ts';

function createMissingEnvFileOptions() {
  return {
    path: '.env.test-missing',
    readTextFileSync() {
      throw new Deno.errors.NotFound('missing');
    },
  };
}

Deno.test('dotenv parser ignores comments and unwraps quoted values for local configuration', () => {
  const parsed = parseDotEnv(`
# comment
OPENAI_API_KEY="sk-test"
RLM_OPENAI_ROOT_MODEL='gpt-5-nano'
RLM_OPENAI_SUB_MODEL=gpt-5-mini
RLM_OPENAI_BASE_URL=https://api.example.test/v1 # trailing comment
EMPTY_VALUE=
`);

  assert.deepEqual(parsed, {
    EMPTY_VALUE: '',
    OPENAI_API_KEY: 'sk-test',
    RLM_OPENAI_BASE_URL: 'https://api.example.test/v1',
    RLM_OPENAI_ROOT_MODEL: 'gpt-5-nano',
    RLM_OPENAI_SUB_MODEL: 'gpt-5-mini',
  });
});

Deno.test('dotenv parser accepts a BOM and quoted trailing comments without polluting the value', () => {
  const parsed = parseDotEnv('\uFEFFOPENAI_API_KEY="sk-test" # local secret\n');

  assert.equal(parsed.OPENAI_API_KEY, 'sk-test');
});

Deno.test('dotenv parser decodes common escape sequences in double-quoted values', () => {
  const parsed = parseDotEnv('OPENAI_API_KEY="line\\nnext\\tvalue\\rend"');

  assert.equal(parsed.OPENAI_API_KEY, 'line\nnext\tvalue\rend');
});

Deno.test('dotenv parser preserves generic escaped characters that are not control shorthands', () => {
  const parsed = parseDotEnv('OPENAI_API_KEY="quote:\\" slash:\\\\"');

  assert.equal(parsed.OPENAI_API_KEY, 'quote:" slash:\\');
});

Deno.test('dotenv parser rejects malformed assignments before configuration can drift', () => {
  assert.throws(
    () => parseDotEnv('NOT AN ASSIGNMENT'),
    /Invalid \.env line 1/u,
  );
});

Deno.test('dotenv parser rejects trailing content after quoted values', () => {
  assert.throws(
    () => parseDotEnv('OPENAI_API_KEY="sk-test" trailing'),
    /unexpected trailing content/u,
  );
});

Deno.test('dotenv parser rejects unfinished escapes and missing quotes before startup', () => {
  assert.throws(
    () => parseDotEnv('OPENAI_API_KEY="sk-test\\'),
    /unfinished escape sequence/u,
  );
  assert.throws(
    () => parseDotEnv('OPENAI_API_KEY="sk-test'),
    /missing closing quote/u,
  );
});

Deno.test('dotenv file loader treats a missing file as an empty local override', () => {
  const parsed = loadDotEnvFile({
    path: '.env',
    readTextFileSync() {
      throw new Deno.errors.NotFound('missing');
    },
  });

  assert.deepEqual(parsed, {});
});

Deno.test('dotenv file loader rethrows unexpected filesystem failures', () => {
  assert.throws(
    () =>
      loadDotEnvFile({
        path: '.env',
        readTextFileSync() {
          throw new Error('boom');
        },
      }),
    /boom/u,
  );
});

Deno.test('OpenAI config loader reads required values from a local env file', () => {
  const config = loadOpenAIProviderConfig({
    path: '.env',
    readTextFileSync() {
      return `
OPENAI_API_KEY=sk-test
RLM_OPENAI_BASE_URL=https://api.example.test/v1
RLM_OPENAI_ROOT_MODEL=gpt-5-nano
RLM_OPENAI_SUB_MODEL=gpt-5-nano
`;
    },
  });

  assert.equal(config.apiKey, 'sk-test');
  assert.equal(config.rootModel, 'gpt-5-nano');
  assert.equal(config.subModel, 'gpt-5-nano');
  assert.equal(config.baseUrl, 'https://api.example.test/v1');
  assert.equal(config.requestTimeoutMs, 30_000);
});

Deno.test('OpenAI config loader lets explicit overrides win over .env defaults', () => {
  const config = loadOpenAIProviderConfig({
    env: {
      RLM_OPENAI_ROOT_MODEL: 'gpt-5-mini',
      RLM_OPENAI_SUB_MODEL: 'gpt-5.2',
    },
    path: '.env',
    readTextFileSync() {
      return `
OPENAI_API_KEY=sk-test
RLM_OPENAI_ROOT_MODEL=gpt-5-nano
RLM_OPENAI_SUB_MODEL=gpt-5-nano
`;
    },
  });

  assert.equal(config.rootModel, 'gpt-5-mini');
  assert.equal(config.subModel, 'gpt-5.2');
});

Deno.test('OpenAI config loader refuses to boot without an API key', () => {
  assert.throws(
    () =>
      loadOpenAIProviderConfig({
        env: {
          RLM_OPENAI_ROOT_MODEL: 'gpt-5-nano',
          RLM_OPENAI_SUB_MODEL: 'gpt-5-nano',
        },
        ...createMissingEnvFileOptions(),
      }),
    /OPENAI_API_KEY/u,
  );
});

Deno.test('OpenAI config loader refuses to boot without a root model', () => {
  assert.throws(
    () =>
      loadOpenAIProviderConfig({
        env: {
          OPENAI_API_KEY: 'sk-test',
          RLM_OPENAI_SUB_MODEL: 'gpt-5-nano',
        },
        ...createMissingEnvFileOptions(),
      }),
    /RLM_OPENAI_ROOT_MODEL/u,
  );
});

Deno.test('OpenAI config loader refuses to boot without a sub model', () => {
  assert.throws(
    () =>
      loadOpenAIProviderConfig({
        env: {
          OPENAI_API_KEY: 'sk-test',
          RLM_OPENAI_ROOT_MODEL: 'gpt-5-nano',
        },
        ...createMissingEnvFileOptions(),
      }),
    /RLM_OPENAI_SUB_MODEL/u,
  );
});

Deno.test('runtime config normalizes optional numeric limits for later RLM orchestration', () => {
  const config = loadRLMConfig({
    env: {
      OPENAI_API_KEY: 'sk-test',
      RLM_MAX_OUTPUT_CHARS: '2048',
      RLM_MAX_STEPS: '12',
      RLM_MAX_SUBCALL_DEPTH: '4',
      RLM_OPENAI_ROOT_MODEL: 'gpt-5-nano',
      RLM_OPENAI_SUB_MODEL: 'gpt-5-mini',
      RLM_REQUEST_TIMEOUT_MS: '45000',
    },
    ...createMissingEnvFileOptions(),
  });

  assert.equal(config.openAI.requestTimeoutMs, 45_000);
  assert.equal(config.runtime.maxSteps, 12);
  assert.equal(config.runtime.maxSubcallDepth, 4);
  assert.equal(config.runtime.outputCharLimit, 2_048);
});

Deno.test('runtime config rejects non-positive numeric limits before a run starts', () => {
  assert.throws(
    () =>
      loadRLMConfig({
        env: {
          OPENAI_API_KEY: 'sk-test',
          RLM_MAX_STEPS: '0',
          RLM_OPENAI_ROOT_MODEL: 'gpt-5-nano',
          RLM_OPENAI_SUB_MODEL: 'gpt-5-mini',
        },
        ...createMissingEnvFileOptions(),
      }),
    /RLM_MAX_STEPS/u,
  );
});
