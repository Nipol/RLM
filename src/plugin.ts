/**
 * Plugin and runtime-helper normalization utilities used by the RLM runtime.
 *
 * @module
 *
 * @example
 * ```ts
 * import { resolveRuntimeHelpers } from './plugin.ts';
 * ```
 */
import { assertCodeIsRunnable } from './code_guard.ts';
import type { RLMRuntimeHelper, RLMRuntimeHelperInputKind } from './types.ts';

/**
 * Describes one pluggable bundle of runtime helpers and prompt additions.
 */
export interface RLMPlugin {
  name: string;
  runtimeHelpers?: RLMRuntimeHelper[];
  systemPromptBlocks?: string[];
}

/**
 * Describes one helper-source bundle authored as ordinary named functions.
 */
export interface RuntimeHelperSourceSerializationOptions {
  entrypoint: string;
  functions: Function[];
}

const JAVASCRIPT_IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/u;
const BUILT_IN_RUNTIME_HELPER_NAMES = new Set([
  'FINAL',
  'FINAL_VAR',
  'SHOW_VARS',
  'context',
  'grep',
  'history',
  'llm_query',
  'llm_query_batched',
  'rlm_query',
  'rlm_query_batched',
]);
const RUNTIME_HELPER_INPUT_IDENTIFIER = 'input';
const DEFAULT_RUNTIME_HELPER_INPUT_KINDS: RLMRuntimeHelperInputKind[] = ['text'];
const DEFAULT_RUNTIME_HELPER_RLM_QUERY_MAX_STEPS = Number.POSITIVE_INFINITY;
const DEFAULT_RUNTIME_HELPER_RLM_QUERY_MAX_SUBCALL_DEPTH = 1;
const VALID_RUNTIME_HELPER_INPUT_KINDS = new Set<RLMRuntimeHelperInputKind>([
  'array',
  'object',
  'repl_code',
  'source',
  'text',
]);

function normalizeRuntimeHelperInputKinds(
  inputKinds: RLMRuntimeHelperInputKind[] | undefined,
): RLMRuntimeHelperInputKind[] {
  if (inputKinds !== undefined && inputKinds.length === 0) {
    throw new Error('Runtime helper input kinds must not be empty.');
  }

  const normalized = inputKinds === undefined
    ? [...DEFAULT_RUNTIME_HELPER_INPUT_KINDS]
    : [...inputKinds];
  const seenKinds = new Set<RLMRuntimeHelperInputKind>();
  const deduped: RLMRuntimeHelperInputKind[] = [];

  for (const kind of normalized) {
    if (!VALID_RUNTIME_HELPER_INPUT_KINDS.has(kind)) {
      throw new Error(`Unknown runtime helper input kind: ${String(kind)}`);
    }

    if (seenKinds.has(kind)) {
      continue;
    }

    seenKinds.add(kind);
    deduped.push(kind);
  }
  return deduped;
}

function normalizeRuntimeHelperRLMQueryMaxSubcallDepth(
  value: number | undefined,
): number {
  const normalized = value ?? DEFAULT_RUNTIME_HELPER_RLM_QUERY_MAX_SUBCALL_DEPTH;
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error('Runtime helper rlm_query maxSubcallDepth must be a positive integer.');
  }

  return normalized;
}

function normalizeRuntimeHelperRLMQueryMaxSteps(
  value: number | undefined,
): number {
  const normalized = value ?? DEFAULT_RUNTIME_HELPER_RLM_QUERY_MAX_STEPS;
  if (normalized === Number.POSITIVE_INFINITY) {
    return normalized;
  }

  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error(
      'Runtime helper rlm_query maxSteps must be a positive integer or Number.POSITIVE_INFINITY.',
    );
  }

  return normalized;
}

function describeRuntimeHelperInputKinds(
  inputKinds: ReadonlyArray<RLMRuntimeHelperInputKind>,
): string {
  if (inputKinds.length === 1 && inputKinds[0] === 'object') {
    return 'null/undefined가 아닌 객체';
  }

  if (inputKinds.length === 1 && inputKinds[0] === 'array') {
    return 'null/undefined가 아닌 배열';
  }

  if (inputKinds.length === 1 && inputKinds[0] === 'text') {
    return '비어 있지 않은 텍스트 문자열';
  }

  if (inputKinds.length === 1 && inputKinds[0] === 'source') {
    return '비어 있지 않은 소스 문자열';
  }

  if (inputKinds.length === 1 && inputKinds[0] === 'repl_code') {
    return '비어 있지 않은 REPL 코드 문자열';
  }

  const objectLikeKinds = inputKinds.filter((kind) => kind === 'object' || kind === 'array');
  const stringLikeKinds = inputKinds.filter((kind) =>
    kind === 'text' || kind === 'source' || kind === 'repl_code'
  );
  const parts: string[] = [];

  if (objectLikeKinds.length === 2) {
    parts.push('null/undefined가 아닌 object 또는 array');
  } else if (objectLikeKinds.length === 1) {
    parts.push(
      objectLikeKinds[0] === 'object' ? 'null/undefined가 아닌 객체' : 'null/undefined가 아닌 배열',
    );
  }

  if (stringLikeKinds.length > 0) {
    if (stringLikeKinds.length === 1 && stringLikeKinds[0] === 'text') {
      parts.push('비어 있지 않은 텍스트 문자열');
    } else if (stringLikeKinds.length === 1 && stringLikeKinds[0] === 'source') {
      parts.push('비어 있지 않은 소스 문자열');
    } else if (stringLikeKinds.length === 1 && stringLikeKinds[0] === 'repl_code') {
      parts.push('비어 있지 않은 REPL 코드 문자열');
    } else {
      parts.push(`비어 있지 않은 문자열이며 의미상 ${stringLikeKinds.join(', ')} 중 하나`);
    }
  }

  return parts.join(' 또는 ');
}

/**
 * Validates that one runtime helper name can be injected as a top-level REPL binding.
 */
export function assertRuntimeHelperName(name: string): void {
  if (!JAVASCRIPT_IDENTIFIER_PATTERN.test(name)) {
    throw new Error(
      `Runtime helper name "${name}" must be a valid JavaScript identifier.`,
    );
  }

  if (BUILT_IN_RUNTIME_HELPER_NAMES.has(name)) {
    throw new Error(
      `Runtime helper name "${name}" conflicts with an existing REPL binding.`,
    );
  }
}

/**
 * Validates one runtime-helper definition, including its sandboxed source body.
 */
export function assertRuntimeHelperDefinition(
  helper: RLMRuntimeHelper,
  options: {
    additionalReservedIdentifiers?: string[];
  } = {},
): void {
  assertRuntimeHelperName(helper.name);
  normalizeRuntimeHelperInputKinds(helper.inputKinds);
  normalizeRuntimeHelperRLMQueryMaxSteps(helper.rlmQueryMaxSteps);
  normalizeRuntimeHelperRLMQueryMaxSubcallDepth(helper.rlmQueryMaxSubcallDepth);

  const source = helper.source.trim();
  if (source.length === 0) {
    throw new Error(`Runtime helper "${helper.name}" requires a non-empty source body.`);
  }

  assertCodeIsRunnable(source, {
    additionalReservedIdentifiers: [
      RUNTIME_HELPER_INPUT_IDENTIFIER,
      ...(options.additionalReservedIdentifiers ?? []),
    ],
  });
}

/**
 * Builds one prompt block that documents a runtime helper on the REPL surface.
 */
export function buildRuntimeHelperPromptBlock(helper: RLMRuntimeHelper): string {
  const explicitBlock = helper.promptBlock?.trim();
  if (explicitBlock !== undefined && explicitBlock.length > 0) {
    return explicitBlock;
  }

  const signature = helper.signature?.trim() || `${helper.name}(input)`;
  const inputDescription = describeRuntimeHelperInputKinds(
    normalizeRuntimeHelperInputKinds(helper.inputKinds),
  );
  const lines = [
    `- \`${signature}\``,
    `  - ${helper.description.trim()}`,
    `  - 입력값: ${inputDescription}`,
  ];

  const returns = helper.returns?.trim();
  if (returns !== undefined && returns.length > 0) {
    lines.push(`  - 반환값: ${returns}`);
  }

  for (const example of helper.examples ?? []) {
    const trimmed = example.trim();
    if (trimmed.length === 0) {
      continue;
    }

    lines.push(`  - 예시: \`${trimmed}\``);
  }

  return lines.join('\n');
}

function pushUniquePromptBlocks(target: string[], blocks: string[] | undefined): void {
  for (const block of blocks ?? []) {
    const trimmed = block.trim();
    if (trimmed.length === 0) {
      continue;
    }

    target.push(trimmed);
  }
}

function renderSerializableRuntimeHelperFunction(fn: Function): string {
  const name = fn.name.trim();
  if (name.length === 0 || !JAVASCRIPT_IDENTIFIER_PATTERN.test(name)) {
    throw new Error('Runtime helper source serialization requires named JavaScript functions.');
  }

  const source = fn.toString().trim();
  if (source.length === 0) {
    throw new Error(`Runtime helper function "${name}" must serialize to non-empty source.`);
  }

  if (source.startsWith('async function') || source.startsWith('function')) {
    return `const ${name} = ${source};`;
  }

  return `const ${name} = ${source};`;
}

/**
 * Serializes ordinary named JavaScript functions into one runtime-helper source body.
 */
export function serializeRuntimeHelperSource(
  options: RuntimeHelperSourceSerializationOptions,
): string {
  const seenNames = new Set<string>();
  const renderedFunctions: string[] = [];

  for (const fn of options.functions) {
    const rendered = renderSerializableRuntimeHelperFunction(fn);
    const name = fn.name.trim();

    if (seenNames.has(name)) {
      throw new Error(`Duplicate runtime helper source function name: ${name}`);
    }

    seenNames.add(name);
    renderedFunctions.push(rendered);
  }

  if (!seenNames.has(options.entrypoint)) {
    throw new Error(`Unknown runtime helper entrypoint: ${options.entrypoint}`);
  }

  return [
    ...renderedFunctions,
    `return await ${options.entrypoint}(input);`,
  ].join('\n\n');
}

/**
 * Resolves one deduplicated runtime-helper list from direct helpers and plugins.
 */
export function resolveRuntimeHelpers(options: {
  plugins?: RLMPlugin[];
  runtimeHelpers?: RLMRuntimeHelper[];
}): RLMRuntimeHelper[] {
  const combined = [
    ...(options.runtimeHelpers ?? []),
    ...(options.plugins ?? []).flatMap((plugin) => plugin.runtimeHelpers ?? []),
  ];

  const seenNames = new Set<string>();
  const resolved: RLMRuntimeHelper[] = [];
  for (const helper of combined) {
    assertRuntimeHelperName(helper.name);
    if (seenNames.has(helper.name)) {
      throw new Error(`Duplicate runtime helper name: ${helper.name}`);
    }

    seenNames.add(helper.name);
    resolved.push({
      ...helper,
      inputKinds: normalizeRuntimeHelperInputKinds(helper.inputKinds),
      rlmQueryMaxSteps: normalizeRuntimeHelperRLMQueryMaxSteps(
        helper.rlmQueryMaxSteps,
      ),
      rlmQueryMaxSubcallDepth: normalizeRuntimeHelperRLMQueryMaxSubcallDepth(
        helper.rlmQueryMaxSubcallDepth,
      ),
      source: helper.source.trim(),
    });
  }

  const helperNames = resolved.map((helper) => helper.name);
  for (const helper of resolved) {
    assertRuntimeHelperDefinition(helper, {
      additionalReservedIdentifiers: helperNames,
    });
  }

  return resolved;
}

/**
 * Collects every runtime-helper prompt block contributed by helpers and plugins.
 */
export function resolveRuntimeHelperPromptBlocks(options: {
  plugins?: RLMPlugin[];
  resolvedRuntimeHelpers?: RLMRuntimeHelper[];
  runtimeHelperPromptBlocks?: string[];
  runtimeHelpers?: RLMRuntimeHelper[];
}): string[] {
  const blocks: string[] = [];
  pushUniquePromptBlocks(blocks, options.runtimeHelperPromptBlocks);

  const runtimeHelpers = options.resolvedRuntimeHelpers ?? resolveRuntimeHelpers(options);
  for (const helper of runtimeHelpers) {
    blocks.push(buildRuntimeHelperPromptBlock(helper));
  }

  for (const plugin of options.plugins ?? []) {
    pushUniquePromptBlocks(blocks, plugin.systemPromptBlocks);
  }

  return blocks;
}
