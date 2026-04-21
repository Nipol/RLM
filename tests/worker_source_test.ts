import assert from 'node:assert/strict';

import {
  buildBlobWorkerSourceHandle,
  buildDataWorkerSourceHandle,
  buildDataWorkerSourceUrl,
  buildPreferredWorkerSourceHandle,
  supportsBlobBackedWorkerSource,
} from '../src/worker_source.ts';

Deno.test('worker source helpers detect blob-backed worker support conservatively', () => {
  assert.equal(supportsBlobBackedWorkerSource({}), false);
  assert.equal(
    supportsBlobBackedWorkerSource({
      Blob,
      URL: {},
    }),
    false,
  );
  assert.equal(
    supportsBlobBackedWorkerSource({
      Blob,
      URL: {
        createObjectURL: (_blob: Blob) => 'blob:test',
        revokeObjectURL: (_url: string) => undefined,
      },
    }),
    true,
  );
});

Deno.test('worker source helpers can build and revoke data-backed handles', () => {
  const source = 'globalThis.postMessage("pong");';
  const handle = buildDataWorkerSourceHandle(source);

  assert.equal(handle.kind, 'data_url');
  assert.equal(handle.url, buildDataWorkerSourceUrl(source));
  assert.doesNotThrow(() => handle.revoke());
});

Deno.test('worker source helpers can build and revoke blob-backed handles', () => {
  const revoked: string[] = [];
  let seenBlob: unknown = null;
  const handle = buildBlobWorkerSourceHandle('postMessage("pong");', {
    Blob,
    URL: {
      createObjectURL: (blob: Blob) => {
        seenBlob = blob;
        return 'blob:worker-source';
      },
      revokeObjectURL: (url: string) => {
        revoked.push(url);
      },
    },
  });

  assert.equal(handle.kind, 'blob_url');
  assert.equal(handle.url, 'blob:worker-source');
  assert.ok(seenBlob instanceof Blob);
  handle.revoke();
  assert.deepEqual(revoked, ['blob:worker-source']);
});

Deno.test('worker source helpers reject blob handles when object URLs are unavailable', () => {
  assert.throws(
    () => buildBlobWorkerSourceHandle('postMessage("pong");', {}),
    /Blob-backed worker URLs are not supported/u,
  );
});

Deno.test('worker source helpers prefer blob URLs when the runtime supports them and fall back otherwise', () => {
  const supported = buildPreferredWorkerSourceHandle('postMessage("pong");', {
    Blob,
    URL: {
      createObjectURL: (_blob: Blob) => 'blob:preferred',
      revokeObjectURL: (_url: string) => undefined,
    },
  });
  assert.equal(supported.kind, 'blob_url');
  assert.equal(supported.url, 'blob:preferred');

  const fallback = buildPreferredWorkerSourceHandle('postMessage("pong");', {});
  assert.equal(fallback.kind, 'data_url');
  assert.equal(
    fallback.url,
    'data:text/javascript;charset=utf-8,postMessage(%22pong%22)%3B',
  );
});
