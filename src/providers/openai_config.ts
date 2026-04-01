/**
 * OpenAI provider configuration contracts shared by standalone, browser, and packaged clients.
 *
 * @module
 *
 * @example
 * ```ts
 * import type { OpenAIProviderConfig } from './openai_config.ts';
 * ```
 */
/**
 * Describes the OpenAI-compatible endpoint, timeout, and model settings used by the provider.
 */
export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl: string;
  requestTimeoutMs: number;
  rootModel: string;
  rootReasoningEffort?: OpenAIReasoningEffort;
  subModel: string;
  subReasoningEffort?: OpenAIReasoningEffort;
}

/**
 * Enumerates the reasoning-effort hints supported by compatible OpenAI Responses models.
 */
export type OpenAIReasoningEffort = 'high' | 'low' | 'medium' | 'minimal' | 'none' | 'xhigh';
