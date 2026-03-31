import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexFile = path.join(__dirname, 'index.html');
const appFile = path.join(__dirname, 'app.mjs');
const coreFile = path.resolve(__dirname, '..', '..', 'dist', 'core', 'index.mjs');
const sharedScenarioFile = path.resolve(__dirname, '..', 'shared', 'runtime_scenario.mjs');

const server = http.createServer(async (request, response) => {
  let requestPath = indexFile;
  let contentType = 'text/html; charset=utf-8';

  if (request.url === '/app.mjs') {
    requestPath = appFile;
    contentType = 'application/javascript; charset=utf-8';
  } else if (request.url === '/shared/runtime_scenario.mjs') {
    requestPath = sharedScenarioFile;
    contentType = 'application/javascript; charset=utf-8';
  } else if (request.url === '/dist/core/index.mjs') {
    requestPath = coreFile;
    contentType = 'application/javascript; charset=utf-8';
  }

  try {
    const body = await fs.readFile(requestPath);
    response.writeHead(200, { 'content-type': contentType });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(error instanceof Error ? error.stack ?? error.message : String(error));
  }
});

await new Promise((resolve) => server.listen(4173, '0.0.0.0', resolve));

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'PASS');
  const result = await page.locator('#result').textContent();
  console.log(JSON.stringify({
    ok: true,
    result,
  }));
} finally {
  await browser.close();
  await new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve(undefined))
  );
}
