import assert from 'node:assert/strict';
import { join } from 'node:path';

import type { LLMCaller } from '../src/llm_adapter.ts';
import { buildOpenAILiveScenarioCatalog, createOpenAILiveSeed } from './openai_live_scenarios.ts';
import {
  buildCodexLiveRunOptions,
  createOpenAILiveJournalPath,
  loadCodexLiveHarness,
  probeCodexLiveProvider,
  readSubqueryJournals,
  resolveCodexLiveModels,
  runOpenAILiveScenario,
} from './openai_live_scenario_support.ts';

Deno.test('createOpenAILiveSeed produces a stable non-zero run seed from the injected source', () => {
  assert.ok(createOpenAILiveSeed() >= 1);
  assert.equal(createOpenAILiveSeed(() => undefined as never), 1);
  assert.equal(createOpenAILiveSeed(() => 0), 1);
  assert.equal(createOpenAILiveSeed(() => 53), 53);
  assert.equal(createOpenAILiveSeed(() => 4_294_967_295), 4_294_967_295);
});

Deno.test('buildOpenAILiveScenarioCatalog uses one run seed across the unified live scenario catalog', () => {
  const catalog = buildOpenAILiveScenarioCatalog(4242);

  assert.equal(catalog.runSeed, 4242);
  assert.equal(catalog.integrationScenarios.length, 11);
  assert.equal(catalog.syntheticScenarios.length, 8);
  assert.equal(catalog.scenarios.length, 19);
  assert.ok(
    catalog.scenarios.every((scenario) =>
      scenario.suite === 'integration' || scenario.suite === 'synthetic'
    ),
  );

  const seededScenarioNames = catalog.scenarios
    .map((scenario) => scenario.name)
    .filter((name) => name.includes('seed'));

  assert.ok(seededScenarioNames.length >= 8);
  assert.ok(seededScenarioNames.every((name) => name.includes('4242')));
  assert.ok(catalog.scenarios.every((scenario) => !scenario.name.includes('seed 17')));
  assert.ok(catalog.scenarios.every((scenario) => !scenario.name.includes('seed 53')));

  const publicNiah = catalog.scenarios.find((scenario) =>
    scenario.journalPathName.includes('public-niah-3200')
  );
  assert.ok(publicNiah);
  assert.match(publicNiah.name, /run seed 4242/u);
  assert.match(publicNiah.journalPathName, /seed-4242/u);

  const directAnchor = catalog.scenarios.find((scenario) =>
    scenario.journalPathName === 'direct-anchor'
  );
  assert.ok(directAnchor);
  assert.equal(directAnchor.expectedAnswer, '618204');

  const syntheticFiltering = catalog.scenarios.find((scenario) =>
    scenario.journalPathName === 'synthetic-filtering-4242'
  );
  assert.ok(syntheticFiltering);
  assert.match(syntheticFiltering.name, /seed 4242/u);

  const zeroDerivedSeedCatalog = buildOpenAILiveScenarioCatalog(
    Math.imul(512, 2654435761) >>> 0,
  );
  assert.ok(
    zeroDerivedSeedCatalog.scenarios.some((scenario) => scenario.name.includes('seed 1')),
  );
});

Deno.test('OpenAI live scenarios normalize code answers and validate subquery journal assertions', async () => {
  const catalog = buildOpenAILiveScenarioCatalog(4242);
  const subqueryScenario = catalog.scenarios.find((scenario) =>
    scenario.normalizeAnswer !== undefined && scenario.assertJournal === undefined
  );
  assert.ok(subqueryScenario?.normalizeAnswer);
  assert.equal(subqueryScenario.normalizeAnswer('  123456  '), '123456');
  assert.equal(subqueryScenario.normalizeAnswer('{"code":"654321"}'), '654321');
  assert.equal(subqueryScenario.normalizeAnswer('not-json'), 'not-json');

  const structuredObjectScenario = catalog.scenarios.find((scenario) =>
    scenario.prompt.includes('JSON object with one string field named `vaultKey`')
  );
  assert.ok(structuredObjectScenario?.assertJournal);
  const objectJournalDir = await Deno.makeTempDir({ prefix: 'rlm-openai-live-object-journal-' });
  await Deno.writeTextFile(
    join(objectJournalDir, 'session.subquery.1.jsonl'),
    '{"vaultKey":"alpha","kind":"object"}',
  );
  await structuredObjectScenario.assertJournal({
    journal: '',
    journalDir: objectJournalDir,
    journalPath: join(objectJournalDir, 'session.jsonl'),
    result: {} as never,
  });

  const structuredArrayScenario = catalog.scenarios.find((scenario) =>
    scenario.prompt.includes('structured array payload')
  );
  assert.ok(structuredArrayScenario?.assertJournal);
  const arrayJournalDir = await Deno.makeTempDir({ prefix: 'rlm-openai-live-array-journal-' });
  await Deno.mkdir(join(arrayJournalDir, 'ignored.subquery.dir'));
  await Deno.writeTextFile(join(arrayJournalDir, 'notes.jsonl'), 'ignored');
  await Deno.writeTextFile(join(arrayJournalDir, 'session.subquery.skip.txt'), 'ignored');
  await Deno.writeTextFile(
    join(arrayJournalDir, 'session.subquery.1.jsonl'),
    '{"payload":[{"vaultKey":"alpha"}]}',
  );
  assert.deepEqual(
    (await readSubqueryJournals(arrayJournalDir)).map((path) => path.slice(arrayJournalDir.length + 1)),
    ['session.subquery.1.jsonl'],
  );
  await structuredArrayScenario.assertJournal({
    journal: '',
    journalDir: arrayJournalDir,
    journalPath: join(arrayJournalDir, 'session.jsonl'),
    result: {} as never,
  });

  const retryScenario = catalog.scenarios.find((scenario) =>
    scenario.prompt.includes('field-specific expect')
  );
  assert.ok(retryScenario?.assertJournal);
  assert.throws(
    () =>
      retryScenario.assertJournal?.({
        journal: '',
        journalDir: arrayJournalDir,
        journalPath: join(arrayJournalDir, 'session.jsonl'),
        result: {} as never,
      }),
  );
  await retryScenario.assertJournal({
    journal: '{"type":"subquery"}\n{"type":"subquery"}',
    journalDir: arrayJournalDir,
    journalPath: join(arrayJournalDir, 'session.jsonl'),
    result: {} as never,
  });
});

Deno.test('resolveCodexLiveModels prefers stable catalog ids and rejects unavailable overrides', () => {
  const availableModels = [
    'gpt-5-mini',
    'gpt-5.3-instant',
    'gpt-5.4-mini',
  ];

  assert.deepEqual(resolveCodexLiveModels(availableModels), {
    rootModel: 'gpt-5-mini',
    subModel: 'gpt-5.3-instant',
  });
  assert.deepEqual(
    resolveCodexLiveModels(availableModels, {
      rootModel: 'gpt-5.4-mini',
      subModel: 'gpt-5-mini',
    }),
    {
      rootModel: 'gpt-5.4-mini',
      subModel: 'gpt-5-mini',
    },
  );
  assert.deepEqual(resolveCodexLiveModels(['custom-root']), {
    rootModel: 'custom-root',
    subModel: 'custom-root',
  });
  assert.deepEqual(resolveCodexLiveModels(['gpt-5-2-instant']), {
    rootModel: 'gpt-5-2-instant',
    subModel: 'gpt-5-2-instant',
  });
  assert.throws(
    () => resolveCodexLiveModels([]),
    /at least one available model/u,
  );
  assert.throws(
    () => resolveCodexLiveModels(availableModels, { rootModel: 'gpt-5-4-thinking' }),
    /Requested Codex live-test model is unavailable/u,
  );
});

Deno.test('buildCodexLiveRunOptions combines provider timeouts with runtime caps for Codex live runs', () => {
  const options = buildCodexLiveRunOptions({
    availableModels: ['gpt-5-mini', 'gpt-5.3-instant'],
    maxStepsCap: 12,
    maxSubcallDepthCap: 1,
    minimumRequestTimeoutMs: 90_000,
    outputCharLimitCap: 1_000,
    requestTimeoutMs: 30_000,
    runtime: {
      cellTimeoutMs: 5_000,
      maxSteps: 20,
      maxSubcallDepth: 3,
      outputCharLimit: 4_000,
    },
  });

  assert.deepEqual(options, {
    cellTimeoutMs: 95_000,
    maxSteps: 12,
    maxSubcallDepth: 1,
    outputCharLimit: 1_000,
    requestTimeoutMs: 90_000,
    rootModel: 'gpt-5-mini',
    subModel: 'gpt-5.3-instant',
  });

  const uncapped = buildCodexLiveRunOptions({
    availableModels: ['custom-root'],
    minimumRequestTimeoutMs: 1,
    requestTimeoutMs: 2,
    runtime: {
      cellTimeoutMs: 3,
      maxSteps: 4,
      maxSubcallDepth: 5,
      outputCharLimit: 6,
    },
  });
  assert.deepEqual(uncapped, {
    cellTimeoutMs: 5,
    maxSteps: 4,
    maxSubcallDepth: 5,
    outputCharLimit: 6,
    requestTimeoutMs: 2,
    rootModel: 'custom-root',
    subModel: 'custom-root',
  });

  const defaults = buildCodexLiveRunOptions({
    availableModels: ['custom-root'],
  });
  assert.ok(defaults.requestTimeoutMs >= 90_000);
  assert.equal(defaults.rootModel, 'custom-root');
  assert.equal(defaults.subModel, 'custom-root');
});

Deno.test('probeCodexLiveProvider requires granted chatgpt.com net permission and stored OAuth auth', async () => {
  const calls: string[] = [];
  const provider = {
    async listModels() {
      calls.push('listModels');
      return ['gpt-5-mini'];
    },
    async loadAuth() {
      calls.push('loadAuth');
      return { provider: 'codex-oauth' };
    },
    createCaller() {
      throw new Error('not used');
    },
  };

  const denied = await probeCodexLiveProvider({
    provider,
    queryNetPermission: async () => ({ state: 'prompt' }),
  });
  assert.deepEqual(denied, {
    enabled: false,
    reason: 'chatgpt.com net permission is not granted.',
  });

  const missingAuth = await probeCodexLiveProvider({
    provider: {
      ...provider,
      async loadAuth() {
        return null;
      },
    },
    queryNetPermission: async () => ({ state: 'granted' }),
  });
  assert.deepEqual(missingAuth, {
    enabled: false,
    reason: 'Codex OAuth auth is missing.',
  });

  const enabled = await probeCodexLiveProvider({
    provider,
    queryNetPermission: async () => ({ state: 'granted' }),
  });
  assert.deepEqual(enabled, {
    enabled: true,
    reason: null,
  });
  assert.deepEqual(calls, ['loadAuth']);
});

Deno.test('loadCodexLiveHarness keeps provider ownership in the caller file and derives run options from its model catalog', async () => {
  const calls: string[] = [];
  const fakeCaller: LLMCaller = {
    async complete() {
      throw new Error('not used');
    },
  };
  const provider = {
    async listModels() {
      calls.push('listModels');
      return ['gpt-5-mini', 'gpt-5.3-instant'];
    },
    async loadAuth() {
      calls.push('loadAuth');
      return { provider: 'codex-oauth' };
    },
    createCaller() {
      calls.push('createCaller');
      return fakeCaller;
    },
  };

  const harness = await loadCodexLiveHarness({
    maxStepsCap: 12,
    maxSubcallDepthCap: 1,
    minimumRequestTimeoutMs: 90_000,
    outputCharLimitCap: 1_000,
    provider,
    requestTimeoutMs: 30_000,
    runtime: {
      cellTimeoutMs: 5_000,
      maxSteps: 20,
      maxSubcallDepth: 3,
      outputCharLimit: 4_000,
    },
  });

  assert.equal(harness.provider, provider);
  assert.deepEqual(harness.runOptions, {
    cellTimeoutMs: 95_000,
    maxSteps: 12,
    maxSubcallDepth: 1,
    outputCharLimit: 1_000,
    requestTimeoutMs: 90_000,
    rootModel: 'gpt-5-mini',
    subModel: 'gpt-5.3-instant',
  });
  assert.deepEqual(calls, ['listModels']);
});

Deno.test('runOpenAILiveScenario can execute a local harness and validate the generated journal', async () => {
  const journalPath = await createOpenAILiveJournalPath('synthetic', 'unit-journal-path');
  assert.match(journalPath, /unit-journal-path\/session\.jsonl$/u);

  let assertJournalCalled = false;
  const harness = {
    provider: {
      createCaller() {
        return {
          async complete() {
            return {
              outputText: '```repl\nFINAL_VAR("42");\n```',
              usage: {
                inputTokens: 10,
                outputTokens: 2,
                totalTokens: 12,
              },
            };
          },
        };
      },
      async listModels() {
        return ['gpt-5-mini'];
      },
      async loadAuth() {
        return { provider: 'codex-oauth' };
      },
    },
    runOptions: {
      cellTimeoutMs: 5_000,
      maxSteps: 1,
      maxSubcallDepth: 1,
      outputCharLimit: 512,
      requestTimeoutMs: 5_000,
      rootModel: 'gpt-5-mini',
      subModel: 'gpt-5-mini',
    },
  };

  await runOpenAILiveScenario(
    {
      context: { document: 'answer 42' },
      expectedAnswer: '42',
      journalPatterns: [/"type":"assistant_turn"/u],
      journalPathName: 'unit-live-scenario',
      name: 'unit live scenario',
      prompt: 'Return 42 through FINAL_VAR.',
      suite: 'synthetic',
      assertJournal({ journal, journalPath }) {
        assertJournalCalled = true;
        assert.match(journal, /"type":"cell"/u);
        assert.match(journalPath, /unit-live-scenario\/session\.jsonl$/u);
      },
    },
    harness,
  );

  assert.equal(assertJournalCalled, true);

  await runOpenAILiveScenario(
    {
      context: { document: 'answer 42' },
      expectedAnswer: '42',
      journalPatterns: [],
      journalPathName: 'unit-live-scenario-empty-patterns',
      name: 'unit live scenario with fallback normalization',
      normalizeAnswer: () => undefined as never,
      prompt: 'Return 42 through FINAL_VAR.',
      suite: 'synthetic',
    },
    harness,
  );

  await runOpenAILiveScenario(
    {
      context: { document: 'answer 42' },
      expectedAnswer: '42',
      journalPathName: 'unit-live-scenario-omitted-patterns',
      name: 'unit live scenario with omitted journal patterns',
      prompt: 'Return 42 through FINAL_VAR.',
      suite: 'synthetic',
    },
    harness,
  );
});
