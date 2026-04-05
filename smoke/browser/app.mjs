import { createRLM } from '/dist/core/index.mjs';
import { createAoTPlugin } from '/dist/plugin/aot/index.mjs';
import { createPingPongPlugin } from '/dist/plugin/pingpong/index.mjs';
import { createOllamaRLM } from '/dist/providers/ollama/index.mjs';
import { createOpenAIRLM } from '/dist/providers/openai/index.mjs';
import { runOllamaProviderSmokeScenario } from '/shared/ollama_provider_scenario.mjs';
import { runOpenAIProviderSmokeScenario } from '/shared/openai_provider_scenario.mjs';
import { runPluginSmokeScenario } from '/shared/plugin_scenario.mjs';
import { runRuntimeHelpersSmokeScenario } from '/shared/runtime_helpers_scenario.mjs';
import { runSmokeScenario } from '/shared/runtime_scenario.mjs';

const statusElement = document.getElementById('status');
const resultElement = document.getElementById('result');

async function main() {
  try {
    const result = await runSmokeScenario(createRLM);
    const runtimeHelpers = await runRuntimeHelpersSmokeScenario(createRLM);
    const pluginResult = await runPluginSmokeScenario(
      createRLM,
      createPingPongPlugin,
      createAoTPlugin,
    );
    const ollamaProvider = await runOllamaProviderSmokeScenario(createOllamaRLM);
    const openAIProvider = await runOpenAIProviderSmokeScenario(createOpenAIRLM);
    if (result.answer !== 'PONG:PONG') {
      throw new Error(`Browser smoke failed: expected PONG:PONG, got ${result.answer}`);
    }
    if (pluginResult.answer !== 'PONG') {
      throw new Error(`Browser plugin smoke failed: expected PONG, got ${pluginResult.answer}`);
    }
    if (pluginResult.aotHelperName !== 'aot') {
      throw new Error(
        `Browser AoT plugin import smoke failed: expected aot helper, got ${pluginResult.aotHelperName}`,
      );
    }
    if (ollamaProvider.answer !== 'PONG:PONG') {
      throw new Error(
        `Browser Ollama provider smoke failed: expected PONG:PONG, got ${ollamaProvider.answer}`,
      );
    }
    if (openAIProvider.answer !== 'PONG:PONG') {
      throw new Error(
        `Browser OpenAI provider smoke failed: expected PONG:PONG, got ${openAIProvider.answer}`,
      );
    }
    if (JSON.stringify(runtimeHelpers.finalValue) !== JSON.stringify({
      delegated: 'PONG',
      delegatedBatch: ['LEFT', 'RIGHT'],
      grepPreview: [{ contextText: 'alpha\nbeta\ngamma', line: 'beta', lineNumber: 2 }],
      plain: 'PONG',
      plainBatch: ['ALPHA', 'BETA'],
    })) {
      throw new Error(
        `Browser runtime-helper smoke failed: unexpected helper result ${JSON.stringify(runtimeHelpers.finalValue)}`,
      );
    }
    if (JSON.stringify(runtimeHelpers.kindCounts) !== JSON.stringify({
      child_turn: 3,
      plain_query: 3,
      root_turn: 1,
    })) {
      throw new Error(
        `Browser runtime-helper smoke failed: unexpected kind counts ${JSON.stringify(runtimeHelpers.kindCounts)}`,
      );
    }

    if (statusElement !== null) {
      statusElement.textContent = 'PASS';
    }

    if (resultElement !== null) {
      resultElement.textContent = JSON.stringify({
        core: result,
        runtimeHelpers,
        plugin: pluginResult,
        ollamaProvider,
        openAIProvider,
      });
    }
  } catch (error) {
    if (statusElement !== null) {
      statusElement.textContent = 'FAIL';
    }

    if (resultElement !== null) {
      resultElement.textContent = error instanceof Error
        ? error.stack ?? error.message
        : String(error);
    }

    throw error;
  }
}

void main();
