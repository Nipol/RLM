/**
 * Serialized source for the ping-pong runtime helper.
 *
 * @module
 *
 * @example
 * ```ts
 * import { PING_PONG_HELPER_SOURCE } from './source.ts';
 * ```
 */
import { serializeRuntimeHelperSource } from '../../src/index.ts';
import { runPingPongHelper } from './runtime.ts';

/**
 * Exposes the pure-JavaScript runtime helper source for the ping-pong plugin.
 */
export const PING_PONG_HELPER_SOURCE: string = serializeRuntimeHelperSource({
  entrypoint: 'runPingPongHelper',
  functions: [runPingPongHelper],
});
