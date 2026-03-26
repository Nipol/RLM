import assert from 'node:assert/strict';
import { join } from 'node:path';

import { __codeGuardTestables } from '../src/code_guard.ts';
import { __llmQueryTestables, RLMSubqueryContractError } from '../src/llm_query.ts';
import { __rlmPromptTestables, buildRLMTurnInput } from '../src/rlm_prompt.ts';
import {
  cloneUsageSummary,
  createUsageSummary,
  mergeUsageSummaries,
  recordUsage,
} from '../src/usage_summary.ts';
import { __workerRuntimeTestables } from '../src/worker_runtime.ts';

Deno.test('code guard helpers cover empty expressions, reserved overrides, and unterminated trivia', () => {
  assert.equal(__codeGuardTestables.looksLikeExpression('   '), false);
  assert.equal(__codeGuardTestables.looksLikeBlockStatement('{}'), true);
  assert.equal(__codeGuardTestables.stripLeadingTrivia('// comment only'), '');
  assert.equal(__codeGuardTestables.stripLeadingTrivia('/* block only'), '');
  assert.equal(
    __codeGuardTestables.stripLeadingTrivia('/* block */   const answer = 42'),
    'const answer = 42',
  );
  assert.match(
    __codeGuardTestables.redactNonCode('const answer = "import"; // hidden\nanswer'),
    /const answer =\s+;\s+\nanswer/u,
  );
  assert.throws(
    () => __codeGuardTestables.assertNoModuleSyntax('import value from "x";'),
    /import\/export syntax/u,
  );
  assert.throws(
    () => __codeGuardTestables.assertNoReservedIdentifierOverride('function context() {}'),
    /Reserved REPL identifiers/u,
  );
  assert.equal(
    __codeGuardTestables.findTrailingExpressionBoundary('const answer = 1;\nanswer'),
    'const answer = 1;\n'.length,
  );
});

Deno.test('llm_query helpers cover payload parsing, contract normalization, and aborts', () => {
  const abortError = __llmQueryTestables.createAbortError();
  assert.equal(abortError.name, 'AbortError');
  assert.match(abortError.message, /aborted/u);
  assert.doesNotThrow(() => __llmQueryTestables.throwIfAborted(undefined));

  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => __llmQueryTestables.throwIfAborted(controller.signal),
    /aborted/u,
  );

  assert.equal(__llmQueryTestables.parseDelegatedPayload('not json'), undefined);
  assert.deepEqual(__llmQueryTestables.parseDelegatedPayload('{"answer":42}'), { answer: 42 });
  assert.deepEqual(
    __llmQueryTestables.buildDelegatedChildPayload(undefined, { answer: 42 }),
    { answer: 42 },
  );
  assert.deepEqual(
    __llmQueryTestables.buildDelegatedChildPayload('value', { answer: 42 }),
    { answer: 42, payload: 'value' },
  );
  assert.deepEqual(
    __llmQueryTestables.inferSelectionHints([
      1,
      { active: true, answer: 'A' },
      { active: false, answer: 'B' },
    ]),
    { positiveSelectors: ['active'] },
  );
  assert.equal(
    __llmQueryTestables.inferSelectionHints([1, { active: true }]),
    undefined,
  );
  assert.equal(__llmQueryTestables.inferSelectionHints([{ only: 'one' }]), undefined);
  assert.equal(
    __llmQueryTestables.inferSelectionHints([{ answer: 'A' }, { answer: 'B' }]),
    undefined,
  );

  assert.deepEqual(
    __llmQueryTestables.normalizeExpectContract('task', 'number'),
    { type: 'number' },
  );
  assert.deepEqual(
    __llmQueryTestables.normalizeExpectContract('task', 'vaultKey'),
    { field: 'vaultKey', type: 'string' },
  );
  assert.deepEqual(
    __llmQueryTestables.normalizeExpectContract(
      'task',
      { minItems: 'two', type: 'array' } as never,
    ),
    { minItems: undefined, type: 'array' },
  );
  assert.deepEqual(
    __llmQueryTestables.normalizeExpectContract('task', { minItems: 2, type: 'array' } as never),
    { minItems: 2, type: 'array' },
  );
  assert.deepEqual(
    __llmQueryTestables.normalizeExpectContract('task', {
      fields: { answer: 'string' },
      requiredKeys: ['answer'],
      type: 'object',
    }),
    {
      fields: { answer: 'string' },
      requiredKeys: ['answer'],
      type: 'object',
    },
  );
  assert.throws(
    () => __llmQueryTestables.normalizeExpectContract('task', ''),
    RLMSubqueryContractError,
  );
  assert.throws(
    () => __llmQueryTestables.normalizeExpectContract('task', 42 as never),
    RLMSubqueryContractError,
  );
  assert.throws(
    () =>
      __llmQueryTestables.normalizeExpectContract(
        'task',
        { fields: ['vaultKey'], type: 'object' } as never,
      ),
    RLMSubqueryContractError,
  );
  assert.throws(
    () =>
      __llmQueryTestables.normalizeExpectContract(
        'task',
        { fields: { vaultKey: 'scalar' }, type: 'object' } as never,
      ),
    RLMSubqueryContractError,
  );
  assert.throws(
    () => __llmQueryTestables.normalizeExpectContract('task', {}),
    RLMSubqueryContractError,
  );
});

Deno.test('llm_query helpers cover scalar selection extraction and delegated value validation', () => {
  assert.equal(__llmQueryTestables.describeJsonValueType(null), 'null');
  assert.equal(__llmQueryTestables.describeJsonValueType([1, 2]), 'array');
  assert.equal(__llmQueryTestables.describeJsonValueType({ answer: 42 }), 'object');

  assert.throws(
    () => __llmQueryTestables.validateScalarFieldValue('task', 'vaultKey', 'string', 'V-554'),
    RLMSubqueryContractError,
  );
  assert.throws(
    () =>
      __llmQueryTestables.validateScalarFieldValue(
        'task',
        'vaultKey',
        'string',
        { answer: 'V-554' },
      ),
    /missing required field/u,
  );
  assert.throws(
    () =>
      __llmQueryTestables.validateScalarFieldValue(
        'task',
        'vaultKey',
        'null',
        { vaultKey: 'V-554' },
      ),
    /expected field vaultKey to be null/u,
  );
  assert.throws(
    () =>
      __llmQueryTestables.validateScalarFieldValue(
        'task',
        'vaultKey',
        'number',
        { vaultKey: 'V-554' },
      ),
    /expected field vaultKey to be number/u,
  );
  assert.equal(
    __llmQueryTestables.validateScalarFieldValue(
      'task',
      'vaultKey',
      'string',
      { vaultKey: 'V-554' },
    ),
    'V-554',
  );
  assert.equal(
    __llmQueryTestables.validateScalarFieldValue(
      'task',
      'missingValue',
      'null',
      { missingValue: null },
    ),
    null,
  );

  assert.equal(
    __llmQueryTestables.extractSelectionIdentifier(undefined, 'V-554'),
    null,
  );
  assert.deepEqual(
    __llmQueryTestables.extractSelectionIdentifier({ field: 'vaultKey', type: 'string' }, 'V-554'),
    { field: 'vaultKey', value: 'V-554' },
  );
  assert.equal(
    __llmQueryTestables.extractSelectionIdentifier(
      { fields: { vaultKey: 'string' }, requiredKeys: ['vaultKey', 'profile'], type: 'object' },
      { vaultKey: 'V-554' },
    ),
    null,
  );
  assert.equal(
    __llmQueryTestables.extractSelectionIdentifier(
      { fields: { vaultKey: 'string' }, requiredKeys: ['vaultKey'], type: 'object' },
      'V-554',
    ),
    null,
  );
  assert.equal(
    __llmQueryTestables.extractSelectionIdentifier(
      { fields: { vaultKey: 'string' }, requiredKeys: ['vaultKey'], type: 'object' },
      { profile: 'orion' },
    ),
    null,
  );
  assert.deepEqual(
    __llmQueryTestables.extractSelectionIdentifier(
      { fields: { vaultKey: 'string' }, requiredKeys: ['vaultKey'], type: 'object' },
      { vaultKey: null },
    ),
    { field: 'vaultKey', value: null },
  );
  assert.deepEqual(
    __llmQueryTestables.extractSelectionIdentifier(
      { fields: { vaultKey: 'string' }, requiredKeys: ['vaultKey'], type: 'object' },
      { vaultKey: 'V-554' },
    ),
    { field: 'vaultKey', value: 'V-554' },
  );
  assert.deepEqual(
    __llmQueryTestables.extractSelectionIdentifier(
      { fields: { vaultKey: 'string' }, type: 'object' },
      { vaultKey: 'V-554' },
    ),
    { field: 'vaultKey', value: 'V-554' },
  );
  assert.equal(
    __llmQueryTestables.extractSelectionIdentifier(
      { type: 'object' },
      { vaultKey: 'V-554' },
    ),
    null,
  );

  assert.doesNotThrow(() =>
    __llmQueryTestables.validateSelectionHints(
      'task',
      [1, { vaultKey: 'V-554' }],
      { positiveSelectors: ['active'] },
      { field: 'vaultKey', type: 'string' },
      'V-554',
    )
  );
  assert.doesNotThrow(() =>
    __llmQueryTestables.validateSelectionHints(
      'task',
      [{ vaultKey: 'V-554' }],
      undefined,
      { field: 'vaultKey', type: 'string' },
      'V-554',
    )
  );
  assert.doesNotThrow(() =>
    __llmQueryTestables.validateSelectionHints(
      'task',
      [{ vaultKey: 'V-554' }],
      { positiveSelectors: ['active'] },
      { field: 'vaultKey', type: 'string' },
      'V-554',
    )
  );
  assert.throws(
    () =>
      __llmQueryTestables.validateSelectionHints(
        'task',
        [
          { active: false, vaultKey: 'V-101' },
          { active: true, vaultKey: 'V-554' },
        ],
        { positiveSelectors: ['active'] },
        { fields: { vaultKey: 'string' }, requiredKeys: ['vaultKey'], type: 'object' },
        { vaultKey: 'V-101' },
      ),
    /unique positive selector row/u,
  );
  assert.doesNotThrow(() =>
    __llmQueryTestables.validateSelectionHints(
      'task',
      [
        { active: true, vaultKey: 'V-101' },
        { active: false, vaultKey: 'V-554' },
      ],
      { positiveSelectors: ['active'] },
      { fields: { answer: 'string' }, requiredKeys: ['answer'], type: 'object' },
      'plain',
    )
  );
  assert.doesNotThrow(() =>
    __llmQueryTestables.validateSelectionHints(
      'task',
      [
        { active: true, vaultKey: 'V-101' },
        { active: true, vaultKey: 'V-554' },
      ],
      { positiveSelectors: ['active'] },
      { field: 'vaultKey', type: 'string' },
      'missing',
    )
  );
  assert.doesNotThrow(() =>
    __llmQueryTestables.validateSelectionHints(
      'task',
      [
        { active: true, vaultKey: 'V-101' },
        { active: true, vaultKey: 'V-554' },
      ],
      { positiveSelectors: ['active'] },
      { fields: { vaultKey: 'string' }, requiredKeys: ['vaultKey'], type: 'object' },
      { vaultKey: 'V-101' },
    )
  );

  assert.equal(
    __llmQueryTestables.normalizeDelegatedValue('task', undefined, undefined, undefined, 'V-554'),
    'V-554',
  );
  assert.equal(
    __llmQueryTestables.normalizeDelegatedValue(
      'task',
      undefined,
      undefined,
      { type: 'null' },
      null,
    ),
    null,
  );
  assert.equal(
    __llmQueryTestables.normalizeDelegatedValue(
      'task',
      undefined,
      undefined,
      { field: 'vaultKey', type: 'string' },
      { vaultKey: 'V-554' },
    ),
    'V-554',
  );
  assert.equal(
    __llmQueryTestables.normalizeDelegatedValue(
      'task',
      undefined,
      undefined,
      { field: 'missingValue', type: 'null' },
      { missingValue: null },
    ),
    null,
  );
  assert.throws(
    () =>
      __llmQueryTestables.normalizeDelegatedValue(
        'task',
        undefined,
        undefined,
        { type: 'null' },
        'not-null',
      ),
    /expected null but received string/u,
  );
  assert.throws(
    () =>
      __llmQueryTestables.normalizeDelegatedValue(
        'task',
        undefined,
        undefined,
        { minItems: 2, type: 'array' },
        ['one'],
      ),
    /at least 2 array items/u,
  );
  assert.deepEqual(
    __llmQueryTestables.normalizeDelegatedValue(
      'task',
      undefined,
      undefined,
      { minItems: 2, type: 'array' },
      ['one', 'two'],
    ),
    ['one', 'two'],
  );
  assert.throws(
    () =>
      __llmQueryTestables.normalizeDelegatedValue(
        'task',
        undefined,
        undefined,
        { type: 'array' },
        'not-array',
      ),
    /expected array but received string/u,
  );
  assert.deepEqual(
    __llmQueryTestables.normalizeDelegatedValue(
      'task',
      undefined,
      undefined,
      { type: 'object' },
      { answer: 42 },
    ),
    { answer: 42 },
  );
  assert.throws(
    () =>
      __llmQueryTestables.normalizeDelegatedValue(
        'task',
        undefined,
        undefined,
        { fields: { answer: 'string' }, requiredKeys: ['answer', 'code'], type: 'object' },
        { answer: 'ok' },
      ),
    /missing required keys: code/u,
  );
  assert.throws(
    () =>
      __llmQueryTestables.normalizeDelegatedValue(
        'task',
        undefined,
        undefined,
        { fields: { answer: 'number' }, requiredKeys: ['answer'], type: 'object' },
        'scalar',
      ),
    /expected object but received string/u,
  );
  assert.throws(
    () =>
      __llmQueryTestables.normalizeDelegatedValue(
        'task',
        undefined,
        undefined,
        { fields: { answer: 'string' }, requiredKeys: ['answer', 'code'], type: 'object' },
        'scalar',
      ),
    /expected object but received string/u,
  );
  assert.deepEqual(
    __llmQueryTestables.normalizeDelegatedValue(
      'task',
      undefined,
      undefined,
      {
        fields: { meta: 'object', missingValue: 'null', tags: 'array', optional: 'string' },
        requiredKeys: ['meta', 'tags'],
        type: 'object',
      },
      { meta: { chapter: 1 }, missingValue: null, tags: ['a'], answer: 'ok' },
    ),
    { meta: { chapter: 1 }, missingValue: null, tags: ['a'], answer: 'ok' },
  );
  assert.deepEqual(
    __llmQueryTestables.normalizeDelegatedValue(
      'task',
      undefined,
      undefined,
      {
        fields: { answer: 'string', missing: 'number' },
        requiredKeys: ['answer'],
        type: 'object',
      },
      { answer: 'ok' },
    ),
    { answer: 'ok' },
  );
  assert.deepEqual(
    __llmQueryTestables.normalizeDelegatedValue(
      'task',
      undefined,
      undefined,
      { fields: { maybeValue: 'null' }, requiredKeys: ['maybeValue'], type: 'object' },
      null,
    ),
    { maybeValue: null },
  );
  assert.deepEqual(
    __llmQueryTestables.normalizeDelegatedValue(
      'task',
      undefined,
      undefined,
      { fields: { matches: 'array' }, requiredKeys: ['matches'], type: 'object' },
      ['one', 'two'],
    ),
    { matches: ['one', 'two'] },
  );
  assert.throws(
    () =>
      __llmQueryTestables.normalizeDelegatedValue(
        'task',
        undefined,
        undefined,
        { fields: { evidence: 'object' }, requiredKeys: ['evidence'], type: 'object' },
        ['not-an-object'],
      ),
    /expected object but received array/u,
  );
  assert.throws(
    () =>
      __llmQueryTestables.normalizeDelegatedValue(
        'task',
        undefined,
        undefined,
        { fields: { meta: 'object' }, requiredKeys: ['meta'], type: 'object' },
        { meta: 'plain-text' },
      ),
    /expected field meta to be object/u,
  );
  assert.throws(
    () =>
      __llmQueryTestables.normalizeDelegatedValue(
        'task',
        undefined,
        undefined,
        { fields: { answer: 'string' }, requiredKeys: ['answer'], type: 'object' },
        { answer: 42 },
      ),
    /expected field answer to be string/u,
  );
  assert.throws(
    () =>
      __llmQueryTestables.normalizeDelegatedValue(
        'task',
        undefined,
        undefined,
        { fields: { items: 'array' }, requiredKeys: ['items'], type: 'object' },
        { items: 'plain-text' },
      ),
    /expected field items to be array/u,
  );
  assert.throws(
    () =>
      __llmQueryTestables.normalizeDelegatedValue(
        'task',
        undefined,
        undefined,
        { fields: { missingValue: 'null' }, requiredKeys: ['missingValue'], type: 'object' },
        { missingValue: 'plain-text' },
      ),
    /expected field missingValue to be null/u,
  );
  assert.equal(
    __llmQueryTestables.normalizeDelegatedValue(
      'task',
      undefined,
      undefined,
      { type: 'mystery' } as never,
      'fallback',
    ),
    undefined,
  );
  assert.deepEqual(
    __llmQueryTestables.buildDelegatedChildContext({ task: 17 } as never),
    {
      payload: { task: 17 },
      task: 17,
      type: 'rlm_delegated_task',
    },
  );
});

Deno.test('rlm prompt helpers cover summaries, previews, and recovery guidance', () => {
  assert.equal(
    __rlmPromptTestables.summarizeString('context', ''),
    'context: string (0 chars, 0 words)',
  );
  assert.equal(
    __rlmPromptTestables.clipText('abcdefghijklmnopqrstuvwxyz', 5),
    'abcde\n...[truncated 21 chars]',
  );
  assert.equal(
    __rlmPromptTestables.clipInlineText('  alpha    beta   gamma  ', 12),
    'alpha beta g...',
  );
  assert.equal(__rlmPromptTestables.slicePreviewTokens('', 5), '(empty)');
  assert.equal(
    __rlmPromptTestables.slicePreviewTokens('one two three four', 2, true),
    'three four',
  );
  assert.equal(__rlmPromptTestables.summarizeTopLevelValue('value', null), 'value: null');
  assert.equal(__rlmPromptTestables.summarizeTopLevelValue('value', 42), 'value: number');
  assert.equal(
    __rlmPromptTestables.summarizeTopLevelValue('items', ['a', 'b']),
    'items: array (2 items)',
  );
  assert.equal(
    __rlmPromptTestables.summarizeTopLevelValue('items', [{}, {}]),
    'items: array (2 items; sample keys: (none))',
  );
  assert.match(
    __rlmPromptTestables.summarizeTopLevelValue('rows', [
      { active: false, code: 'A' },
      { active: true, code: 'B' },
    ]),
    /varying boolean fields: active/u,
  );
  assert.doesNotMatch(
    __rlmPromptTestables.summarizeTopLevelValue('rows', [
      { a: 1, b: 2, c: 3, d: 4, e: 5 },
      { f: 6, g: 7, h: 8, i: 9, j: 10 },
    ]),
    /i, j/u,
  );
  assert.match(
    __rlmPromptTestables.summarizeTopLevelValue('context', {
      meta: { chapter: '1' },
      results: { code: 'A' },
      title: 'Book',
    }),
    /sample value keys: chapter, code/u,
  );
  assert.equal(
    __rlmPromptTestables.summarizeTopLevelValue('bag', {}),
    'bag: object (0 keys: (none))',
  );
  assert.equal(
    __rlmPromptTestables.summarizeTopLevelValue('register', { alpha: {} }),
    'register: object (1 keys: alpha; sample value keys: (none))',
  );
  assert.doesNotMatch(
    __rlmPromptTestables.summarizeTopLevelValue('context', {
      a: { a1: 1, a2: 2, a3: 3 },
      b: { b1: 1, b2: 2, b3: 3 },
      c: { c1: 1, c2: 2, c3: 3 },
      d: { d1: 1, d2: 2, d3: 3 },
    }),
    /c3|d1/u,
  );
  assert.equal(__rlmPromptTestables.buildContextSummary(null), '- context: null');
  assert.equal(
    __rlmPromptTestables.buildContextSummary('hello world'),
    '- context: string (11 chars, 2 words)',
  );
  assert.equal(__rlmPromptTestables.buildContextSummary(true), '- context: boolean');
  assert.equal(__rlmPromptTestables.buildContextSummary([1, 2, 3]), '- context: array (3 items)');
  assert.match(
    __rlmPromptTestables.buildContextSummary({ title: 'Book' }),
    /- title: string/u,
  );
  assert.equal(__rlmPromptTestables.buildContextPreviews(null), null);
  assert.equal(__rlmPromptTestables.buildContextPreviews(42 as never), null);
  assert.match(
    __rlmPromptTestables.buildContextPreviews('token '.repeat(25_000)) ?? '',
    /context head preview/u,
  );
  assert.match(
    __rlmPromptTestables.buildContextPreviews({
      a: 'token '.repeat(25_000),
      b: 'token '.repeat(25_000),
      c: 'token '.repeat(25_000),
    }) ?? '',
    /a head preview/u,
  );
  assert.equal(__rlmPromptTestables.buildQuestionHints(null), null);
  assert.equal(
    __rlmPromptTestables.buildQuestionHints({ title: 'Book' } as never),
    null,
  );
  assert.match(
    __rlmPromptTestables.buildQuestionHints({
      prompt: 'What is the code?',
      retrievalQuestion: 'Find amber.',
    }) ?? '',
    /retrievalQuestion/u,
  );
  const questionHints = __rlmPromptTestables.buildQuestionHints({
    prompt: 'A',
    query: 'B',
    question: 'C',
    retrievalQuestion: 'D',
    user_query: 'E',
  }) ?? '';
  assert.equal(questionHints.split('\n').length, 4);
  assert.equal(__rlmPromptTestables.isLargeContextValue('tiny'), false);
  assert.equal(__rlmPromptTestables.isLargeContextValue('token '.repeat(25_000)), true);
  assert.equal(__rlmPromptTestables.isLargeContextValue(new Array(2_000).fill(1)), true);
  assert.equal(__rlmPromptTestables.isLargeContext('token '.repeat(25_000) as never), true);
  assert.equal(__rlmPromptTestables.isLargeContext(new Array(2_000).fill(1) as never), true);
  assert.equal(__rlmPromptTestables.isLargeContext(42 as never), false);
  assert.equal(__rlmPromptTestables.isLargeContext({ small: 'tiny' }), false);
  assert.equal(
    __rlmPromptTestables.isLargeContext({ document: 'token '.repeat(25_000) }),
    true,
  );
  assert.equal(__rlmPromptTestables.requiresExecutionRecovery([]), false);
  assert.equal(
    __rlmPromptTestables.requiresExecutionRecovery([
      {
        assistantText: '```repl\n1\n```',
        executions: [{
          code: '1',
          finalAnswer: 'undefined',
          resultPreview: 'undefined',
          status: 'success',
          stderr: '',
          stdout: '',
        }],
        step: 1,
      },
    ]),
    true,
  );
  assert.equal(
    __rlmPromptTestables.normalizeExecutionFailure({
      code: '1',
      finalAnswer: null,
      resultPreview: '1',
      status: 'success',
      stderr: '',
      stdout: '',
    }),
    null,
  );
  assert.equal(
    __rlmPromptTestables.normalizeExecutionFailure({
      code: '1',
      finalAnswer: null,
      resultPreview: '1',
      status: 'timeout',
      stderr: '',
      stdout: '',
    }),
    'TimeoutError: Execution timed out',
  );
  assert.equal(
    __rlmPromptTestables.normalizeExecutionFailure({
      code: '1',
      finalAnswer: null,
      resultPreview: '1',
      status: 'error',
      stderr: '',
      stdout: '',
    }),
    null,
  );
  assert.equal(__rlmPromptTestables.classifyFailureKind('oops'), 'other');
  assert.equal(__rlmPromptTestables.classifyFailureKind('SyntaxError: bad'), 'syntax');
  assert.equal(__rlmPromptTestables.classifyFailureKind('TypeError: bad'), 'type');
  assert.equal(
    __rlmPromptTestables.classifyFailureKind('RLMSubqueryContractError: bad'),
    'contract',
  );
  assert.equal(__rlmPromptTestables.summarizeRepeatedFailure([]), null);
  assert.deepEqual(
    __rlmPromptTestables.summarizeRepeatedFailure([
      {
        assistantText: '```repl\n1\n```',
        executions: [{
          code: '1',
          finalAnswer: null,
          resultPreview: '1',
          status: 'error',
          stderr: 'TypeError: helper is not a function\nstack',
          stdout: '',
        }],
        step: 1,
      },
    ]),
    {
      count: 1,
      kind: 'type',
      signature: 'TypeError: helper is not a function',
    },
  );
  assert.match(
    __rlmPromptTestables.buildStrategyShiftGuidance({
      count: 1,
      kind: 'contract',
      signature: 'RLMSubqueryContractError: mismatch',
    }),
    /concrete expect contract/u,
  );
  assert.match(
    __rlmPromptTestables.buildStrategyShiftGuidance({
      count: 1,
      kind: 'syntax',
      signature: 'SyntaxError: unexpected token',
    }),
    /smaller valid block/u,
  );
  assert.match(
    __rlmPromptTestables.buildStrategyShiftGuidance({
      count: 1,
      kind: 'other',
      signature: 'OtherError: fail',
    }),
    /Change the execution shape/u,
  );
  assert.match(
    buildRLMTurnInput({
      context: { excerpt: 'token '.repeat(25_000), task: 'Narrow child task' },
      outputCharLimit: 120,
      prompt: 'Child prompt',
      role: 'child',
      transcript: [],
    }),
    /Stay on the delegated target or candidate subset/u,
  );
});

Deno.test('usage summary helpers cover request accounting, merge paths, and cloning', () => {
  const summary = createUsageSummary();
  recordUsage(summary, 'gpt-5-mini', undefined);
  recordUsage(summary, 'gpt-5-mini', {
    cachedInputTokens: 2,
    inputTokens: 10,
    outputTokens: 5,
  });
  recordUsage(summary, 'gpt-5-nano', {
    cachedInputTokens: 1,
    inputTokens: 6,
    outputTokens: 4,
    totalTokens: 25,
  });

  assert.deepEqual(summary, {
    byModel: [
      {
        cachedInputTokens: 2,
        inputTokens: 10,
        model: 'gpt-5-mini',
        outputTokens: 5,
        reportedRequests: 1,
        requests: 2,
        totalTokens: 15,
      },
      {
        cachedInputTokens: 1,
        inputTokens: 6,
        model: 'gpt-5-nano',
        outputTokens: 4,
        reportedRequests: 1,
        requests: 1,
        totalTokens: 25,
      },
    ],
    cachedInputTokens: 3,
    inputTokens: 16,
    outputTokens: 9,
    reportedRequests: 2,
    requests: 3,
    totalTokens: 40,
  });

  const nested = createUsageSummary();
  recordUsage(nested, 'gpt-5-mini', {
    cachedInputTokens: 3,
    inputTokens: 9,
    outputTokens: 6,
    totalTokens: 15,
  });
  recordUsage(nested, 'gpt-5.4-mini', {
    cachedInputTokens: 0,
    inputTokens: 7,
    outputTokens: 2,
    totalTokens: 9,
  });
  mergeUsageSummaries(summary, nested);

  assert.equal(summary.byModel.length, 3);
  assert.equal(summary.byModel.find((entry) => entry.model === 'gpt-5-mini')?.requests, 3);
  assert.equal(summary.byModel.find((entry) => entry.model === 'gpt-5.4-mini')?.totalTokens, 9);

  const cloned = cloneUsageSummary(summary);
  cloned.byModel[0]!.requests += 10;
  assert.notEqual(cloned.byModel[0]!.requests, summary.byModel[0]!.requests);
});

Deno.test('worker runtime helpers cover stale worker detection and pending-query abort selection', () => {
  const sharedWorker = {
    onerror: null,
    onmessage: null,
    onmessageerror: null,
    postMessage() {},
    terminate() {},
  };
  const otherWorker = {
    onerror: null,
    onmessage: null,
    onmessageerror: null,
    postMessage() {},
    terminate() {},
  };

  assert.equal(
    __workerRuntimeTestables.isStalePersistentWorker(
      sharedWorker as never,
      sharedWorker as never,
    ),
    false,
  );
  assert.equal(
    __workerRuntimeTestables.isStalePersistentWorker(
      sharedWorker as never,
      otherWorker as never,
    ),
    true,
  );
  assert.equal(
    __workerRuntimeTestables.shouldAbortPendingQueryController(
      sharedWorker as never,
      sharedWorker as never,
    ),
    true,
  );
  assert.equal(
    __workerRuntimeTestables.shouldAbortPendingQueryController(
      sharedWorker as never,
      otherWorker as never,
    ),
    false,
  );
  assert.equal(
    __workerRuntimeTestables.shouldAbortPendingQueryController(
      null,
      otherWorker as never,
    ),
    true,
  );

  const firstController = new AbortController();
  const secondController = new AbortController();
  const pendingControllers = new Map([
    [1, { controller: firstController, worker: sharedWorker as never }],
    [2, { controller: secondController, worker: otherWorker as never }],
  ]);
  __workerRuntimeTestables.abortPendingQueryControllers(
    pendingControllers,
    sharedWorker as never,
  );
  assert.equal(firstController.signal.aborted, true);
  assert.equal(secondController.signal.aborted, false);
  assert.equal(pendingControllers.has(1), false);
  assert.equal(pendingControllers.has(2), true);
});
