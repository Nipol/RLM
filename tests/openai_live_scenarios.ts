import assert from 'node:assert/strict';

import type { OpenAILiveScenario } from './openai_live_scenario_support.ts';
import {
  createDeterministicRandom,
  createNoiseSummary,
  createRandomCode,
  createRandomWord,
  readSubqueryJournals,
} from './openai_live_scenario_support.ts';
import type { JsonValue } from '../src/types.ts';

const SECRET_CONTEXT_LENGTHS = [512, 1_200, 3_200] as const;
const PUBLIC_NIAH_CONTEXT_LENGTHS = [1_200, 3_200] as const;

export interface OpenAILiveScenarioCatalog {
  integrationScenarios: OpenAILiveScenario[];
  runSeed: number;
  scenarios: OpenAILiveScenario[];
  syntheticScenarios: OpenAILiveScenario[];
}

export function createOpenAILiveSeed(
  nextUInt32: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0,
): number {
  const raw = nextUInt32() >>> 0;
  return raw === 0 ? 1 : raw;
}

function deriveScenarioSeed(runSeed: number, salt: number): number {
  const mixed = (runSeed ^ Math.imul(salt, 2654435761)) >>> 0;
  return mixed === 0 ? 1 : mixed;
}

function normalizeCodeAnswer(answer: string): string {
  const trimmed = answer.trim();
  if (/^\d+$/u.test(trimmed)) {
    return trimmed;
  }

  try {
    const parsed = JSON.parse(trimmed) as { code?: unknown };
    if (typeof parsed?.code === 'string') {
      return parsed.code;
    }
  } catch {
    // Keep the original answer when it is not JSON.
  }

  return trimmed;
}

function createSecretCodeDocument(
  targetLength: number,
  seed = targetLength,
): { document: string; secretCode: string } {
  const random = createDeterministicRandom(seed);
  const secretCode = String(100_000 + Math.floor(random() * 900_000));
  const secretLine = `비밀 코드: ${secretCode}`;
  const words: string[] = [];
  let currentLength = 0;

  while (currentLength + secretLine.length < targetLength) {
    const wordLength = 3 + Math.floor(random() * 8);
    const word = createRandomWord(wordLength, random);
    words.push(word);
    currentLength += word.length + 1;
  }

  const insertionIndex = Math.floor(random() * (words.length + 1));
  words.splice(insertionIndex, 0, secretLine);

  return {
    document: words.join(' '),
    secretCode,
  };
}

function createPublicNeedleInHaystackScenario(
  targetLength: number,
  seed: number,
  runSeed: number,
): OpenAILiveScenario {
  const random = createDeterministicRandom(seed);
  const cities = [
    'Chicago',
    'Toronto',
    'Sydney',
    'Mumbai',
    'Barcelona',
    'Seattle',
  ] as const;
  const targetCity = cities[Math.floor(random() * cities.length)];
  const targetNumber = String(1_000_000 + Math.floor(random() * 9_000_000));
  const retrievalQuestion = `What is the special magic ${targetCity} number?`;
  const distractorCities = cities.filter((city) => city !== targetCity);
  const distractorNeedles = distractorCities.map((city) =>
    `The special magic ${city} number is: ${String(1_000_000 + Math.floor(random() * 9_000_000))}.`
  );
  const targetNeedle = `The special magic ${targetCity} number is: ${targetNumber}.`;
  const fragments: string[] = [];
  let currentLength = 0;

  while (currentLength + targetNeedle.length < targetLength) {
    const wordLength = 3 + Math.floor(random() * 8);
    const word = createRandomWord(wordLength, random);
    fragments.push(word);
    currentLength += word.length + 1;
  }

  for (const distractor of distractorNeedles) {
    const insertionIndex = Math.floor(random() * (fragments.length + 1));
    fragments.splice(insertionIndex, 0, distractor);
  }

  const targetInsertionIndex = Math.floor(random() * (fragments.length + 1));
  fragments.splice(targetInsertionIndex, 0, targetNeedle);

  return {
    suite: 'integration',
    name:
      `OpenAI integration runner can answer a public needle-in-a-haystack city query at length ${targetLength} (run seed ${runSeed})`,
    context: {
      document: fragments.join(' '),
      retrievalQuestion,
      benchmarkFamily: 'needle_in_a_haystack_public_example',
    },
    expectedAnswer: targetNumber,
    journalPathName: `public-niah-${targetLength}-seed-${runSeed}`,
    journalPatterns: [
      new RegExp(targetCity, 'u'),
      /The special magic/u,
    ],
    prompt: [
      'Inspect `context.document` and `context.retrievalQuestion` in the REPL.',
      'Answer the retrieval question by finding the city-specific magic number hidden in the long context.',
      'The document uses sentences in the form `The special magic {city} number is: {number}.`.',
      'Return only the decimal digits of the answer through FINAL_VAR, with no extra text.',
      'Use concise REPL code.',
      'Do not include imports.',
      'Do not include prose outside repl code fences.',
    ].join(' '),
  };
}

function createFilteringScenario(): OpenAILiveScenario {
  return {
    suite: 'integration',
    name: 'OpenAI integration runner can filter competing candidates down to the current code',
    context: {
      targetProject: 'marlin',
      policy: {
        requiredReviewers: 2,
        requireNotRevoked: true,
      },
      auditLog: [
        {
          project: 'marlin',
          code: '190241',
          active: true,
          status: 'active',
          revoked: false,
          reviewerCount: 2,
          issuedAt: '2026-03-14T10:00:00Z',
        },
        {
          project: 'marlin',
          code: '731845',
          active: true,
          status: 'active',
          revoked: false,
          reviewerCount: 1,
          issuedAt: '2026-03-18T08:30:00Z',
        },
        {
          project: 'marlin',
          code: '640281',
          active: true,
          status: 'active',
          revoked: false,
          reviewerCount: 4,
          issuedAt: '2026-03-20T09:45:00Z',
        },
        {
          project: 'marlin',
          code: '404115',
          active: false,
          status: 'inactive',
          revoked: false,
          reviewerCount: 5,
          issuedAt: '2026-03-22T09:45:00Z',
        },
        {
          project: 'marlin',
          code: '552019',
          active: true,
          status: 'active',
          revoked: true,
          reviewerCount: 3,
          issuedAt: '2026-03-23T07:00:00Z',
        },
        {
          project: 'tern',
          code: '991102',
          active: true,
          status: 'active',
          revoked: false,
          reviewerCount: 5,
          issuedAt: '2026-03-24T07:00:00Z',
        },
      ],
    },
    expectedAnswer: '640281',
    journalPathName: 'filtering',
    prompt: [
      'Inspect the REPL state and determine the current release code for the project named in `context.targetProject`.',
      'Review `context.auditLog` and keep only entries for that project whose `status` is `active`, whose `revoked` field is false, and whose `reviewerCount` is at least `context.policy.requiredReviewers`.',
      'If more than one eligible entry remains, choose the one with the most recent `issuedAt` timestamp.',
      'Return only the 6-digit code through FINAL_VAR. Do not return null or explanatory text.',
      'Use concise REPL code.',
      'Do not include imports.',
      'Do not include prose outside repl code fences.',
    ].join(' '),
  };
}

function createDirectAnchorScenario(): OpenAILiveScenario {
  return {
    suite: 'integration',
    name: 'OpenAI integration runner can extract a direct anchored code from a short retrieval query',
    context: {
      document:
        'Prelude text. The route beacon for amber has control code 618204. Closing text.',
      retrievalQuestion: 'What is the control code for amber?',
    },
    expectedAnswer: '618204',
    journalPathName: 'direct-anchor',
    journalPatterns: [/route beacon/u, /amber/u],
    prompt: [
      'Inspect `context.document` and `context.retrievalQuestion` in the REPL.',
      'The document contains one exact sentence in the form `The route beacon for {label} has control code {digits}.`.',
      'Use the label named by `context.retrievalQuestion`, extract only that code, and return only the decimal digits through FINAL_VAR.',
      'Use concise REPL code.',
      'Do not include imports.',
      'Do not include prose outside repl code fences.',
    ].join(' '),
  };
}

function createMultiHopScenario(): OpenAILiveScenario {
  return {
    suite: 'integration',
    name: 'OpenAI integration runner can follow a multi-hop lookup chain across related tables',
    context: {
      requestAlias: 'lumen',
      aliasDirectory: [
        { alias: 'ember', operatorId: 'op-03' },
        { alias: 'solace', operatorId: 'op-11' },
        { alias: 'lumen', operatorId: 'op-27' },
        { alias: 'kepler', operatorId: 'op-31' },
      ],
      operatorAssignments: {
        'op-03': 'locker-2',
        'op-11': 'locker-4',
        'op-27': 'locker-9',
        'op-31': 'locker-1',
      },
      lockers: [
        { id: 'locker-1', lockerId: 'locker-1', shard: 'east', slot: 'slot-2' },
        { id: 'locker-2', lockerId: 'locker-2', shard: 'west', slot: 'slot-1' },
        { id: 'locker-4', lockerId: 'locker-4', shard: 'north', slot: 'slot-5' },
        { id: 'locker-9', lockerId: 'locker-9', shard: 'west', slot: 'slot-3' },
      ],
      shardEntries: {
        east: [
          { slot: 'slot-2', accessCode: '431002' },
        ],
        north: [
          { slot: 'slot-5', accessCode: '774301' },
        ],
        west: [
          { slot: 'slot-1', accessCode: '118209' },
          { slot: 'slot-3', accessCode: '552740' },
        ],
      },
    },
    expectedAnswer: '552740',
    journalPathName: 'multihop',
    prompt: [
      'Inspect the REPL state and resolve the final access code for `context.requestAlias`.',
      'First find the row in `context.aliasDirectory` whose alias matches `context.requestAlias` and read its `operatorId`.',
      'Then use that `operatorId` as a key into the `context.operatorAssignments` mapping to get the `lockerId`.',
      'Use that `lockerId` to find the locker record in `context.lockers`; those locker records expose both `id` and `lockerId`, along with the `shard` and `slot`.',
      'Finally look up the entry in `context.shardEntries[shard]` whose `slot` matches and return its `accessCode`.',
      'Return only the 6-digit code through FINAL_VAR.',
      'Use concise REPL code.',
      'Do not include imports.',
      'Do not include prose outside repl code fences.',
    ].join(' '),
  };
}

function createAggregationScenario(): OpenAILiveScenario {
  return {
    suite: 'integration',
    name: 'OpenAI integration runner can aggregate a control total from the latest eligible batch',
    context: {
      targetDesk: 'delta',
      rule: {
        approvedStatus: 'approved',
      },
      batches: [
        {
          desk: 'delta',
          targetDesk: 'delta',
          batchId: '2026-03-18-A',
          batchClosedAt: '2026-03-18T18:00:00Z',
          rows: [
            { status: 'approved', amount: 120 },
            { status: 'approved', amount: 85 },
          ],
        },
        {
          desk: 'delta',
          targetDesk: 'delta',
          batchId: '2026-03-20-B',
          batchClosedAt: '2026-03-20T18:30:00Z',
          rows: [
            { status: 'approved', amount: 75 },
            { status: 'approved', amount: 30 },
            { status: 'approved', amount: 55 },
            { status: 'rejected', amount: 999 },
          ],
        },
        {
          desk: 'kappa',
          targetDesk: 'kappa',
          batchId: '2026-03-21-X',
          batchClosedAt: '2026-03-21T18:00:00Z',
          rows: [
            { status: 'approved', amount: 444 },
          ],
        },
      ],
    },
    expectedAnswer: '160',
    journalPathName: 'aggregation',
    prompt: [
      'Inspect the REPL state and compute the control total for the desk named in `context.targetDesk`.',
      'The candidate batches are stored in `context.batches`.',
      'Select the latest batch for `context.targetDesk` using `batchClosedAt`.',
      'Inside that chosen batch, keep only rows whose `status` matches `context.rule.approvedStatus`, then sum their `amount` values.',
      'Return only the decimal digits of the total through FINAL_VAR. Do not return null or explanatory text.',
      'Use concise REPL code.',
      'Do not include imports.',
      'Do not include prose outside repl code fences.',
    ].join(' '),
  };
}

function createSubqueryScenario(
  name: string,
  suite: 'integration' | 'synthetic',
  seedLabel: string,
  targetProfile: string,
  distractorProfile: string,
  matchingVaultKey: string,
  matchingCode: string,
  dossiers: Array<Record<string, JsonValue>>,
  vaultRegister: Record<string, { code: string }>,
): OpenAILiveScenario {
  return {
    suite,
    name,
    context: {
      targetProfile,
      dossiers,
      vaultRegister,
    },
    expectedAnswer: matchingCode,
    journalPathName: `${seedLabel}`,
    journalPatterns: [/"type":"subquery"/u],
    normalizeAnswer: normalizeCodeAnswer,
    prompt: [
      'Inspect the REPL state and find the enabled 6-digit access code for `context.targetProfile`.',
      'You must use exactly one `await rlm_query(...)` call before returning the answer.',
      'In the parent REPL, build a narrow delegated prompt that keeps only the dossier records needed for the lookup.',
      'Pass the dossier evidence as structured `payload`, not as a prose string.',
      'The delegated data must include the exact fields `profile`, `active`, `primaryDispatch`, and `vaultKey` for every candidate record that you pass to the child.',
      'Use that single subquery to return only the `vaultKey` for the dossier whose `profile` matches `context.targetProfile`, whose `active` field is true, and whose `primaryDispatch` field is true.',
      'The correct dossier exists, so the subquery should not return `NONE`.',
      'After the subquery returns the vault key, resolve it with `context.vaultRegister[vaultKey]`, read the `code` field, and return only the 6-digit code through FINAL_VAR.',
      'Use concise REPL code.',
      'Do not include imports.',
      'Do not include prose outside repl code fences.',
    ].join(' '),
  };
}

function createReturnShapeBenchmarkScenario(seed: number): OpenAILiveScenario {
  const random = createDeterministicRandom(seed * 23);
  const targetProfile = `shape-profile-${seed}`;
  const matchingVaultKey = `VS-${seed}-B`;
  const matchingCode = createRandomCode(random);
  const distractorProfile = `shape-other-${seed}`;

  return {
    suite: 'synthetic',
    name: `Synthetic return-shape benchmark seed ${seed}`,
    context: {
      targetProfile,
      dossiers: [
        {
          profile: targetProfile,
          active: false,
          primaryDispatch: false,
          vaultKey: `VS-${seed}-A`,
        },
        {
          profile: targetProfile,
          active: true,
          primaryDispatch: true,
          vaultKey: matchingVaultKey,
        },
        {
          profile: distractorProfile,
          active: true,
          primaryDispatch: true,
          vaultKey: `VS-${seed}-C`,
        },
      ],
      vaultRegister: {
        [`VS-${seed}-A`]: { code: createRandomCode(random) },
        [matchingVaultKey]: { code: matchingCode },
        [`VS-${seed}-C`]: { code: createRandomCode(random) },
      },
    },
    expectedAnswer: matchingCode,
    journalPathName: `synthetic-return-shape-${seed}`,
    journalPatterns: [/"type":"subquery"/u],
    prompt: [
      'Inspect the REPL state and return the enabled 6-digit access code for `context.targetProfile`.',
      'You must use exactly one `await rlm_query(...)` call before FINAL_VAR.',
      'Delegate only the dossier-selection step.',
      'Pass the narrowed dossier rows as structured `payload`.',
      'Ask the child to return a JSON object with one string field named `vaultKey`.',
      'After the child returns, read `childResult.vaultKey` in code, resolve `context.vaultRegister[vaultKey]`, then read `.code` and return only that 6-digit code.',
      'Use concise REPL code.',
      'Do not include imports.',
      'Do not include prose outside repl code fences.',
    ].join(' '),
    assertJournal: async ({ journalDir }) => {
      const childPaths = await readSubqueryJournals(journalDir);
      assert.ok(childPaths.length >= 1);
      const childJournal = await Deno.readTextFile(childPaths[0]);
      assert.match(childJournal, /"vaultKey"/u);
      assert.match(childJournal, /"kind":"(?:object|string)"/u);
    },
  };
}

function createAnchorTargetBenchmarkScenario(seed: number): OpenAILiveScenario {
  const random = createDeterministicRandom(seed * 29);
  const labels = ['amber', 'violet', 'cedar', 'onyx', 'sable', 'linen'] as const;
  const targetLabel = labels[seed % labels.length];
  const targetNumber = createRandomCode(random);
  const distractors = labels.filter((label) => label !== targetLabel);
  const fragments: string[] = [];

  for (const label of distractors) {
    fragments.push(
      `The route beacon for ${label} has control code ${createRandomCode(random)}.`,
    );
    fragments.push(createNoiseSummary(random, 8));
  }

  const insertionIndex = Math.floor(random() * (fragments.length + 1));
  fragments.splice(
    insertionIndex,
    0,
    `The route beacon for ${targetLabel} has control code ${targetNumber}.`,
  );

  return {
    suite: 'synthetic',
    name: `Synthetic anchor-target benchmark seed ${seed}`,
    context: {
      document: fragments.join(' '),
      retrievalQuestion: `What is the control code for ${targetLabel}?`,
    },
    expectedAnswer: targetNumber,
    journalPathName: `synthetic-anchor-target-${seed}`,
    prompt: [
      'Inspect `context.document` and `context.retrievalQuestion` in the REPL.',
      'The document uses repeated sentences in the form `The route beacon for {label} has control code {digits}.`.',
      'Build an exact target-specific anchor from the label named in `context.retrievalQuestion` and extract only that target code.',
      'Return only the decimal digits through FINAL_VAR.',
      'Use concise REPL code.',
      'Do not include imports.',
      'Do not include prose outside repl code fences.',
    ].join(' '),
  };
}

function createStructuredPayloadBenchmarkScenario(seed: number): OpenAILiveScenario {
  const random = createDeterministicRandom(seed * 31);
  const targetProfile = `structured-profile-${seed}`;
  const matchingVaultKey = `VP-${seed}-B`;
  const matchingCode = createRandomCode(random);
  const rows = [
    {
      profile: targetProfile,
      active: false,
      primaryDispatch: false,
      vaultKey: `VP-${seed}-A`,
      summary: createNoiseSummary(random),
    },
    {
      profile: targetProfile,
      active: true,
      primaryDispatch: true,
      vaultKey: matchingVaultKey,
      summary: createNoiseSummary(random),
    },
    {
      profile: `structured-other-${seed}`,
      active: true,
      primaryDispatch: true,
      vaultKey: `VP-${seed}-C`,
      summary: createNoiseSummary(random),
    },
  ];

  return {
    suite: 'synthetic',
    name: `Synthetic structured-payload benchmark seed ${seed}`,
    context: {
      targetProfile,
      dossiers: rows,
      vaultRegister: {
        [`VP-${seed}-A`]: { code: createRandomCode(random) },
        [matchingVaultKey]: { code: matchingCode },
        [`VP-${seed}-C`]: { code: createRandomCode(random) },
      },
    },
    expectedAnswer: matchingCode,
    journalPathName: `synthetic-structured-payload-${seed}`,
    journalPatterns: [/"type":"subquery"/u],
    prompt: [
      'Inspect the REPL state and return the enabled 6-digit access code for `context.targetProfile`.',
      'You must use exactly one `await rlm_query(...)` call before FINAL_VAR.',
      'Pass the narrowed dossier evidence as a structured array payload, not as a prose string.',
      'The child should inspect that structured payload to find the matching `vaultKey`.',
      'After the child returns the `vaultKey`, read `context.vaultRegister[vaultKey].code` and return only the 6-digit code.',
      'Use concise REPL code.',
      'Do not include imports.',
      'Do not include prose outside repl code fences.',
    ].join(' '),
    assertJournal: async ({ journalDir }) => {
      const childPaths = await readSubqueryJournals(journalDir);
      assert.ok(childPaths.length >= 1);
      const childJournal = await Deno.readTextFile(childPaths[0]);
      assert.match(childJournal, /"payload":\[/u);
      assert.doesNotMatch(childJournal, /"payload":"Dossier/u);
    },
  };
}

function createDelegationContractBenchmarkScenario(seed: number): OpenAILiveScenario {
  const random = createDeterministicRandom(seed * 37);
  const targetProfile = `contract-profile-${seed}`;
  const matchingVaultKey = `VC-${seed}-B`;
  const matchingCode = createRandomCode(random);
  const dossiers = [
    {
      profile: targetProfile,
      active: false,
      primaryDispatch: false,
      vaultKey: `VC-${seed}-A`,
    },
    {
      profile: targetProfile,
      active: true,
      primaryDispatch: true,
      vaultKey: matchingVaultKey,
    },
    {
      profile: `contract-other-${seed}`,
      active: true,
      primaryDispatch: true,
      vaultKey: `VC-${seed}-C`,
    },
  ];

  return {
    suite: 'synthetic',
    name: `Synthetic delegation-contract benchmark seed ${seed}`,
    context: {
      targetProfile,
      dossiers,
      vaultRegister: {
        [`VC-${seed}-A`]: { code: createRandomCode(random) },
        [matchingVaultKey]: { code: matchingCode },
        [`VC-${seed}-C`]: { code: createRandomCode(random) },
      },
    },
    expectedAnswer: matchingCode,
    journalPathName: `synthetic-delegation-contract-${seed}`,
    journalPatterns: [/"type":"subquery"/u],
    prompt: [
      'Inspect the REPL state and return the enabled 6-digit access code for `context.targetProfile`.',
      'You must use exactly one `await rlm_query(...)` call before FINAL_VAR, even if the root REPL could solve the data locally.',
      'Delegate the dossier selection step to the child and use the child result as the basis for the final lookup.',
      'Preserve the actual source field names `profile`, `active`, `primaryDispatch`, and `vaultKey` while narrowing or delegating.',
      'Use a field-specific expect such as `expect: "vaultKey"` for the delegated lookup key instead of a generic string contract.',
      'Return only the 6-digit code through FINAL_VAR.',
      'Use concise REPL code.',
      'Do not include imports.',
      'Do not include prose outside repl code fences.',
    ].join(' '),
    assertJournal: ({ journal }) => {
      const matches = journal.match(/"type":"subquery"/gu) ?? [];
      assert.equal(matches.length, 1);
    },
  };
}

const integrationCoreScenarios: OpenAILiveScenario[] = [
  {
    suite: 'integration',
    name:
      'OpenAI integration runner can solve a trivial arithmetic task through the real Responses API',
    context: {
      question: '6 * 7',
    },
    expectedAnswer: '42',
    journalPathName: 'real-runner',
    prompt: [
      'Inspect `context` in the REPL.',
      'Compute the arithmetic expression stored in `context.question`.',
      'The value passed to FINAL_VAR must be exactly the decimal digits of the answer and nothing else.',
      'Use the smallest amount of code that solves the task.',
      'Do not include imports.',
      'Do not include prose outside repl code fences.',
    ].join(' '),
  },
  createDirectAnchorScenario(),
  createFilteringScenario(),
  createMultiHopScenario(),
  createAggregationScenario(),
  createSubqueryScenario(
    'OpenAI integration runner can use rlm_query for a recursive dossier lookup',
    'integration',
    'subquery',
    'orion',
    'sol',
    'V-554',
    '845907',
    [
      {
        id: 'd-alpha',
        profile: 'orion',
        active: false,
        primaryDispatch: false,
        vaultKey: 'V-101',
        approvalCount: 4,
        summary: 'Archived record that should not be used.',
      },
      {
        id: 'd-beta',
        profile: 'orion',
        active: true,
        primaryDispatch: true,
        vaultKey: 'V-554',
        approvalCount: 3,
        summary: 'Active primary dispatch record for the target profile.',
      },
      {
        id: 'd-gamma',
        profile: 'sol',
        active: true,
        primaryDispatch: true,
        vaultKey: 'V-220',
        approvalCount: 5,
        summary: 'Primary dispatch record, but for a different profile.',
      },
    ],
    {
      'V-101': { code: '112233' },
      'V-220': { code: '901122' },
      'V-554': { code: '845907' },
    },
  ),
];

function buildDynamicIntegrationScenarios(runSeed: number): OpenAILiveScenario[] {
  return [
    ...SECRET_CONTEXT_LENGTHS.map((contextLength) => {
      const scenario = createSecretCodeDocument(
        contextLength,
        deriveScenarioSeed(runSeed, contextLength),
      );
    return {
      suite: 'integration' as const,
      name:
        `OpenAI integration runner can recover a secret code from noisy context with length ${contextLength} (run seed ${runSeed})`,
      context: {
        document: scenario.document,
        targetLength: contextLength,
      },
      expectedAnswer: scenario.secretCode,
      journalPathName: `secret-code-${contextLength}-seed-${runSeed}`,
      journalPatterns: [/비밀 코드/u],
      prompt: [
        'Inspect `context.document` in the REPL.',
        'Find the unique substring that matches the exact label `비밀 코드: ` followed by decimal digits.',
        'Return only the decimal digits through FINAL_VAR, with no label and no extra text.',
        'Use concise REPL code.',
        'Do not include imports.',
        'Do not include prose outside repl code fences.',
      ].join(' '),
    };
    }),
    ...PUBLIC_NIAH_CONTEXT_LENGTHS.map((contextLength) =>
      createPublicNeedleInHaystackScenario(
        contextLength,
        deriveScenarioSeed(runSeed, contextLength + 17),
        runSeed,
      )
    ),
  ];
}

function buildSyntheticScenarios(runSeed: number): OpenAILiveScenario[] {
  const seed = runSeed;
  const random = createDeterministicRandom(seed * 19);
  const targetProfile = `profile-${seed}`;
  const distractorProfile = `other-${seed}`;
  const matchingVaultKey = `V-${seed}-B`;
  const matchingCode = createRandomCode(random);

  const baseSubquery = createSubqueryScenario(
    `Synthetic subquery benchmark seed ${seed}`,
    'synthetic',
    `synthetic-subquery-${seed}`,
    targetProfile,
    distractorProfile,
    matchingVaultKey,
    matchingCode,
    [
      {
        id: `d-alpha-${seed}`,
        profile: targetProfile,
        active: false,
        primaryDispatch: false,
        vaultKey: `V-${seed}-A`,
        approvalCount: 4,
        summary: createNoiseSummary(random),
      },
      {
        id: `d-beta-${seed}`,
        profile: targetProfile,
        active: true,
        primaryDispatch: true,
        vaultKey: matchingVaultKey,
        approvalCount: 3,
        summary: createNoiseSummary(random),
      },
      {
        id: `d-gamma-${seed}`,
        profile: distractorProfile,
        active: true,
        primaryDispatch: true,
        vaultKey: `V-${seed}-C`,
        approvalCount: 5,
        summary: createNoiseSummary(random),
      },
    ],
    {
      [`V-${seed}-A`]: { code: createRandomCode(random) },
      [matchingVaultKey]: { code: matchingCode },
      [`V-${seed}-C`]: { code: createRandomCode(random) },
    },
  );

  return [
    {
      suite: 'synthetic',
      name: `Synthetic filtering benchmark seed ${seed}`,
      ...(() => {
        const r = createDeterministicRandom(seed);
        const projectNames = ['marlin', 'tern', 'solace', 'kepler'];
        const targetProject = projectNames[seed % projectNames.length];
        const requiredReviewers = 2 + (seed % 2);
        const targetRecords = [
          {
            project: targetProject,
            code: createRandomCode(r),
            active: true,
            status: 'active',
            revoked: false,
            reviewerCount: requiredReviewers,
            issuedAt: '2026-03-14T10:00:00Z',
          },
          {
            project: targetProject,
            code: createRandomCode(r),
            active: true,
            status: 'active',
            revoked: false,
            reviewerCount: requiredReviewers - 1,
            issuedAt: '2026-03-17T08:30:00Z',
          },
          {
            project: targetProject,
            code: createRandomCode(r),
            active: true,
            status: 'active',
            revoked: true,
            reviewerCount: requiredReviewers + 1,
            issuedAt: '2026-03-18T08:30:00Z',
          },
          {
            project: targetProject,
            code: createRandomCode(r),
            active: true,
            status: 'active',
            revoked: false,
            reviewerCount: requiredReviewers + 2,
            issuedAt: '2026-03-20T09:45:00Z',
          },
        ];
        const expectedAnswer = targetRecords[targetRecords.length - 1].code;
        const distractors = projectNames
          .filter((name) => name !== targetProject)
          .map((project, index) => ({
            project,
            code: createRandomCode(r),
            active: true,
            status: index % 2 === 0 ? 'active' : 'inactive',
            revoked: false,
            reviewerCount: requiredReviewers + 2,
            issuedAt: `2026-03-2${index}T07:00:00Z`,
          }));

        return {
          context: {
            targetProject,
            policy: {
              requiredReviewers,
              requireNotRevoked: true,
            },
            auditLog: [...targetRecords, ...distractors],
          },
          expectedAnswer,
          journalPathName: `synthetic-filtering-${seed}`,
          prompt: [
            'Inspect the REPL state and determine the current release code for the project named in `context.targetProject`.',
            'Review `context.auditLog` and keep only entries for that project whose `status` is `active`, whose `revoked` field is false, and whose `reviewerCount` is at least `context.policy.requiredReviewers`.',
            'If more than one eligible entry remains, choose the one with the most recent `issuedAt` timestamp.',
            'Return only the 6-digit code through FINAL_VAR.',
            'Use concise REPL code.',
            'Do not include imports.',
            'Do not include prose outside repl code fences.',
          ].join(' '),
        };
      })(),
    },
    {
      suite: 'synthetic',
      name: `Synthetic multihop benchmark seed ${seed}`,
      ...(() => {
        const r = createDeterministicRandom(seed * 7);
        const aliases = ['ember', 'solace', 'lumen', 'kepler'].map((alias, index) =>
          `${alias}-${seed + index}`
        );
        const targetAlias = aliases[seed % aliases.length];
        const shardNames = ['east', 'west', 'north', 'south'];
        const aliasDirectory = aliases.map((alias, index) => ({
          alias,
          operatorId: `op-${seed}-${index}`,
        }));
        const operatorAssignments: Record<string, string> = {};
        const lockers = aliasDirectory.map((entry, index) => {
          const lockerId = `locker-${seed}-${index}`;
          operatorAssignments[entry.operatorId] = lockerId;

          return {
            id: lockerId,
            lockerId,
            shard: shardNames[index % shardNames.length],
            slot: `slot-${index + 1}`,
          };
        });

        const shardEntries: Record<string, Array<{ accessCode: string; slot: string }>> = {};
        for (const locker of lockers) {
          const list = shardEntries[locker.shard] ?? [];
          list.push({
            accessCode: createRandomCode(r),
            slot: locker.slot,
          });
          shardEntries[locker.shard] = list;
        }

        const targetOperator = aliasDirectory.find((entry) => entry.alias === targetAlias)!;
        const targetLockerId = operatorAssignments[targetOperator.operatorId];
        const targetLocker = lockers.find((locker) => locker.id === targetLockerId)!;
        const expectedAnswer = shardEntries[targetLocker.shard].find((entry) =>
          entry.slot === targetLocker.slot
        )!
          .accessCode;

        return {
          context: {
            requestAlias: targetAlias,
            aliasDirectory,
            operatorAssignments,
            lockers,
            shardEntries,
          },
          expectedAnswer,
          journalPathName: `synthetic-multihop-${seed}`,
          prompt: [
            'Inspect the REPL state and resolve the final access code for `context.requestAlias`.',
            'First find the row in `context.aliasDirectory` whose alias matches `context.requestAlias` and read its `operatorId`.',
            'Then use that `operatorId` as a key into the `context.operatorAssignments` mapping to get the `lockerId`.',
            'Use that `lockerId` to find the locker record in `context.lockers`; those locker records expose both `id` and `lockerId`, along with the `shard` and `slot`.',
            'Finally look up the entry in `context.shardEntries[shard]` whose `slot` matches and return its `accessCode`.',
            'Return only the 6-digit code through FINAL_VAR.',
            'Use concise REPL code.',
            'Do not include imports.',
            'Do not include prose outside repl code fences.',
          ].join(' '),
        };
      })(),
    },
    {
      suite: 'synthetic',
      name: `Synthetic aggregation benchmark seed ${seed}`,
      ...(() => {
        const r = createDeterministicRandom(seed * 13);
        const desks = ['delta', 'kappa', 'sol'];
        const targetDesk = desks[seed % desks.length];
        const otherDesk = desks[(seed + 1) % desks.length];
        const latestRows = [
          { status: 'approved', amount: 20 + Math.floor(r() * 40) },
          { status: 'approved', amount: 20 + Math.floor(r() * 40) },
          { status: 'approved', amount: 20 + Math.floor(r() * 40) },
          { status: 'rejected', amount: 999 },
        ];
        const expectedAnswer = String(
          latestRows
            .filter((row) => row.status === 'approved')
            .reduce((sum, row) => sum + row.amount, 0),
        );

        return {
          context: {
            targetDesk,
            rule: {
              approvedStatus: 'approved',
            },
            batches: [
              {
                desk: targetDesk,
                targetDesk,
                batchId: `old-${seed}`,
                batchClosedAt: '2026-03-18T18:00:00Z',
                rows: [
                  { status: 'approved', amount: 10 + Math.floor(r() * 20) },
                  { status: 'approved', amount: 10 + Math.floor(r() * 20) },
                ],
              },
              {
                desk: targetDesk,
                targetDesk,
                batchId: `latest-${seed}`,
                batchClosedAt: '2026-03-21T18:30:00Z',
                rows: latestRows,
              },
              {
                desk: otherDesk,
                targetDesk: otherDesk,
                batchId: `other-${seed}`,
                batchClosedAt: '2026-03-22T18:30:00Z',
                rows: [
                  { status: 'approved', amount: 400 + Math.floor(r() * 50) },
                ],
              },
            ],
          },
          expectedAnswer,
          journalPathName: `synthetic-aggregation-${seed}`,
          prompt: [
            'Inspect the REPL state and compute the control total for the desk named in `context.targetDesk`.',
            'The candidate batches are stored in `context.batches`.',
            'Select the latest batch for `context.targetDesk` using `batchClosedAt`.',
            'Inside that chosen batch, keep only rows whose `status` matches `context.rule.approvedStatus`, then sum their `amount` values.',
            'Return only the decimal digits of the total through FINAL_VAR.',
            'Use concise REPL code.',
            'Do not include imports.',
            'Do not include prose outside repl code fences.',
          ].join(' '),
        };
      })(),
    },
    baseSubquery,
    createReturnShapeBenchmarkScenario(seed),
    createAnchorTargetBenchmarkScenario(seed),
    createStructuredPayloadBenchmarkScenario(seed),
    createDelegationContractBenchmarkScenario(seed),
  ];
}

export function buildOpenAILiveScenarioCatalog(runSeed: number): OpenAILiveScenarioCatalog {
  const integrationScenarios = [
    ...integrationCoreScenarios,
    ...buildDynamicIntegrationScenarios(runSeed),
  ];
  const syntheticScenarios = buildSyntheticScenarios(runSeed);

  return {
    integrationScenarios,
    runSeed,
    scenarios: [...integrationScenarios, ...syntheticScenarios],
    syntheticScenarios,
  };
}

export const openAILiveRunSeed = createOpenAILiveSeed();
const openAILiveScenarioCatalog = buildOpenAILiveScenarioCatalog(openAILiveRunSeed);
export const integrationScenarios = openAILiveScenarioCatalog.integrationScenarios;
export const syntheticScenarios = openAILiveScenarioCatalog.syntheticScenarios;
export const openAILiveScenarios = openAILiveScenarioCatalog.scenarios;
