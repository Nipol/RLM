import assert from 'node:assert/strict';

import {
  __browserRunTestables,
  buildConversationRunInput,
  emitBrowserRunDebugLog,
  loadProviderCatalog,
  runConversationTurn,
} from './rlm_browser.ts';
import { createProviderSettings } from './lib/provider_config.ts';

const settings = createProviderSettings({
  apiKey: 'sk-test',
  availableModels: ['gpt-5', 'gpt-5-mini'],
  baseUrl: 'https://api.openai.com/v1',
  kind: 'openai',
  rootModel: 'gpt-5',
  rootReasoningEffort: 'high',
  subModel: 'gpt-5-mini',
  subReasoningEffort: 'minimal',
}, new Date('2026-03-31T00:00:00.000Z'));

Deno.test('buildConversationRunInput forwards all previous turns into context and keeps the current prompt separate', () => {
  const runInput = buildConversationRunInput(settings, [
    {
      content: '첫 질문',
      createdAt: '2026-03-31T12:00:00.000Z',
      id: 'u1',
      role: 'user',
    },
    {
      content: '첫 답변',
      createdAt: '2026-03-31T12:00:02.000Z',
      id: 'a1',
      role: 'assistant',
    },
    {
      content: '두 번째 질문',
      createdAt: '2026-03-31T12:01:00.000Z',
      id: 'u2',
      role: 'user',
    },
  ], '세 번째 질문');

  assert.equal(runInput.prompt, '세 번째 질문');
  assert.deepEqual(runInput.context, {
    app: 'examples/web',
    conversation: [
      {
        content: '첫 질문',
        createdAt: '2026-03-31T12:00:00.000Z',
        error: null,
        id: 'u1',
        role: 'user',
        steps: null,
        usage: null,
      },
      {
        content: '첫 답변',
        createdAt: '2026-03-31T12:00:02.000Z',
        error: null,
        id: 'a1',
        role: 'assistant',
        steps: null,
        usage: null,
      },
      {
        content: '두 번째 질문',
        createdAt: '2026-03-31T12:01:00.000Z',
        error: null,
        id: 'u2',
        role: 'user',
        steps: null,
        usage: null,
      },
    ],
    document: '1. 사용자: 첫 질문\n2. RLM: 첫 답변\n3. 사용자: 두 번째 질문',
    conversationTranscript: '1. 사용자: 첫 질문\n2. RLM: 첫 답변\n3. 사용자: 두 번째 질문',
    provider: {
      kind: 'openai',
      label: 'OpenAI',
      requestTimeoutMs: 30000,
      rootModel: 'gpt-5',
      rootReasoningEffort: 'high',
      subModel: 'gpt-5-mini',
      subReasoningEffort: 'minimal',
    },
    storedTurnCount: 3,
  });
});

Deno.test('emitBrowserRunDebugLog prints the run input and stores it on the global scope', () => {
  const runInput = buildConversationRunInput(settings, [
    {
      content: '이전 질문',
      createdAt: '2026-03-31T12:00:00.000Z',
      id: 'u1',
      role: 'user',
    },
  ], '새 질문');

  const calls: unknown[][] = [];
  const scope: { __RLM_LAST_RUN_INPUT__?: typeof runInput } = {};

  emitBrowserRunDebugLog(runInput, {
    groupCollapsed: (...args) => calls.push(['groupCollapsed', ...args]),
    groupEnd: () => calls.push(['groupEnd']),
    log: (...args) => calls.push(['log', ...args]),
  }, scope);

  assert.deepEqual(calls, [
    ['groupCollapsed', '[RLM] Browser Run Input'],
    ['log', 'prompt', '새 질문'],
    ['log', 'context', {
      app: 'examples/web',
      conversation: [
        {
          content: '이전 질문',
          createdAt: '2026-03-31T12:00:00.000Z',
          error: null,
          id: 'u1',
          role: 'user',
          steps: null,
          usage: null,
        },
      ],
      document: '1. 사용자: 이전 질문',
      conversationTranscript: '1. 사용자: 이전 질문',
      provider: {
        kind: 'openai',
        label: 'OpenAI',
        requestTimeoutMs: 30000,
        rootModel: 'gpt-5',
        rootReasoningEffort: 'high',
        subModel: 'gpt-5-mini',
        subReasoningEffort: 'minimal',
      },
      storedTurnCount: 1,
    }],
    ['groupEnd'],
  ]);
  assert.deepEqual(scope.__RLM_LAST_RUN_INPUT__, runInput);
});

Deno.test('emitBrowserRunDebugLog falls back to a single log call when grouping is unavailable', () => {
  const runInput = buildConversationRunInput(settings, [], 'fallback prompt');
  const calls: unknown[][] = [];

  emitBrowserRunDebugLog(runInput, {
    log: (...args) => calls.push(args),
  });

  assert.deepEqual(calls, [[
    '[RLM] Browser Run Input',
    {
      context: runInput.context,
      prompt: runInput.prompt,
    },
  ]]);
});

Deno.test('loadProviderCatalog delegates through the browser wrapper', async () => {
  const globalRecord = globalThis as typeof globalThis & { fetch?: typeof fetch };
  const originalFetch = globalRecord.fetch;

  Object.defineProperty(globalRecord, 'fetch', {
    configurable: true,
    value: async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'gpt-5.4-mini' }],
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      ),
    writable: true,
  });

  try {
    const catalog = await loadProviderCatalog({
      apiKey: 'sk-openai',
      availableModels: [],
      baseUrl: 'https://api.openai.com',
      kind: 'openai',
      rootModel: '',
      subModel: '',
    });
    assert.deepEqual(catalog, {
      availableModels: ['gpt-5.4-mini'],
      baseUrl: 'https://api.openai.com/v1',
    });
  } finally {
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalRecord, 'fetch');
    } else {
      Object.defineProperty(globalRecord, 'fetch', {
        configurable: true,
        value: originalFetch,
        writable: true,
      });
    }
  }
});

Deno.test('browser run helpers cover usage snapshots and both provider branches', async () => {
  assert.deepEqual(
    __browserRunTestables.toUsageSnapshot({
      byModel: [{
        cachedInputTokens: 0,
        inputTokens: 8,
        model: 'gpt-5',
        outputTokens: 5,
        reportedRequests: 1,
        requests: 1,
        totalTokens: 13,
      }],
      cachedInputTokens: 0,
      inputTokens: 8,
      outputTokens: 5,
      reportedRequests: 1,
      requests: 1,
      totalTokens: 13,
    }),
    {
      byModel: [{
        inputTokens: 8,
        model: 'gpt-5',
        outputTokens: 5,
        totalTokens: 13,
      }],
      inputTokens: 8,
      outputTokens: 5,
      totalTokens: 13,
    },
  );

  const openAICalls: unknown[] = [];
  let openAISessionClosed = false;
  const openAIResult = await __browserRunTestables.runConversationTurnWithDependencies(
    settings,
    [],
    'openai prompt',
    {
      createOpenAIClient: (options) => {
        openAICalls.push(options);
        return {
          run: async (input) => {
            openAICalls.push(input);
            return {
              answer: 'openai answer',
              finalValue: 'openai answer',
              session: {
                close: async () => {
                  openAISessionClosed = true;
                },
              },
              steps: 3,
              usage: {
                byModel: [{
                  cachedInputTokens: 0,
                  inputTokens: 8,
                  model: 'gpt-5',
                  outputTokens: 5,
                  reportedRequests: 1,
                  requests: 1,
                  totalTokens: 13,
                }],
                cachedInputTokens: 0,
                inputTokens: 8,
                outputTokens: 5,
                reportedRequests: 1,
                requests: 1,
                totalTokens: 13,
              },
            };
          },
        };
      },
      emitDebugLog: () => {},
    },
  );

  assert.equal(openAICalls.length, 2);
  assert.equal(openAIResult.answer, 'openai answer');
  assert.equal(openAIResult.steps, 3);
  assert.equal(openAISessionClosed, true);

  const localSettings = createProviderSettings({
    apiKey: '',
    availableModels: ['llama3.2:3b'],
    baseUrl: 'localhost:11434',
    kind: 'ollama-local',
    rootModel: 'llama3.2:3b',
    subModel: 'llama3.2:3b',
  }, new Date('2026-03-31T00:00:00.000Z'));

  const ollamaCalls: unknown[] = [];
  let ollamaSessionClosed = false;
  const ollamaResult = await __browserRunTestables.runConversationTurnWithDependencies(
    localSettings,
    [],
    'ollama prompt',
    {
      createOllamaClient: (options) => {
        ollamaCalls.push(options);
        return {
          run: async (input) => {
            ollamaCalls.push(input);
            return {
              answer: 'ollama answer',
              finalValue: 'ollama answer',
              session: {
                close: async () => {
                  ollamaSessionClosed = true;
                },
              },
              steps: 2,
              usage: {
                byModel: [],
                cachedInputTokens: 0,
                inputTokens: 1,
                outputTokens: 1,
                reportedRequests: 1,
                requests: 1,
                totalTokens: 2,
              },
            };
          },
        };
      },
      emitDebugLog: () => {},
    },
  );

  assert.equal(ollamaCalls.length, 2);
  assert.equal(ollamaResult.answer, 'ollama answer');
  assert.equal(ollamaResult.steps, 2);
  assert.equal(ollamaSessionClosed, true);
});

Deno.test('runConversationTurn can execute through the public browser wrapper with a mocked OpenAI fetch transport', async () => {
  const globalRecord = globalThis as typeof globalThis & { fetch?: typeof fetch };
  const originalFetch = globalRecord.fetch;

  Object.defineProperty(globalRecord, 'fetch', {
    configurable: true,
    value: async () =>
      new Response(
        JSON.stringify({
          id: 'resp_browser_1',
          output_text: '```repl\nFINAL("browser wrapped answer")\n```',
          usage: {
            input_tokens: 11,
            output_tokens: 7,
            total_tokens: 18,
          },
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      ),
    writable: true,
  });

  try {
    const result = await runConversationTurn(settings, [], 'wrapped prompt');
    assert.deepEqual(result, {
      answer: 'browser wrapped answer',
      steps: 1,
      usage: {
        byModel: [{
          inputTokens: 11,
          model: 'gpt-5',
          outputTokens: 7,
          totalTokens: 18,
        }],
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
      },
    });
  } finally {
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalRecord, 'fetch');
    } else {
      Object.defineProperty(globalRecord, 'fetch', {
        configurable: true,
        value: originalFetch,
        writable: true,
      });
    }
  }
});
