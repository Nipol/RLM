import { createRLM } from '../../dist/core/index.mjs';
import { runSmokeScenario } from '../shared/runtime_scenario.mjs';

const module = {
  result: await runSmokeScenario(createRLM),
};
console.log(JSON.stringify({
  ok: true,
  result: module.result,
}));
