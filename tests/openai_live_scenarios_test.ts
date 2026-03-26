import assert from 'node:assert/strict';

import {
  buildOpenAILiveScenarioCatalog,
  createOpenAILiveSeed,
} from './openai_live_scenarios.ts';

Deno.test('createOpenAILiveSeed produces a stable non-zero run seed from the injected source', () => {
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
  assert.ok(catalog.scenarios.every((scenario) =>
    scenario.suite === 'integration' || scenario.suite === 'synthetic'
  ));

  const seededScenarioNames = catalog.scenarios
    .map((scenario) => scenario.name)
    .filter((name) => name.includes('seed'));

  assert.ok(seededScenarioNames.length >= 8);
  assert.ok(seededScenarioNames.every((name) => name.includes('4242')));
  assert.ok(catalog.scenarios.every((scenario) => !scenario.name.includes('seed 17')));
  assert.ok(catalog.scenarios.every((scenario) => !scenario.name.includes('seed 53')));

  const publicNiah = catalog.scenarios.find((scenario) => scenario.journalPathName.includes('public-niah-3200'));
  assert.ok(publicNiah);
  assert.match(publicNiah.name, /run seed 4242/u);
  assert.match(publicNiah.journalPathName, /seed-4242/u);

  const directAnchor = catalog.scenarios.find((scenario) => scenario.journalPathName === 'direct-anchor');
  assert.ok(directAnchor);
  assert.equal(directAnchor.expectedAnswer, '618204');

  const syntheticFiltering = catalog.scenarios.find((scenario) =>
    scenario.journalPathName === 'synthetic-filtering-4242'
  );
  assert.ok(syntheticFiltering);
  assert.match(syntheticFiltering.name, /seed 4242/u);
});
