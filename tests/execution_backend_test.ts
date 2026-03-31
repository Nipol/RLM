import assert from 'node:assert/strict';

import { __executionBackendTestables, WorkerExecutionBackend } from '../src/execution_backend.ts';

Deno.test('execution backend helpers choose standard or Deno worker options by runtime capability', () => {
  assert.deepEqual(__executionBackendTestables.createWorkerOptions(false), {
    type: 'module',
  });
  assert.deepEqual(__executionBackendTestables.createWorkerOptions(true), {
    deno: { permissions: 'none' },
    type: 'module',
  });

  assert.equal(
    __executionBackendTestables.runtimeSupportsDenoWorkerPermissions({} as typeof globalThis),
    false,
  );
  assert.equal(
    __executionBackendTestables.runtimeSupportsDenoWorkerPermissions(
      {
        Deno: { version: { deno: '2.2.0' } },
      } as typeof globalThis,
    ),
    true,
  );
});

Deno.test('execution backend helpers can decode generated worker URLs and wrap node worker source', () => {
  const source = 'globalThis.postMessage("pong");';
  const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;

  assert.equal(__executionBackendTestables.decodeWorkerDataUrl(url), source);

  const nodeSource = __executionBackendTestables.buildNodeWorkerSource(source);
  assert(nodeSource.includes("import { parentPort } from 'node:worker_threads';"));
  assert(nodeSource.includes('globalThis.postMessage = (value) =>'));
  assert(nodeSource.includes(source));
});

Deno.test('execution backend helpers adapt node worker thread events into worker-like callbacks', () => {
  let messageListener: ((value: unknown) => void) | undefined;
  let errorListener: ((error: Error) => void) | undefined;
  let messageErrorListener: ((error: unknown) => void) | undefined;
  const posted: unknown[] = [];
  let terminated = false;

  const adapted = __executionBackendTestables.adaptNodeWorkerThread({
    on(event, listener) {
      if (event === 'message') {
        messageListener = listener as (value: unknown) => void;
      } else if (event === 'error') {
        errorListener = listener as (error: Error) => void;
      } else {
        messageErrorListener = listener as (error: unknown) => void;
      }

      return undefined;
    },
    postMessage(message) {
      posted.push(message);
    },
    terminate() {
      terminated = true;
      return undefined;
    },
  });

  let seenMessage: unknown;
  let seenError = '';
  let seenMessageError: unknown;
  adapted.onmessage = (event) => {
    seenMessage = event.data;
  };
  adapted.onerror = (event) => {
    seenError = event.message;
  };
  adapted.onmessageerror = (event) => {
    seenMessageError = event.data;
  };

  messageListener?.('pong');
  errorListener?.(new Error('broken'));
  messageErrorListener?.({ stale: true });
  adapted.postMessage('ping');
  adapted.terminate();

  assert.equal(seenMessage, 'pong');
  assert.equal(seenError, 'broken');
  assert.deepEqual(seenMessageError, { stale: true });
  assert.deepEqual(posted, ['ping']);
  assert.equal(terminated, true);
});

Deno.test('execution backend helpers can build a node-style worker factory when no global Worker exists', async () => {
  let receivedScriptUrl = '';
  let receivedType = '';

  const factory = __executionBackendTestables.createPortableWorkerFactory({
    globalWorker: undefined,
    importWorkerThreads: async () => ({
      Worker: class {
        readonly #listeners = new Map<string, Array<(value: unknown) => void>>();

        constructor(
          scriptUrl: string | URL,
          options?: { eval?: boolean; type?: 'commonjs' | 'module' },
        ) {
          receivedScriptUrl = String(scriptUrl);
          receivedType = options?.type ?? '';
        }

        on(event: 'error' | 'message' | 'messageerror', listener: (value: unknown) => void) {
          const listeners = this.#listeners.get(event) ?? [];
          listeners.push(listener);
          this.#listeners.set(event, listeners);
          return this;
        }

        postMessage(_message: unknown): void {
          // no-op: this test only verifies factory resolution, not full runtime execution
        }

        terminate(): void {
        }
      } as unknown as new (
        scriptUrl: string | URL,
        options?: { eval?: boolean; type?: 'commonjs' | 'module' },
      ) => {
        on(
          event: 'error' | 'message' | 'messageerror',
          listener: (value: unknown) => void,
        ): unknown;
        postMessage(message: unknown): void;
        terminate(): void | Promise<number>;
      },
    }),
  });

  const adapted = await factory!(
    `data:text/javascript;charset=utf-8,${encodeURIComponent('globalThis.postMessage("pong");')}`,
    { type: 'module' },
  );

  assert(receivedScriptUrl.startsWith('data:text/javascript;charset=utf-8,'));
  assert.equal(receivedType, 'module');
  assert.equal(typeof adapted.postMessage, 'function');
  assert.equal(typeof adapted.terminate, 'function');
});

Deno.test('WorkerExecutionBackend can create runtimes through the portable worker factory path', () => {
  const backend = new WorkerExecutionBackend({
    globalWorker: class {
      onerror = null;
      onmessage = null;
      onmessageerror = null;

      postMessage(_message: unknown): void {}

      terminate(): void {}
    },
  });

  const runtime = backend.createRuntime({ context: null });
  assert(typeof runtime.execute === 'function');
  assert(typeof runtime.close === 'function');
});
