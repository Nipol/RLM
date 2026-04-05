import { createRLM } from '../../dist/core/index.mjs';
import { createAoTPlugin } from '../../dist/plugin/aot/index.mjs';
import { createPingPongPlugin } from '../../dist/plugin/pingpong/index.mjs';
import { createOllamaRLM } from '../../dist/providers/ollama/index.mjs';
import { createOpenAIRLM } from '../../dist/providers/openai/index.mjs';
import { runOllamaProviderSmokeScenario } from '../shared/ollama_provider_scenario.mjs';
import { runOpenAIProviderSmokeScenario } from '../shared/openai_provider_scenario.mjs';
import { runPluginSmokeScenario } from '../shared/plugin_scenario.mjs';
import { runRuntimeHelpersSmokeScenario } from '../shared/runtime_helpers_scenario.mjs';
import { runSmokeScenario } from '../shared/runtime_scenario.mjs';

const module = {
  pluginResult: await runPluginSmokeScenario(createRLM, createPingPongPlugin, createAoTPlugin),
  ollamaProvider: await runOllamaProviderSmokeScenario(createOllamaRLM),
  openAIProvider: await runOpenAIProviderSmokeScenario(createOpenAIRLM),
  runtimeHelpers: await runRuntimeHelpersSmokeScenario(createRLM),
  result: await runSmokeScenario(createRLM),
};
if (module.pluginResult.answer !== 'PONG') {
  throw new Error(`Bun plugin smoke failed: expected PONG, got ${module.pluginResult.answer}`);
}
if (module.pluginResult.aotHelperName !== 'aot') {
  throw new Error(
    `Bun AoT plugin import smoke failed: expected aot helper, got ${module.pluginResult.aotHelperName}`,
  );
}
if (module.ollamaProvider.answer !== 'PONG:PONG') {
  throw new Error(
    `Bun Ollama provider smoke failed: expected PONG:PONG, got ${module.ollamaProvider.answer}`,
  );
}
if (module.openAIProvider.answer !== 'PONG:PONG') {
  throw new Error(
    `Bun OpenAI provider smoke failed: expected PONG:PONG, got ${module.openAIProvider.answer}`,
  );
}
if (module.result.answer !== 'PONG:PONG') {
  throw new Error(`Bun core smoke failed: expected PONG:PONG, got ${module.result.answer}`);
}
if (JSON.stringify(module.runtimeHelpers.finalValue) !== JSON.stringify({
  delegated: 'PONG',
  delegatedBatch: ['LEFT', 'RIGHT'],
  grepPreview: [{ contextText: 'alpha\nbeta\ngamma', line: 'beta', lineNumber: 2 }],
  plain: 'PONG',
  plainBatch: ['ALPHA', 'BETA'],
})) {
  throw new Error(
    `Bun runtime-helper smoke failed: unexpected helper result ${JSON.stringify(module.runtimeHelpers.finalValue)}`,
  );
}
if (JSON.stringify(module.runtimeHelpers.kindCounts) !== JSON.stringify({
  child_turn: 3,
  plain_query: 3,
  root_turn: 1,
})) {
  throw new Error(
    `Bun runtime-helper smoke failed: unexpected kind counts ${JSON.stringify(module.runtimeHelpers.kindCounts)}`,
  );
}
console.log(JSON.stringify({
  ok: true,
  pluginResult: module.pluginResult,
  ollamaProvider: module.ollamaProvider,
  result: module.result,
  runtimeHelpers: module.runtimeHelpers,
  openAIProvider: module.openAIProvider,
}));
