import { CodexOAuthProvider } from '../src/providers/codex_oauth.ts';
import { openAIIntegrationScenarios } from './openai_integration.ts';
import {
  loadCodexLiveHarness,
  probeCodexLiveProvider,
  runOpenAILiveScenario,
} from './openai_live_scenario_support.ts';

const liveProvider = new CodexOAuthProvider();
const liveAvailability = await probeCodexLiveProvider({
  provider: liveProvider,
});
let cachedIntegrationHarnessPromise:
  | ReturnType<typeof loadCodexLiveHarness>
  | null = null;

function loadIntegrationHarness() {
  cachedIntegrationHarnessPromise ??= loadCodexLiveHarness({
    maxStepsCap: 12,
    maxSubcallDepthCap: 1,
    minimumRequestTimeoutMs: 90_000,
    outputCharLimitCap: 1_000,
    provider: liveProvider,
  });
  return cachedIntegrationHarnessPromise;
}

for (const scenario of openAIIntegrationScenarios) {
  Deno.test({
    name: scenario.name,
    ignore: !liveAvailability.enabled,
    fn: async () => {
      const harness = await loadIntegrationHarness();
      await runOpenAILiveScenario(scenario, harness);
    },
  });
}
