import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';

import {
  __codexOAuthProviderTestables,
  type CodexOAuthAuthRecord,
  CodexOAuthProvider,
} from '../src/providers/codex_oauth.ts';

interface LegacyCodexOAuthAuthRecord {
  apiBaseUrl: string;
  apiKey: string;
  authBaseUrl: string;
  clientId: string;
  provider: 'codex-oauth';
  tokens: CodexOAuthAuthRecord['tokens'];
  updatedAt: string;
  version: 1;
}

function createClock(start = Date.parse('2026-03-27T00:00:00.000Z')): () => Date {
  let current = start;
  return () => {
    const value = new Date(current);
    current += 1_000;
    return value;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

function createIdToken(overrides: Record<string, unknown> = {}): string {
  return createJwt({
    'https://api.openai.com/auth': {
      organization_id: 'org-test',
      chatgpt_account_id: 'acct-test',
    },
    exp: Math.floor(Date.parse('2026-03-27T01:00:00.000Z') / 1_000),
    ...overrides,
  });
}

function createAccessToken(expiryIso = '2026-03-27T01:00:00.000Z'): string {
  return createJwt({
    exp: Math.floor(Date.parse(expiryIso) / 1_000),
  });
}

function createStoredAuth(overrides: Partial<CodexOAuthAuthRecord> = {}): CodexOAuthAuthRecord {
  return {
    apiBaseUrl: 'https://chatgpt.com/backend-api',
    authBaseUrl: 'https://auth.openai.com',
    clientId: 'client-test',
    provider: 'codex-oauth',
    tokens: {
      accessToken: createAccessToken(),
      accountId: 'acct-test',
      expiresAt: '2026-03-27T01:00:00.000Z',
      idToken: createIdToken(),
      organizationId: 'org-test',
      refreshToken: 'refresh-test',
    },
    updatedAt: '2026-03-27T00:00:00.000Z',
    version: 2,
    ...overrides,
  };
}

function createLegacyStoredAuth(
  overrides: Partial<LegacyCodexOAuthAuthRecord> = {},
): LegacyCodexOAuthAuthRecord {
  return {
    apiBaseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-cached',
    authBaseUrl: 'https://auth.openai.com',
    clientId: 'client-test',
    provider: 'codex-oauth',
    tokens: createStoredAuth().tokens,
    updatedAt: '2026-03-27T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

Deno.test('Codex OAuth helpers build authorize URLs and parse JWT-derived state deterministically', async () => {
  const authorizeUrl = await __codexOAuthProviderTestables.buildAuthorizeUrl({
    authBaseUrl: 'https://auth.openai.com',
    clientId: 'client-test',
    codeChallenge: 'challenge-test',
    originator: 'rlm',
    redirectUri: 'http://localhost:1455/auth/callback',
    state: 'state-test',
  });

  const parsed = new URL(authorizeUrl);
  assert.equal(parsed.origin, 'https://auth.openai.com');
  assert.equal(parsed.pathname, '/oauth/authorize');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('client_id'), 'client-test');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assert.equal(
    parsed.searchParams.get('scope'),
    'openid profile email offline_access',
  );
  assert.equal(parsed.searchParams.get('code_challenge'), 'challenge-test');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('codex_cli_simplified_flow'), 'true');
  assert.equal(parsed.searchParams.get('originator'), 'rlm');
  assert.equal(parsed.searchParams.get('state'), 'state-test');

  assert.equal(__codexOAuthProviderTestables.extractAccountId(createIdToken()), 'acct-test');
  assert.equal(
    __codexOAuthProviderTestables.extractOrganizationId(createIdToken()),
    'org-test',
  );
  assert.equal(
    __codexOAuthProviderTestables.extractExpiryIso(createAccessToken()),
    '2026-03-27T01:00:00.000Z',
  );
  assert.equal(__codexOAuthProviderTestables.extractAccountId('not-a-jwt'), null);
  assert.equal(__codexOAuthProviderTestables.extractOrganizationId('not-a-jwt'), null);
  assert.equal(__codexOAuthProviderTestables.extractExpiryIso('not-a-jwt'), null);
  assert.ok(__codexOAuthProviderTestables.createRandomVerifier().length > 0);
  assert.ok(__codexOAuthProviderTestables.createRandomState().length > 0);
  assert.equal(
    __codexOAuthProviderTestables.buildModelListUrl('https://chatgpt.com/backend-api/'),
    'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0',
  );
  assert.equal(
    __codexOAuthProviderTestables.buildResponsesUrl('https://chatgpt.com/backend-api/'),
    'https://chatgpt.com/backend-api/codex/responses',
  );
});

Deno.test('Codex OAuth helpers cover streamed payload parsing, structured errors, and raw payload serialization', async () => {
  assert.deepEqual(__codexOAuthProviderTestables.tryParseJson('{"ok":true}'), { ok: true });
  assert.equal(__codexOAuthProviderTestables.tryParseJson('not-json'), 'not-json');
  assert.deepEqual(
    __codexOAuthProviderTestables.parseServerSentEventPayload([
      '\n\n',
      '',
      'event: response.created',
      'data: {"type":"response.created"}',
      '',
      'event: ignored',
      'data: [DONE]',
      '',
      'event: plain',
      'data: hello',
      '',
      'event: missing-data',
      'id: 1',
      '',
    ].join('\n')),
    [{ type: 'response.created' }, 'hello'],
  );
  assert.deepEqual(
    __codexOAuthProviderTestables.parseServerSentEventPayload(
      'event: numeric\ndata: 42\n',
    ),
    [42],
  );

  assert.deepEqual(
    __codexOAuthProviderTestables.normalizeStreamedCodexPayload([
      'event: noop',
      'data: 42',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":null}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"type":"reasoning","content":[{"type":"summary","text":"skip"}]}}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"type":"message","content":[{"type":"output_text","text":{"value":"alpha"}}]}}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"type":"message","content":[null,{"type":"summary","text":"skip"},{"type":"text","text":"gamma"}]}}',
      '',
      'event: response.content_part.done',
      'data: {"type":"response.content_part.done","part":{"type":"text","text":"beta"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp-1","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}',
    ].join('\n')),
    {
      id: 'resp-1',
      output_text: 'alphagammabeta',
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    },
  );
  assert.deepEqual(
    __codexOAuthProviderTestables.normalizeStreamedCodexPayload(
      'event: response.content_part.added\ndata: {"type":"response.content_part.added","part":{"type":"output_text","text":{}}}\n',
    ),
    {},
  );
  assert.deepEqual(
    __codexOAuthProviderTestables.normalizeStreamedCodexPayload(
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","content":{"type":"output_text","text":"skip"}}}\n',
    ),
    {},
  );
  assert.equal(
    __codexOAuthProviderTestables.extractOutputTextOrNull({
      output: [{
        content: [{
          text: { value: 'object text value' },
          type: 'output_text',
        }],
        type: 'message',
      }],
    }),
    'object text value',
  );
  assert.deepEqual(
    __codexOAuthProviderTestables.normalizeStreamedCodexPayload(
      'event: response.created\ndata: {"type":"response.created"}\n',
    ),
    {},
  );

  assert.deepEqual(
    __codexOAuthProviderTestables.normalizeStreamedCodexPayload(
      'event: error\ndata: {"type":"error","error_description":{"message":"stream failed"}}\n',
    ),
    {
      error: {
        message: 'stream failed',
      },
    },
  );

  assert.deepEqual(
    __codexOAuthProviderTestables.parseCodexResponseBody(''),
    {},
  );
  assert.deepEqual(
    __codexOAuthProviderTestables.parseCodexResponseBody(
      '{"output":[{"type":"message","content":[{"type":"output_text","text":{"value":"pong"}}]}]}',
    ),
    {
      output: [{ content: [{ text: { value: 'pong' }, type: 'output_text' }], type: 'message' }],
      output_text: 'pong',
    },
  );
  assert.deepEqual(
    __codexOAuthProviderTestables.parseCodexResponseBody(
      'event: response.output_text.done\ndata: {"type":"response.output_text.done","text":"PONG"}\n',
    ),
    { output_text: 'PONG' },
  );
  assert.equal(
    __codexOAuthProviderTestables.formatThrownErrorMessage(new Error('structured failure')),
    'structured failure',
  );
  assert.equal(
    __codexOAuthProviderTestables.formatThrownErrorMessage('string failure'),
    'string failure',
  );
  assert.equal(
    __codexOAuthProviderTestables.parseCodexResponseBody('123'),
    123,
  );

  assert.equal(
    __codexOAuthProviderTestables.extractOutputTextOrNull({
      output: [
        {
          content: [{ text: { value: 'pong' }, type: 'text' }],
          type: 'message',
        },
      ],
    }),
    'pong',
  );
  assert.equal(
    __codexOAuthProviderTestables.extractOutputTextOrNull({
      output: [
        {
          content: [{ text: { value: 42 } as never, type: 'text' }],
          type: 'message',
        },
      ],
    }),
    null,
  );
  assert.equal(
    __codexOAuthProviderTestables.extractOutputTextOrNull({
      output: [
        { content: { type: 'output_text', text: 'skip' } as never, type: 'message' },
      ],
    }),
    null,
  );
  assert.equal(
    __codexOAuthProviderTestables.extractOutputTextOrNull({
      output: [
        {
          content: [{ text: 'skip', type: 'summary' }],
          type: 'message',
        },
      ],
    }),
    null,
  );
  assert.deepEqual(
    __codexOAuthProviderTestables.normalizeCodexResponsePayload({
      output: [
        {
          content: [{ text: 'pong', type: 'output_text' }],
          type: 'message',
        },
      ],
    }),
    {
      output: [
        {
          content: [{ text: 'pong', type: 'output_text' }],
          type: 'message',
        },
      ],
      output_text: 'pong',
    },
  );
  assert.equal(
    __codexOAuthProviderTestables.extractCallerOutputText({
      output_text: 'pong',
    }),
    'pong',
  );
  assert.deepEqual(
    __codexOAuthProviderTestables.normalizeUsage({
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens: 4,
        total_tokens: 14,
      },
    }),
    {
      cachedInputTokens: 2,
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    },
  );
  assert.equal(
    __codexOAuthProviderTestables.normalizeUsage({}),
    undefined,
  );

  assert.equal(
    __codexOAuthProviderTestables.extractStructuredErrorMessage('direct message', 'fallback'),
    'direct message',
  );
  assert.equal(
    __codexOAuthProviderTestables.extractStructuredErrorMessage(42, 'fallback'),
    'fallback',
  );
  assert.equal(
    __codexOAuthProviderTestables.extractStructuredErrorMessage(
      { error_description: { error: { message: 'nested failure' } } },
      'fallback',
    ),
    'nested failure',
  );

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(
    __codexOAuthProviderTestables.extractStructuredErrorMessage(circular, 'fallback'),
    'fallback',
  );
  assert.equal(
    __codexOAuthProviderTestables.serializeRawResponsePayload(circular, ''),
    '[object Object]',
  );
  assert.equal(
    __codexOAuthProviderTestables.serializeRawResponsePayload({ ok: true }, ' raw body '),
    'raw body',
  );
  assert.equal(
    __codexOAuthProviderTestables.extractAccountId(createJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: '',
      },
    })),
    null,
  );
  assert.deepEqual(
    __codexOAuthProviderTestables.normalizeModelIds({
      categories: [{ models: [{ id: 'gpt-5-3-instant' }] }],
      data: { invalid: true } as unknown as Array<{ id?: string; slug?: string }>,
      models: { invalid: true } as unknown as Array<{ id?: string; slug?: string }>,
    }),
    ['gpt-5-3-instant'],
  );
  assert.deepEqual(
    __codexOAuthProviderTestables.normalizeModelIds({
      categories: [{ models: 'invalid' as never }],
      data: [{ id: 'gpt-5-4-t-mini' }, { slug: 'gpt-5-4-thinking' }],
      models: [{ id: 'gpt-5-4-t-mini' }, { id: '', slug: '' }, {}],
    }),
    ['gpt-5-4-t-mini', 'gpt-5-4-thinking'],
  );
});

Deno.test('Codex OAuth helpers cover organization fallbacks, auth expiry, model validation, and callback servers', async () => {
  const orgViaOrganizations = createJwt({
    'https://api.openai.com/auth': {
      organizations: [{ id: 'org-from-array' }],
    },
  });
  assert.equal(
    __codexOAuthProviderTestables.extractOrganizationId(orgViaOrganizations),
    'org-from-array',
  );
  assert.equal(
    __codexOAuthProviderTestables.extractOrganizationId(createJwt({
      'https://api.openai.com/auth': {
        organizations: [null, { missing: true }],
      },
    })),
    null,
  );
  assert.equal(__codexOAuthProviderTestables.extractExpiryIso('a.b!.c'), null);
  assert.equal(
    __codexOAuthProviderTestables.isAuthExpired(
      createStoredAuth({
        tokens: {
          ...createStoredAuth().tokens,
          expiresAt: null,
        },
      }),
      new Date('2026-03-27T00:00:00.000Z'),
    ),
    false,
  );
  assert.throws(
    () => __codexOAuthProviderTestables.resolveCodexModelId('   ', ['gpt-5-4-t-mini']),
    /non-empty model identifier/u,
  );
  assert.throws(
    () =>
      __codexOAuthProviderTestables.resolveCodexModelId(undefined as unknown as string, [
        'gpt-5-4-t-mini',
      ]),
    /non-empty model identifier/u,
  );
  assert.equal(
    __codexOAuthProviderTestables.resolveCodexModelId('gpt-5-4-t-mini', ['gpt-5-4-t-mini']),
    'gpt-5-4-t-mini',
  );

  const immediateAbortController = new AbortController();
  immediateAbortController.abort();
  const immediateAbortTarget = new AbortController();
  __codexOAuthProviderTestables.attachAbortListener(
    immediateAbortController.signal,
    immediateAbortTarget,
    () => {},
  );
  assert.equal(immediateAbortTarget.signal.aborted, true);

  const attachedController = new AbortController();
  const externalController = new AbortController();
  __codexOAuthProviderTestables.attachAbortListener(
    externalController.signal,
    attachedController,
    () => attachedController.abort(),
  );
  externalController.abort();
  assert.equal(attachedController.signal.aborted, true);

  let cleanupCalls = 0;
  const cleanupController = new AbortController();
  const cleanupTimer = setTimeout(() => {
    cleanupCalls += 10;
  }, 50);
  const onAbort = () => {
    cleanupCalls += 1;
  };
  cleanupController.signal.addEventListener('abort', onAbort, { once: true });
  __codexOAuthProviderTestables.cleanupCompletionRequest(
    cleanupTimer,
    cleanupController.signal,
    onAbort,
  );
  cleanupController.abort();
  assert.equal(cleanupCalls, 0);

  const originalServe = Deno.serve;
  let handler:
    | ((request: Request) => Response | Promise<Response>)
    | undefined;
  let resolveFinished: (() => void) | undefined;

  try {
    Object.defineProperty(Deno, 'serve', {
      configurable: true,
      value: (
        _options: unknown,
        suppliedHandler: (request: Request) => Response | Promise<Response>,
      ) => {
        handler = suppliedHandler;
        return {
          finished: new Promise<void>((resolve) => {
            resolveFinished = resolve;
          }),
        };
      },
    });

    const receiverPromise = __codexOAuthProviderTestables.defaultReceiveAuthorizationCode({
      authUrl: 'https://auth.example.test/login',
      callbackPort: 1455,
      redirectUri: 'http://localhost:1455/auth/callback',
      state: 'state-test',
    });

    const probeResponse = await handler!(
      new Request('http://localhost:1455/auth/callback?state=state-test'),
    );
    assert.equal(probeResponse.status, 202);

    const finalResponse = await handler!(
      new Request('http://localhost:1455/auth/callback?code=code-test&state=state-test'),
    );
    assert.equal(finalResponse.status, 200);
    resolveFinished?.();

    assert.deepEqual(await receiverPromise, {
      code: 'code-test',
      state: 'state-test',
    });
  } finally {
    Object.defineProperty(Deno, 'serve', {
      configurable: true,
      value: originalServe,
    });
  }
});

Deno.test('Codex OAuth filesystem and model-list helpers cover explicit, Deno-default, and node-fallback branches', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-fs-' });
  const nestedDir = join(root, 'nested');
  const filePath = join(nestedDir, 'state.txt');
  const originalMkdir = Deno.mkdir;
  const originalReadTextFile = Deno.readTextFile;
  const originalWriteTextFile = Deno.writeTextFile;

  const customRead = async () => 'custom-read';
  const customWrite = async () => {};
  const customMkdir = async () => {};
  assert.equal(__codexOAuthProviderTestables.resolveReadTextFile(customRead), customRead);
  assert.equal(__codexOAuthProviderTestables.resolveWriteTextFile(customWrite), customWrite);
  assert.equal(__codexOAuthProviderTestables.resolveMkdir(customMkdir), customMkdir);

  const resolvedMkdir = __codexOAuthProviderTestables.resolveMkdir(undefined);
  await resolvedMkdir(nestedDir, { recursive: true });

  const resolvedWrite = __codexOAuthProviderTestables.resolveWriteTextFile(undefined);
  await resolvedWrite(filePath, 'persisted');

  const resolvedRead = __codexOAuthProviderTestables.resolveReadTextFile(undefined);
  assert.equal(await resolvedRead(filePath), 'persisted');

  try {
    Object.defineProperty(Deno, 'readTextFile', {
      configurable: true,
      value: undefined,
      writable: true,
    });
    Object.defineProperty(Deno, 'writeTextFile', {
      configurable: true,
      value: undefined,
      writable: true,
    });
    Object.defineProperty(Deno, 'mkdir', {
      configurable: true,
      value: undefined,
      writable: true,
    });
    const nodeFsCalls: string[] = [];
    const importBuiltin = (async (specifier: string) => {
      assert.equal(specifier, 'fs/promises');
      return {
        mkdir: async (path: string) => {
          nodeFsCalls.push(`mkdir:${path}`);
        },
        readFile: async (path: string) => {
          nodeFsCalls.push(`read:${path}`);
          return 'node-read';
        },
        writeFile: async (path: string, data: string) => {
          nodeFsCalls.push(`write:${path}:${data}`);
        },
      };
    }) as typeof __codexOAuthProviderTestables.resolveReadTextFile extends (
      file: unknown,
      importer: infer T,
    ) => unknown ? T
      : never;
    const injectedMkdir = __codexOAuthProviderTestables.resolveMkdir(undefined, importBuiltin);
    await injectedMkdir(join(root, 'injected-dir'), { recursive: true });
    const injectedWrite = __codexOAuthProviderTestables.resolveWriteTextFile(
      undefined,
      importBuiltin,
    );
    await injectedWrite(join(root, 'injected.txt'), 'node-write');
    const injectedRead = __codexOAuthProviderTestables.resolveReadTextFile(
      undefined,
      importBuiltin,
    );
    assert.equal(await injectedRead(join(root, 'injected.txt')), 'node-read');
    assert.deepEqual(nodeFsCalls, [
      `mkdir:${join(root, 'injected-dir')}`,
      `write:${join(root, 'injected.txt')}:node-write`,
      `read:${join(root, 'injected.txt')}`,
    ]);
    Object.defineProperty(Deno, 'mkdir', {
      configurable: true,
      value: originalMkdir,
      writable: true,
    });

    const nodeFallbackDir = join(root, 'node-fallback');
    const nodeFallbackFile = join(nodeFallbackDir, 'state.txt');
    const fallbackMkdir = __codexOAuthProviderTestables.resolveMkdir(undefined);
    await fallbackMkdir(nodeFallbackDir, { recursive: true });

    const fallbackWrite = __codexOAuthProviderTestables.resolveWriteTextFile(undefined);
    await fallbackWrite(nodeFallbackFile, 'node-persisted');

    const fallbackRead = __codexOAuthProviderTestables.resolveReadTextFile(undefined);
    assert.equal(await fallbackRead(nodeFallbackFile), 'node-persisted');
  } finally {
    Object.defineProperty(Deno, 'mkdir', {
      configurable: true,
      value: originalMkdir,
      writable: true,
    });
    Object.defineProperty(Deno, 'readTextFile', {
      configurable: true,
      value: originalReadTextFile,
      writable: true,
    });
    Object.defineProperty(Deno, 'writeTextFile', {
      configurable: true,
      value: originalWriteTextFile,
      writable: true,
    });
  }

  assert.equal(
    __codexOAuthProviderTestables.parseModelListPayload('   '),
    null,
  );
  assert.equal(
    __codexOAuthProviderTestables.parseModelListPayload('[]'),
    null,
  );
  assert.equal(
    __codexOAuthProviderTestables.formatInvalidModelListPayloadMessage('   '),
    'Codex OAuth model listing returned an invalid response payload.',
  );
  assert.match(
    __codexOAuthProviderTestables.formatInvalidModelListPayloadMessage(' <html>bad</html> '),
    /raw=<html>bad<\/html>/u,
  );
});

Deno.test('Codex OAuth default authorization receiver covers the node-http callback path without Deno.serve', async () => {
  const responseStatusCodes: number[] = [];
  const responseBodies: string[] = [];
  let capturedHandler:
    | ((request: { headers: { host?: string }; url?: string }, response: {
      end(text?: string, callback?: () => void): void;
      writeHead(statusCode: number, headers: Record<string, string>): void;
    }) => void)
    | undefined;
  let connectionListener:
    | ((socket: { destroy(): void; once(event: 'close', listener: () => void): void }) => void)
    | undefined;
  let closeCalls = 0;
  let destroyedSockets = 0;
  const receiverPromise = __codexOAuthProviderTestables.defaultReceiveAuthorizationCode(
    {
      authUrl: 'https://auth.example.test/login',
      callbackPort: 1456,
      redirectUri: 'http://localhost:1456/auth/callback',
      state: 'state-test',
    },
    (async (specifier: string) => {
      assert.equal(specifier, 'http');
      return {
        createServer: (
          handler: typeof capturedHandler extends undefined ? never
            : NonNullable<typeof capturedHandler>,
        ) => {
          capturedHandler = handler;
          return {
            close: () => {
              closeCalls += 1;
            },
            listen: () => {},
            on: (
              event: 'connection' | 'error',
              listener:
                | ((socket: {
                  destroy(): void;
                  once(event: 'close', listener: () => void): void;
                }) => void)
                | ((error: Error) => void),
            ) => {
              if (event === 'connection') {
                connectionListener = listener as typeof connectionListener;
              }
            },
          };
        },
      };
    }) as typeof __codexOAuthProviderTestables.defaultReceiveAuthorizationCode extends (
      session: unknown,
      importer: infer T,
      denoServe: infer _U,
    ) => unknown ? T
      : never,
    false,
  );

  await Promise.resolve();
  assert.ok(capturedHandler !== undefined);

  let closedSocketListener: (() => void) | undefined;
  const closedSocket = {
    destroy: () => {
      destroyedSockets += 1;
    },
    once: (_event: 'close', listener: () => void) => {
      closedSocketListener = listener;
    },
  };
  connectionListener?.(closedSocket);
  closedSocketListener?.();

  const openSocket = {
    destroy: () => {
      destroyedSockets += 1;
    },
    once: (_event: 'close', _listener: () => void) => {},
  };
  connectionListener?.(openSocket);

  capturedHandler(
    {
      headers: {},
    },
    {
      end: (text?: string) => {
        responseBodies.push(text ?? '');
      },
      writeHead: (statusCode) => {
        responseStatusCodes.push(statusCode);
      },
    },
  );

  capturedHandler(
    {
      headers: { host: '127.0.0.1:1456' },
      url: '/auth/callback?state=state-test',
    },
    {
      end: (text?: string) => {
        responseBodies.push(text ?? '');
      },
      writeHead: (statusCode) => {
        responseStatusCodes.push(statusCode);
      },
    },
  );

  capturedHandler(
    {
      headers: { host: '127.0.0.1:1456' },
      url: '/auth/callback?code=code-test&state=state-test',
    },
    {
      end: (text?: string, callback?: () => void) => {
        responseBodies.push(text ?? '');
        callback?.();
      },
      writeHead: (statusCode) => {
        responseStatusCodes.push(statusCode);
      },
    },
  );

  assert.deepEqual(await receiverPromise, {
    code: 'code-test',
    state: 'state-test',
  });

  assert.deepEqual(responseStatusCodes, [202, 202, 200]);
  assert.equal(responseBodies.length, 3);
  assert.equal(closeCalls >= 1, true);
  assert.equal(destroyedSockets, 1);
});

Deno.test('Codex OAuth callback helpers can extract code and state from pasted callback URLs and ignore incomplete callback probes', () => {
  assert.deepEqual(
    __codexOAuthProviderTestables.extractAuthorizationCodeFromCallbackUrl(
      'http://localhost:1455/auth/callback?code=code-test&state=state-test',
    ),
    {
      code: 'code-test',
      state: 'state-test',
    },
  );

  assert.equal(
    __codexOAuthProviderTestables.extractAuthorizationCodeFromCallbackUrl(
      'http://localhost:1455/auth/callback?state=state-test',
    ),
    null,
  );
  assert.equal(
    __codexOAuthProviderTestables.extractAuthorizationCodeFromCallbackUrl(
      'http://localhost:1455/auth/callback?code=code-test',
    ),
    null,
  );
  assert.equal(
    __codexOAuthProviderTestables.extractAuthorizationCodeFromCallbackUrl(
      'http://localhost:1455/auth/callback?foo=bar',
    ),
    null,
  );

  assert.throws(
    () =>
      __codexOAuthProviderTestables.extractAuthorizationCodeFromCallbackUrl(
        'not-a-valid-url',
      ),
    /callback URL/u,
  );
});

Deno.test('Codex OAuth provider login exchanges tokens and persists a reusable OAuth session record', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-login-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  const authorizeUrls: string[] = [];
  const requestBodies: string[] = [];

  const provider = new CodexOAuthProvider({
    clientId: 'client-test',
    clock: createClock(),
    createCodeVerifier: () => 'verifier-test',
    createState: () => 'state-test',
    fetcher: async (input, init) => {
      const url = String(input);
      const body = String((init as RequestInit | undefined)?.body ?? '');
      requestBodies.push(body);

      if (url.endsWith('/oauth/token')) {
        const form = new URLSearchParams(body);
        const grantType = form.get('grant_type');
        if (grantType === 'authorization_code') {
          assert.equal(form.get('code'), 'code-test');
          assert.equal(form.get('client_id'), 'client-test');
          assert.equal(form.get('code_verifier'), 'verifier-test');
          return jsonResponse({
            access_token: createAccessToken(),
            id_token: createIdToken(),
            refresh_token: 'refresh-from-login',
          });
        }
      }

      throw new Error(`Unexpected request: ${url} ${body}`);
    },
    receiveAuthorizationCode: async (session) => {
      authorizeUrls.push(session.authUrl);
      return {
        code: 'code-test',
        state: 'state-test',
      };
    },
    storagePath,
  });

  const record = await provider.login({
    onAuthUrl: (url) => {
      authorizeUrls.push(url);
    },
  });

  assert.equal(record.tokens.refreshToken, 'refresh-from-login');
  assert.equal(record.tokens.accountId, 'acct-test');
  assert.equal(record.tokens.organizationId, 'org-test');
  assert.equal(record.version, 2);
  assert.equal(authorizeUrls.length, 2);
  assert.equal(authorizeUrls[0], authorizeUrls[1]);
  assert.equal(requestBodies.length, 1);

  const stored = JSON.parse(await Deno.readTextFile(storagePath)) as CodexOAuthAuthRecord;
  assert.equal(stored.version, 2);
  assert.equal(stored.tokens.accountId, 'acct-test');
  assert.equal(stored.tokens.organizationId, 'org-test');
  assert.equal('apiKey' in stored, false);
});

Deno.test('Codex OAuth provider login can complete from a custom authorization receiver without waiting for the default local HTTP receiver', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-pasted-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  const requestBodies: string[] = [];

  const provider = new CodexOAuthProvider({
    clientId: 'client-test',
    clock: createClock(),
    createCodeVerifier: () => 'verifier-test',
    createState: () => 'state-test',
    fetcher: async (input, init) => {
      const url = String(input);
      const body = String((init as RequestInit | undefined)?.body ?? '');
      requestBodies.push(body);

      if (url.endsWith('/oauth/token')) {
        const form = new URLSearchParams(body);
        const grantType = form.get('grant_type');
        if (grantType === 'authorization_code') {
          assert.equal(form.get('code'), 'manual-code');
          return jsonResponse({
            access_token: createAccessToken(),
            id_token: createIdToken(),
            refresh_token: 'refresh-manual',
          });
        }
      }

      throw new Error(`Unexpected request: ${url} ${body}`);
    },
    receiveAuthorizationCode: async () => {
      throw new Error('manual callback login should not start the local receiver');
    },
    storagePath,
  });

  const record = await provider.login({
    receiveAuthorizationCode: async () => {
      const callback = __codexOAuthProviderTestables.extractAuthorizationCodeFromCallbackUrl(
        'http://localhost:1455/auth/callback?code=manual-code&state=state-test',
      );
      if (callback === null) {
        throw new Error('expected a complete pasted callback URL');
      }
      return callback;
    },
  });

  assert.equal(record.tokens.refreshToken, 'refresh-manual');
  assert.equal(record.tokens.organizationId, 'org-test');
  assert.equal(requestBodies.length, 1);
});

Deno.test('Codex OAuth provider login can derive expiry from the id token and optionally open the browser URL', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-login-open-url-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  const openedUrls: string[] = [];

  const provider = new CodexOAuthProvider({
    clientId: 'client-test',
    createCodeVerifier: () => 'verifier-test',
    createState: () => 'state-test',
    fetcher: async () =>
      jsonResponse({
        access_token: createJwt({}),
        id_token: createIdToken(),
        refresh_token: 'refresh-test',
      }),
    openUrl: async (url) => {
      openedUrls.push(url);
    },
    storagePath,
  });

  const record = await provider.login({
    force: true,
    receiveAuthorizationCode: async () => ({
      code: 'code-test',
      state: 'state-test',
    }),
  });

  assert.equal(record.tokens.expiresAt, '2026-03-27T01:00:00.000Z');
  assert.equal(openedUrls.length, 1);
});

Deno.test('Codex OAuth provider reuses an existing unexpired auth record during login and validates callback state', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-login-reuse-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(storagePath, JSON.stringify(createStoredAuth(), null, 2));

  let fetchCalls = 0;
  const provider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async () => {
      fetchCalls += 1;
      throw new Error('reused login should not hit the network');
    },
    storagePath,
  });

  const reused = await provider.login();
  assert.equal(reused.tokens.accountId, 'acct-test');
  assert.equal(fetchCalls, 0);

  await assert.rejects(
    async () =>
      await provider.login({
        force: true,
        receiveAuthorizationCode: async () => ({
          code: 'code-test',
          state: 'wrong-state',
        }),
      }),
    /state mismatch/u,
  );
});

Deno.test('Codex OAuth provider surfaces missing token-set and missing account-id failures during login and refresh', async () => {
  const loginRoot = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-login-invalid-' });
  const loginStoragePath = join(loginRoot, '.rlm/codex-oauth.json');
  const loginProvider = new CodexOAuthProvider({
    clientId: 'client-test',
    createCodeVerifier: () => 'verifier-test',
    createState: () => 'state-test',
    fetcher: async () =>
      jsonResponse({
        access_token: createAccessToken(),
        refresh_token: 'refresh-only',
      }),
    storagePath: loginStoragePath,
  });

  await assert.rejects(
    async () =>
      await loginProvider.login({
        force: true,
        receiveAuthorizationCode: async () => ({
          code: 'code-test',
          state: 'state-test',
        }),
      }),
    /required token set/u,
  );

  const noAccountRoot = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-login-no-account-' });
  const noAccountStoragePath = join(noAccountRoot, '.rlm/codex-oauth.json');
  const noAccountProvider = new CodexOAuthProvider({
    clientId: 'client-test',
    createCodeVerifier: () => 'verifier-test',
    createState: () => 'state-test',
    fetcher: async () =>
      jsonResponse({
        access_token: createJwt({
          exp: Math.floor(Date.parse('2026-03-27T01:00:00.000Z') / 1_000),
        }),
        id_token: createJwt({ exp: Math.floor(Date.parse('2026-03-27T01:00:00.000Z') / 1_000) }),
        refresh_token: 'refresh-test',
      }),
    storagePath: noAccountStoragePath,
  });

  await assert.rejects(
    async () =>
      await noAccountProvider.login({
        force: true,
        receiveAuthorizationCode: async () => ({
          code: 'code-test',
          state: 'state-test',
        }),
      }),
    /did not yield an account ID/u,
  );

  const refreshRoot = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-refresh-invalid-' });
  const refreshStoragePath = join(refreshRoot, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(refreshRoot, '.rlm'));
  await Deno.writeTextFile(
    refreshStoragePath,
    JSON.stringify(
      createStoredAuth({
        tokens: {
          accessToken: '',
          accountId: 'acct-test',
          expiresAt: '2026-03-26T00:00:00.000Z',
          idToken: createIdToken(),
          organizationId: 'org-test',
          refreshToken: 'refresh-test',
        },
      }),
      null,
      2,
    ),
  );
  const refreshProvider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async () =>
      jsonResponse({
        access_token: createAccessToken(),
        refresh_token: 'refresh-only',
      }),
    storagePath: refreshStoragePath,
  });

  await assert.rejects(
    async () => {
      await refreshProvider.ensureAuth();
    },
    /required token set/u,
  );

  const refreshNoAccountRoot = await Deno.makeTempDir({
    prefix: 'rlm-codex-oauth-refresh-no-account-',
  });
  const refreshNoAccountStoragePath = join(refreshNoAccountRoot, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(refreshNoAccountRoot, '.rlm'));
  await Deno.writeTextFile(
    refreshNoAccountStoragePath,
    JSON.stringify(
      createStoredAuth({
        tokens: {
          accessToken: createAccessToken('2026-03-26T00:00:00.000Z'),
          accountId: 'acct-test',
          expiresAt: '2026-03-26T00:00:00.000Z',
          idToken: createIdToken(),
          organizationId: 'org-test',
          refreshToken: 'refresh-test',
        },
      }),
      null,
      2,
    ),
  );
  const refreshNoAccountProvider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async () =>
      jsonResponse({
        access_token: createJwt({
          exp: Math.floor(Date.parse('2026-03-27T01:00:00.000Z') / 1_000),
        }),
        id_token: createJwt({ exp: Math.floor(Date.parse('2026-03-27T01:00:00.000Z') / 1_000) }),
        refresh_token: 'refresh-test',
      }),
    storagePath: refreshNoAccountStoragePath,
  });

  await assert.rejects(
    async () => {
      await refreshNoAccountProvider.ensureAuth();
    },
    /refresh did not yield an account ID/u,
  );

  const refreshExpiryRoot = await Deno.makeTempDir({
    prefix: 'rlm-codex-oauth-refresh-expiry-fallback-',
  });
  const refreshExpiryStoragePath = join(refreshExpiryRoot, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(refreshExpiryRoot, '.rlm'));
  await Deno.writeTextFile(
    refreshExpiryStoragePath,
    JSON.stringify(
      createStoredAuth({
        tokens: {
          ...createStoredAuth().tokens,
          accessToken: createAccessToken('2026-03-26T00:00:00.000Z'),
          expiresAt: '2026-03-26T00:00:00.000Z',
        },
      }),
      null,
      2,
    ),
  );
  const refreshExpiryProvider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async () =>
      jsonResponse({
        access_token: createJwt({}),
        id_token: createIdToken(),
        refresh_token: 'refresh-test',
      }),
    storagePath: refreshExpiryStoragePath,
  });

  const refreshed = await refreshExpiryProvider.ensureAuth();
  assert.equal(refreshed.tokens.expiresAt, '2026-03-27T01:00:00.000Z');
});

Deno.test('Codex OAuth provider reuses stored access tokens and sends explicit input messages', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-reuse-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  const storedAuth = createStoredAuth();
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(storagePath, JSON.stringify(storedAuth, null, 2));

  const calls: Array<{
    accountId: string;
    authorization: string;
    body?: unknown;
    originator: string;
    url: string;
    userAgent: string;
  }> = [];
  const provider = new CodexOAuthProvider({
    clientId: 'client-test',
    clock: createClock(),
    fetcher: async (input, init) => {
      const url = String(input);
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      calls.push({
        accountId: headers.get('chatgpt-account-id') ?? '',
        authorization: headers.get('Authorization') ?? '',
        body: (init as RequestInit | undefined)?.body === undefined
          ? undefined
          : JSON.parse(String((init as RequestInit | undefined)?.body)),
        originator: headers.get('originator') ?? '',
        url,
        userAgent: headers.get('User-Agent') ?? '',
      });

      if (url.includes('/codex/models')) {
        return jsonResponse({
          models: [
            { slug: 'gpt-5-4-t-mini' },
            { id: 'gpt-5-3-instant' },
            { slug: 'gpt-5-4-t-mini' },
          ],
        });
      }

      if (url.endsWith('/codex/responses')) {
        return jsonResponse({
          id: 'resp_codex_1',
          output_text: '```repl\nFINAL_VAR("done")\n```',
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath,
  });

  const models = await provider.listModels();
  const llm = provider.createCaller({
    requestTimeoutMs: 15_000,
  });
  const completion = await llm.complete({
    input: 'Return done.',
    kind: 'root_turn',
    messages: [
      { content: 'Return done.', role: 'user' },
      { content: '```repl\n"working"\n```', role: 'assistant' },
      { content: 'REPL result: working', role: 'user' },
    ],
    metadata: { depth: 0, step: 1 },
    model: 'gpt-5-4-t-mini',
    systemPrompt: 'Use the REPL.',
  });

  assert.deepEqual(models, ['gpt-5-4-t-mini', 'gpt-5-3-instant']);
  assert.equal(completion.outputText, '```repl\nFINAL_VAR("done")\n```');
  assert.equal(completion.turnState, undefined);
  assert.deepEqual(
    calls.map((call) => ({
      accountId: call.accountId,
      authorization: call.authorization,
      originator: call.originator,
      userAgent: call.userAgent,
    })),
    [
      {
        accountId: 'acct-test',
        authorization: `Bearer ${storedAuth.tokens.accessToken}`,
        originator: 'rlm',
        userAgent: 'rlm',
      },
      {
        accountId: 'acct-test',
        authorization: `Bearer ${storedAuth.tokens.accessToken}`,
        originator: 'rlm',
        userAgent: 'rlm',
      },
      {
        accountId: 'acct-test',
        authorization: `Bearer ${storedAuth.tokens.accessToken}`,
        originator: 'rlm',
        userAgent: 'rlm',
      },
    ],
  );
  assert.equal(
    calls[0]?.url,
    'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0',
  );
  assert.equal(
    calls[1]?.url,
    'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0',
  );
  assert.equal(calls[2]?.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.deepEqual(calls[2]?.body, {
    input: [
      {
        content: [
          {
            text: 'Return done.',
            type: 'input_text',
          },
        ],
        role: 'user',
      },
      {
        content: [
          {
            text: '```repl\n"working"\n```',
            type: 'input_text',
          },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            text: 'REPL result: working',
            type: 'input_text',
          },
        ],
        role: 'user',
      },
    ],
    instructions: 'Use the REPL.',
    model: 'gpt-5-4-t-mini',
    store: false,
    stream: true,
  });
});

Deno.test('Codex OAuth input payload builder falls back to legacy input when messages are absent or empty', () => {
  const withoutMessages = __codexOAuthProviderTestables.buildCodexInputPayload({
    input: 'Return done.',
    kind: 'root_turn',
    model: 'gpt-5-4-t-mini',
    systemPrompt: 'Use the REPL.',
  });
  const withEmptyMessages = __codexOAuthProviderTestables.buildCodexInputPayload({
    input: 'Return done.',
    kind: 'root_turn',
    messages: [],
    model: 'gpt-5-4-t-mini',
    systemPrompt: 'Use the REPL.',
  });

  assert.deepEqual(withoutMessages, [
    {
      content: [
        {
          text: 'Return done.',
          type: 'input_text',
        },
      ],
      role: 'user',
    },
  ]);
  assert.deepEqual(withEmptyMessages, withoutMessages);
});

Deno.test('Codex OAuth provider can parse streamed Codex responses when the backend requires stream=true', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-stream-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  const storedAuth = createStoredAuth();
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(storagePath, JSON.stringify(storedAuth, null, 2));

  const provider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        return jsonResponse({
          models: [{ slug: 'gpt-5-4-t-mini' }],
        });
      }

      if (url.endsWith('/codex/responses')) {
        const body = JSON.parse(String((init as RequestInit | undefined)?.body));
        assert.equal(body.stream, true);
        assert.equal(body.store, false);

        const streamBody = [
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","delta":"```repl\\n"}',
          '',
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","delta":"FINAL_VAR(\\"done\\")\\n```"}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_stream_1","output_text":"```repl\\nFINAL_VAR(\\"done\\")\\n```","usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}}}',
          '',
          'data: [DONE]',
          '',
        ].join('\n');

        return new Response(streamBody, {
          headers: { 'Content-Type': 'text/event-stream' },
          status: 200,
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath,
  });

  const llm = provider.createCaller({
    requestTimeoutMs: 15_000,
  });
  const completion = await llm.complete({
    input: 'Return done.',
    kind: 'root_turn',
    metadata: { depth: 0, step: 1 },
    model: 'gpt-5-4-t-mini',
    systemPrompt: 'Use the REPL.',
  });

  assert.equal(completion.outputText, '```repl\nFINAL_VAR("done")\n```');
  assert.equal(completion.turnState, undefined);
  assert.deepEqual(completion.usage, {
    cachedInputTokens: undefined,
    inputTokens: 12,
    outputTokens: 4,
    totalTokens: 16,
  });
});

Deno.test('Codex OAuth provider recognizes SSE response bodies even when the content-type is not text/event-stream', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-stream-sniff-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  const storedAuth = createStoredAuth();
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(storagePath, JSON.stringify(storedAuth, null, 2));

  const provider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        return jsonResponse({
          models: [{ slug: 'gpt-5.4' }],
        });
      }

      if (url.endsWith('/codex/responses')) {
        const body = JSON.parse(String((init as RequestInit | undefined)?.body));
        assert.equal(body.stream, true);
        assert.equal(body.store, false);

        const streamBody = [
          'event: response.created',
          'data: {"type":"response.created","response":{"id":"resp_stream_sniff","output":[]}}',
          '',
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","delta":"P"}',
          '',
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","delta":"ONG"}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_stream_sniff","output":[{"type":"message","content":[{"type":"output_text","text":"PONG"}]}],"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}',
          '',
          'data: [DONE]',
          '',
        ].join('\n');

        return new Response(streamBody, {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath,
  });

  const llm = provider.createCaller({
    requestTimeoutMs: 15_000,
  });
  const completion = await llm.complete({
    input: 'ping',
    kind: 'plain_query',
    metadata: { depth: 0, queryIndex: 0 },
    model: 'gpt-5.4',
    systemPrompt: 'If you receive ping, respond with exactly PONG.',
  });

  assert.equal(completion.outputText, 'PONG');
  assert.equal(completion.turnState, undefined);
  assert.deepEqual(completion.usage, {
    cachedInputTokens: undefined,
    inputTokens: 4,
    outputTokens: 2,
    totalTokens: 6,
  });
});

Deno.test('Codex OAuth provider can recover assistant text from streamed output_item events even when response.completed omits output_text', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-stream-output-item-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  const storedAuth = createStoredAuth();
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(storagePath, JSON.stringify(storedAuth, null, 2));

  const provider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        return jsonResponse({
          models: [{ slug: 'gpt-5-4-t-mini' }],
        });
      }

      if (url.endsWith('/codex/responses')) {
        const body = JSON.parse(String((init as RequestInit | undefined)?.body));
        assert.equal(body.stream, true);

        const streamBody = [
          'event: response.output_item.done',
          'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"```repl\\nFINAL_VAR(\\"done\\")\\n```"}]}}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_stream_2","output":[{"type":"message","content":[{"type":"output_text","text":"```repl\\nFINAL_VAR(\\"done\\")\\n```"}]}],"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}',
          '',
          'data: [DONE]',
          '',
        ].join('\n');

        return new Response(streamBody, {
          headers: { 'Content-Type': 'text/event-stream' },
          status: 200,
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath,
  });

  const llm = provider.createCaller({
    requestTimeoutMs: 15_000,
  });
  const completion = await llm.complete({
    input: 'Return done.',
    kind: 'root_turn',
    metadata: { depth: 0, step: 1 },
    model: 'gpt-5-4-t-mini',
    systemPrompt: 'Use the REPL.',
  });

  assert.equal(completion.outputText, '```repl\nFINAL_VAR("done")\n```');
  assert.equal(completion.turnState, undefined);
  assert.deepEqual(completion.usage, {
    cachedInputTokens: undefined,
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10,
  });
});

Deno.test('Codex OAuth provider can recover assistant text from streamed content_part events even when output items are omitted', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-stream-content-part-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  const storedAuth = createStoredAuth();
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(storagePath, JSON.stringify(storedAuth, null, 2));

  const provider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        return jsonResponse({
          models: [{ slug: 'gpt-5-4-t-mini' }],
        });
      }

      if (url.endsWith('/codex/responses')) {
        const body = JSON.parse(String((init as RequestInit | undefined)?.body));
        assert.equal(body.stream, true);
        assert.equal(body.store, false);

        const streamBody = [
          'event: response.content_part.added',
          'data: {"type":"response.content_part.added","part":{"type":"text","text":"```repl\\n"}}',
          '',
          'event: response.content_part.done',
          'data: {"type":"response.content_part.done","part":{"type":"text","text":"FINAL_VAR(\\"done\\")\\n```"}}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_stream_3","usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13}}}',
          '',
          'data: [DONE]',
          '',
        ].join('\n');

        return new Response(streamBody, {
          headers: { 'Content-Type': 'text/event-stream' },
          status: 200,
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath,
  });

  const llm = provider.createCaller({
    requestTimeoutMs: 15_000,
  });
  const completion = await llm.complete({
    input: 'Return done.',
    kind: 'root_turn',
    metadata: { depth: 0, step: 1 },
    model: 'gpt-5-4-t-mini',
    systemPrompt: 'Use the REPL.',
  });

  assert.equal(completion.outputText, '```repl\nFINAL_VAR("done")\n```');
  assert.equal(completion.turnState, undefined);
  assert.deepEqual(completion.usage, {
    cachedInputTokens: undefined,
    inputTokens: 9,
    outputTokens: 4,
    totalTokens: 13,
  });
});

Deno.test('Codex OAuth provider includes the raw response payload when no assistant text can be extracted', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-no-assistant-text-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  const storedAuth = createStoredAuth();
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(storagePath, JSON.stringify(storedAuth, null, 2));

  const provider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        return jsonResponse({
          models: [{ slug: 'gpt-5-4-t-mini' }],
        });
      }

      if (url.endsWith('/codex/responses')) {
        return jsonResponse({
          id: 'resp_empty',
          output: [
            {
              type: 'reasoning',
              summary: [
                {
                  text: 'thinking only',
                },
              ],
            },
          ],
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath,
  });

  const llm = provider.createCaller({
    requestTimeoutMs: 15_000,
  });

  await assert.rejects(
    async () =>
      await llm.complete({
        input: 'Return done.',
        kind: 'root_turn',
        metadata: { depth: 0, step: 1 },
        model: 'gpt-5-4-t-mini',
        systemPrompt: 'Use the REPL.',
      }),
    /raw=/u,
  );

  await assert.rejects(
    async () =>
      await llm.complete({
        input: 'Return done.',
        kind: 'root_turn',
        metadata: { depth: 0, step: 1 },
        model: 'gpt-5-4-t-mini',
        systemPrompt: 'Use the REPL.',
      }),
    /resp_empty/u,
  );
});

Deno.test('Codex OAuth provider preserves primitive raw payloads, undefined turn state, and non-Error transport failures', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-primitive-raw-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  const storedAuth = createStoredAuth();
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(storagePath, JSON.stringify(storedAuth, null, 2));

  const provider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        return jsonResponse({
          models: [{ slug: 'gpt-5-4-t-mini' }],
        });
      }

      return new Response('123', {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    },
    storagePath,
  });

  const llm = provider.createCaller({
    requestTimeoutMs: 15_000,
  });

  await assert.rejects(
    async () =>
      await llm.complete({
        input: 'Return done.',
        kind: 'root_turn',
        metadata: { depth: 0, step: 1 },
        model: 'gpt-5-4-t-mini',
        systemPrompt: 'Use the REPL.',
      }),
    /raw=123/u,
  );

  const successProvider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        return jsonResponse({
          models: [{ slug: 'gpt-5-4-t-mini' }],
        });
      }

      return jsonResponse({
        output_text: 'pong',
      });
    },
    storagePath,
  });

  const success = await successProvider.createCaller({
    requestTimeoutMs: 15_000,
  }).complete({
    input: 'ping',
    kind: 'plain_query',
    metadata: { depth: 0 },
    model: 'gpt-5-4-t-mini',
    systemPrompt: 'Respond with pong.',
  });

  assert.equal(success.outputText, 'pong');
  assert.equal(success.turnState, undefined);

  const thrownProvider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async () => {
      throw 'network boom';
    },
    storagePath,
  });

  await assert.rejects(
    async () =>
      await thrownProvider.createCaller({
        requestTimeoutMs: 15_000,
      }).complete({
        input: 'ping',
        kind: 'plain_query',
        metadata: { depth: 0 },
        model: 'gpt-5-4-t-mini',
        systemPrompt: 'Respond with pong.',
      }),
    /network boom/u,
  );

  const responseThrowingProvider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        return jsonResponse({
          models: [{ slug: 'gpt-5-4-t-mini' }],
        });
      }

      throw 'response transport boom';
    },
    storagePath,
  });

  await assert.rejects(
    async () =>
      await responseThrowingProvider.createCaller({
        requestTimeoutMs: 15_000,
      }).complete({
        input: 'ping',
        kind: 'plain_query',
        metadata: { depth: 0 },
        model: 'gpt-5-4-t-mini',
        systemPrompt: 'Respond with pong.',
      }),
    /response transport boom/u,
  );
});

Deno.test('Codex OAuth provider retries once when a streamed response completes with an empty assistant message and then succeeds', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-empty-stream-retry-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  const storedAuth = createStoredAuth();
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(storagePath, JSON.stringify(storedAuth, null, 2));

  let responsesCalls = 0;
  const provider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        return jsonResponse({
          models: [{ slug: 'gpt-5.4-mini' }],
        });
      }

      if (url.endsWith('/codex/responses')) {
        responsesCalls += 1;
        if (responsesCalls === 1) {
          const emptyStreamBody = [
            'event: response.created',
            'data: {"type":"response.created","response":{"id":"resp_empty_attempt_1"}}',
            '',
            'event: response.output_item.added',
            'data: {"type":"response.output_item.added","item":{"id":"msg_empty_1","type":"message","status":"in_progress","content":[],"role":"assistant"}}',
            '',
            'event: response.content_part.added',
            'data: {"type":"response.content_part.added","part":{"type":"output_text","text":""}}',
            '',
            'event: response.output_item.done',
            'data: {"type":"response.output_item.done","item":{"id":"msg_empty_1","type":"message","status":"completed","content":[{"type":"output_text","text":""}],"role":"assistant"}}',
            '',
            'event: response.completed',
            'data: {"type":"response.completed","response":{"id":"resp_empty_attempt_1","output":[{"id":"msg_empty_1","type":"message","status":"completed","content":[{"type":"output_text","text":""}],"role":"assistant"}],"usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15}}}',
            '',
          ].join('\n');

          return new Response(emptyStreamBody, {
            headers: { 'Content-Type': 'text/event-stream' },
            status: 200,
          });
        }

        const successStreamBody = [
          'event: response.output_text.done',
          'data: {"type":"response.output_text.done","text":"```repl\\nFINAL_VAR(\\"done\\")\\n```"}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_success_attempt_2","output_text":"```repl\\nFINAL_VAR(\\"done\\")\\n```","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}',
          '',
        ].join('\n');

        return new Response(successStreamBody, {
          headers: { 'Content-Type': 'text/event-stream' },
          status: 200,
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath,
  });

  const llm = provider.createCaller({
    requestTimeoutMs: 15_000,
  });
  const completion = await llm.complete({
    input: 'Return done.',
    kind: 'root_turn',
    metadata: { depth: 0, step: 1 },
    model: 'gpt-5.4-mini',
    systemPrompt: 'Use the REPL.',
  });

  assert.equal(responsesCalls, 2);
  assert.equal(completion.outputText, '```repl\nFINAL_VAR("done")\n```');
  assert.equal(completion.turnState, undefined);
});

Deno.test('Codex OAuth provider surfaces a stable error after repeated empty assistant responses', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-empty-stream-exhausted-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  const storedAuth = createStoredAuth();
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(storagePath, JSON.stringify(storedAuth, null, 2));

  let responsesCalls = 0;
  const provider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        return jsonResponse({
          models: [{ slug: 'gpt-5.4-mini' }],
        });
      }

      if (url.endsWith('/codex/responses')) {
        responsesCalls += 1;
        const emptyStreamBody = [
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_empty_retry","output":[{"id":"msg_empty_retry","type":"message","status":"completed","content":[{"type":"output_text","text":""}],"role":"assistant"}],"usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15}}}',
          '',
        ].join('\n');

        return new Response(emptyStreamBody, {
          headers: { 'Content-Type': 'text/event-stream' },
          status: 200,
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath,
  });

  const llm = provider.createCaller({
    requestTimeoutMs: 15_000,
  });

  await assert.rejects(
    async () =>
      await llm.complete({
        input: 'Return done.',
        kind: 'root_turn',
        metadata: { depth: 0, step: 1 },
        model: 'gpt-5.4-mini',
        systemPrompt: 'Use the REPL.',
      }),
    /after 2 attempts/u,
  );
  assert.equal(responsesCalls, 2);
});

Deno.test('Codex OAuth provider refreshes expired auth and rotates the access token before listing models', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-refresh-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(
    storagePath,
    JSON.stringify(
      createStoredAuth({
        tokens: {
          accessToken: createAccessToken('2026-03-26T00:00:00.000Z'),
          accountId: 'acct-test',
          expiresAt: '2026-03-26T00:00:00.000Z',
          idToken: createIdToken({
            exp: Math.floor(Date.parse('2026-03-26T00:00:00.000Z') / 1_000),
          }),
          organizationId: 'org-test',
          refreshToken: 'refresh-stale',
        },
      }),
      null,
      2,
    ),
  );

  const calls: string[] = [];
  const provider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input, init) => {
      const url = String(input);
      const body = String((init as RequestInit | undefined)?.body ?? '');
      calls.push(`${url} ${body}`);

      if (url.endsWith('/oauth/token')) {
        const form = new URLSearchParams(body);
        const grantType = form.get('grant_type');
        if (grantType === 'refresh_token') {
          assert.equal(form.get('refresh_token'), 'refresh-stale');
          return jsonResponse({
            access_token: createAccessToken(),
            id_token: createIdToken(),
            refresh_token: 'refresh-rotated',
          });
        }
      }

      if (url.includes('/codex/models')) {
        const headers = new Headers((init as RequestInit | undefined)?.headers);
        assert.equal(headers.get('Authorization'), `Bearer ${createAccessToken()}`);
        assert.equal(headers.get('chatgpt-account-id'), 'acct-test');
        assert.equal(headers.get('originator'), 'rlm');
        assert.equal(headers.get('User-Agent'), 'rlm');
        return jsonResponse({
          models: [{ slug: 'gpt-5-4-t-mini' }],
        });
      }

      throw new Error(`Unexpected request: ${url} ${body}`);
    },
    storagePath,
  });

  const models = await provider.listModels();
  const stored = JSON.parse(await Deno.readTextFile(storagePath)) as CodexOAuthAuthRecord;

  assert.deepEqual(models, ['gpt-5-4-t-mini']);
  assert.equal(stored.tokens.accessToken, createAccessToken());
  assert.equal(stored.tokens.refreshToken, 'refresh-rotated');
  assert.equal(stored.tokens.organizationId, 'org-test');
  assert.equal(stored.version, 2);
  assert.equal(calls.length, 2);
});

Deno.test('Codex OAuth provider validates missing account IDs before model listing or caller execution', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-missing-account-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(
    storagePath,
    JSON.stringify(
      createStoredAuth({
        tokens: {
          ...createStoredAuth().tokens,
          accountId: null,
          idToken: createJwt({
            exp: Math.floor(Date.parse('2026-03-27T01:00:00.000Z') / 1_000),
          }),
        },
      }),
      null,
      2,
    ),
  );

  const provider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async () => jsonResponse({}),
    storagePath,
  });

  await assert.rejects(
    async () => {
      await provider.listModels();
    },
    /requires an account ID/u,
  );

  await assert.rejects(
    async () =>
      await provider.createCaller().complete({
        input: 'Return done.',
        kind: 'root_turn',
        metadata: { depth: 0, step: 1 },
        model: 'gpt-5-4-t-mini',
        systemPrompt: 'Use the REPL.',
      }),
    /calls require an account ID/u,
  );

  const emptyAccessRoot = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-empty-access-' });
  const emptyAccessStoragePath = join(emptyAccessRoot, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(emptyAccessRoot, '.rlm'));
  await Deno.writeTextFile(
    emptyAccessStoragePath,
    JSON.stringify(
      createStoredAuth({
        tokens: {
          ...createStoredAuth().tokens,
          accessToken: '',
          expiresAt: '2121-01-01T00:00:00.000Z',
        },
      }),
      null,
      2,
    ),
  );
  const emptyAccessProvider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input) => {
      const url = String(input);
      if (url.endsWith('/oauth/token')) {
        return jsonResponse({
          access_token: createAccessToken(),
          id_token: createIdToken(),
          refresh_token: 'refresh-rotated',
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath: emptyAccessStoragePath,
  });

  const refreshed = await emptyAccessProvider.ensureAuth();
  assert.equal(refreshed.tokens.accessToken, createAccessToken());
});

Deno.test('Codex OAuth provider surfaces raw HTTP failures, payload errors, timeouts, and generic read errors', async () => {
  const rawRoot = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-raw-http-' });
  const rawStoragePath = join(rawRoot, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(rawRoot, '.rlm'));
  await Deno.writeTextFile(rawStoragePath, JSON.stringify(createStoredAuth(), null, 2));

  const rawProvider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        return jsonResponse({
          models: [{ slug: 'gpt-5-4-t-mini' }],
        });
      }

      if (url.endsWith('/codex/responses')) {
        return new Response('backend exploded', {
          headers: { 'Content-Type': 'text/plain' },
          status: 400,
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath: rawStoragePath,
  });

  await assert.rejects(
    async () =>
      await rawProvider.createCaller().complete({
        input: 'Return done.',
        kind: 'root_turn',
        metadata: { depth: 0, step: 1 },
        model: 'gpt-5-4-t-mini',
        systemPrompt: 'Use the REPL.',
      }),
    /raw=backend exploded/u,
  );

  const payloadErrorRoot = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-payload-error-' });
  const payloadErrorStoragePath = join(payloadErrorRoot, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(payloadErrorRoot, '.rlm'));
  await Deno.writeTextFile(
    payloadErrorStoragePath,
    JSON.stringify(createStoredAuth(), null, 2),
  );
  const payloadErrorProvider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        return jsonResponse({
          models: [{ slug: 'gpt-5-4-t-mini' }],
        });
      }

      if (url.endsWith('/codex/responses')) {
        return jsonResponse({
          error: {
            message: 'payload level failure',
          },
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath: payloadErrorStoragePath,
  });

  await assert.rejects(
    async () =>
      await payloadErrorProvider.createCaller().complete({
        input: 'Return done.',
        kind: 'root_turn',
        metadata: { depth: 0, step: 1 },
        model: 'gpt-5-4-t-mini',
        systemPrompt: 'Use the REPL.',
      }),
    /payload level failure/u,
  );

  const timeoutRoot = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-timeout-' });
  const timeoutStoragePath = join(timeoutRoot, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(timeoutRoot, '.rlm'));
  await Deno.writeTextFile(timeoutStoragePath, JSON.stringify(createStoredAuth(), null, 2));
  const timeoutProvider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        return jsonResponse({
          models: [{ slug: 'gpt-5-4-t-mini' }],
        });
      }

      if (url.endsWith('/codex/responses')) {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath: timeoutStoragePath,
  });

  await assert.rejects(
    async () =>
      await timeoutProvider.createCaller({ requestTimeoutMs: 1 }).complete({
        input: 'Return done.',
        kind: 'root_turn',
        metadata: { depth: 0, step: 1 },
        model: 'gpt-5-4-t-mini',
        systemPrompt: 'Use the REPL.',
      }),
    /timed out after 1ms/u,
  );

  const externalAbortRoot = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-external-abort-' });
  const externalAbortStoragePath = join(externalAbortRoot, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(externalAbortRoot, '.rlm'));
  await Deno.writeTextFile(externalAbortStoragePath, JSON.stringify(createStoredAuth(), null, 2));
  const runningController = new AbortController();
  const externalAbortProvider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        return jsonResponse({
          models: [{ slug: 'gpt-5-4-t-mini' }],
        });
      }

      if (url.endsWith('/codex/responses')) {
        runningController.abort();
        const requestInit = init as RequestInit | undefined;
        assert.equal(requestInit?.signal?.aborted ?? false, true);
        throw new DOMException('Aborted', 'AbortError');
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath: externalAbortStoragePath,
  });

  await assert.rejects(
    async () =>
      await externalAbortProvider.createCaller({ requestTimeoutMs: 25 }).complete({
        input: 'Return done.',
        kind: 'root_turn',
        metadata: { depth: 0, step: 1 },
        model: 'gpt-5-4-t-mini',
        signal: runningController.signal,
        systemPrompt: 'Use the REPL.',
      }),
    /timed out after 25ms/u,
  );

  const readErrorRoot = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-read-error-' });
  const readErrorStoragePath = join(readErrorRoot, '.rlm/codex-oauth.json');
  const readErrorProvider = new CodexOAuthProvider({
    readTextFile: async () => {
      throw new Error('disk failed');
    },
    storagePath: readErrorStoragePath,
  });

  await assert.rejects(
    async () => {
      await readErrorProvider.loadAuth();
    },
    /disk failed/u,
  );
});

Deno.test('Codex OAuth provider backfills organizationId from a stored session when the id token already contains it', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-org-backfill-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(
    storagePath,
    JSON.stringify(
      {
        ...createStoredAuth(),
        tokens: {
          ...createStoredAuth().tokens,
          organizationId: undefined,
        },
      },
      null,
      2,
    ),
  );

  const provider = new CodexOAuthProvider({
    clock: createClock(),
    storagePath,
  });

  const record = await provider.loadAuth();
  assert.ok(record !== null);
  assert.equal(record.tokens.organizationId, 'org-test');
});

Deno.test('Codex OAuth provider normalizes a legacy v1 API-key auth record into a v2 OAuth session record', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-v1-backfill-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(storagePath, JSON.stringify(createLegacyStoredAuth(), null, 2));

  const provider = new CodexOAuthProvider({
    storagePath,
  });

  const record = await provider.loadAuth();
  assert.ok(record !== null);
  assert.equal(record.version, 2);
  assert.equal(record.tokens.accountId, 'acct-test');
  assert.equal(record.tokens.organizationId, 'org-test');
  assert.equal('apiKey' in (record as unknown as Record<string, unknown>), false);
});

Deno.test('Codex OAuth provider reports that interactive login is required when no stored auth exists', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-missing-' });
  const provider = new CodexOAuthProvider({
    storagePath: join(root, '.rlm/codex-oauth.json'),
  });

  await assert.rejects(
    async () => {
      await provider.listModels();
    },
    /login/u,
  );
});

Deno.test('Codex OAuth provider surfaces structured OAuth failures instead of printing [object Object]', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-oauth-error-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');

  const provider = new CodexOAuthProvider({
    clientId: 'client-test',
    clock: createClock(),
    createCodeVerifier: () => 'verifier-test',
    createState: () => 'state-test',
    fetcher: async (input, init) => {
      const url = String(input);
      const body = String((init as RequestInit | undefined)?.body ?? '');

      if (url.endsWith('/oauth/token')) {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') === 'authorization_code') {
          return jsonResponse(
            {
              error: {
                message: 'authorization code was rejected',
              },
            },
            400,
          );
        }
      }

      throw new Error(`Unexpected request: ${url} ${body}`);
    },
    storagePath,
  });

  await assert.rejects(
    async () => {
      await provider.login({
        receiveAuthorizationCode: async () => ({
          code: 'code-test',
          state: 'state-test',
        }),
      });
    },
    /authorization code was rejected/u,
  );
});

Deno.test('Codex OAuth provider surfaces structured model-list failures instead of printing [object Object]', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-model-error-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(storagePath, JSON.stringify(createStoredAuth(), null, 2));

  const provider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        return jsonResponse(
          {
            error: {
              message: 'model listing is not available for this account',
            },
          },
          403,
        );
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath,
  });

  await assert.rejects(
    async () => {
      await provider.listModels();
    },
    /model listing is not available for this account/u,
  );
});

Deno.test('Codex OAuth provider reports empty model-list HTTP bodies after retry', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-model-empty-error-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(storagePath, JSON.stringify(createStoredAuth(), null, 2));

  let modelListCalls = 0;
  const provider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        modelListCalls += 1;
        return new Response('', { status: 500 });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath,
  });

  await assert.rejects(
    async () => {
      await provider.listModels();
    },
    /Model listing failed with status 500\. raw=\(empty\)/u,
  );
  assert.equal(modelListCalls, 2);
});

Deno.test('Codex OAuth provider retries a transient HTML model-list response before completing a request', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-model-html-retry-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(storagePath, JSON.stringify(createStoredAuth(), null, 2));

  let modelListCalls = 0;
  const provider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        modelListCalls += 1;
        if (modelListCalls === 1) {
          return new Response('<html>temporary edge error</html>', {
            headers: { 'Content-Type': 'text/html' },
            status: 502,
          });
        }

        return jsonResponse({
          models: [{ slug: 'gpt-5-4-t-mini' }],
        });
      }

      if (url.endsWith('/codex/responses')) {
        return jsonResponse({
          id: 'resp_codex_1',
          output_text: '```repl\nFINAL_VAR("done")\n```',
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath,
  });

  const completion = await provider.createCaller().complete({
    input: 'Return done.',
    kind: 'root_turn',
    metadata: { depth: 0, step: 1 },
    model: 'gpt-5-4-t-mini',
    systemPrompt: 'Use the REPL.',
  });

  assert.equal(completion.outputText, '```repl\nFINAL_VAR("done")\n```');
  assert.equal(modelListCalls, 2);
});

Deno.test('Codex OAuth provider clears a rejected cached model-list promise and surfaces stable errors for invalid HTML payloads', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-model-html-reset-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(storagePath, JSON.stringify(createStoredAuth(), null, 2));

  let modelListCalls = 0;
  const provider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        modelListCalls += 1;
        if (modelListCalls <= 2) {
          return new Response('<html>gateway error</html>', {
            headers: { 'Content-Type': 'text/html' },
            status: 502,
          });
        }

        return jsonResponse({
          models: [{ slug: 'gpt-5-4-t-mini' }],
        });
      }

      if (url.endsWith('/codex/responses')) {
        return jsonResponse({
          id: 'resp_codex_2',
          output_text: '```repl\nFINAL_VAR("done")\n```',
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath,
  });

  const llm = provider.createCaller();

  await assert.rejects(
    async () =>
      await llm.complete({
        input: 'Return done.',
        kind: 'root_turn',
        metadata: { depth: 0, step: 1 },
        model: 'gpt-5-4-t-mini',
        systemPrompt: 'Use the REPL.',
      }),
    /Model listing failed with status 502|invalid response payload/u,
  );

  const completion = await llm.complete({
    input: 'Return done.',
    kind: 'root_turn',
    metadata: { depth: 0, step: 2 },
    model: 'gpt-5-4-t-mini',
    systemPrompt: 'Use the REPL.',
  });

  assert.equal(completion.outputText, '```repl\nFINAL_VAR("done")\n```');
  assert.equal(modelListCalls, 3);
});

Deno.test('Codex OAuth provider retries one invalid successful model-list payload before surfacing the payload error', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-model-invalid-ok-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(storagePath, JSON.stringify(createStoredAuth(), null, 2));

  let modelListCalls = 0;
  const provider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        modelListCalls += 1;
        return new Response('<html>still invalid</html>', {
          headers: { 'Content-Type': 'text/html' },
          status: 200,
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath,
  });

  await assert.rejects(
    async () => {
      await provider.listModels();
    },
    /invalid response payload.*raw=<html>still invalid<\/html>/u,
  );
  assert.equal(modelListCalls, 2);
});

Deno.test('Codex OAuth provider rejects non-catalog model aliases before calling the Codex responses endpoint', async () => {
  const root = await Deno.makeTempDir({ prefix: 'rlm-codex-oauth-model-validate-' });
  const storagePath = join(root, '.rlm/codex-oauth.json');
  const storedAuth = createStoredAuth();
  await Deno.mkdir(join(root, '.rlm'));
  await Deno.writeTextFile(storagePath, JSON.stringify(storedAuth, null, 2));

  let responsesCalls = 0;
  const provider = new CodexOAuthProvider({
    clock: createClock(),
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes('/codex/models')) {
        return jsonResponse({
          models: [
            { slug: 'gpt-5-4-t-mini' },
            { slug: 'gpt-5-3-instant' },
          ],
        });
      }

      if (url.endsWith('/codex/responses')) {
        responsesCalls += 1;
        return jsonResponse({
          output_text: 'should not happen',
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
    storagePath,
  });

  const llm = provider.createCaller({
    requestTimeoutMs: 15_000,
  });

  await assert.rejects(
    async () =>
      await llm.complete({
        input: 'Return done.',
        kind: 'root_turn',
        metadata: { depth: 0, step: 1 },
        model: 'gpt-5.4-mini',
        systemPrompt: 'Use the REPL.',
      }),
    /Requested Codex model is unavailable: gpt-5\.4-mini\./u,
  );

  assert.equal(responsesCalls, 0);
});
