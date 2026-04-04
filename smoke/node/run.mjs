import { createRLM } from '../../dist/core/index.mjs';
import { createAoTPlugin } from '../../dist/plugin/aot/index.mjs';
import { createPingPongPlugin } from '../../dist/plugin/pingpong/index.mjs';
import { createOllamaRLM } from '../../dist/providers/ollama/index.mjs';
import { createOpenAIRLM } from '../../dist/providers/openai/index.mjs';
import { runOllamaProviderSmokeScenario } from '../shared/ollama_provider_scenario.mjs';
import { runOpenAIProviderSmokeScenario } from '../shared/openai_provider_scenario.mjs';
import { runPluginSmokeScenario } from '../shared/plugin_scenario.mjs';
import { runSmokeScenario } from '../shared/runtime_scenario.mjs';

const module = {
  pluginResult: await runPluginSmokeScenario(createRLM, createPingPongPlugin, createAoTPlugin),
  ollamaProvider: await runOllamaProviderSmokeScenario(createOllamaRLM),
  openAIProvider: await runOpenAIProviderSmokeScenario(createOpenAIRLM),
  result: await runSmokeScenario(createRLM),
};
if (module.pluginResult.answer !== 'PONG') {
  throw new Error(`Node plugin smoke failed: expected PONG, got ${module.pluginResult.answer}`);
}
if (module.pluginResult.aotHelperName !== 'aot') {
  throw new Error(
    `Node AoT plugin import smoke failed: expected aot helper, got ${module.pluginResult.aotHelperName}`,
  );
}
if (module.ollamaProvider.answer !== 'PONG:PONG') {
  throw new Error(
    `Node Ollama provider smoke failed: expected PONG:PONG, got ${module.ollamaProvider.answer}`,
  );
}
if (module.openAIProvider.answer !== 'PONG:PONG') {
  throw new Error(
    `Node OpenAI provider smoke failed: expected PONG:PONG, got ${module.openAIProvider.answer}`,
  );
}
if (module.result.answer !== 'PONG:PONG') {
  throw new Error(`Node core smoke failed: expected PONG:PONG, got ${module.result.answer}`);
}
console.log(JSON.stringify({
  ok: true,
  pluginResult: module.pluginResult,
  ollamaProvider: module.ollamaProvider,
  result: module.result,
  openAIProvider: module.openAIProvider,
}));
