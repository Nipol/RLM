import { CodexOAuthProvider } from '../src/providers/codex_oauth.ts';
import { syntheticScenarios } from './openai_live_scenarios.ts';
import {
  loadCodexLiveHarness,
  probeCodexLiveProvider,
  runOpenAILiveScenario,
} from './openai_live_scenario_support.ts';

export { syntheticScenarios as openAISyntheticScenarios } from './openai_live_scenarios.ts';

const syntheticProvider = new CodexOAuthProvider();
const syntheticAvailability = await probeCodexLiveProvider({
  provider: syntheticProvider,
});
let cachedSyntheticHarnessPromise:
  | ReturnType<typeof loadCodexLiveHarness>
  | null = null;

function loadSyntheticHarness() {
  cachedSyntheticHarnessPromise ??= loadCodexLiveHarness({
    maxStepsCap: 12,
    maxSubcallDepthCap: 1,
    minimumRequestTimeoutMs: 90_000,
    outputCharLimitCap: 1_000,
    provider: syntheticProvider,
  });
  return cachedSyntheticHarnessPromise;
}

for (const scenario of syntheticScenarios) {
  Deno.test({
    name: scenario.name,
    ignore: !syntheticAvailability.enabled,
    fn: async () => {
      const harness = await loadSyntheticHarness();
      await runOpenAILiveScenario(scenario, harness);
    },
  });
}
