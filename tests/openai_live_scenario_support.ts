import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';

import type { LLMCaller } from '../src/llm_adapter.ts';
import { loadProviderRequestTimeoutMs, loadRLMRuntimeConfig } from '../examples/standalone/env.ts';
import { runRLM } from '../src/rlm_runner.ts';
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
    result: Awaited<ReturnType<typeof runRLM>>;
  }) => Promise<void> | void;
}

export interface CodexLiveModels {
  rootModel: string;
  subModel: string;
}

export interface CodexLiveRunOptions {
  cellTimeoutMs: number;
  maxSteps: number;
  maxSubcallDepth: number;
  outputCharLimit: number;
  requestTimeoutMs: number;
  rootModel: string;
  subModel: string;
}

export interface CodexLiveProviderLike {
  createCaller(config: { requestTimeoutMs?: number }): LLMCaller;
  listModels(): Promise<string[]>;
  loadAuth(): Promise<unknown | null>;
}

export interface CodexLiveHarness {
  provider: CodexLiveProviderLike;
  runOptions: CodexLiveRunOptions;
}

interface PermissionStatusLike {
  state: Deno.PermissionState;
}

export interface ProbeCodexLiveProviderOptions {
  provider: CodexLiveProviderLike;
  queryNetPermission?: (
    descriptor: Deno.PermissionDescriptor,
  ) => Promise<PermissionStatusLike>;
}

export interface CodexLiveProviderAvailability {
  enabled: boolean;
  reason: string | null;
}

export async function createOpenAILiveJournalPath(
  suite: OpenAILiveScenarioSuite,
  testName: string,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: `rlm-openai-${suite}-` });
  return join(root, testName, 'session.jsonl');
}

function pickPreferredModel(
  availableModels: string[],
  preferred: string[],
): string | undefined {
  for (const candidate of preferred) {
    if (availableModels.includes(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function resolveCodexLiveModels(
  availableModels: string[],
  overrides: {
    rootModel?: string;
    subModel?: string;
  } = {},
): CodexLiveModels {
  const ensureExactModel = (requestedModel: string | undefined): string | undefined => {
    if (requestedModel === undefined) {
      return undefined;
    }

    if (availableModels.includes(requestedModel)) {
      return requestedModel;
    }

    throw new Error(
      [
        `Requested Codex live-test model is unavailable: ${requestedModel}.`,
        'Configure an exact model id from the current Codex catalog.',
        `Available models: ${[...availableModels].sort().join(', ')}`,
      ].join(' '),
    );
  };

  const rootModel = ensureExactModel(overrides.rootModel) ??
    pickPreferredModel(
      availableModels,
      [
        'gpt-5-mini',
        'gpt-5.4-mini',
        'gpt-5-4-t-mini',
        'gpt-5',
        'gpt-5.4',
        'gpt-5-3',
      ],
    ) ??
    availableModels[0];

  if (rootModel === undefined) {
    throw new Error('Codex live tests require at least one available model.');
  }

  const subModel = ensureExactModel(overrides.subModel) ??
    pickPreferredModel(
      availableModels,
      [
        'gpt-5.3-instant',
        'gpt-5-3-instant',
        'gpt-5-t-mini',
        'gpt-5-mini',
        rootModel,
        'gpt-5.2-instant',
        'gpt-5-2-instant',
      ],
    ) ??
    rootModel;

  return {
    rootModel,
    subModel,
  };
}

export function buildCodexLiveRunOptions(
  options: {
    availableModels: string[];
    maxStepsCap?: number;
    maxSubcallDepthCap?: number;
    minimumRequestTimeoutMs?: number;
    modelOverrides?: {
      rootModel?: string;
      subModel?: string;
    };
    outputCharLimitCap?: number;
    requestTimeoutMs?: number;
    runtime?: ReturnType<typeof loadRLMRuntimeConfig>;
  },
): CodexLiveRunOptions {
  const runtime = options.runtime ?? loadRLMRuntimeConfig();
  const requestTimeoutMs = Math.max(
    options.requestTimeoutMs ?? loadProviderRequestTimeoutMs(),
    options.minimumRequestTimeoutMs ?? 90_000,
  );
  const models = resolveCodexLiveModels(options.availableModels, options.modelOverrides);

  return {
    cellTimeoutMs: requestTimeoutMs + runtime.cellTimeoutMs,
    maxSteps: Math.min(runtime.maxSteps, options.maxStepsCap ?? runtime.maxSteps),
    maxSubcallDepth: Math.min(
      runtime.maxSubcallDepth,
      options.maxSubcallDepthCap ?? runtime.maxSubcallDepth,
    ),
    outputCharLimit: Math.min(
      runtime.outputCharLimit,
      options.outputCharLimitCap ?? runtime.outputCharLimit,
    ),
    requestTimeoutMs,
    rootModel: models.rootModel,
    subModel: models.subModel,
  };
}

export async function probeCodexLiveProvider(
  options: ProbeCodexLiveProviderOptions,
): Promise<CodexLiveProviderAvailability> {
  const queryNetPermission = options.queryNetPermission ??
    ((descriptor) => Deno.permissions.query(descriptor));
  const netPermission = await queryNetPermission({
    name: 'net',
    host: 'chatgpt.com',
  });

  if (netPermission.state !== 'granted') {
    return {
      enabled: false,
      reason: 'chatgpt.com net permission is not granted.',
    };
  }

  const auth = await options.provider.loadAuth();
  if (auth === null) {
    return {
      enabled: false,
      reason: 'Codex OAuth auth is missing.',
    };
  }

  return {
    enabled: true,
    reason: null,
  };
}

export async function loadCodexLiveHarness(
  options: {
    maxStepsCap?: number;
    maxSubcallDepthCap?: number;
    minimumRequestTimeoutMs?: number;
    modelOverrides?: {
      rootModel?: string;
      subModel?: string;
    };
    outputCharLimitCap?: number;
    provider: CodexLiveProviderLike;
    requestTimeoutMs?: number;
    runtime?: ReturnType<typeof loadRLMRuntimeConfig>;
  },
): Promise<CodexLiveHarness> {
  const availableModels = await options.provider.listModels();
  return {
    provider: options.provider,
    runOptions: buildCodexLiveRunOptions({
      availableModels,
      maxStepsCap: options.maxStepsCap,
      maxSubcallDepthCap: options.maxSubcallDepthCap,
      minimumRequestTimeoutMs: options.minimumRequestTimeoutMs,
      modelOverrides: options.modelOverrides,
      outputCharLimitCap: options.outputCharLimitCap,
      requestTimeoutMs: options.requestTimeoutMs,
      runtime: options.runtime,
    }),
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
  harness: CodexLiveHarness,
): Promise<void> {
  const journalPath = await createOpenAILiveJournalPath(
    scenario.suite,
    scenario.journalPathName,
  );
  const result = await runRLM({
    cellTimeoutMs: harness.runOptions.cellTimeoutMs,
    context: scenario.context,
    journalPath,
    llm: harness.provider.createCaller({
      requestTimeoutMs: harness.runOptions.requestTimeoutMs,
    }),
    maxSteps: harness.runOptions.maxSteps,
    maxSubcallDepth: harness.runOptions.maxSubcallDepth,
    outputCharLimit: harness.runOptions.outputCharLimit,
    prompt: scenario.prompt,
    rootModel: harness.runOptions.rootModel,
    subModel: harness.runOptions.subModel,
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
