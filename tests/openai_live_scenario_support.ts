import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';

import { loadRLMConfig } from '../src/env.ts';
import { runOpenAIRLM } from '../src/rlm_runner.ts';
import type { JsonValue } from '../src/types.ts';

export type OpenAILiveScenarioSuite = 'integration' | 'synthetic';

export interface OpenAILiveScenario {
  context: JsonValue;
  expectedAnswer: string;
  journalPathName: string;
  name: string;
  prompt: string;
  suite: OpenAILiveScenarioSuite;
  journalPatterns?: RegExp[];
  normalizeAnswer?: (answer: string) => string;
  assertJournal?: (options: {
    journal: string;
    journalDir: string;
    journalPath: string;
    result: Awaited<ReturnType<typeof runOpenAIRLM>>;
  }) => Promise<void> | void;
}

export async function createOpenAILiveJournalPath(
  suite: OpenAILiveScenarioSuite,
  testName: string,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: `rlm-openai-${suite}-` });
  return join(root, testName, 'session.jsonl');
}

export function buildOpenAILiveConfig() {
  const loaded = loadRLMConfig();
  return {
    openAI: {
      ...loaded.openAI,
      requestTimeoutMs: Math.max(loaded.openAI.requestTimeoutMs, 90_000),
    },
    runtime: {
      ...loaded.runtime,
      maxSteps: Math.min(loaded.runtime.maxSteps, 12),
      maxSubcallDepth: Math.min(loaded.runtime.maxSubcallDepth, 1),
      outputCharLimit: Math.min(loaded.runtime.outputCharLimit, 1_000),
    },
  };
}

export function createDeterministicRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function createRandomWord(length: number, random: () => number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let word = '';

  for (let index = 0; index < length; index += 1) {
    word += alphabet[Math.floor(random() * alphabet.length)];
  }

  return word;
}

export function createRandomCode(random: () => number): string {
  return String(100_000 + Math.floor(random() * 900_000));
}

export function createNoiseSummary(random: () => number, words = 5): string {
  const parts: string[] = [];

  for (let index = 0; index < words; index += 1) {
    parts.push(createRandomWord(4 + Math.floor(random() * 5), random));
  }

  return parts.join(' ');
}

export async function readSubqueryJournals(journalDir: string): Promise<string[]> {
  const childPaths: string[] = [];

  for await (const entry of Deno.readDir(journalDir)) {
    if (!entry.isFile) {
      continue;
    }

    if (!entry.name.includes('.subquery.')) {
      continue;
    }

    if (!entry.name.endsWith('.jsonl')) {
      continue;
    }

    childPaths.push(join(journalDir, entry.name));
  }

  childPaths.sort();
  return childPaths;
}

export async function runOpenAILiveScenario(
  scenario: OpenAILiveScenario,
): Promise<void> {
  const config = buildOpenAILiveConfig();
  const journalPath = await createOpenAILiveJournalPath(
    scenario.suite,
    scenario.journalPathName,
  );
  const result = await runOpenAIRLM({
    config,
    context: scenario.context,
    journalPath,
    prompt: scenario.prompt,
  });

  const normalizedAnswer = scenario.normalizeAnswer?.(result.answer) ?? result.answer;
  assert.equal(normalizedAnswer, scenario.expectedAnswer, scenario.name);
  assert.ok(result.steps >= 1);

  const journal = await Deno.readTextFile(journalPath);
  assert.match(journal, /"type":"assistant_turn"/u);
  assert.match(journal, /"type":"cell"/u);

  for (const pattern of scenario.journalPatterns ?? []) {
    assert.match(journal, pattern);
  }

  await scenario.assertJournal?.({
    journal,
    journalDir: dirname(journalPath),
    journalPath,
    result,
  });
}
