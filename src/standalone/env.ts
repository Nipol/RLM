/**
 * Standalone environment loading helpers for provider credentials and runtime limits.
 *
 * @module
 *
 * @example
 * ```ts
 * import { loadRLMConfig } from './env.ts';
 * ```
 */
import type { OpenAIProviderConfig, OpenAIReasoningEffort } from '../providers/openai_config.ts';
import { isNotFoundError, type ReadTextFileSync } from '../platform.ts';

/**
 * Describes the local `.env` file reader used by the configuration loader.
 *
 * @example
 * ```ts
 * const fileValues = loadDotEnvFile({
 *   path: '.env.local',
 *   readTextFileSync: Deno.readTextFileSync,
 * });
 * ```
 */
export interface DotEnvFileOptions {
  path?: string;
  readTextFileSync?: ReadTextFileSync;
}

/**
 * Describes runtime bounds that keep recursive RLM runs finite and predictable.
 *
 * @example
 * ```ts
 * const runtime: RLMRuntimeConfig = {
 *   cellTimeoutMs: 5_000,
 *   maxSteps: 12,
 *   maxSubcallDepth: 1,
 *   outputCharLimit: 4_000,
 * };
 * ```
 */
export interface RLMRuntimeConfig {
  /**
   * Additional REPL cell budget appended to provider request timeouts in provider-backed
   * convenience paths such as `runOpenAIRLM(...)` and the standalone CLI.
   */
  cellTimeoutMs: number;
  maxSteps: number;
  maxSubcallDepth: number;
  outputCharLimit: number;
}

/**
 * Groups provider credentials with orchestration limits so callers can boot one runner.
 *
 * @example
 * ```ts
 * const config = loadRLMConfig();
 * console.log(config.openAI.rootModel);
 * console.log(config.runtime.maxSteps);
 * ```
 */
export interface RLMConfig {
  openAI: OpenAIProviderConfig;
  runtime: RLMRuntimeConfig;
}

/**
 * Describes the inputs accepted by the configuration loader.
 *
 * @example
 * ```ts
 * const config = loadRLMConfig({
 *   env: {
 *     OPENAI_API_KEY: 'sk-test',
 *     RLM_OPENAI_ROOT_MODEL: 'gpt-5-nano',
 *     RLM_OPENAI_SUB_MODEL: 'gpt-5-mini',
 *   },
 * });
 * ```
 */
export interface LoadRLMConfigOptions extends DotEnvFileOptions {
  env?: Record<string, string | undefined>;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_ENV_PATH = '.env';
const DEFAULT_MAX_OUTPUT_CHARS = 4_000;
const DEFAULT_MAX_STEPS = 12;
const DEFAULT_CELL_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SUBCALL_DEPTH = 3;

/**
 * Removes an inline comment from an unquoted dotenv value.
 */
function stripInlineComment(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '#' && (index === 0 || /\s/u.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }

  return value.trimEnd();
}

/**
 * Decodes one dotenv value after its `KEY=` prefix has already been removed.
 */
function parseDotEnvValue(rawValue: string, lineNumber: number): string {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return '';
  }

  if (trimmed[0] !== '"' && trimmed[0] !== "'") {
    return stripInlineComment(trimmed);
  }

  const quote = trimmed[0];
  let decoded = '';

  for (let index = 1; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === quote) {
      const trailing = trimmed.slice(index + 1).trim();
      if (trailing.length > 0 && !trailing.startsWith('#')) {
        throw new Error(`Invalid .env line ${lineNumber}: unexpected trailing content.`);
      }

      return decoded;
    }

    if (quote === '"' && char === '\\') {
      const escaped = trimmed[index + 1];
      if (escaped === undefined) {
        throw new Error(`Invalid .env line ${lineNumber}: unfinished escape sequence.`);
      }

      decoded += escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped === 't' ? '\t' : escaped;
      index += 1;
      continue;
    }

    decoded += char;
  }

  throw new Error(`Invalid .env line ${lineNumber}: missing closing quote.`);
}

/**
 * Reads one required string value or throws a message that points at the missing key.
 */
function readRequiredEnv(
  values: Record<string, string | undefined>,
  key: string,
): string {
  const value = values[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

/**
 * Reads a positive integer from the merged environment values.
 */
function readPositiveIntegerEnv(
  values: Record<string, string | undefined>,
  key: string,
  defaultValue: number,
): number {
  const raw = values[key]?.trim();
  if (raw === undefined || raw.length === 0) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${key} must be a positive integer.`);
  }

  return parsed;
}

function isOpenAIReasoningEffort(value: string): value is OpenAIReasoningEffort {
  return value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh';
}

function readOptionalOpenAIReasoningEffortEnv(
  values: Record<string, string | undefined>,
  key: string,
): OpenAIReasoningEffort | undefined {
  const raw = values[key]?.trim();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }

  if (!isOpenAIReasoningEffort(raw)) {
    throw new Error(
      `Environment variable ${key} must be one of none, minimal, low, medium, high, xhigh.`,
    );
  }

  return raw;
}

function readRuntimeConfig(
  values: Record<string, string | undefined>,
): RLMRuntimeConfig {
  return {
    cellTimeoutMs: readPositiveIntegerEnv(
      values,
      'RLM_CELL_TIMEOUT_MS',
      DEFAULT_CELL_TIMEOUT_MS,
    ),
    maxSteps: readPositiveIntegerEnv(values, 'RLM_MAX_STEPS', DEFAULT_MAX_STEPS),
    maxSubcallDepth: readPositiveIntegerEnv(
      values,
      'RLM_MAX_SUBCALL_DEPTH',
      DEFAULT_SUBCALL_DEPTH,
    ),
    outputCharLimit: readPositiveIntegerEnv(
      values,
      'RLM_MAX_OUTPUT_CHARS',
      DEFAULT_MAX_OUTPUT_CHARS,
    ),
  };
}

/**
 * Parses dotenv text into plain key/value pairs.
 *
 * @example
 * ```ts
 * const values = parseDotEnv(`
 * OPENAI_API_KEY=sk-test
 * RLM_OPENAI_ROOT_MODEL=gpt-5-nano
 * `);
 * ```
 */
export function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  const normalized = text.startsWith('\uFEFF') ? text.slice(1) : text;

  for (const [index, rawLine] of normalized.split('\n').entries()) {
    const lineNumber = index + 1;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u);
    if (match === null) {
      throw new Error(`Invalid .env line ${lineNumber}: expected KEY=value syntax.`);
    }

    values[match[1]] = parseDotEnvValue(match[2], lineNumber);
  }

  return values;
}

/**
 * Loads one dotenv file and treats a missing file as an empty configuration source.
 *
 * @example
 * ```ts
 * const values = loadDotEnvFile({ path: '.env' });
 * ```
 */
export function loadDotEnvFile(options: DotEnvFileOptions = {}): Record<string, string> {
  const path = options.path ?? DEFAULT_ENV_PATH;
  const readTextFileSync = options.readTextFileSync ??
    ((globalThis as typeof globalThis & {
      Deno?: {
        readTextFileSync?: ReadTextFileSync;
      };
    }).Deno?.readTextFileSync);

  if (readTextFileSync === undefined) {
    return {};
  }

  try {
    return parseDotEnv(readTextFileSync(path));
  } catch (error) {
    if (isNotFoundError(error)) {
      return {};
    }

    throw error;
  }
}

/**
 * Loads only the OpenAI provider portion of the repository configuration.
 *
 * @example
 * ```ts
 * const openAI = loadOpenAIProviderConfig({
 *   env: {
 *     OPENAI_API_KEY: 'sk-test',
 *     RLM_OPENAI_ROOT_MODEL: 'gpt-5-nano',
 *     RLM_OPENAI_SUB_MODEL: 'gpt-5-mini',
 *   },
 * });
 * ```
 */
export function loadOpenAIProviderConfig(
  options: LoadRLMConfigOptions = {},
): OpenAIProviderConfig {
  return loadRLMConfig(options).openAI;
}

/**
 * Loads the provider request timeout used by standalone convenience paths.
 *
 * This timeout is provider-facing and separate from the extra REPL cell budget
 * loaded through `RLM_CELL_TIMEOUT_MS`.
 *
 * @example
 * ```ts
 * const requestTimeoutMs = loadProviderRequestTimeoutMs({
 *   env: {
 *     RLM_REQUEST_TIMEOUT_MS: '45000',
 *   },
 * });
 * ```
 */
export function loadProviderRequestTimeoutMs(
  options: LoadRLMConfigOptions = {},
): number {
  const fileValues = loadDotEnvFile({
    path: options.path,
    readTextFileSync: options.readTextFileSync,
  });
  const values: Record<string, string | undefined> = {
    ...fileValues,
    ...(options.env ?? {}),
  };

  return readPositiveIntegerEnv(
    values,
    'RLM_REQUEST_TIMEOUT_MS',
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
}

/**
 * Loads only runtime orchestration limits from `.env` and explicit overrides.
 *
 * This helper does not require provider credentials, so standalone flows that use
 * non-OpenAI providers can still reuse the same runtime defaults.
 *
 * @example
 * ```ts
 * const runtime = loadRLMRuntimeConfig({
 *   env: {
 *     RLM_CELL_TIMEOUT_MS: '7000',
 *     RLM_MAX_STEPS: '12',
 *   },
 * });
 * ```
 */
export function loadRLMRuntimeConfig(options: LoadRLMConfigOptions = {}): RLMRuntimeConfig {
  const fileValues = loadDotEnvFile({
    path: options.path,
    readTextFileSync: options.readTextFileSync,
  });
  const values: Record<string, string | undefined> = {
    ...fileValues,
    ...(options.env ?? {}),
  };

  return readRuntimeConfig(values);
}

/**
 * Loads the complete repository configuration from `.env` and explicit overrides.
 *
 * @example
 * ```ts
 * const config = loadRLMConfig({
 *   env: {
 *     OPENAI_API_KEY: 'sk-test',
 *     RLM_OPENAI_ROOT_MODEL: 'gpt-5-nano',
 *     RLM_OPENAI_SUB_MODEL: 'gpt-5-mini',
 *   },
 * });
 * ```
 */
export function loadRLMConfig(options: LoadRLMConfigOptions = {}): RLMConfig {
  const fileValues = loadDotEnvFile({
    path: options.path,
    readTextFileSync: options.readTextFileSync,
  });
  const values: Record<string, string | undefined> = {
    ...fileValues,
    ...(options.env ?? {}),
  };

  const openAI: OpenAIProviderConfig = {
    apiKey: readRequiredEnv(values, 'OPENAI_API_KEY'),
    baseUrl: values.RLM_OPENAI_BASE_URL?.trim() || DEFAULT_BASE_URL,
    requestTimeoutMs: readPositiveIntegerEnv(
      values,
      'RLM_REQUEST_TIMEOUT_MS',
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    rootModel: readRequiredEnv(values, 'RLM_OPENAI_ROOT_MODEL'),
    rootReasoningEffort: readOptionalOpenAIReasoningEffortEnv(
      values,
      'RLM_OPENAI_ROOT_REASONING_EFFORT',
    ),
    subModel: readRequiredEnv(values, 'RLM_OPENAI_SUB_MODEL'),
    subReasoningEffort: readOptionalOpenAIReasoningEffortEnv(
      values,
      'RLM_OPENAI_SUB_REASONING_EFFORT',
    ),
  };

  const runtime = readRuntimeConfig(values);

  return { openAI, runtime };
}
