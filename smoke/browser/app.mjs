import { createRLM } from '/dist/core/index.mjs';
import { runSmokeScenario } from '/shared/runtime_scenario.mjs';

const statusElement = document.getElementById('status');
const resultElement = document.getElementById('result');

async function main() {
  try {
    const result = await runSmokeScenario(createRLM);
    if (result.answer !== 'PONG:PONG') {
      throw new Error(`Browser smoke failed: expected PONG:PONG, got ${result.answer}`);
    }

    if (statusElement !== null) {
      statusElement.textContent = 'PASS';
    }

    if (resultElement !== null) {
      resultElement.textContent = JSON.stringify(result);
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
