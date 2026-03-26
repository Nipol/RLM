import assert from 'node:assert/strict';
import { join } from 'node:path';

import { loadRLMConfig } from '../src/env.ts';
import { estimateOpenAIRunCostUsd, resolveOpenAITextModelPricing } from '../src/openai_pricing.ts';
import { runOpenAIRLM } from '../src/rlm_runner.ts';
import type { OpenAIRunCostEstimate } from '../src/openai_pricing.ts';
import type { RLMRunResult } from '../src/rlm_runner.ts';
import type { JsonValue } from '../src/types.ts';

const LONG_DOCUMENT_OUTPUT_CHAR_LIMIT = 1_200;
const NEAR_MAX_CONTEXT_WINDOW_FACTOR = 0.6;

const FILLER_PARAGRAPHS = [
  'River crews logged lantern cargo beside orchard roads while harbor clerks compared weather notes, copied transit numbers, and repeated routine maintenance phrases for the evening checkpoint summary.',
  'Window stewards reviewed archive shelves near stone plazas as meadow teams traded route updates, balanced supply ledgers, and described ordinary packing steps that carried no sensitive meaning.',
  'Harbor inspectors watched market ferries cross shallow water while courtyard aides counted paper bundles, checked rope seals, and recited simple inventory wording for the midday briefing.',
  'Lantern keepers from the north station walked past cedar walls and quiet alleys, recording mundane travel remarks, weather changes, and standard storage reminders for the daily report.',
] as const;

interface LongContextScenario {
  context: JsonValue;
  expectedAnswer: string;
  expectedMinDocumentWords: number;
  journalPathName: string;
  normalizeAnswer?: (answer: string) => string;
  prompt: string;
  summaryLabel: string;
}

interface BenchmarkOutcome {
  actualAnswer: string | null;
  contextChars: number;
  contextWords: number;
  error: string | null;
  journalPath: string | null;
  passed: boolean;
  providerInputTokens: number;
  providerOutputTokens: number;
  providerTotalTokens: number;
  reportedRequests: number;
  requests: number;
  scenario: string;
  steps: number | null;
  totalCostUsd: number | null;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/u).length;
}

const FILLER_WORD_COUNTS = FILLER_PARAGRAPHS.map((paragraph) => countWords(paragraph));

function createDeterministicRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

async function createIntegrationJournalPath(testName: string): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: 'rlm-openai-long-context-' });
  return join(root, testName, 'session.jsonl');
}

function buildIntegrationConfig() {
  const loaded = loadRLMConfig();
  return {
    openAI: {
      ...loaded.openAI,
      requestTimeoutMs: Math.max(loaded.openAI.requestTimeoutMs, 180_000),
    },
    runtime: {
      ...loaded.runtime,
      maxSteps: 12,
      maxSubcallDepth: 1,
      outputCharLimit: Math.min(loaded.runtime.outputCharLimit, LONG_DOCUMENT_OUTPUT_CHAR_LIMIT),
    },
  };
}

function buildLongDocument(
  targetWordCount: number,
  inserts: string[],
  seed: number,
): string {
  const random = createDeterministicRandom(seed);
  const paragraphs: string[] = [];
  let currentWords = 0;

  while (currentWords < targetWordCount) {
    const paragraphIndex = Math.floor(random() * FILLER_PARAGRAPHS.length);
    paragraphs.push(FILLER_PARAGRAPHS[paragraphIndex]);
    currentWords += FILLER_WORD_COUNTS[paragraphIndex];
  }

  for (const insert of inserts) {
    const insertionIndex = Math.floor(random() * (paragraphs.length + 1));
    paragraphs.splice(insertionIndex, 0, insert);
  }

  return paragraphs.join('\n\n');
}

function measureDocumentContext(context: JsonValue): { chars: number; words: number } {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    return { chars: 0, words: 0 };
  }

  const document = 'document' in context && typeof context.document === 'string'
    ? context.document
    : '';

  if (document.length === 0) {
    return { chars: 0, words: 0 };
  }

  return {
    chars: document.length,
    words: countWords(document),
  };
}

function createLongBenchInspiredScenario(): LongContextScenario {
  const targetWordCount = 24_000;
  const division = 'lumen';
  const archiveCode = 'ARC-812';
  const expectedAnswer = 'C';

  const document = buildLongDocument(
    targetWordCount,
    [
      [
        'Section 14. Division routing memo.',
        `Division ${division} escalates its final compliance memo through archive code ${archiveCode}.`,
        'The archive code must be resolved through the appendix before the memo bundle can be named.',
      ].join(' '),
      [
        'Appendix B. Archive bundle index.',
        'Archive ARC-104 maps to memo bundle A.',
        'Archive ARC-377 maps to memo bundle B.',
        `Archive ${archiveCode} maps to memo bundle ${expectedAnswer}.`,
        'Archive ARC-990 maps to memo bundle D.',
      ].join(' '),
    ],
    41,
  );

  return {
    context: {
      document,
      question: 'Which memo bundle contains the final compliance memo for division lumen?',
      options: {
        A: 'bundle A',
        B: 'bundle B',
        C: 'bundle C',
        D: 'bundle D',
      },
    },
    expectedAnswer,
    expectedMinDocumentWords: 24_000,
    journalPathName: 'longbench-inspired',
    prompt: [
      'Inspect `context.document`, `context.question`, and `context.options` in the REPL.',
      'Answer the question using the long document.',
      'Return only the single uppercase option letter through FINAL_VAR.',
      'Use concise REPL code.',
      'Do not include imports.',
      'Do not include prose outside repl code fences.',
    ].join(' '),
    summaryLabel: 'longbench-inspired-single-doc-qa',
  };
}

function createZeroScrollsInspiredScenario(): LongContextScenario {
  const targetWordCount = 48_000;
  const expectedAnswer = '430';
  const inserts = [
    'Program Orion entry: status=approved amount=120 reviewer=west.',
    'Program Orion entry: status=approved amount=140 reviewer=south.',
    'Program Orion entry: status=rejected amount=999 reviewer=east.',
    'Program Orion entry: status=approved amount=170 reviewer=north.',
    'Program Lyra entry: status=approved amount=600 reviewer=west.',
    'Program Vega entry: status=approved amount=510 reviewer=east.',
  ];

  return {
    context: {
      document: buildLongDocument(targetWordCount, inserts, 77),
      targetProgram: 'Orion',
    },
    expectedAnswer,
    expectedMinDocumentWords: 48_000,
    journalPathName: 'zeroscrolls-inspired',
    prompt: [
      'Inspect `context.document` and `context.targetProgram` in the REPL.',
      'Find every entry for the target program whose status is `approved` and sum its amount values.',
      'Return only the decimal digits through FINAL_VAR.',
      'Use concise REPL code.',
      'Do not include imports.',
      'Do not include prose outside repl code fences.',
    ].join(' '),
    summaryLabel: 'zeroscrolls-inspired-aggregation',
  };
}

function createLEvalInspiredScenario(): LongContextScenario {
  const targetWordCount = 36_000;
  const expectedAnswer = 'B';
  const lectureInsert = [
    'Lecture note: the safe handoff sequence is verify seal, read checksum, archive copy.',
    'Question options: A=read checksum, verify seal, archive copy.',
    'Question options: B=verify seal, read checksum, archive copy.',
    'Question options: C=archive copy, verify seal, read checksum.',
    'Question options: D=verify seal, archive copy, read checksum.',
  ];

  return {
    context: {
      document: buildLongDocument(targetWordCount, lectureInsert, 93),
      question: 'Which option gives the correct safe handoff sequence?',
    },
    expectedAnswer,
    expectedMinDocumentWords: 36_000,
    journalPathName: 'leval-inspired',
    prompt: [
      'Inspect `context.document` and `context.question` in the REPL.',
      'Answer the multiple-choice question from the lecture note.',
      'Return only the single uppercase option letter through FINAL_VAR.',
      'Use concise REPL code.',
      'Do not include imports.',
      'Do not include prose outside repl code fences.',
    ].join(' '),
    summaryLabel: 'leval-inspired-closed-ended',
  };
}

function createRulerInspiredNearMaxScenario(): LongContextScenario {
  const config = buildIntegrationConfig();
  const pricing = resolveOpenAITextModelPricing(config.openAI.rootModel);
  assert.ok(pricing !== null, `No OpenAI pricing metadata for model ${config.openAI.rootModel}.`);

  const targetWordCount = Math.floor(pricing.contextWindowTokens * NEAR_MAX_CONTEXT_WINDOW_FACTOR);
  const city = 'Chicago';
  const expectedAnswer = '7318452';
  const document = buildLongDocument(
    targetWordCount,
    [
      'The special magic Toronto number is: 8842106.',
      'The special magic Sydney number is: 9154031.',
      'The special magic Mumbai number is: 4021188.',
      `The special magic ${city} number is: ${expectedAnswer}.`,
      'The special magic Barcelona number is: 6402219.',
    ],
    131,
  );

  return {
    context: {
      document,
      retrievalQuestion: `What is the special magic ${city} number?`,
      rootModel: config.openAI.rootModel,
    },
    expectedAnswer,
    expectedMinDocumentWords: targetWordCount,
    journalPathName: 'ruler-inspired-near-max',
    prompt: [
      'Inspect `context.document` and `context.retrievalQuestion` in the REPL.',
      'Answer the retrieval question by finding the city-specific magic number hidden in the long context.',
      'Return only the decimal digits through FINAL_VAR.',
      'Use concise REPL code.',
      'Do not include imports.',
      'Do not include prose outside repl code fences.',
    ].join(' '),
    summaryLabel: 'ruler-inspired-near-max-needle',
  };
}

function emitBenchmarkSummary(outcome: BenchmarkOutcome) {
  console.log(JSON.stringify({
    type: 'benchmark_result',
    ...outcome,
  }));
}

async function runLongContextScenario(
  scenario: LongContextScenario,
): Promise<BenchmarkOutcome> {
  const contextSize = measureDocumentContext(scenario.context);
  const journalPath = await createIntegrationJournalPath(scenario.journalPathName);
  let lastCost: OpenAIRunCostEstimate | undefined;
  let lastOutcome: BenchmarkOutcome | null = null;
  let lastResult: RLMRunResult | undefined;
  let lastNormalizedAnswer: string | null = null;

  try {
    const config = buildIntegrationConfig();
    const result = await runOpenAIRLM({
      config,
      context: scenario.context,
      journalPath,
      prompt: scenario.prompt,
    });
    lastResult = result;
    const cost = estimateOpenAIRunCostUsd(result.usage);
    lastCost = cost;

    const normalizedAnswer = scenario.normalizeAnswer?.(result.answer) ?? result.answer;
    lastNormalizedAnswer = normalizedAnswer;
    assert.equal(normalizedAnswer, scenario.expectedAnswer, scenario.summaryLabel);
    assert.ok(result.steps >= 1);
    assert.ok(result.usage.reportedRequests >= 1);
    assert.ok(
      contextSize.words >= scenario.expectedMinDocumentWords,
      `${scenario.summaryLabel} document words were ${contextSize.words}, expected at least ${scenario.expectedMinDocumentWords}.`,
    );
    assert.deepEqual(cost.missingPricingModels, []);
    assert.ok(cost.totalCostUsd > 0);

    const journal = await Deno.readTextFile(journalPath);
    assert.match(journal, /"type":"assistant_turn"/u);
    assert.match(journal, /"type":"cell"/u);

    const outcome: BenchmarkOutcome = {
      actualAnswer: normalizedAnswer,
      contextChars: contextSize.chars,
      contextWords: contextSize.words,
      error: null,
      journalPath,
      passed: true,
      providerInputTokens: result.usage.inputTokens,
      providerOutputTokens: result.usage.outputTokens,
      providerTotalTokens: result.usage.totalTokens,
      reportedRequests: result.usage.reportedRequests,
      requests: result.usage.requests,
      scenario: scenario.summaryLabel,
      steps: result.steps,
      totalCostUsd: cost.totalCostUsd,
    };
    lastOutcome = outcome;
    emitBenchmarkSummary(outcome);

    return lastOutcome!;
  } catch (error) {
    const providerUsage = lastResult === undefined ? undefined : lastResult.usage;
    const lastTotalCostUsd = lastCost === undefined ? null : lastCost.totalCostUsd;
    const outcome: BenchmarkOutcome = {
      actualAnswer: lastNormalizedAnswer,
      contextChars: contextSize.chars,
      contextWords: contextSize.words,
      error: error instanceof Error ? error.message : String(error),
      journalPath,
      passed: false,
      providerInputTokens: providerUsage?.inputTokens ?? 0,
      providerOutputTokens: providerUsage?.outputTokens ?? 0,
      providerTotalTokens: providerUsage?.totalTokens ?? 0,
      reportedRequests: providerUsage?.reportedRequests ?? 0,
      requests: providerUsage?.requests ?? 0,
      scenario: scenario.summaryLabel,
      steps: lastResult?.steps ?? null,
      totalCostUsd: lastTotalCostUsd,
    };
    emitBenchmarkSummary(outcome);
    return outcome;
  }
}

const LONG_CONTEXT_SCENARIO_FACTORIES = [
  createLongBenchInspiredScenario,
  createZeroScrollsInspiredScenario,
  createLEvalInspiredScenario,
  createRulerInspiredNearMaxScenario,
];

for (const createScenario of LONG_CONTEXT_SCENARIO_FACTORIES) {
  const scenario = createScenario();

  Deno.test(`live long-context benchmark ${scenario.summaryLabel}`, async () => {
    const outcome = await runLongContextScenario(scenario);

    assert.equal(
      outcome.passed,
      true,
      outcome.error ?? `${scenario.summaryLabel} failed without an explicit error.`,
    );
    assert.ok(outcome.contextWords > 0);
    assert.equal(typeof outcome.passed, 'boolean');
  });
}
