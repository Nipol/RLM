import { openAILiveScenarios } from './openai_live_scenarios.ts';
import { runOpenAILiveScenario } from './openai_live_scenario_support.ts';

for (const scenario of openAILiveScenarios) {
  Deno.test(scenario.name, async () => {
    await runOpenAILiveScenario(scenario);
  });
}
