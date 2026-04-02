import assert from 'node:assert/strict';
import { join, relative } from 'node:path';

const REPO_ROOT = Deno.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');
const PROMPTS_ROOT = join(REPO_ROOT, 'prompts');
const ENTRYPOINTS = [
  'mod.ts',
  'core.ts',
  'openai.ts',
  'ollama.ts',
  'codex-oauth.ts',
] as const;

const DECLARATION_EXPORT_PATTERN =
  /^export\s+(?:async\s+)?(?:class|function|interface|type|const|enum)\s+[A-Za-z0-9_$]+/gmu;
const MODULE_DOC_PATTERN = /^\s*\/\*\*[\s\S]*?@module[\s\S]*?@example[\s\S]*?\*\/\s*/u;

async function collectPublishedTypeScriptFiles(): Promise<string[]> {
  const files = [...ENTRYPOINTS].map((path) => join(REPO_ROOT, path));

  for await (const entry of Deno.readDir(SRC_ROOT)) {
    void entry;
  }

  const visit = async (root: string) => {
    for await (const entry of Deno.readDir(root)) {
      const nextPath = join(root, entry.name);
      if (entry.isDirectory) {
        await visit(nextPath);
        continue;
      }

      if (!entry.isFile || !nextPath.endsWith('.ts')) {
        continue;
      }

      files.push(nextPath);
    }
  };

  await visit(SRC_ROOT);
  await visit(PROMPTS_ROOT);

  files.sort();
  return files;
}

function findPrecedingJsdoc(source: string, declarationIndex: number): string | null {
  const precedingSource = source.slice(0, declarationIndex);
  const matches = [...precedingSource.matchAll(/\/\*\*[\s\S]*?\*\//gu)];
  if (matches.length === 0) {
    return null;
  }

  const lastMatch = matches.at(-1);
  if (lastMatch === undefined) {
    return null;
  }

  const trailingWhitespace = precedingSource.slice((lastMatch.index ?? 0) + lastMatch[0].length);
  if (trailingWhitespace.trim().length > 0) {
    return null;
  }

  return lastMatch[0];
}

Deno.test('published TypeScript files include module docs and standalone symbol docs on declarations', async () => {
  const files = await collectPublishedTypeScriptFiles();
  const failures: string[] = [];

  for (const filePath of files) {
    const source = await Deno.readTextFile(filePath);
    const label = relative(REPO_ROOT, filePath) || filePath;

    if (!MODULE_DOC_PATTERN.test(source)) {
      failures.push(`${label}: missing @module documentation.`);
    }

    for (const match of source.matchAll(DECLARATION_EXPORT_PATTERN)) {
      const declaration = match[0];
      const declarationIndex = match.index ?? 0;
      const jsdoc = findPrecedingJsdoc(source, declarationIndex);
      if (jsdoc === null) {
        failures.push(`${label}: missing JSDoc for "${declaration}".`);
        continue;
      }

      const plainTextLines = jsdoc
        .replace(/^\/\*\*|\*\/$/gu, '')
        .split('\n')
        .map((line) => line.replace(/^\s*\*\s?/u, '').trim())
        .filter((line) => line.length > 0 && !line.startsWith('@'));

      if (plainTextLines.length === 0) {
        failures.push(`${label}: symbol doc for "${declaration}" is missing descriptive text.`);
      }
    }
  }

  assert.deepEqual(failures, []);
});
