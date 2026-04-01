const DIST_ROOT = new URL('./dist/', import.meta.url);
const INDEX_FILE = new URL('./dist/index.html', import.meta.url);
const DEFAULT_PORT = Number(Deno.args[0] ?? '4173');

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.woff2', 'font/woff2'],
]);

function sanitizeRequestPath(pathname: string): string {
  const segments = pathname.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    return '/';
  }

  return `/${segments.join('/')}`;
}

function contentTypeFor(pathname: string): string {
  const extension = pathname.match(/\.[A-Za-z0-9]+$/u)?.[0] ?? '';
  return MIME_TYPES.get(extension) ?? 'application/octet-stream';
}

async function tryReadAsset(pathname: string): Promise<Response | null> {
  const sanitized = sanitizeRequestPath(pathname);
  const assetUrl = new URL(`.${sanitized}`, DIST_ROOT);

  try {
    const body = await Deno.readFile(assetUrl);
    return new Response(body, {
      headers: {
        'Content-Type': contentTypeFor(sanitized),
      },
      status: 200,
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }

    return new Response(error instanceof Error ? error.message : String(error), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      status: 500,
    });
  }
}

async function readIndexFile(): Promise<Response> {
  const body = await Deno.readFile(INDEX_FILE);
  return new Response(body, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
    },
    status: 200,
  });
}

console.log(`RLM web example server listening on http://127.0.0.1:${DEFAULT_PORT}`);

Deno.serve({ port: DEFAULT_PORT }, async (request) => {
  const url = new URL(request.url);
  const asset = await tryReadAsset(url.pathname);

  if (asset !== null) {
    return asset;
  }

  return await readIndexFile();
});
