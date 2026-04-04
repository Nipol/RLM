import assert from 'node:assert/strict';

import { createAoTPlugin } from '../plugin/aot/mod.ts';
import { normalizeInput } from '../plugin/aot/runtime_shared.ts';
import {
  assertRuntimeHelperDefinition,
  assertRuntimeHelperName,
  buildRuntimeHelperPromptBlock,
  resolveRuntimeHelperPromptBlocks,
  resolveRuntimeHelpers,
  serializeRuntimeHelperSource,
} from '../src/plugin.ts';

Deno.test('runtime helper definitions reject module syntax inside helper source', () => {
  assert.throws(
    () =>
      assertRuntimeHelperDefinition({
        description: '모듈 문법을 쓰면 안 됩니다.',
        name: 'bad_helper',
        source: 'import "https://example.com/mod.js";\n"PONG";',
      }),
    /REPL v1 does not support import\/export syntax\./u,
  );
});

Deno.test('runtime helper definitions treat the input binding as reserved', () => {
  assert.throws(
    () =>
      assertRuntimeHelperDefinition({
        description: 'input은 재할당할 수 없습니다.',
        name: 'bad_input',
        source: 'input = "mutated";\ninput;',
      }),
    /Reserved REPL identifiers cannot be reassigned or redeclared\./u,
  );
});

Deno.test('resolveRuntimeHelpers validates plugin helpers and preserves helper prompt docs', () => {
  const [helper] = resolveRuntimeHelpers({
    plugins: [{
      name: 'ping',
      runtimeHelpers: [{
        description: 'PING을 입력으로 받으면 PONG을 반환합니다.',
        examples: ['await ping_pong("PING")'],
        inputKinds: ['text'],
        name: 'ping_pong',
        returns: '`"PONG"`',
        signature: 'ping_pong(text)',
        source: 'input === "PING" ? "PONG" : "UNKNOWN"',
      }],
    }],
  });

  assert.equal(helper?.name, 'ping_pong');
  assert.deepEqual(helper?.inputKinds, ['text']);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /`ping_pong\(text\)`/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /입력값: 비어 있지 않은 텍스트 문자열/u);
  assert.match(
    buildRuntimeHelperPromptBlock(helper!),
    /PING을 입력으로 받으면 PONG을 반환합니다\./u,
  );
});

Deno.test('runtime helper prompt docs describe object, array, and mixed object/string inputs when declared', () => {
  const [helper, objectOnly, arrayOnly, objectAndSource, objectAndText, objectAndCode, helperWithBlankExample] = resolveRuntimeHelpers({
    runtimeHelpers: [{
      description: '객체 또는 배열 입력을 분석합니다.',
      inputKinds: ['object', 'array'],
      name: 'inspect_payload',
      source: 'Array.isArray(input) ? input.length : Object.keys(input).length',
    }, {
      description: '객체만 받습니다.',
      inputKinds: ['object'],
      name: 'object_only',
      source: 'Object.keys(input).length',
    }, {
      description: '배열만 받습니다.',
      inputKinds: ['array'],
      name: 'array_only',
      source: 'input.length',
    }, {
      description: '객체 또는 소스 문자열을 받습니다.',
      inputKinds: ['object', 'source'],
      name: 'object_or_source',
      source: 'typeof input === "string" ? input : Object.keys(input).join(",")',
    }, {
      description: '객체 또는 텍스트를 받습니다.',
      examples: ['   ', 'await object_or_text({ id: 1 })'],
      inputKinds: ['object', 'text'],
      name: 'object_or_text',
      source: 'typeof input === "string" ? input : String(input.id ?? "")',
    }, {
      description: '객체 또는 REPL 코드를 받습니다.',
      inputKinds: ['object', 'repl_code'],
      name: 'object_or_code',
      source: 'typeof input === "string" ? input : Object.keys(input).length',
    }, {
      description: '빈 예시는 무시됩니다.',
      examples: ['  ', 'await helper_with_blank_example("x")'],
      inputKinds: ['text'],
      name: 'helper_with_blank_example',
      source: 'input',
    }],
  });

  assert.deepEqual(helper?.inputKinds, ['object', 'array']);
  assert.match(
    buildRuntimeHelperPromptBlock(helper!),
    /입력값: null\/undefined가 아닌 object 또는 array/u,
  );
  assert.match(buildRuntimeHelperPromptBlock(objectOnly!), /입력값: null\/undefined가 아닌 객체/u);
  assert.match(buildRuntimeHelperPromptBlock(arrayOnly!), /입력값: null\/undefined가 아닌 배열/u);
  assert.match(
    buildRuntimeHelperPromptBlock(objectAndSource!),
    /입력값: null\/undefined가 아닌 객체 또는 비어 있지 않은 소스 문자열/u,
  );
  assert.match(
    buildRuntimeHelperPromptBlock(objectAndText!),
    /입력값: null\/undefined가 아닌 객체 또는 비어 있지 않은 텍스트 문자열/u,
  );
  assert.match(
    buildRuntimeHelperPromptBlock(objectAndCode!),
    /입력값: null\/undefined가 아닌 객체 또는 비어 있지 않은 REPL 코드 문자열/u,
  );
  assert.equal(
    buildRuntimeHelperPromptBlock(helperWithBlankExample!).match(/예시:/gu)?.length ?? 0,
    1,
  );
});

Deno.test('runtime helper prompt docs cover source, repl_code, and mixed string-like inputs', () => {
  const [sourceHelper, replCodeHelper, mixedHelper] = resolveRuntimeHelpers({
    runtimeHelpers: [{
      description: '소스 문자열만 받습니다.',
      inputKinds: ['source'],
      name: 'source_only',
      source: 'input',
    }, {
      description: 'REPL 코드 문자열만 받습니다.',
      inputKinds: ['repl_code'],
      name: 'code_only',
      source: 'input',
    }, {
      description: '여러 문자열 의미를 허용합니다.',
      inputKinds: ['text', 'source', 'repl_code', 'text'],
      name: 'mixed_strings',
      source: 'input',
    }],
  });

  assert.match(buildRuntimeHelperPromptBlock(sourceHelper!), /비어 있지 않은 소스 문자열/u);
  assert.match(buildRuntimeHelperPromptBlock(replCodeHelper!), /비어 있지 않은 REPL 코드 문자열/u);
  assert.match(
    buildRuntimeHelperPromptBlock(mixedHelper!),
    /비어 있지 않은 문자열이며 의미상 text, source, repl_code 중 하나/u,
  );
  assert.deepEqual(mixedHelper?.inputKinds, ['text', 'source', 'repl_code']);
});

Deno.test('runtime helper prompt docs prefer custom prompt blocks and ignore blank examples or prompt blocks', () => {
  const [helper] = resolveRuntimeHelpers({
    plugins: [{
      name: 'custom-docs',
      runtimeHelpers: [{
        description: '커스텀 프롬프트 문구를 사용합니다.',
        examples: ['  ', 'await custom_doc("PING")'],
        name: 'custom_doc',
        promptBlock: '  - `custom_doc(input)`\n  - 직접 작성한 문구입니다.  ',
        source: 'input',
      }],
      systemPromptBlocks: ['  ', '추가 plugin 문구'],
    }],
  });

  assert.equal(buildRuntimeHelperPromptBlock(helper!), '- `custom_doc(input)`\n  - 직접 작성한 문구입니다.');
  assert.deepEqual(
    resolveRuntimeHelperPromptBlocks({
      plugins: [{
        name: 'custom-docs',
        systemPromptBlocks: ['  ', '추가 plugin 문구'],
      }],
      resolvedRuntimeHelpers: [helper!],
      runtimeHelperPromptBlocks: ['  ', '추가 runtime helper 문구'],
    }),
    [
      '추가 runtime helper 문구',
      '- `custom_doc(input)`\n  - 직접 작성한 문구입니다.',
      '추가 plugin 문구',
    ],
  );
});

Deno.test('resolveRuntimeHelpers defaults helper rlm_query depth to 1 and preserves explicit overrides', () => {
  const [defaultHelper, customHelper] = resolveRuntimeHelpers({
    runtimeHelpers: [{
      description: '기본 depth를 사용합니다.',
      name: 'default_depth_helper',
      source: 'input',
    }, {
      description: '명시한 depth를 사용합니다.',
      name: 'custom_depth_helper',
      rlmQueryMaxSubcallDepth: 2,
      source: 'input',
    }],
  });

  assert.equal(defaultHelper?.rlmQueryMaxSubcallDepth, 1);
  assert.equal(customHelper?.rlmQueryMaxSubcallDepth, 2);
});

Deno.test('resolveRuntimeHelpers leaves helper rlm_query maxSteps unbounded by default and preserves explicit overrides', () => {
  const [defaultHelper, customHelper] = resolveRuntimeHelpers({
    runtimeHelpers: [{
      description: '기본 nested step budget은 무제한입니다.',
      name: 'default_steps_helper',
      source: 'input',
    }, {
      description: '명시한 nested step budget을 사용합니다.',
      name: 'custom_steps_helper',
      rlmQueryMaxSteps: 6,
      source: 'input',
    }],
  });

  assert.equal(defaultHelper?.rlmQueryMaxSteps, Number.POSITIVE_INFINITY);
  assert.equal(customHelper?.rlmQueryMaxSteps, 6);
});

Deno.test('runtime helper definitions reject non-positive rlm_query depth defaults', () => {
  assert.throws(
    () =>
      assertRuntimeHelperDefinition({
        description: '잘못된 depth를 사용합니다.',
        name: 'bad_depth_helper',
        rlmQueryMaxSubcallDepth: 0,
        source: 'input',
      }),
    /positive integer/u,
  );
});

Deno.test('runtime helper definitions reject non-positive finite rlm_query maxSteps defaults', () => {
  assert.throws(
    () =>
      assertRuntimeHelperDefinition({
        description: '잘못된 step budget을 사용합니다.',
        name: 'bad_steps_helper',
        rlmQueryMaxSteps: 0,
        source: 'input',
      }),
    /positive integer/u,
  );
});

Deno.test('runtime helper names reject invalid identifiers and built-in helper collisions', () => {
  assert.throws(() => assertRuntimeHelperName('123bad'), /valid JavaScript identifier/u);
  assert.throws(() => assertRuntimeHelperName('llm_query'), /conflicts with an existing REPL binding/u);
});

Deno.test('runtime helper resolution rejects unknown input kinds, duplicate helper names, and empty sources', () => {
  assert.throws(
    () =>
      resolveRuntimeHelpers({
        runtimeHelpers: [{
          description: '비어 있는 입력 kind 목록입니다.',
          inputKinds: [],
          name: 'empty_kinds',
          source: 'input',
        }],
      }),
    /must not be empty/u,
  );

  assert.throws(
    () =>
      resolveRuntimeHelpers({
        runtimeHelpers: [{
          description: '알 수 없는 입력 kind입니다.',
          inputKinds: ['bogus' as never],
          name: 'bad_kind',
          source: 'input',
        }],
      }),
    /Unknown runtime helper input kind/u,
  );

  assert.throws(
    () =>
      resolveRuntimeHelpers({
        runtimeHelpers: [{
          description: '첫 helper입니다.',
          name: 'duplicate_helper',
          source: 'input',
        }, {
          description: '중복 helper입니다.',
          name: 'duplicate_helper',
          source: 'input',
        }],
      }),
    /Duplicate runtime helper name/u,
  );

  assert.throws(
    () =>
      assertRuntimeHelperDefinition({
        description: '빈 source는 허용되지 않습니다.',
        name: 'empty_source',
        source: '   ',
      }),
    /requires a non-empty source body/u,
  );
});

Deno.test('serializeRuntimeHelperSource turns named functions into runnable helper source', () => {
  function normalizeText(value: unknown) {
    return String(value).trim();
  }

  async function runSerializedHelper(input: unknown) {
    return normalizeText(input).toUpperCase();
  }

  const source = serializeRuntimeHelperSource({
    entrypoint: 'runSerializedHelper',
    functions: [normalizeText, runSerializedHelper],
  });

  assert.match(source, /const normalizeText = function normalizeText/u);
  assert.match(source, /const runSerializedHelper = async function runSerializedHelper/u);
  assert.match(source, /return await runSerializedHelper\(input\);/u);

  assert.doesNotThrow(() =>
    assertRuntimeHelperDefinition({
      description: '직렬화된 helper source입니다.',
      name: 'serialized_helper',
      source,
    })
  );
});

Deno.test('serializeRuntimeHelperSource rejects unnamed or missing entrypoint functions', () => {
  function namedHelper(input: unknown) {
    return input;
  }

  assert.throws(
    () =>
      serializeRuntimeHelperSource({
        entrypoint: 'namedHelper',
        functions: [function () {
          return null;
        }, namedHelper],
      }),
    /named JavaScript functions/u,
  );

  assert.throws(
    () =>
      serializeRuntimeHelperSource({
        entrypoint: 'missingEntry',
        functions: [namedHelper],
      }),
    /Unknown runtime helper entrypoint/u,
  );
});

Deno.test('serializeRuntimeHelperSource covers duplicate names and non-function-style serialization', () => {
  const arrowHelper = (input: unknown) => String(input).toUpperCase();
  const duplicateNamed = function duplicateNamed(input: unknown) {
    return input;
  };
  const duplicateNamedToo = function duplicateNamed(input: unknown) {
    return input;
  };

  const source = serializeRuntimeHelperSource({
    entrypoint: 'arrowHelper',
    functions: [arrowHelper],
  });

  assert.match(source, /const arrowHelper = \(input\)\s*=>\s*String\(input\)\.toUpperCase\(\);/u);

  assert.throws(
    () =>
      serializeRuntimeHelperSource({
        entrypoint: 'duplicateNamed',
        functions: [duplicateNamed, duplicateNamedToo],
      }),
    /Duplicate runtime helper source function name/u,
  );

  function blankSource(input: unknown) {
    return input;
  }
  Object.defineProperty(blankSource, 'toString', {
    value: () => '   ',
  });

  assert.throws(
    () =>
      serializeRuntimeHelperSource({
        entrypoint: 'blankSource',
        functions: [blankSource],
      }),
    /must serialize to non-empty source/u,
  );
});

Deno.test('AoT input normalization clamps costly search settings to bounded ceilings', () => {
  const normalized = normalizeInput({
    beamWidth: 99,
    maxIndependentSubquestions: 99,
    maxIterations: 99,
    maxRefinements: 99,
    question: '질문',
    transitionSamples: 99,
  });

  assert.equal(normalized.beamWidth, 2);
  assert.equal(normalized.maxIndependentSubquestions, 4);
  assert.equal(normalized.maxIterations, 4);
  assert.equal(normalized.maxRefinements, 2);
  assert.equal(normalized.transitionSamples, 3);
});

Deno.test('AoT plugin exposes a helper that accepts text or object input', () => {
  const plugin = createAoTPlugin();
  const [helper] = resolveRuntimeHelpers({
    plugins: [plugin],
  });

  assert.equal(helper?.name, 'aot');
  assert.deepEqual(helper?.inputKinds, ['text', 'object']);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /`aot\(input\)`/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /AoT/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /dependency DAG로 분해/u);
  assert.match(
    buildRuntimeHelperPromptBlock(helper!),
    /`transitionSamples: 1`, `beamWidth: 1`, `maxRefinements: 0`/u,
  );
  assert.match(buildRuntimeHelperPromptBlock(helper!), /judge/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /reflective refinement/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /옵션 기준/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /maxIterations/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /transitionSamples/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /beamWidth/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /maxRefinements/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /beamWidth × transitionSamples/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /llm_query/u);
  assert.doesNotMatch(buildRuntimeHelperPromptBlock(helper!), /rlm_query/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /maxIterations<=4/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /transitionSamples<=3/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /beamWidth<=2/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /maxRefinements<=2/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /\{maxIterations\}/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /\{transitionSamples\}/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /\{beamWidth\}/u);
  assert.match(buildRuntimeHelperPromptBlock(helper!), /\{maxRefinements\}/u);
  assert.match(helper?.source ?? '', /return await runAOTHelper\(input\);/u);
  assert.match(
    buildRuntimeHelperPromptBlock(helper!),
    /직접적인 답이 없더라도.*풍부한 답변/u,
  );
  assert.match(helper?.examples?.[1] ?? '', /\{maxIterations\}/u);
  assert.match(helper?.examples?.[1] ?? '', /\{maxRefinements\}/u);
  assert.doesNotMatch(helper?.examples?.[1] ?? '', /\{transitionSamples\}/u);
  assert.match(helper?.examples?.[2] ?? '', /\{transitionSamples\}/u);
  assert.match(helper?.examples?.[2] ?? '', /\{beamWidth\}/u);
  assert.match(helper?.examples?.[2] ?? '', /\{maxRefinements\}/u);
});
