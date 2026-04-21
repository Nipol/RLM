/**
 * Cross-runtime platform helpers for paths, files, dynamic imports, and base64url encoding.
 *
 * @module
 *
 * @example
 * ```ts
 * import { normalizeFilePath } from './platform.ts';
 * ```
 */
/**
 * Describes the directory-creation options used by portable filesystem helpers.
 */
export interface DirectoryCreateOptions {
  recursive?: boolean;
}

/**
 * Describes write options for portable text-file helpers.
 */
export interface WriteTextFileOptions {
  append?: boolean;
}

/**
 * Describes an async text-file reader used by portable helpers.
 */
export type ReadTextFile = (path: string) => Promise<string>;

/**
 * Describes a sync text-file reader used by dotenv loading helpers.
 */
export type ReadTextFileSync = (path: string) => string;

/**
 * Describes an async text-file writer used by portable helpers.
 */
export type WriteTextFile = (
  path: string,
  data: string,
  options?: WriteTextFileOptions,
) => Promise<void>;

/**
 * Describes an async directory-creation helper used by portable helpers.
 */
export type MakeDirectory = (
  path: string,
  options?: DirectoryCreateOptions,
) => Promise<void>;

const dynamicImport = new Function(
  'specifier',
  'return import(specifier);',
) as <Module = unknown>(specifier: string) => Promise<Module>;

function resolvePathSeparator(path: string): '/' | '\\' {
  return /^[A-Za-z]:\\/u.test(path) || path.includes('\\') ? '\\' : '/';
}

function splitDrivePrefix(path: string): { path: string; prefix: string } {
  const normalized = path.replace(/\\/gu, '/');
  const driveMatch = normalized.match(/^[A-Za-z]:/u);
  if (driveMatch !== null) {
    return {
      path: normalized.slice(driveMatch[0].length),
      prefix: driveMatch[0],
    };
  }

  if (normalized.startsWith('//')) {
    return {
      path: normalized.slice(2),
      prefix: '//',
    };
  }

  if (normalized.startsWith('/')) {
    return {
      path: normalized.slice(1),
      prefix: '/',
    };
  }

  return {
    path: normalized,
    prefix: '',
  };
}

/**
 * Returns whether a path is already absolute on POSIX, Windows drive, or UNC forms.
 */
export function isAbsolutePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(path);
}

/**
 * Normalizes a potentially relative or platform-specific file path.
 */
export function normalizeFilePath(path: string): string {
  if (path.length === 0) {
    return '.';
  }

  const separator = resolvePathSeparator(path);
  const { path: normalizedPath, prefix } = splitDrivePrefix(path);
  const stack: string[] = [];

  for (const part of normalizedPath.split('/')) {
    if (part.length === 0 || part === '.') {
      continue;
    }

    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
        continue;
      }

      if (prefix.length === 0) {
        stack.push(part);
      }
      continue;
    }

    stack.push(part);
  }

  const joined = stack.join(separator);
  if (prefix === '/') {
    return `${separator}${joined}`;
  }

  if (prefix === '//') {
    return `${separator}${separator}${joined}`;
  }

  if (prefix.length > 0) {
    return joined.length > 0 ? `${prefix}${separator}${joined}` : `${prefix}${separator}`;
  }

  return joined.length > 0 ? joined : '.';
}

/**
 * Joins path parts using the leading path style and normalizes the result.
 */
export function joinFilePath(...parts: string[]): string {
  const filtered = parts.filter((part) => part.length > 0);
  if (filtered.length === 0) {
    return '.';
  }

  const separator = resolvePathSeparator(filtered[0]);
  return normalizeFilePath(filtered.join(separator));
}

/**
 * Returns the parent directory portion of a normalized file path.
 */
export function dirnameFilePath(path: string): string {
  const normalized = normalizeFilePath(path);
  const separator = resolvePathSeparator(normalized);

  if (normalized === '.' || normalized === separator) {
    return normalized;
  }

  const driveMatch = normalized.match(/^[A-Za-z]:[\\/]$/u);
  if (driveMatch !== null) {
    return normalized;
  }

  const index = normalized.lastIndexOf(separator);
  if (index < 0) {
    return '.';
  }

  if (index === 0) {
    return separator;
  }

  return normalized.slice(0, index);
}

/**
 * Returns the file extension portion of a normalized file path.
 */
export function extnameFilePath(path: string): string {
  const normalized = normalizeFilePath(path);
  const separator = resolvePathSeparator(normalized);
  const lastSeparator = normalized.lastIndexOf(separator);
  const basename = lastSeparator < 0 ? normalized : normalized.slice(lastSeparator + 1);
  const lastDot = basename.lastIndexOf('.');

  if (lastDot <= 0) {
    return '';
  }

  return basename.slice(lastDot);
}

/**
 * Resolves a possibly relative file path against a working directory.
 */
export function resolveFilePath(cwd: string, path: string): string {
  return isAbsolutePath(path) ? normalizeFilePath(path) : joinFilePath(cwd, path);
}

/**
 * Resolves the current working directory across Deno, Node, and fallback runtimes.
 */
export function resolveCurrentWorkingDirectory(
  scope: typeof globalThis = globalThis,
): string {
  const deno = scope as typeof globalThis & {
    Deno?: {
      cwd?: () => string;
    };
  };
  if (typeof deno.Deno?.cwd === 'function') {
    return deno.Deno.cwd();
  }

  const processScope = scope as typeof globalThis & {
    process?: {
      cwd?: () => string;
    };
  };
  if (typeof processScope.process?.cwd === 'function') {
    return processScope.process.cwd();
  }

  return '.';
}

/**
 * Detects common not-found filesystem errors across Deno and Node runtimes.
 */
export function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const record = error as Error & { code?: string };
  return error.name === 'NotFound' || record.code === 'ENOENT';
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  throw new Error('No base64 encoder is available in this runtime.');
}

function decodeBase64(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  throw new Error('No base64 decoder is available in this runtime.');
}

/**
 * Encodes raw bytes using URL-safe base64 without padding.
 */
export function encodeBase64Url(input: Uint8Array): string {
  return encodeBase64(input)
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
}

/**
 * Decodes a URL-safe base64 string into text.
 */
export function decodeBase64Url(input: string): string {
  const padded = input
    .replace(/-/gu, '+')
    .replace(/_/gu, '/')
    .padEnd(Math.ceil(input.length / 4) * 4, '=');
  return new TextDecoder().decode(decodeBase64(padded));
}

/**
 * Performs a runtime dynamic import without triggering static bundler resolution.
 */
export function importModule<Module = unknown>(specifier: string): Promise<Module> {
  return dynamicImport<Module>(specifier);
}

/**
 * Dynamically imports a Node builtin module by name.
 */
export function importNodeBuiltin<Module = unknown>(name: string): Promise<Module> {
  return dynamicImport<Module>(`node:${name}`);
}

/**
 * Exposes internal platform helpers for focused tests.
 */
export const __platformTestables = {
  dirnameFilePath,
  importModule,
  importNodeBuiltin,
  normalizeFilePath,
};
