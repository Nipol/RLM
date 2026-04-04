/**
 * Runnable-code validation helpers for the RLM REPL.
 *
 * @module
 *
 * @example
 * ```ts
 * import { assertCodeIsRunnable } from './code_guard.ts';
 * ```
 */
const RESERVED_IDENTIFIERS = [
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
] as const;

const BLOCKED_IMPORT_PATTERNS = [/\bimport\s*\(/, /\bimport\s+/, /\bimport\.meta\b/, /\bexport\s+/];

function buildReservedIdentifierList(
  additionalReservedIdentifiers: string[] = [],
): string[] {
  return [
    ...RESERVED_IDENTIFIERS,
    ...additionalReservedIdentifiers,
  ];
}

/**
 * Replaces the contents of strings and comments with whitespace so structural
 * checks can scan the remaining code without tripping over quoted text.
 */
function redactNonCode(source: string): string {
  let state: 'block-comment' | 'code' | 'double' | 'line-comment' | 'single' | 'template' = 'code';
  let output = '';

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'code') {
      if (char === "'" || char === '"' || char === '`') {
        state = char === "'" ? 'single' : char === '"' ? 'double' : 'template';
        output += ' ';
        continue;
      }

      if (char === '/' && next === '/') {
        state = 'line-comment';
        output += '  ';
        index += 1;
        continue;
      }

      if (char === '/' && next === '*') {
        state = 'block-comment';
        output += '  ';
        index += 1;
        continue;
      }

      output += char;
      continue;
    }

    if (state === 'line-comment') {
      output += char === '\n' ? '\n' : ' ';

      if (char === '\n') {
        state = 'code';
      }

      continue;
    }

    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 1;
        state = 'code';
        continue;
      }

      output += char === '\n' ? '\n' : ' ';
      continue;
    }

    if (char === '\\') {
      output += ' ';

      if (index + 1 < source.length) {
        const escaped = source[index + 1];
        output += escaped === '\n' ? '\n' : ' ';
        index += 1;
      }

      continue;
    }

    const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
    if (char === quote) {
      output += ' ';
      state = 'code';
      continue;
    }

    output += char === '\n' ? '\n' : ' ';
  }

  return output;
}

/**
 * Rejects module-oriented syntax that the sandbox intentionally does not support.
 */
function assertNoModuleSyntax(redactedSource: string): void {
  for (const pattern of BLOCKED_IMPORT_PATTERNS) {
    if (pattern.test(redactedSource)) {
      throw new Error('REPL v1 does not support import/export syntax.');
    }
  }
}

/**
 * Prevents user code from shadowing reserved bindings that the REPL injects.
 */
function assertNoReservedIdentifierOverride(redactedSource: string): void {
  assertNoReservedIdentifierOverrideWithIdentifiers(redactedSource, RESERVED_IDENTIFIERS);
}

function assertNoReservedIdentifierOverrideWithIdentifiers(
  redactedSource: string,
  reservedIdentifiers: ReadonlyArray<string>,
): void {
  const names = reservedIdentifiers.join('|');
  const declarationPattern = new RegExp(`\\b(?:const|let|var|function|class)\\s+(${names})\\b`);
  const assignmentPattern = new RegExp(`(^|[^.\\w$])(${names})\\s*=(?!=|>)`, 'm');

  if (declarationPattern.test(redactedSource) || assignmentPattern.test(redactedSource)) {
    throw new Error('Reserved REPL identifiers cannot be reassigned or redeclared.');
  }
}

/**
 * Heuristically decides whether the last non-empty line can be treated as the
 * cell's display value.
 */
function looksLikeExpression(lastLine: string): boolean {
  const normalized = stripLeadingTrivia(lastLine);
  if (normalized.length === 0) {
    return false;
  }

  if (normalized === '}' || normalized.endsWith('{')) {
    return false;
  }

  if (
    /^(?:async\s+function|await\s+using|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|finally|for|function|if|import|interface|let|return|switch|throw|try|type|using|var|while)\b/
      .test(normalized)
  ) {
    return false;
  }

  return !normalized.endsWith(';');
}

/**
 * Distinguishes a top-level block statement from a bare object-literal expression.
 */
function looksLikeBlockStatement(source: string): boolean {
  if (!source.startsWith('{') || !source.endsWith('}')) {
    return false;
  }

  const inner = source.slice(1, -1).trim();
  if (inner.length === 0) {
    return true;
  }

  return /(?:^|[\n;])\s*(?:const|let|var|function|class)\b/u.test(inner) ||
    inner.includes(';') ||
    inner.includes('\n');
}

/**
 * Finds the start index of a trailing top-level expression, if one exists.
 */
function findTrailingExpressionBoundary(source: string): number | null {
  let state: 'block-comment' | 'code' | 'double' | 'line-comment' | 'single' | 'template' = 'code';
  let braces = 0;
  let brackets = 0;
  let parens = 0;
  let boundary: number | null = null;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'code') {
      if (char === "'" || char === '"' || char === '`') {
        state = char === "'" ? 'single' : char === '"' ? 'double' : 'template';
        continue;
      }

      if (char === '/' && next === '/') {
        state = 'line-comment';
        index += 1;
        continue;
      }

      if (char === '/' && next === '*') {
        state = 'block-comment';
        index += 1;
        continue;
      }

      if (char === '{') {
        braces += 1;
        continue;
      }

      if (char === '}') {
        braces = Math.max(0, braces - 1);
        continue;
      }

      if (char === '(') {
        parens += 1;
        continue;
      }

      if (char === ')') {
        parens = Math.max(0, parens - 1);
        continue;
      }

      if (char === '[') {
        brackets += 1;
        continue;
      }

      if (char === ']') {
        brackets = Math.max(0, brackets - 1);
        continue;
      }

      if (braces === 0 && brackets === 0 && parens === 0 && (char === ';' || char === '\n')) {
        boundary = index + 1;
      }

      continue;
    }

    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'code';
        if (braces === 0 && brackets === 0 && parens === 0) {
          boundary = index + 1;
        }
      }

      continue;
    }

    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        index += 1;
        state = 'code';
      }

      continue;
    }

    if (char === '\\') {
      index += 1;
      continue;
    }

    const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
    if (char === quote) {
      state = 'code';
    }
  }

  return boundary;
}

/**
 * Removes leading whitespace and comments so statement-vs-expression checks see
 * the first real token of the source.
 */
function stripLeadingTrivia(source: string): string {
  let current = source.trimStart();

  while (current.startsWith('//') || current.startsWith('/*')) {
    if (current.startsWith('//')) {
      const newlineIndex = current.indexOf('\n');
      if (newlineIndex === -1) {
        return '';
      }

      current = current.slice(newlineIndex + 1).trimStart();
      continue;
    }

    const endIndex = current.indexOf('*/');
    if (endIndex === -1) {
      return '';
    }

    current = current.slice(endIndex + 2).trimStart();
  }

  return current;
}

/**
 * Validates that a cell can run inside the v1 sandbox before any worker is created.
 */
export function assertCodeIsRunnable(
  source: string,
  options: {
    additionalReservedIdentifiers?: string[];
  } = {},
): void {
  const redactedSource = redactNonCode(source);
  assertNoModuleSyntax(redactedSource);
  assertNoReservedIdentifierOverrideWithIdentifiers(
    redactedSource,
    buildReservedIdentifierList(options.additionalReservedIdentifiers),
  );
}

/**
 * Splits a cell into its statement body and an optional trailing expression so
 * the runtime can preserve REPL-like result previews.
 */
export function splitTrailingExpression(
  source: string,
): { body: string; expression: string | null } {
  const trimmed = source.trimEnd();
  if (trimmed.length === 0) {
    return { body: '', expression: null };
  }

  const boundary = findTrailingExpressionBoundary(trimmed);
  if (boundary !== null) {
    const expression = trimmed.slice(boundary).trim();
    if (expression.length > 0 && looksLikeExpression(expression)) {
      return {
        body: trimmed.slice(0, boundary).trimEnd(),
        expression,
      };
    }
  }

  if (looksLikeExpression(trimmed)) {
    if (looksLikeBlockStatement(trimmed)) {
      return { body: trimmed, expression: null };
    }

    return { body: '', expression: trimmed };
  }

  return { body: trimmed, expression: null };
}

/**
 * Exposes internal code-guard helpers for focused unit tests.
 */
export const __codeGuardTestables = {
  buildReservedIdentifierList,
  assertNoModuleSyntax,
  assertNoReservedIdentifierOverride,
  assertNoReservedIdentifierOverrideWithIdentifiers,
  findTrailingExpressionBoundary,
  looksLikeBlockStatement,
  looksLikeExpression,
  redactNonCode,
  stripLeadingTrivia,
};
