/**
 * Worker source-handle helpers used by both one-shot and persistent sandbox runtimes.
 *
 * @module
 *
 * @example
 * ```ts
 * import { buildPreferredWorkerSourceHandle } from './worker_source.ts';
 * ```
 */

/**
 * Describes the minimum URL APIs required to support blob-backed worker sources.
 */
export interface WorkerSourceUrlApi {
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

/**
 * Describes the minimum host capabilities needed to choose a worker source strategy.
 */
export interface WorkerSourceScope {
  Blob?: typeof Blob;
  URL?: WorkerSourceUrlApi;
}

/**
 * Describes one prepared worker script handle plus its cleanup hook.
 */
export interface WorkerSourceHandle {
  kind: 'blob_url' | 'data_url';
  revoke: () => void;
  url: string;
}

/**
 * Returns whether one runtime can create and revoke blob-backed worker URLs.
 */
export function supportsBlobBackedWorkerSource(scope: WorkerSourceScope): boolean {
  return typeof scope.Blob === 'function' &&
    typeof scope.URL?.createObjectURL === 'function' &&
    typeof scope.URL?.revokeObjectURL === 'function';
}

/**
 * Encodes generated worker source as a self-contained JavaScript data URL.
 */
export function buildDataWorkerSourceUrl(source: string): string {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

/**
 * Builds a no-cleanup data-URL worker script handle.
 */
export function buildDataWorkerSourceHandle(source: string): WorkerSourceHandle {
  return {
    kind: 'data_url',
    revoke: () => undefined,
    url: buildDataWorkerSourceUrl(source),
  };
}

/**
 * Builds a blob-backed worker script handle for runtimes that support object URLs.
 */
export function buildBlobWorkerSourceHandle(
  source: string,
  scope: WorkerSourceScope,
): WorkerSourceHandle {
  if (!supportsBlobBackedWorkerSource(scope)) {
    throw new Error('Blob-backed worker URLs are not supported in this runtime.');
  }

  const blob = new scope.Blob!([source], { type: 'text/javascript;charset=utf-8' });
  const url = scope.URL!.createObjectURL!(blob);

  return {
    kind: 'blob_url',
    revoke: () => {
      scope.URL!.revokeObjectURL!(url);
    },
    url,
  };
}

/**
 * Chooses the most portable worker source handle available in the current runtime.
 */
export function buildPreferredWorkerSourceHandle(
  source: string,
  scope: WorkerSourceScope = globalThis as unknown as WorkerSourceScope,
): WorkerSourceHandle {
  if (supportsBlobBackedWorkerSource(scope)) {
    return buildBlobWorkerSourceHandle(source, scope);
  }

  return buildDataWorkerSourceHandle(source);
}
