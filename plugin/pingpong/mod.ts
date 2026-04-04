/**
 * Ping-pong plugin entrypoint that can be registered on one RLM client.
 *
 * @module
 *
 * @example
 * ```ts
 * import { createPingPongPlugin } from '@yoonsung/rlm/plugin/pingpong';
 * ```
 */
import type { RLMPlugin } from '../../src/index.ts';
import { PING_PONG_HELPER_SOURCE } from './source.ts';

/**
 * Builds the minimal ping-pong runtime-helper plugin.
 */
export function createPingPongPlugin(): RLMPlugin {
  return {
    name: 'ping-pong',
    runtimeHelpers: [{
      description: 'PING을 입력으로 받으면 PONG을 반환합니다.',
      examples: ['await ping_pong("PING")'],
      inputKinds: ['text'],
      name: 'ping_pong',
      returns: '`"PONG"` 또는 알 수 없는 입력일 때 `"UNKNOWN"` 문자열',
      signature: 'ping_pong(text)',
      source: PING_PONG_HELPER_SOURCE,
      timeoutMs: 1_000,
    }],
  };
}

export { PING_PONG_HELPER_SOURCE } from './source.ts';
