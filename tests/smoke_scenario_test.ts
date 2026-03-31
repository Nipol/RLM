import assert from 'node:assert/strict';

import { createRLM } from '../mod.ts';
import { runSmokeScenario } from '../smoke/shared/scenario.ts';

Deno.test('shared smoke scenario completes through the public library interface', async () => {
  const result = await runSmokeScenario(createRLM);

  assert.equal(result.answer, 'PONG:PONG');
  assert.equal(result.finalValue, 'PONG:PONG');
  assert.equal(result.steps, 1);
  assert.deepEqual(result.kinds, ['root_turn', 'child_turn', 'plain_query']);
});
