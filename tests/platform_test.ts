import assert from 'node:assert/strict';

import {
  __platformTestables,
  decodeBase64Url,
  encodeBase64Url,
  isAbsolutePath,
  isNotFoundError,
  joinFilePath,
  resolveCurrentWorkingDirectory,
  resolveFilePath,
} from '../src/platform.ts';

Deno.test('platform path helpers normalize relative, posix, and windows-like paths', () => {
  assert.equal(isAbsolutePath('/workspace/book.md'), true);
  assert.equal(isAbsolutePath('C:\\workspace\\book.md'), true);
  assert.equal(isAbsolutePath('book.md'), false);

  assert.equal(
    __platformTestables.normalizeFilePath('/workspace/./logs/../book.md'),
    '/workspace/book.md',
  );
  assert.equal(
    __platformTestables.normalizeFilePath('C:\\workspace\\logs\\..\\book.md'),
    'C:\\workspace\\book.md',
  );
  assert.equal(joinFilePath('/workspace', 'logs', '..', 'book.md'), '/workspace/book.md');
  assert.equal(
    resolveFilePath('/workspace/rlm', 'fixtures/book.txt'),
    '/workspace/rlm/fixtures/book.txt',
  );
  assert.equal(
    resolveFilePath('C:\\workspace\\rlm', 'fixtures\\book.txt'),
    'C:\\workspace\\rlm\\fixtures\\book.txt',
  );
  assert.equal(
    __platformTestables.dirnameFilePath('/workspace/logs/session.jsonl'),
    '/workspace/logs',
  );
  assert.equal(
    __platformTestables.dirnameFilePath('C:\\workspace\\logs\\session.jsonl'),
    'C:\\workspace\\logs',
  );
});

Deno.test('platform helpers resolve cwd, not-found errors, and base64url encoding portably', () => {
  assert.equal(
    resolveCurrentWorkingDirectory(
      {
        Deno: { cwd: () => '/deno-workspace' },
      } as typeof globalThis,
    ),
    '/deno-workspace',
  );
  assert.equal(
    resolveCurrentWorkingDirectory(
      {
        process: { cwd: () => '/node-workspace' },
      } as typeof globalThis,
    ),
    '/node-workspace',
  );
  assert.equal(resolveCurrentWorkingDirectory({} as typeof globalThis), '.');

  assert.equal(isNotFoundError(new Error('missing')), false);
  assert.equal(
    isNotFoundError(Object.assign(new Error('missing'), { code: 'ENOENT' })),
    true,
  );
  assert.equal(
    isNotFoundError(Object.assign(new Error('missing'), { name: 'NotFound' })),
    true,
  );

  const encoded = encodeBase64Url(new TextEncoder().encode('hello?world'));
  assert.equal(encoded.length > 0, true);
  assert.equal(decodeBase64Url(encoded), 'hello?world');
});

Deno.test('platform import helper can load a dynamic module specifier without static node resolution', async () => {
  const module = await __platformTestables.importModule<{ value: number }>(
    'data:text/javascript,export const value = 7;',
  );

  assert.equal(module.value, 7);
});
