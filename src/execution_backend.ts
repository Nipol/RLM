import type { ExecutionBackend, PersistentRuntimeLike } from './types.ts';
import { importNodeBuiltin } from './platform.ts';
import { PersistentSandboxRuntime } from './worker_runtime.ts';

interface WorkerConstructorLike {
  new (scriptUrl: string | URL, options?: WorkerOptions): {
    onerror: ((event: ErrorEvent) => void) | null;
    onmessage: ((event: MessageEvent<unknown>) => void) | null;
    onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
    postMessage(message: unknown): void;
    terminate(): void;
  };
}

interface NodeWorkerThreadsWorkerLike {
  on(event: 'error' | 'message' | 'messageerror', listener: (value: unknown) => void): unknown;
  postMessage(message: unknown): void;
  terminate(): void | Promise<number>;
}

interface NodeWorkerThreadsModule {
  Worker: new (
    scriptUrl: string | URL,
    options?: {
      eval?: boolean;
      type?: 'commonjs' | 'module';
    },
  ) => NodeWorkerThreadsWorkerLike;
}

interface WorkerExecutionBackendOptions {
  globalWorker?: WorkerConstructorLike;
  importWorkerThreads?: () => Promise<NodeWorkerThreadsModule>;
  useDenoPermissions?: boolean;
}

function createWorkerOptions(
  supportsDenoPermissions: boolean,
): WorkerOptions & { deno?: { permissions: 'none' } } {
  if (supportsDenoPermissions) {
    return {
      deno: { permissions: 'none' },
      type: 'module',
    };
  }

  return { type: 'module' };
}

function runtimeSupportsDenoWorkerPermissions(
  scope: typeof globalThis = globalThis,
): boolean {
  const deno = (scope as typeof globalThis & {
    Deno?: {
      version?: {
        deno?: string;
      };
    };
  }).Deno;
  return typeof deno?.version?.deno === 'string';
}

function decodeWorkerDataUrl(sourceUrl: string): string {
  const commaIndex = sourceUrl.indexOf(',');
  if (commaIndex < 0) {
    throw new Error('Worker source URL must be a data URL with encoded source text.');
  }

  return decodeURIComponent(sourceUrl.slice(commaIndex + 1));
}

function buildNodeWorkerSource(webWorkerSource: string): string {
  return `
import { parentPort } from 'node:worker_threads';

const __parentPort = parentPort;

if (__parentPort === null) {
  throw new Error('Node worker thread did not expose parentPort.');
}

globalThis.postMessage = (value) => {
  __parentPort.postMessage(value);
};

globalThis.addEventListener = (type, listener) => {
  if (type !== 'message') {
    return;
  }

  __parentPort.on('message', (data) => {
    listener({ data });
  });
};

${webWorkerSource}
`;
}

function adaptNodeWorkerThread(
  worker: NodeWorkerThreadsWorkerLike,
): {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
} {
  const adapted = {
    onerror: null as ((event: ErrorEvent) => void) | null,
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    onmessageerror: null as ((event: MessageEvent<unknown>) => void) | null,
    postMessage: (message: unknown) => {
      worker.postMessage(message);
    },
    terminate: () => {
      void worker.terminate();
    },
  };

  worker.on('message', (value) => {
    adapted.onmessage?.({ data: value } as MessageEvent<unknown>);
  });
  worker.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    adapted.onerror?.({ message } as ErrorEvent);
  });
  worker.on('messageerror', (error) => {
    adapted.onmessageerror?.({ data: error } as MessageEvent<unknown>);
  });

  return adapted;
}

function createPortableWorkerFactory(
  options: WorkerExecutionBackendOptions = {},
): ConstructorParameters<typeof PersistentSandboxRuntime>[1] {
  const globalWorker = 'globalWorker' in options ? options.globalWorker : globalThis.Worker;
  if (typeof globalWorker === 'function') {
    const workerOptions = createWorkerOptions(
      (options.useDenoPermissions ?? false) && runtimeSupportsDenoWorkerPermissions(),
    );
    return (url) =>
      new globalWorker(url, workerOptions) as unknown as {
        onerror: ((event: ErrorEvent) => void) | null;
        onmessage: ((event: MessageEvent<unknown>) => void) | null;
        onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
        postMessage(message: unknown): void;
        terminate(): void;
      };
  }

  const importWorkerThreads = options.importWorkerThreads ??
    (async () =>
      await importNodeBuiltin<NodeWorkerThreadsModule>('worker_threads'));

  return async (url) => {
    const workerThreads = await importWorkerThreads();
    const nodeSource = buildNodeWorkerSource(decodeWorkerDataUrl(url));
    const worker = new workerThreads.Worker(
      new URL(`data:text/javascript;charset=utf-8,${encodeURIComponent(nodeSource)}`),
      { type: 'module' },
    );
    return adaptNodeWorkerThread(worker) as unknown as {
      onerror: ((event: ErrorEvent) => void) | null;
      onmessage: ((event: MessageEvent<unknown>) => void) | null;
      onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
      postMessage(message: unknown): void;
      terminate(): void;
    };
  };
}

/**
 * Adapts the existing persistent worker runtime to the generic execution backend interface.
 *
 * This is the default backend used by the library today.
 * It preserves the current Deno worker-based execution strategy behind
 * the small `ExecutionBackend` abstraction.
 *
 * @example
 * ```ts
 * const backend = new WorkerExecutionBackend();
 * const runtime = backend.createRuntime({ context: { document: 'alpha' } });
 * ```
 */
export class WorkerExecutionBackend implements ExecutionBackend {
  readonly #options: WorkerExecutionBackendOptions;

  /**
   * Captures optional runtime-specific worker creation hooks.
   */
  constructor(options: WorkerExecutionBackendOptions = {}) {
    this.#options = options;
  }

  /**
   * Creates one persistent worker-backed runtime for a single REPL session.
   *
   * @param options Session-scoped runtime configuration such as `context`
   * and the host-side `llm_query` handler.
   * @returns A persistent runtime that satisfies the generic backend contract.
   *
   * @example
   * ```ts
   * const runtime = new WorkerExecutionBackend().createRuntime({
   *   context: { document: 'alpha' },
   * });
   * ```
   */
  createRuntime(
    options: ConstructorParameters<typeof PersistentSandboxRuntime>[0],
  ): PersistentRuntimeLike {
    return new PersistentSandboxRuntime(options, createPortableWorkerFactory(this.#options));
  }
}

/**
 * Returns the default execution backend used by library and standalone runs alike.
 *
 * @returns A fresh worker-backed execution backend instance.
 *
 * @example
 * ```ts
 * const backend = createDefaultExecutionBackend();
 * const runtime = backend.createRuntime({ context: null });
 * ```
 */
export function createDefaultExecutionBackend(): ExecutionBackend {
  return new WorkerExecutionBackend();
}

export const __executionBackendTestables = {
  adaptNodeWorkerThread,
  buildNodeWorkerSource,
  createPortableWorkerFactory,
  createWorkerOptions,
  decodeWorkerDataUrl,
  runtimeSupportsDenoWorkerPermissions,
};
