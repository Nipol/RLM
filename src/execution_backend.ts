import type { ExecutionBackend, PersistentRuntimeLike } from './types.ts';
import { PersistentSandboxRuntime } from './worker_runtime.ts';

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
    return new PersistentSandboxRuntime(options);
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
