import type { ProviderDraft, ProviderKind, ProviderSettings } from './types.ts';

export const OPENAI_REASONING_EFFORT_OPTIONS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OLLAMA_CLOUD_BASE_URL = 'https://ollama.com/api';
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function normalizeProviderRequestTimeoutMs(requestTimeoutMs: number | undefined): number {
  if (requestTimeoutMs === undefined) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }

  if (!Number.isFinite(requestTimeoutMs)) {
    throw new Error('요청 제한 시간은 숫자여야 합니다.');
  }

  const normalized = Math.trunc(requestTimeoutMs);
  if (normalized <= 0) {
    throw new Error('요청 제한 시간은 1ms 이상이어야 합니다.');
  }

  return normalized;
}

export function coerceStoredProviderRequestTimeoutMs(requestTimeoutMs: unknown): number {
  if (typeof requestTimeoutMs !== 'number' || !Number.isFinite(requestTimeoutMs)) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }

  const normalized = Math.trunc(requestTimeoutMs);
  return normalized > 0 ? normalized : DEFAULT_REQUEST_TIMEOUT_MS;
}

function prefixUrlScheme(input: string, protocol: 'http://' | 'https://'): string {
  return /^[A-Za-z][A-Za-z0-9+\-.]*:\/\//u.test(input) ? input : `${protocol}${input}`;
}

function stripTrailingSlash(input: string): string {
  return input.replace(/\/+$/u, '');
}

function toSortedUnique(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

export function getProviderLabel(kind: ProviderKind): string {
  switch (kind) {
    case 'openai':
      return 'OpenAI';
    case 'ollama-local':
      return 'Ollama Local';
    case 'ollama-cloud':
      return 'Ollama Cloud';
  }
}

export function normalizeProviderBaseUrl(kind: ProviderKind, rawValue: string): string {
  if (kind === 'ollama-cloud') {
    return DEFAULT_OLLAMA_CLOUD_BASE_URL;
  }

  if (kind === 'openai') {
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) {
      return DEFAULT_OPENAI_BASE_URL;
    }

    const url = new URL(prefixUrlScheme(trimmed, 'https://'));
    if (url.hostname === 'api.openai.com' && (url.pathname === '' || url.pathname === '/')) {
      url.pathname = '/v1';
    }

    return stripTrailingSlash(url.toString());
  }

  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    throw new Error('Ollama Local 주소를 입력하세요.');
  }

  const url = new URL(prefixUrlScheme(trimmed, 'http://'));
  const normalizedPath = stripTrailingSlash(url.pathname);

  if (normalizedPath.length === 0) {
    url.pathname = '/api';
  } else if (!normalizedPath.endsWith('/api')) {
    url.pathname = `${normalizedPath}/api`;
  } else {
    url.pathname = normalizedPath;
  }

  return stripTrailingSlash(url.toString());
}

export function extractOpenAIModelIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
    return [];
  }

  const data = payload.data;
  if (!Array.isArray(data)) {
    return [];
  }

  return data.flatMap((entry) =>
    typeof entry === 'object' && entry !== null && typeof entry.id === 'string'
      ? [entry.id]
      : []
  );
}

export function extractOllamaModelIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null || !('models' in payload)) {
    return [];
  }

  const models = payload.models;
  if (!Array.isArray(models)) {
    return [];
  }

  return models.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }

    if (typeof entry.name === 'string') {
      return [entry.name];
    }

    if (typeof entry.model === 'string') {
      return [entry.model];
    }

    return [];
  });
}

export function isLikelyChatModel(modelId: string): boolean {
  const lowered = modelId.toLowerCase();
  const excludedFragments = [
    'dall-e',
    'embedding',
    'image',
    'moderation',
    'omni-moderation',
    'realtime',
    'transcribe',
    'tts',
    'whisper',
  ];
  return !excludedFragments.some((fragment) => lowered.includes(fragment));
}

export function normalizeCatalogModelIds(kind: ProviderKind, modelIds: string[]): string[] {
  const uniqueIds = toSortedUnique(modelIds);
  if (kind !== 'openai') {
    return uniqueIds;
  }

  return uniqueIds.filter((modelId) => isLikelyChatModel(modelId));
}

export function resolveModelSelection(
  availableModels: string[],
  preferredRootModel = '',
  preferredSubModel = '',
): { rootModel: string; subModel: string } {
  if (availableModels.length === 0) {
    return { rootModel: '', subModel: '' };
  }

  const rootModel = availableModels.includes(preferredRootModel)
    ? preferredRootModel
    : availableModels[0];
  const fallbackSubModel = availableModels[1] ?? rootModel;
  const subModel = availableModels.includes(preferredSubModel)
    ? preferredSubModel
    : fallbackSubModel;

  return { rootModel, subModel };
}

export function createProviderSettings(
  draft: ProviderDraft,
  now = new Date(),
): ProviderSettings {
  const baseUrl = normalizeProviderBaseUrl(draft.kind, draft.baseUrl);
  const requestTimeoutMs = normalizeProviderRequestTimeoutMs(draft.requestTimeoutMs);
  const availableModels = normalizeCatalogModelIds(draft.kind, draft.availableModels);
  const { rootModel, subModel } = resolveModelSelection(
    availableModels,
    draft.rootModel,
    draft.subModel,
  );

  if (draft.kind !== 'ollama-local' && draft.apiKey.trim().length === 0) {
    throw new Error(`${getProviderLabel(draft.kind)} API 키를 입력하세요.`);
  }

  if (availableModels.length === 0) {
    throw new Error('사용 가능한 모델을 먼저 불러오세요.');
  }

  return {
    apiKey: draft.apiKey.trim(),
    availableModels,
    baseUrl,
    kind: draft.kind,
    requestTimeoutMs,
    rootModel,
    rootReasoningEffort: draft.kind === 'openai' ? draft.rootReasoningEffort : undefined,
    subModel,
    subReasoningEffort: draft.kind === 'openai' ? draft.subReasoningEffort : undefined,
    updatedAt: now.toISOString(),
  };
}
