import assert from 'node:assert/strict';

import { buildRLMSystemPrompt, buildRLMTurnInput } from '../src/rlm_prompt.ts';

Deno.test('RLM system prompts stay protocol-focused and role-specific', () => {
  const rootPrompt = buildRLMSystemPrompt();
  assert.match(rootPrompt, /persistent JavaScript\/TypeScript REPL/u);
  assert.match(rootPrompt, /top-level await/u);
  assert.match(rootPrompt, /Keep the user query as the success condition/u);
  assert.match(rootPrompt, /REPL interface: `context`, `history`, `FINAL\(value\)`, `FINAL_VAR\(value\)`, `llm_query\(prompt\)`, `rlm_query\(prompt\)`, `normalizeTarget\(value\)`, `findAnchoredValue\(text, prefix, suffix\)`, and `console\.log\(\.\.\.\)`/u);
  assert.match(rootPrompt, /`context` and `history` are read-only inputs/u);
  assert.match(rootPrompt, /`normalizeTarget\(value\)` returns a clean lookup string, returns `""` when a non-null input does not resolve to one, and returns `null` only for nullish input/u);
  assert.match(rootPrompt, /`findAnchoredValue\(text, prefix, suffix\)` returns the substring between exact anchors, returns `""` when a non-null search misses, and returns `null` only for nullish input/u);
  assert.match(rootPrompt, /store derived state in ordinary top-level variables/u);
  assert.match(rootPrompt, /blocks run sequentially/u);
  assert.match(rootPrompt, /structured result signals/u);
  assert.match(rootPrompt, /prefer the built-in helpers directly over broad regex or whole-document scans/u);
  assert.match(rootPrompt, /You are the root controller/u);
  assert.match(rootPrompt, /Define or refine a `query_contract` variable in code before broad search/u);
  assert.match(rootPrompt, /Delegate only narrowed subproblems/u);
  assert.match(rootPrompt, /Call `rlm_query` either with a task string or with `\{ task, payload, expect \}`/u);
  assert.match(rootPrompt, /object form is preferred when the delegated evidence is structured/u);
  assert.match(rootPrompt, /When multiple narrowed candidates still share the main identifier, keep the distinguishing fields in the payload or delegated task/u);
  assert.match(rootPrompt, /Preserve the source field names that carry the selection rule/u);
  assert.match(rootPrompt, /If narrowed rows still differ on positive selector fields such as active, current, enabled, or primaryDispatch/u);
  assert.match(rootPrompt, /Prefer the smallest named value that directly powers the next step/u);
  assert.match(rootPrompt, /field-specific scalar expects such as `"vaultKey"` or `"index"`/u);
  assert.match(rootPrompt, /read that existing field instead of inventing a new field name/u);
  assert.match(rootPrompt, /Treat child returns as validated JavaScript values or delegated evidence/u);
  assert.match(rootPrompt, /After a dependent lookup returns a record or object, continue to the requested scalar field before FINAL/u);
  assert.match(rootPrompt, /finish with that scalar value rather than the enclosing record/u);
  assert.match(rootPrompt, /Keep `rlm_query` calls sequential/u);
  assert.doesNotMatch(rootPrompt, /decimal digits/u);
  assert.doesNotMatch(rootPrompt, /Date\.parse/u);
  assert.doesNotMatch(rootPrompt, /regex literals directly/u);
  assert.doesNotMatch(rootPrompt, /Example:/u);

  const childPrompt = buildRLMSystemPrompt({ role: 'child' });
  assert.match(childPrompt, /focused child controller/u);
  assert.match(childPrompt, /narrow delegated task/u);
  assert.match(childPrompt, /`context\.task` is the authoritative delegated task/u);
  assert.match(childPrompt, /`context\.payload` is the complete delegated evidence/u);
  assert.match(childPrompt, /`context\.expect` is a runtime-checked return contract/u);
  assert.match(childPrompt, /`context\.selectionHints\.positiveSelectors` is present/u);
  assert.match(childPrompt, /Return the smallest JavaScript value that satisfies the delegated task or `context\.expect`/u);
  assert.match(childPrompt, /This child run is terminal for recursion/u);
  assert.match(childPrompt, /use `llm_query` only if plain model help is necessary/u);
  assert.doesNotMatch(childPrompt, /query_contract/u);
  assert.doesNotMatch(childPrompt, /delegate only narrowed subproblems/u);
});

Deno.test('RLM turn input keeps root hints compact and state-oriented', () => {
  const turnInput = buildRLMTurnInput({
    context: {
      document: 'alpha beta gamma delta',
      question: 'Which token matters?',
    },
    outputCharLimit: 10,
    prompt: 'Solve the task.',
    transcript: [
      {
        assistantText: 'This assistant text is intentionally long.',
        executions: [
          {
            code: 'const longValue = "123456789012345";',
            finalAnswer: null,
            resultPreview: '123456789012345',
            resultSignals: [
              {
                kind: 'string',
                path: '$',
                preview: '123456789012345',
              },
            ],
            status: 'success',
            stderr: '',
            stdout: '123456789012345',
          },
        ],
        step: 1,
      },
    ],
  });

  assert.match(turnInput, /\.\.\.\[truncated/u);
  assert.match(turnInput, /Task summary:/u);
  assert.match(turnInput, /prompt: string \(15 chars, 3 words\)/u);
  assert.match(turnInput, /Root checklist:/u);
  assert.match(turnInput, /define or refine a `query_contract` variable in code before broad search/u);
  assert.match(turnInput, /solve direct structured filtering, indexing, and aggregation in root before delegating/u);
  assert.match(turnInput, /read that field first and extract the target entity in code before broad scanning/u);
  assert.match(turnInput, /prefer `rlm_query\(\{ task, payload, expect \}\)` once the evidence is narrowed/u);
  assert.match(turnInput, /keep distinguishing fields in the payload or delegated task when multiple narrowed candidates still share the main identifier/u);
  assert.match(turnInput, /preserve the actual source field names used by the selection rule instead of inventing aliases while narrowing rows/u);
  assert.match(turnInput, /if narrowed rows still differ on positive selector fields such as `active`, `current`, `enabled`, or `primaryDispatch`, copy those exact fields and desired truth values into the delegated task/u);
  assert.match(turnInput, /if the next step is a dependent lookup by a named key or index field, prefer a field-specific scalar `expect` such as `"vaultKey"` or `"index"`/u);
  assert.match(turnInput, /when a narrowed record already exposes the requested scalar field, read that existing field name directly/u);
  assert.match(turnInput, /when exact prefix and suffix anchors exist, prefer `findAnchoredValue\(\.\.\.\)` before broad regex or whole-document scans/u);
  assert.match(turnInput, /build a target-specific anchor or filter in code before you scan all matches/u);
  assert.match(turnInput, /after a dependent lookup returns a record, continue to the requested scalar field before FINAL/u);
  assert.match(turnInput, /treat child returns as validated JavaScript values or delegated evidence and inspect them in code before FINAL or the next delegation/u);
  assert.match(turnInput, /REPL interface reminder:/u);
  assert.match(turnInput, /`normalizeTarget\(value\)` returns a clean string target, `""` when a non-null input stays unresolved, and `null` only for nullish input/u);
  assert.match(turnInput, /`findAnchoredValue\(text, prefix, suffix\)` returns the substring between exact anchors, `""` when a non-null search misses, and `null` only for nullish input/u);
  assert.match(turnInput, /`context` and `history` are read-only inputs/u);
  assert.match(turnInput, /store derived values in top-level variables/u);
  assert.match(turnInput, /Context summary:/u);
  assert.match(turnInput, /document: string \(22 chars, 4 words\)/u);
  assert.match(turnInput, /Question-like context fields:/u);
  assert.match(turnInput, /question: Which token matters\?/u);
  assert.match(turnInput, /signals:/u);
  assert.match(turnInput, /\$ \(string\): 123456789012345/u);
  assert.match(turnInput, /If one of the previous executions already exposed the exact requested value, finalize now/u);
  assert.match(turnInput, /When a child return is incomplete, build the next narrower delegated task from that returned value/u);
  assert.doesNotMatch(turnInput, /decimal digits/u);
  assert.doesNotMatch(turnInput, /Date\.parse/u);
  assert.doesNotMatch(turnInput, /regex literals directly/u);
});

Deno.test('RLM turn input surfaces actual field names for top-level arrays of records', () => {
  const turnInput = buildRLMTurnInput({
    context: {
      dossiers: [
        { active: false, primaryDispatch: false, profile: 'shape-profile-17', vaultKey: 'VS-17-A' },
        { active: true, primaryDispatch: true, profile: 'shape-profile-17', vaultKey: 'VS-17-B' },
      ],
      targetProfile: 'shape-profile-17',
      vaultRegister: {
        'VC-17-A': { code: '769365' },
        'VC-17-B': { code: '448840' },
      },
    },
    outputCharLimit: 80,
    prompt: 'Return the 6-digit access code for context.targetProfile.',
    transcript: [],
  });

  assert.match(
    turnInput,
    /dossiers: array \(2 items; sample keys: active, primaryDispatch, profile, vaultKey\); varying boolean fields: active, primaryDispatch/u,
  );
  assert.match(
    turnInput,
    /vaultRegister: object \(2 keys: VC-17-A, VC-17-B; sample value keys: code\)/u,
  );
});

Deno.test('RLM turn input keeps large-context, recovery, repeated-failure, and child guidance concise', () => {
  const largeContextTurnInput = buildRLMTurnInput({
    context: {
      document: 'alpha '.repeat(4_000),
    },
    outputCharLimit: 20,
    prompt: 'Solve the task.',
    transcript: [],
  });

  assert.match(largeContextTurnInput, /Large-context mode is active/u);
  assert.match(largeContextTurnInput, /Inspect size and structure before broad search/u);
  assert.match(largeContextTurnInput, /document head preview/u);
  assert.match(largeContextTurnInput, /document tail preview/u);
  assert.match(largeContextTurnInput, /The response should begin with a ```repl block/u);

  const recoveryTurnInput = buildRLMTurnInput({
    context: {
      document: 'alpha beta gamma delta',
    },
    outputCharLimit: 40,
    prompt: 'Recover from the last failed execution.',
    transcript: [
      {
        assistantText: '```repl\nFINAL_VAR("wrong");\nthrow new Error("boom");\n```',
        executions: [
          {
            code: 'FINAL_VAR("wrong");\nthrow new Error("boom");',
            finalAnswer: 'wrong',
            resultPreview: 'undefined',
            status: 'error',
            stderr: 'Error: boom',
            stdout: '',
          },
        ],
        step: 1,
      },
    ],
  });

  assert.match(recoveryTurnInput, /Execution recovery is active/u);
  assert.match(recoveryTurnInput, /Repair the failing code using the recorded stderr and prior outputs/u);

  const repeatedFailureTurnInput = buildRLMTurnInput({
    context: {
      document: 'alpha beta gamma delta',
    },
    outputCharLimit: 80,
    prompt: 'Find the current release code.',
    transcript: [
      {
        assistantText: '```repl\nfunction helper() {}\n```',
        executions: [
          {
            code: 'function helper() {}',
            finalAnswer: null,
            resultPreview: 'undefined',
            status: 'error',
            stderr: 'TypeError: helper is not a function',
            stdout: '',
          },
        ],
        step: 1,
      },
    ],
  });

  assert.match(repeatedFailureTurnInput, /Strategy shift is active/u);
  assert.match(repeatedFailureTurnInput, /Use one self-contained block for the next attempt/u);

  const contractFailureTurnInput = buildRLMTurnInput({
    context: {
      dossiers: [{ profile: 'orion', vaultKey: 'V-554' }],
      targetProfile: 'orion',
    },
    outputCharLimit: 80,
    prompt: 'Return the enabled 6-digit access code for context.targetProfile.',
    transcript: [
      {
        assistantText: '```repl\nawait rlm_query({ task: "Pick the dossier.", expect: "vaultKey" })\n```',
        executions: [
          {
            code: 'await rlm_query({ task: "Pick the dossier.", expect: "vaultKey" })',
            finalAnswer: null,
            resultPreview: 'undefined',
            status: 'error',
            stderr:
              'RLMSubqueryContractError: rlm_query contract mismatch for "Pick the dossier.": expected object but received string.',
            stdout: '',
          },
        ],
        step: 1,
      },
    ],
  });

  assert.match(contractFailureTurnInput, /Delegated contract recovery is active/u);
  assert.match(
    contractFailureTurnInput,
    /Rewrite the next `rlm_query` call with a concrete `expect` contract/u,
  );
  assert.match(
    contractFailureTurnInput,
    /If multiple candidates still share the main identifier, carry the remaining distinguishing fields/u,
  );

  const childTurnInput = buildRLMTurnInput({
    context: {
      expect: { type: 'string' },
      payload: {
        dossiers: [{ profile: 'orion', primaryDispatch: true, vaultKey: 'V-554' }],
      },
      selectionHints: {
        positiveSelectors: ['primaryDispatch'],
      },
      task: 'Return only the vaultKey for the active primary dispatch dossier.',
      type: 'rlm_delegated_task',
    },
    outputCharLimit: 80,
    prompt: 'Extract the exact code from the narrowed excerpt.',
    role: 'child',
    transcript: [],
  });

  assert.match(childTurnInput, /Child-mode constraints are active/u);
  assert.match(childTurnInput, /If `context\.task` is present, treat it as the delegated task/u);
  assert.match(childTurnInput, /If `context\.payload` is present, treat it as the narrowed delegated data you must inspect in code/u);
  assert.match(childTurnInput, /If `context\.expect` is present, return a JavaScript value that satisfies that runtime-checked contract/u);
  assert.match(childTurnInput, /If `context\.selectionHints\.positiveSelectors` is present, use those source field names as decisive positive selectors/u);
  assert.doesNotMatch(childTurnInput, /Task summary:/u);
  assert.doesNotMatch(childTurnInput, /Root checklist:/u);
  assert.doesNotMatch(childTurnInput, /head preview/u);
  assert.doesNotMatch(childTurnInput, /tail preview/u);
});
