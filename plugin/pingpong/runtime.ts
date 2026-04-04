/**
 * Minimal runtime helper functions used by the ping-pong plugin.
 *
 * @module
 *
 * @example
 * ```ts
 * import { runPingPongHelper } from './runtime.ts';
 * ```
 */

/**
 * Returns `PONG` for `PING` and `UNKNOWN` otherwise.
 */
export function runPingPongHelper(input: unknown): string {
  return input === 'PING' ? 'PONG' : 'UNKNOWN';
}
