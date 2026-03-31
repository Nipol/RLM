import type {
  LLMCaller,
  LLMCallerRequest,
  LLMCallerResponse,
  LLMProvider,
} from '../llm_adapter.ts';
import {
  decodeBase64Url,
  type DirectoryCreateOptions,
  dirnameFilePath,
  encodeBase64Url,
  importNodeBuiltin,
  isNotFoundError,
  joinFilePath,
  type MakeDirectory,
  type ReadTextFile,
  resolveCurrentWorkingDirectory,
  type WriteTextFile,
} from '../platform.ts';

const DEFAULT_AUTH_BASE_URL = 'https://auth.openai.com';
const DEFAULT_API_BASE_URL = 'https://chatgpt.com/backend-api';
const DEFAULT_CALLBACK_PORT = 1455;
const DEFAULT_CLIENT_VERSION = '1.0.0';
const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_SCOPE = 'openid profile email offline_access';
const DEFAULT_ORIGINATOR = 'rlm';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const EMPTY_ASSISTANT_TEXT_RETRY_COUNT = 1;
const MODEL_LIST_RETRY_COUNT = 1;
const DEFAULT_USER_AGENT = 'rlm';
const MODEL_LIST_PATH = '/codex/models';
const REFRESH_SKEW_MS = 60_000;
const RESPONSES_PATH = '/codex/responses';

type FetchLike = typeof fetch;

interface OAuthTokenResponse {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
}

interface ModelListResponse {
  categories?: Array<{
    models?: Array<{
      id?: string;
      slug?: string;
    }>;
  }>;
  data?: Array<{
    id?: string;
    slug?: string;
  }>;
  models?: Array<{
    id?: string;
    slug?: string;
  }>;
}

interface CodexUsagePayload {
  input_tokens_details?: {
    cached_tokens?: number;
  };
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface CodexMessageContentPayload {
  text?: string | {
    value?: string;
  };
  type?: string;
}

interface CodexMessagePayload {
  content?: CodexMessageContentPayload[];
  type?: string;
}

interface CodexResponsePayload {
  error?: {
    message?: string;
  };
  id?: string;
  output?: CodexMessagePayload[];
  output_text?: string;
  usage?: CodexUsagePayload;
}

interface NodeFsPromisesLike {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string, encoding: string): Promise<string>;
  writeFile(path: string, data: string, encoding: string): Promise<void>;
}

interface NodeHttpModuleLike {
  createServer(
    handler: (request: NodeHttpRequestLike, response: NodeHttpResponseLike) => void,
  ): {
    close(callback?: (error?: Error) => void): void;
    listen(port: number, hostname: string, callback?: () => void): void;
    on(event: 'connection', listener: (socket: NodeHttpSocketLike) => void): void;
    on(event: 'error', listener: (error: Error) => void): void;
  };
}

interface NodeHttpRequestLike {
  headers: {
    host?: string;
  };
  url?: string;
}

interface NodeHttpResponseLike {
  end(text?: string, callback?: () => void): void;
  writeHead(statusCode: number, headers: Record<string, string>): void;
}

interface NodeHttpSocketLike {
  destroy(): void;
  once(event: 'close', listener: () => void): void;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseServerSentEventPayload(text: string): unknown[] {
  const payloads: unknown[] = [];
  const blocks = text.split(/\n\n+/u);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const dataLines = trimmed
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart());

    if (dataLines.length === 0) {
      continue;
    }

    const data = dataLines.join('\n').trim();
    if (data === '[DONE]') {
      continue;
    }

    payloads.push(tryParseJson(data));
  }

  return payloads;
}

function normalizeStreamedCodexPayload(text: string): CodexResponsePayload {
  const events = parseServerSentEventPayload(text);
  let completedResponse: CodexResponsePayload | null = null;
  let outputText = '';

  const extractTextValue = (value: unknown): string | null => {
    if (typeof value === 'string') {
      return value;
    }

    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.value === 'string') {
        return record.value;
      }
    }

    return null;
  };

  const appendTextValue = (value: unknown) => {
    const textValue = extractTextValue(value);
    if (textValue !== null) {
      outputText += textValue;
    }
  };

  const appendMessageTexts = (value: unknown) => {
    if (value === null || typeof value !== 'object') {
      return;
    }

    const record = value as Record<string, unknown>;
    if (record.type !== 'message') {
      return;
    }

    const contents = Array.isArray(record.content) ? record.content : [];
    for (const content of contents) {
      if (content === null || typeof content !== 'object') {
        continue;
      }

      const contentRecord = content as Record<string, unknown>;
      const contentType = contentRecord.type;
      if (contentType !== 'output_text' && contentType !== 'text') {
        continue;
      }

      appendTextValue(contentRecord.text);
    }
  };

  for (const event of events) {
    if (event === null || typeof event !== 'object') {
      continue;
    }

    const record = event as Record<string, unknown>;
    if (
      record.type === 'response.completed' &&
      record.response !== null &&
      typeof record.response === 'object'
    ) {
      completedResponse = record.response as CodexResponsePayload;
      continue;
    }

    if (
      record.type === 'response.output_text.delta' &&
      typeof record.delta === 'string'
    ) {
      outputText += record.delta;
      continue;
    }

    if (
      record.type === 'response.output_text.done' &&
      typeof record.text === 'string'
    ) {
      outputText += record.text;
      continue;
    }

    if (
      record.type === 'response.output_item.done' || record.type === 'response.output_item.added'
    ) {
      appendMessageTexts(record.item);
      continue;
    }

    if (
      record.type === 'response.content_part.added' || record.type === 'response.content_part.done'
    ) {
      const part = record.part;
      if (part !== null && typeof part === 'object') {
        const partRecord = part as Record<string, unknown>;
        const partType = partRecord.type;
        if (partType === 'output_text' || partType === 'text') {
          appendTextValue(partRecord.text);
        }
      }
      continue;
    }

    if (record.type === 'error') {
      return {
        error: {
          message: extractStructuredErrorMessage(record, 'Codex OAuth stream failed.'),
        },
      };
    }
  }

  if (completedResponse !== null) {
    const normalizedCompleted = normalizeCodexResponsePayload(completedResponse);
    if (
      (typeof normalizedCompleted.output_text !== 'string' ||
        normalizedCompleted.output_text.length === 0) &&
      outputText.length > 0
    ) {
      normalizedCompleted.output_text = outputText;
    }
    return normalizedCompleted;
  }

  if (outputText.length > 0) {
    return {
      output_text: outputText,
    };
  }

  return {};
}

function extractOutputTextOrNull(payload: CodexResponsePayload): string | null {
  if (typeof payload.output_text === 'string' && payload.output_text.length > 0) {
    return payload.output_text;
  }

  const parts: string[] = [];
  const outputItems = Array.isArray(payload.output) ? payload.output : [];
  for (const item of outputItems) {
    if (item.type !== 'message') {
      continue;
    }

    const contents = Array.isArray(item.content) ? item.content : [];
    for (const content of contents) {
      if (content.type !== 'output_text' && content.type !== 'text') {
        continue;
      }

      const textValue = typeof content.text === 'string'
        ? content.text
        : content.text !== undefined &&
            content.text !== null &&
            typeof content.text === 'object' &&
            typeof (content.text as { value?: unknown }).value === 'string'
        ? String((content.text as { value?: unknown }).value)
        : null;
      if (textValue === null || textValue.length === 0) {
        continue;
      }

      parts.push(textValue);
    }
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join('\n');
}

function normalizeCodexResponsePayload(payload: CodexResponsePayload): CodexResponsePayload {
  const normalizedOutputText = extractOutputTextOrNull(payload);
  if (normalizedOutputText === null) {
    return payload;
  }

  return {
    ...payload,
    output_text: normalizedOutputText,
  };
}

function parseCodexResponseBody(rawText: string): CodexResponsePayload | unknown {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return {};
  }

  if (
    trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"') ||
    /^-?\d/u.test(trimmed) || trimmed === 'true' || trimmed === 'false' || trimmed === 'null'
  ) {
    const payload = tryParseJson(trimmed);
    if (payload !== null && typeof payload === 'object') {
      return normalizeCodexResponsePayload(payload as CodexResponsePayload);
    }
    return payload;
  }

  return normalizeStreamedCodexPayload(trimmed);
}

interface LegacyCodexOAuthAuthRecord {
  apiBaseUrl: string;
  apiKey: string;
  authBaseUrl: string;
  clientId: string;
  provider: 'codex-oauth';
  tokens: CodexOAuthTokenBundle;
  updatedAt: string;
  version: 1;
}

function extractStructuredErrorMessage(
  payload: unknown,
  fallback: string,
): string {
  if (typeof payload === 'string') {
    return payload;
  }

  if (payload === null || typeof payload !== 'object') {
    return fallback;
  }

  const record = payload as Record<string, unknown>;
  const directMessage = record.message;
  if (typeof directMessage === 'string' && directMessage.length > 0) {
    return directMessage;
  }

  const nestedErrorDescription = record.error_description;
  if (nestedErrorDescription !== undefined) {
    return extractStructuredErrorMessage(nestedErrorDescription, fallback);
  }

  const nestedError = record.error;
  if (nestedError !== undefined) {
    return extractStructuredErrorMessage(nestedError, fallback);
  }

  try {
    return JSON.stringify(payload);
  } catch {
    return fallback;
  }
}

/**
 * Captures the persisted token bundle used by the Codex OAuth provider.
 *
 * @example
 * ```ts
 * const tokens: CodexOAuthTokenBundle = {
 *   accessToken: 'access-token',
 *   accountId: 'acct-123',
 *   expiresAt: '2026-03-27T01:00:00.000Z',
 *   idToken: 'id-token',
 *   organizationId: 'org-123',
 *   refreshToken: 'refresh-token',
 * };
 * ```
 */
export interface CodexOAuthTokenBundle {
  accessToken: string;
  accountId: string | null;
  expiresAt: string | null;
  idToken: string;
  organizationId: string | null;
  refreshToken: string;
}

/**
 * Describes one persisted Codex OAuth auth record.
 *
 * @example
 * ```ts
 * const record: CodexOAuthAuthRecord = {
 *   apiBaseUrl: 'https://api.openai.com/v1',
 *   authBaseUrl: 'https://auth.openai.com',
 *   clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
 *   provider: 'codex-oauth',
 *   tokens,
 *   updatedAt: '2026-03-27T00:00:00.000Z',
 *   version: 2,
 * };
 * ```
 */
export interface CodexOAuthAuthRecord {
  apiBaseUrl: string;
  authBaseUrl: string;
  clientId: string;
  provider: 'codex-oauth';
  tokens: CodexOAuthTokenBundle;
  updatedAt: string;
  version: 2;
}

/**
 * Describes one interactive authorization session before the code exchange.
 */
export interface CodexOAuthAuthorizationSession {
  authUrl: string;
  callbackPort: number;
  redirectUri: string;
  state: string;
}

/**
 * Describes the callback data captured after the user approves the browser login.
 */
export interface CodexOAuthAuthorizationCodeResult {
  code: string;
  state: string;
}

/**
 * Describes the callback used to wait for the browser redirect during login.
 */
export type CodexOAuthAuthorizationReceiver = (
  session: CodexOAuthAuthorizationSession,
) => Promise<CodexOAuthAuthorizationCodeResult>;

/**
 * Describes optional knobs for one interactive login run.
 */
export interface CodexOAuthLoginOptions {
  force?: boolean;
  onAuthUrl?: (url: string) => void | Promise<void>;
  receiveAuthorizationCode?: CodexOAuthAuthorizationReceiver;
}

/**
 * Describes one caller produced by the Codex OAuth provider.
 */
export interface CodexOAuthCallerConfig {
  requestTimeoutMs?: number;
}

/**
 * Describes the constructor options for the Codex OAuth provider.
 *
 * @example
 * ```ts
 * const provider = new CodexOAuthProvider({
 *   storagePath: './.rlm/codex-oauth.json',
 * });
 * ```
 */
export interface CodexOAuthProviderOptions {
  apiBaseUrl?: string;
  authBaseUrl?: string;
  callbackPort?: number;
  clientId?: string;
  clock?: () => Date;
  createCodeVerifier?: () => string | Promise<string>;
  createState?: () => string;
  fetcher?: FetchLike;
  mkdir?: MakeDirectory;
  originator?: string;
  openUrl?: (url: string) => void | Promise<void>;
  readTextFile?: ReadTextFile;
  receiveAuthorizationCode?: CodexOAuthAuthorizationReceiver;
  storagePath?: string;
  userAgent?: string;
  writeTextFile?: WriteTextFile;
}

function resolveClock(clock: CodexOAuthProviderOptions['clock']): () => Date {
  return clock ?? (() => new Date());
}

function resolveReadTextFile(
  readTextFile: CodexOAuthProviderOptions['readTextFile'],
): NonNullable<CodexOAuthProviderOptions['readTextFile']> {
  const defaultReadTextFile = (globalThis as typeof globalThis & {
    Deno?: {
      readTextFile?: ReadTextFile;
    };
  }).Deno?.readTextFile;

  if (readTextFile !== undefined) {
    return readTextFile;
  }

  if (defaultReadTextFile !== undefined) {
    return defaultReadTextFile;
  }

  return async (path) => {
    const fs = await importNodeBuiltin<NodeFsPromisesLike>('fs/promises');
    return await fs.readFile(path, 'utf8');
  };
}

function resolveWriteTextFile(
  writeTextFile: CodexOAuthProviderOptions['writeTextFile'],
): NonNullable<CodexOAuthProviderOptions['writeTextFile']> {
  const defaultWriteTextFile = (globalThis as typeof globalThis & {
    Deno?: {
      writeTextFile?: WriteTextFile;
    };
  }).Deno?.writeTextFile;

  if (writeTextFile !== undefined) {
    return writeTextFile;
  }

  if (defaultWriteTextFile !== undefined) {
    return defaultWriteTextFile;
  }

  return async (path, data) => {
    const fs = await importNodeBuiltin<NodeFsPromisesLike>('fs/promises');
    await fs.writeFile(path, data, 'utf8');
  };
}

function resolveMkdir(
  mkdir: CodexOAuthProviderOptions['mkdir'],
): NonNullable<CodexOAuthProviderOptions['mkdir']> {
  const defaultMkdir = (globalThis as typeof globalThis & {
    Deno?: {
      mkdir?: MakeDirectory;
    };
  }).Deno?.mkdir;

  if (mkdir !== undefined) {
    return mkdir;
  }

  if (defaultMkdir !== undefined) {
    return defaultMkdir;
  }

  return async (path, options?: DirectoryCreateOptions) => {
    const fs = await importNodeBuiltin<NodeFsPromisesLike>('fs/promises');
    await fs.mkdir(path, options);
  };
}

function resolveStoragePath(path: string | undefined): string {
  return path ?? joinFilePath(resolveCurrentWorkingDirectory(), '.rlm', 'codex-oauth.json');
}

async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

function createRandomVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function createRandomState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2 || parts[1] === undefined) {
    return null;
  }

  try {
    return JSON.parse(decodeBase64Url(parts[1])) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractAccountId(idToken: string): string | null {
  const payload = parseJwtPayload(idToken);
  const auth = payload?.['https://api.openai.com/auth'];
  if (auth === null || typeof auth !== 'object') {
    return null;
  }

  const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
}

function extractOrganizationId(idToken: string): string | null {
  const payload = parseJwtPayload(idToken);
  const auth = payload?.['https://api.openai.com/auth'];
  if (auth === null || typeof auth !== 'object') {
    return null;
  }

  const record = auth as Record<string, unknown>;
  const directOrganizationId = record.organization_id;
  if (typeof directOrganizationId === 'string' && directOrganizationId.length > 0) {
    return directOrganizationId;
  }

  const organizations = record.organizations;
  if (Array.isArray(organizations)) {
    for (const organization of organizations) {
      if (organization === null || typeof organization !== 'object') {
        continue;
      }

      const organizationId = (organization as Record<string, unknown>).id;
      if (typeof organizationId === 'string' && organizationId.length > 0) {
        return organizationId;
      }
    }
  }

  return null;
}

function extractExpiryIso(token: string): string | null {
  const payload = parseJwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return null;
  }

  return new Date(exp * 1_000).toISOString();
}

function isAuthExpired(record: CodexOAuthAuthRecord, now: Date): boolean {
  const expiresAt = record.tokens.expiresAt;
  if (expiresAt === null) {
    return false;
  }

  return Date.parse(expiresAt) <= now.getTime() + REFRESH_SKEW_MS;
}

function extractCallerOutputText(payload: CodexResponsePayload): string {
  const normalizedOutputText = extractOutputTextOrNull(payload);
  if (normalizedOutputText === null) {
    throw new Error('Codex OAuth response did not contain assistant text.');
  }

  return normalizedOutputText;
}

function normalizeUsage(payload: CodexResponsePayload): LLMCallerResponse['usage'] {
  if (payload.usage === undefined) {
    return undefined;
  }

  return {
    cachedInputTokens: payload.usage.input_tokens_details?.cached_tokens,
    inputTokens: payload.usage.input_tokens,
    outputTokens: payload.usage.output_tokens,
    totalTokens: payload.usage.total_tokens,
  };
}

function serializeRawResponsePayload(payload: unknown, rawText: string): string {
  if (typeof rawText === 'string' && rawText.trim().length > 0) {
    return rawText.trim();
  }

  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function normalizeModelIds(payload: ModelListResponse): string[] {
  const ids: string[] = [];
  const buckets = [
    Array.isArray(payload.data) ? payload.data : [],
    Array.isArray(payload.models) ? payload.models : [],
    Array.isArray(payload.categories)
      ? payload.categories.flatMap((category) =>
        Array.isArray(category.models) ? category.models : []
      )
      : [],
  ];
  for (const bucket of buckets) {
    for (const model of bucket) {
      const id = typeof model.slug === 'string' && model.slug.length > 0
        ? model.slug
        : typeof model.id === 'string' && model.id.length > 0
        ? model.id
        : null;
      if (id === null || ids.includes(id)) {
        continue;
      }

      ids.push(id);
    }
  }

  return ids;
}

function parseModelListPayload(rawText: string): (ModelListResponse & { error?: unknown }) | null {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const payload = tryParseJson(trimmed);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  return payload as ModelListResponse & { error?: unknown };
}

function formatInvalidModelListPayloadMessage(rawText: string): string {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return 'Codex OAuth model listing returned an invalid response payload.';
  }

  return `Codex OAuth model listing returned an invalid response payload. raw=${trimmed}`;
}

function resolveCodexModelId(requestedModel: string, availableModels: string[]): string {
  const requested = String(requestedModel ?? '').trim();
  if (requested.length === 0) {
    throw new Error('Codex requests require a non-empty model identifier.');
  }

  const exact = availableModels.find((modelId) => modelId === requested);
  if (exact !== undefined) {
    return exact;
  }

  throw new Error(
    [
      `Requested Codex model is unavailable: ${requested}.`,
      'Configure an exact model id from the current profile catalog.',
      `Available models: ${[...availableModels].sort().join(', ')}`,
    ].join(' '),
  );
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/u, '');
}

function buildModelListUrl(baseUrl: string): string {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}${MODEL_LIST_PATH}`);
  url.searchParams.set('client_version', DEFAULT_CLIENT_VERSION);
  return url.toString();
}

function buildResponsesUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}${RESPONSES_PATH}`;
}

async function buildAuthorizeUrl(options: {
  authBaseUrl: string;
  clientId: string;
  codeChallenge: string;
  originator: string;
  redirectUri: string;
  state: string;
}): Promise<string> {
  const url = new URL('/oauth/authorize', options.authBaseUrl.replace(/\/+$/u, '') + '/');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', DEFAULT_SCOPE);
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', options.state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', options.originator);
  return url.toString();
}

async function postOAuthToken(
  fetcher: FetchLike,
  authBaseUrl: string,
  params: URLSearchParams,
): Promise<OAuthTokenResponse> {
  const response = await fetcher(
    `${authBaseUrl.replace(/\/+$/u, '')}/oauth/token`,
    {
      body: params,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    },
  );

  const payload = await response.json() as OAuthTokenResponse & {
    error?: unknown;
    error_description?: unknown;
  };

  if (!response.ok) {
    const message = extractStructuredErrorMessage(
      payload,
      `OAuth request failed with status ${response.status}.`,
    );
    throw new Error(message);
  }

  return payload;
}

async function exchangeCodeForTokens(
  fetcher: FetchLike,
  options: {
    authBaseUrl: string;
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
): Promise<CodexOAuthTokenBundle> {
  const payload = await postOAuthToken(
    fetcher,
    options.authBaseUrl,
    new URLSearchParams({
      client_id: options.clientId,
      code: options.code,
      code_verifier: options.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: options.redirectUri,
    }),
  );

  if (
    typeof payload.access_token !== 'string' || typeof payload.id_token !== 'string' ||
    typeof payload.refresh_token !== 'string'
  ) {
    throw new Error('Codex OAuth login did not return the required token set.');
  }

  return {
    accessToken: payload.access_token,
    accountId: extractAccountId(payload.access_token) ?? extractAccountId(payload.id_token),
    expiresAt: extractExpiryIso(payload.access_token) ?? extractExpiryIso(payload.id_token),
    idToken: payload.id_token,
    organizationId: extractOrganizationId(payload.id_token),
    refreshToken: payload.refresh_token,
  };
}

async function refreshTokens(
  fetcher: FetchLike,
  options: {
    authBaseUrl: string;
    clientId: string;
    refreshToken: string;
  },
): Promise<CodexOAuthTokenBundle> {
  const payload = await postOAuthToken(
    fetcher,
    options.authBaseUrl,
    new URLSearchParams({
      client_id: options.clientId,
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken,
    }),
  );

  if (
    typeof payload.access_token !== 'string' || typeof payload.id_token !== 'string' ||
    typeof payload.refresh_token !== 'string'
  ) {
    throw new Error('Codex OAuth refresh did not return the required token set.');
  }

  return {
    accessToken: payload.access_token,
    accountId: extractAccountId(payload.access_token) ?? extractAccountId(payload.id_token),
    expiresAt: extractExpiryIso(payload.access_token) ?? extractExpiryIso(payload.id_token),
    idToken: payload.id_token,
    organizationId: extractOrganizationId(payload.id_token),
    refreshToken: payload.refresh_token,
  };
}

function normalizeAuthRecord(
  record: CodexOAuthAuthRecord | LegacyCodexOAuthAuthRecord,
): CodexOAuthAuthRecord {
  return {
    apiBaseUrl: record.apiBaseUrl,
    authBaseUrl: record.authBaseUrl,
    clientId: record.clientId,
    provider: 'codex-oauth',
    tokens: {
      ...record.tokens,
      accountId: record.tokens.accountId ?? extractAccountId(record.tokens.idToken),
      organizationId: record.tokens.organizationId ??
        extractOrganizationId(record.tokens.idToken),
    },
    updatedAt: record.updatedAt,
    version: 2,
  };
}

export function extractAuthorizationCodeFromCallbackUrl(
  callbackUrl: string,
): CodexOAuthAuthorizationCodeResult | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(callbackUrl);
  } catch {
    throw new Error('Codex OAuth callback URL must be a full http:// or https:// URL.');
  }

  const code = parsedUrl.searchParams.get('code');
  const state = parsedUrl.searchParams.get('state');
  if (code === null || state === null) {
    return null;
  }

  return { code, state };
}

async function defaultReceiveAuthorizationCode(
  session: CodexOAuthAuthorizationSession,
): Promise<CodexOAuthAuthorizationCodeResult> {
  const denoServe = (globalThis as typeof globalThis & {
    Deno?: {
      serve?: (
        options: {
          hostname: string;
          port: number;
          signal: AbortSignal;
        },
        handler: (request: Request) => Response | Promise<Response>,
      ) => {
        finished: Promise<void>;
      };
    };
  }).Deno?.serve;

  if (typeof denoServe === 'function') {
    const controller = new AbortController();
    let resolveResult: ((value: CodexOAuthAuthorizationCodeResult) => void) | undefined;
    const result = new Promise<CodexOAuthAuthorizationCodeResult>((resolve) => {
      resolveResult = resolve;
    });

    const server = denoServe(
      {
        hostname: '127.0.0.1',
        port: session.callbackPort,
        signal: controller.signal,
      },
      (request) => {
        const callback = extractAuthorizationCodeFromCallbackUrl(request.url);
        if (callback === null) {
          return new Response(
            'Codex OAuth callback is waiting for the final code and state. Return to the browser login and try again, or paste the full callback URL into the CLI.',
            { status: 202, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
          );
        }

        resolveResult?.(callback);
        controller.abort();
        return new Response(
          'Codex OAuth login complete. You can close this tab and return to the CLI.',
          { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
        );
      },
    );

    try {
      const callback = await result;
      await server.finished;
      return callback;
    } finally {
      controller.abort();
    }
  }

  const controller = new AbortController();
  let resolveResult: ((value: CodexOAuthAuthorizationCodeResult) => void) | undefined;
  let rejectResult: ((reason?: unknown) => void) | undefined;
  const result = new Promise<CodexOAuthAuthorizationCodeResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const nodeHttp = await importNodeBuiltin<NodeHttpModuleLike>('http');
  const sockets = new Set<{
    destroy(): void;
    once(event: 'close', listener: () => void): void;
  }>();

  const server = nodeHttp.createServer((request, response) => {
    const fullUrl = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? `127.0.0.1:${session.callbackPort}`}`,
    );
    const callback = extractAuthorizationCodeFromCallbackUrl(fullUrl.toString());

    if (callback === null) {
      response.writeHead(202, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end(
        'Codex OAuth callback is waiting for the final code and state. Return to the browser login and try again, or paste the full callback URL into the CLI.',
      );
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    response.end(
      'Codex OAuth login complete. You can close this tab and return to the CLI.',
      () => {
        resolveResult?.(callback);
        controller.abort();
      },
    );
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
    });
  });

  const abortHandler = () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close();
    rejectResult?.(new DOMException('Aborted', 'AbortError'));
  };
  controller.signal.addEventListener('abort', abortHandler, { once: true });
  server.listen(session.callbackPort, '127.0.0.1');

  try {
    return await result;
  } finally {
    controller.abort();
    controller.signal.removeEventListener('abort', abortHandler);
  }
}

interface CodexOAuthCallerOptions {
  accessToken: string;
  accountId: string;
  apiBaseUrl: string;
  availableModels: string[];
  fetcher: FetchLike;
  originator: string;
  requestTimeoutMs: number;
  userAgent: string;
}

function attachAbortListener(
  signal: AbortSignal | undefined,
  controller: AbortController,
  handleExternalAbort: () => void,
): void {
  if (signal?.aborted === true) {
    controller.abort();
    return;
  }

  if (signal === undefined) {
    return;
  }

  signal.addEventListener('abort', handleExternalAbort, { once: true });
}

function detachAbortListener(
  signal: AbortSignal | undefined,
  handleExternalAbort: () => void,
): void {
  if (signal === undefined) {
    return;
  }

  signal.removeEventListener('abort', handleExternalAbort);
}

function cleanupCompletionRequest(
  timer: ReturnType<typeof setTimeout>,
  signal: AbortSignal | undefined,
  handleExternalAbort: () => void,
): void {
  clearTimeout(timer);
  detachAbortListener(signal, handleExternalAbort);
}

class CodexOAuthCaller implements LLMCaller {
  readonly #accessToken: string;
  readonly #accountId: string;
  readonly #apiBaseUrl: string;
  readonly #availableModels: string[];
  readonly #fetcher: FetchLike;
  readonly #originator: string;
  readonly #requestTimeoutMs: number;
  readonly #userAgent: string;

  constructor(options: CodexOAuthCallerOptions) {
    this.#accessToken = options.accessToken;
    this.#accountId = options.accountId;
    this.#apiBaseUrl = options.apiBaseUrl;
    this.#availableModels = options.availableModels;
    this.#fetcher = options.fetcher;
    this.#originator = options.originator;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#userAgent = options.userAgent;
  }

  async complete(request: LLMCallerRequest): Promise<LLMCallerResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    const handleExternalAbort = () => controller.abort();
    attachAbortListener(request.signal, controller, handleExternalAbort);

    try {
      const requestBody: {
        input: Array<{
          content: Array<{
            text: string;
            type: 'input_text';
          }>;
          role: 'user';
        }>;
        instructions: string;
        model: string;
        store: false;
        stream: true;
      } = {
        input: [
          {
            content: [
              {
                text: request.input,
                type: 'input_text',
              },
            ],
            role: 'user',
          },
        ],
        instructions: request.systemPrompt,
        model: request.model,
        store: false,
        stream: true,
      };
      requestBody.model = resolveCodexModelId(request.model, this.#availableModels);

      for (let attempt = 0;; attempt += 1) {
        const response = await this.#fetcher(
          buildResponsesUrl(this.#apiBaseUrl),
          {
            body: JSON.stringify(requestBody),
            headers: {
              Authorization: `Bearer ${this.#accessToken}`,
              'Content-Type': 'application/json',
              'chatgpt-account-id': this.#accountId,
              originator: this.#originator,
              'User-Agent': this.#userAgent,
            },
            method: 'POST',
            signal: controller.signal,
          },
        );
        const rawText = await response.text();
        const rawPayload = parseCodexResponseBody(rawText);
        const statusFallback = `Codex OAuth request failed with status ${response.status}.`;
        const payload = (typeof rawPayload === 'object' && rawPayload !== null
          ? rawPayload
          : {}) as CodexResponsePayload;
        const rawPayloadIsEmptyObject = typeof rawPayload === 'object' &&
          rawPayload !== null &&
          !Array.isArray(rawPayload) &&
          Object.keys(rawPayload).length === 0;
        let providerMessage = extractStructuredErrorMessage(rawPayload, statusFallback);
        if (
          (providerMessage === statusFallback || rawPayloadIsEmptyObject) &&
          typeof rawText === 'string' &&
          rawText.trim().length > 0
        ) {
          providerMessage = `${statusFallback} raw=${rawText.trim()}`;
        }

        if (!response.ok) {
          throw new Error(providerMessage);
        }

        if (
          typeof payload.error === 'object' && payload.error !== null &&
          typeof payload.error.message === 'string'
        ) {
          throw new Error(providerMessage);
        }

        try {
          const outputText = extractCallerOutputText(payload);
          cleanupCompletionRequest(timer, request.signal, handleExternalAbort);
          return {
            outputText,
            turnState: typeof payload.id === 'string' ? payload.id : undefined,
            usage: normalizeUsage(payload),
          };
        } catch (error) {
          const normalizedError = error instanceof Error ? error : new Error(String(error));
          const rawPayloadText = serializeRawResponsePayload(rawPayload, rawText);
          if (attempt < EMPTY_ASSISTANT_TEXT_RETRY_COUNT) {
            continue;
          }

          throw new Error(
            `${normalizedError.message} after ${attempt + 1} attempts raw=${rawPayloadText}`,
          );
        }
      }
      // deno-fmt-ignore
    } catch (error) { const thrownError = error;
      cleanupCompletionRequest(timer, request.signal, handleExternalAbort);

      if (thrownError instanceof DOMException && thrownError.name === 'AbortError') {
        throw new Error(`Codex OAuth request timed out after ${this.#requestTimeoutMs}ms.`);
      }

      throw thrownError instanceof Error ? thrownError : new Error(String(thrownError));
    }
  }
}

/**
 * Provides interactive Codex OAuth login, persisted auth reuse, and provider-neutral callers.
 *
 * The provider stores one reusable OAuth session on disk, refreshes expired tokens,
 * lists the exact Codex model ids visible to the current account, and produces
 * `LLMCaller` instances that plug directly into the provider-neutral RLM core.
 *
 * @example
 * ```ts
 * const provider = new CodexOAuthProvider({
 *   storagePath: './.rlm/codex-oauth.json',
 * });
 *
 * await provider.login();
 * const models = await provider.listModels();
 * const llm = provider.createCaller({ requestTimeoutMs: 45_000 });
 * ```
 */
export class CodexOAuthProvider implements LLMProvider<CodexOAuthCallerConfig> {
  readonly #apiBaseUrl: string;
  readonly #authBaseUrl: string;
  readonly #callbackPort: number;
  readonly #clientId: string;
  readonly #clock: () => Date;
  readonly #createCodeVerifier: () => string | Promise<string>;
  readonly #createState: () => string;
  readonly #fetcher: FetchLike;
  readonly #mkdir: NonNullable<CodexOAuthProviderOptions['mkdir']>;
  readonly #originator: string;
  readonly #openUrl?: (url: string) => void | Promise<void>;
  readonly #readTextFile: NonNullable<CodexOAuthProviderOptions['readTextFile']>;
  readonly #receiveAuthorizationCode: CodexOAuthAuthorizationReceiver;
  readonly #storagePath: string;
  readonly #userAgent: string;
  readonly #writeTextFile: NonNullable<CodexOAuthProviderOptions['writeTextFile']>;

  /**
   * Captures the provider wiring, storage path, and optional interactive login hooks.
   */
  constructor(options: CodexOAuthProviderOptions = {}) {
    this.#apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.#authBaseUrl = options.authBaseUrl ?? DEFAULT_AUTH_BASE_URL;
    this.#callbackPort = options.callbackPort ?? DEFAULT_CALLBACK_PORT;
    this.#clientId = options.clientId ?? DEFAULT_CLIENT_ID;
    this.#clock = resolveClock(options.clock);
    this.#createCodeVerifier = options.createCodeVerifier ?? createRandomVerifier;
    this.#createState = options.createState ?? createRandomState;
    this.#fetcher = options.fetcher ?? fetch;
    this.#mkdir = resolveMkdir(options.mkdir);
    this.#originator = options.originator ?? DEFAULT_ORIGINATOR;
    this.#openUrl = options.openUrl;
    this.#readTextFile = resolveReadTextFile(options.readTextFile);
    this.#receiveAuthorizationCode = options.receiveAuthorizationCode ??
      defaultReceiveAuthorizationCode;
    this.#storagePath = resolveStoragePath(options.storagePath);
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#writeTextFile = resolveWriteTextFile(options.writeTextFile);
  }

  /**
   * Loads the persisted auth record, or returns `null` when the file does not exist yet.
   */
  async loadAuth(): Promise<CodexOAuthAuthRecord | null> {
    try {
      const text = await this.#readTextFile(this.#storagePath);
      const parsed = JSON.parse(text) as CodexOAuthAuthRecord | LegacyCodexOAuthAuthRecord;
      const normalized = normalizeAuthRecord(parsed);
      if ('apiKey' in parsed || parsed.version !== 2) {
        await this.saveAuth(normalized);
      }
      return normalized;
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }

      throw error;
    }
  }

  /**
   * Stores the latest auth record so later CLI runs can reuse the same login.
   */
  async saveAuth(record: CodexOAuthAuthRecord): Promise<void> {
    await this.#mkdir(dirnameFilePath(this.#storagePath), { recursive: true });
    await this.#writeTextFile(this.#storagePath, JSON.stringify(record, null, 2));
  }

  /**
   * Performs the interactive browser login flow and persists the resulting auth state.
   *
   * The provider emits the authorization URL through `onAuthUrl`, optionally opens
   * it through `openUrl`, waits for the callback code, and then exchanges that code
   * for the reusable OAuth token bundle stored on disk.
   */
  async login(options: CodexOAuthLoginOptions = {}): Promise<CodexOAuthAuthRecord> {
    if (options.force !== true) {
      const existing = await this.loadAuth();
      if (existing !== null && !isAuthExpired(existing, this.#clock())) {
        return existing;
      }
    }

    const redirectUri = `http://localhost:${this.#callbackPort}/auth/callback`;
    const state = this.#createState();
    const codeVerifier = await this.#createCodeVerifier();
    const codeChallenge = await createCodeChallenge(codeVerifier);
    const authUrl = await buildAuthorizeUrl({
      authBaseUrl: this.#authBaseUrl,
      clientId: this.#clientId,
      codeChallenge,
      originator: this.#originator,
      redirectUri,
      state,
    });

    await options.onAuthUrl?.(authUrl);
    await this.#openUrl?.(authUrl);
    const callback = await (options.receiveAuthorizationCode ?? this.#receiveAuthorizationCode)({
      authUrl,
      callbackPort: this.#callbackPort,
      redirectUri,
      state,
    });

    if (callback.state !== state) {
      throw new Error('Codex OAuth callback state mismatch.');
    }

    const tokens = await exchangeCodeForTokens(this.#fetcher, {
      authBaseUrl: this.#authBaseUrl,
      clientId: this.#clientId,
      code: callback.code,
      codeVerifier,
      redirectUri,
    });
    if (tokens.accountId === null || tokens.accountId.length === 0) {
      throw new Error('Codex OAuth login did not yield an account ID in the access token.');
    }

    const record: CodexOAuthAuthRecord = {
      apiBaseUrl: this.#apiBaseUrl,
      authBaseUrl: this.#authBaseUrl,
      clientId: this.#clientId,
      provider: 'codex-oauth',
      tokens,
      updatedAt: this.#clock().toISOString(),
      version: 2,
    };

    await this.saveAuth(record);
    return record;
  }

  async #refreshAuth(record: CodexOAuthAuthRecord): Promise<CodexOAuthAuthRecord> {
    const tokens = await refreshTokens(this.#fetcher, {
      authBaseUrl: record.authBaseUrl,
      clientId: record.clientId,
      refreshToken: record.tokens.refreshToken,
    });
    if (tokens.accountId === null || tokens.accountId.length === 0) {
      throw new Error('Codex OAuth refresh did not yield an account ID in the access token.');
    }

    const refreshed: CodexOAuthAuthRecord = {
      ...record,
      tokens,
      updatedAt: this.#clock().toISOString(),
      version: 2,
    };
    await this.saveAuth(refreshed);
    return refreshed;
  }

  /**
   * Ensures a reusable auth record exists and refreshes it when the stored tokens have expired.
   */
  async ensureAuth(): Promise<CodexOAuthAuthRecord> {
    const record = await this.loadAuth();
    if (record === null) {
      throw new Error('Codex OAuth login is required before this command can run.');
    }

    if (isAuthExpired(record, this.#clock())) {
      return await this.#refreshAuth(record);
    }

    if (record.tokens.accessToken.length === 0) {
      return await this.#refreshAuth(record);
    }

    return record;
  }

  /**
   * Lists the exact Codex model identifiers visible through the stored OAuth session.
   *
   * These ids are the values to pass back into standalone `--root-model` / `--sub-model`
   * overrides or into `LLMCallerRequest.model`.
   */
  async listModels(): Promise<string[]> {
    const auth = await this.ensureAuth();
    if (auth.tokens.accountId === null || auth.tokens.accountId.length === 0) {
      throw new Error('Codex OAuth model listing requires an account ID.');
    }
    for (let attempt = 0;; attempt += 1) {
      const response = await this.#fetcher(
        buildModelListUrl(auth.apiBaseUrl),
        {
          headers: {
            Authorization: `Bearer ${auth.tokens.accessToken}`,
            'chatgpt-account-id': auth.tokens.accountId,
            originator: this.#originator,
            'User-Agent': this.#userAgent,
          },
          method: 'GET',
        },
      );
      const rawText = await response.text();
      const payload = parseModelListPayload(rawText);

      if (!response.ok) {
        const fallback = `Model listing failed with status ${response.status}.`;
        const message = payload === null
          ? `${fallback} raw=${rawText.trim() || '(empty)'}`
          : extractStructuredErrorMessage(payload, fallback);
        if (payload === null && attempt < MODEL_LIST_RETRY_COUNT) {
          continue;
        }

        throw new Error(message);
      }

      if (payload === null) {
        if (attempt < MODEL_LIST_RETRY_COUNT) {
          continue;
        }

        throw new Error(formatInvalidModelListPayloadMessage(rawText));
      }

      return normalizeModelIds(payload);
    }
  }

  /**
   * Creates a provider-neutral caller that reuses the stored Codex OAuth auth state.
   *
   * The returned caller validates each request against the live Codex model catalog and
   * applies the provider-side request timeout from `config.requestTimeoutMs`.
   */
  createCaller(config: CodexOAuthCallerConfig = {}): LLMCaller {
    let modelsPromise: Promise<string[]> | null = null;
    return {
      complete: async (request) => {
        const auth = await this.ensureAuth();
        if (auth.tokens.accountId === null || auth.tokens.accountId.length === 0) {
          throw new Error('Codex OAuth calls require an account ID.');
        }
        if (modelsPromise === null) {
          modelsPromise = this.listModels().catch((error) => {
            modelsPromise = null;
            throw error;
          });
        }
        const caller = new CodexOAuthCaller({
          accessToken: auth.tokens.accessToken,
          accountId: auth.tokens.accountId,
          apiBaseUrl: auth.apiBaseUrl,
          availableModels: await modelsPromise,
          fetcher: this.#fetcher,
          originator: this.#originator,
          requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
          userAgent: this.#userAgent,
        });
        return await caller.complete(request);
      },
    };
  }
}

export const __codexOAuthProviderTestables = {
  attachAbortListener,
  buildAuthorizeUrl,
  buildModelListUrl,
  buildResponsesUrl,
  cleanupCompletionRequest,
  createCodeChallenge,
  createRandomState,
  createRandomVerifier,
  defaultReceiveAuthorizationCode,
  detachAbortListener,
  extractCallerOutputText,
  extractAuthorizationCodeFromCallbackUrl,
  extractAccountId,
  extractExpiryIso,
  extractOrganizationId,
  extractOutputTextOrNull,
  extractStructuredErrorMessage,
  isAuthExpired,
  normalizeCodexResponsePayload,
  normalizeAuthRecord,
  normalizeModelIds,
  parseModelListPayload,
  normalizeStreamedCodexPayload,
  normalizeUsage,
  formatInvalidModelListPayloadMessage,
  parseCodexResponseBody,
  parseServerSentEventPayload,
  resolveCodexModelId,
  resolveStoragePath,
  serializeRawResponsePayload,
  tryParseJson,
};
