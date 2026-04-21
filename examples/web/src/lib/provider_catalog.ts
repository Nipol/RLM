import {
  normalizeProviderRequestTimeoutMs,
  extractOllamaModelIds,
  extractOpenAIModelIds,
  getProviderLabel,
  normalizeCatalogModelIds,
  normalizeProviderBaseUrl,
} from './provider_config.ts';
import type { ProviderDraft } from './types.ts';

type FetchLike = typeof fetch;

export interface ProviderCatalogResult {
  availableModels: string[];
  baseUrl: string;
}

function extractProviderErrorMessage(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const record = payload as {
    error?: string | {
      message?: string;
    };
  };

  if (typeof record.error === 'string') {
    return record.error;
  }

  if (typeof record.error === 'object' && record.error !== null && typeof record.error.message === 'string') {
    return record.error.message;
  }

  return null;
}

async function readJsonPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function assertRemoteApiKey(kind: ProviderDraft['kind'], apiKey: string): void {
  if (kind !== 'ollama-local' && apiKey.trim().length === 0) {
    throw new Error(`${getProviderLabel(kind)} API 키를 입력하세요.`);
  }
}

export async function listModelsForDraft(
  draft: ProviderDraft,
  fetcher: FetchLike = fetch,
): Promise<ProviderCatalogResult> {
  const baseUrl = normalizeProviderBaseUrl(draft.kind, draft.baseUrl);
  const requestTimeoutMs = normalizeProviderRequestTimeoutMs(draft.requestTimeoutMs);
  const headers = new Headers();
  let endpoint = `${baseUrl}/tags`;

  if (draft.kind === 'openai') {
    assertRemoteApiKey(draft.kind, draft.apiKey);
    headers.set('Authorization', `Bearer ${draft.apiKey.trim()}`);
    endpoint = `${baseUrl}/models`;
  }

  if (draft.kind === 'ollama-cloud') {
    assertRemoteApiKey(draft.kind, draft.apiKey);
    headers.set('Authorization', `Bearer ${draft.apiKey.trim()}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetcher(endpoint, {
      headers,
      method: 'GET',
      signal: controller.signal,
    });
    const payload = await readJsonPayload(response);

    if (!response.ok) {
      throw new Error(
        extractProviderErrorMessage(payload) ??
          `${getProviderLabel(draft.kind)} 모델 목록을 불러오지 못했습니다. (${response.status})`,
      );
    }

    const availableModels = normalizeCatalogModelIds(
      draft.kind,
      draft.kind === 'openai' ? extractOpenAIModelIds(payload) : extractOllamaModelIds(payload),
    );

    if (availableModels.length === 0) {
      throw new Error(`${getProviderLabel(draft.kind)}에서 사용할 수 있는 모델을 찾지 못했습니다.`);
    }

    const result = {
      availableModels,
      baseUrl,
    };
    clearTimeout(timer);
    return result;
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(
        `${getProviderLabel(draft.kind)} 모델 목록 요청이 ${requestTimeoutMs}ms 뒤에 시간 초과되었습니다.`,
      );
    }

    throw error;
  }
}
