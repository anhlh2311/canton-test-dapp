/**
 * Prove Vite preview serves wallet SPA at /__c8/embedded/ (same-origin proxy).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 4179;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitFor(url, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${url}`);
}

test('vite preview /__c8/embedded/ returns wallet SPA via same-origin proxy', async (t) => {
  // preview requires dist/; build if missing.
  const distIndex = path.join(ROOT, 'dist/index.html');
  try {
    await import('node:fs/promises').then((fs) => fs.access(distIndex));
  } catch {
    await new Promise((resolve, reject) => {
      const build = spawn(
        process.execPath,
        [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
      );
      build.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`vite build exited ${code}`))));
    });
  }

  const child = spawn(
    process.execPath,
    [
      path.join(ROOT, 'node_modules/vite/bin/vite.js'),
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(PORT),
      '--strictPort',
    ],
    {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  t.after(() => {
    child.kill('SIGTERM');
  });

  await waitFor(`${BASE}/`);
  const res = await fetch(`${BASE}/__c8/embedded/?c8u=mainnet`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-c8-spa-proxy'), '1');
  const html = await res.text();
  assert.match(html, /id=["']root["']/);
  assert.match(html, /_expo\/static\/js\/web\/entry-/);
  assert.match(html, /history\.replaceState/);
  assert.match(html, /\/__c8/);

  // Cookie-gated asset proxy: /_expo should work after visiting /__c8
  const cookie = res.headers.getSetCookie?.()?.join('; ') ?? res.headers.get('set-cookie') ?? '';
  assert.match(cookie, /c8_proxy=1/);
  const asset = await fetch(`${BASE}/_expo/static/js/web/entry-b122853c130cc8b6dcc93b7b059adbaa.js`, {
    headers: { cookie: 'c8_proxy=1; c8u=mainnet' },
  });
  assert.equal(asset.status, 200);
  const js = await asset.text();
  assert.ok(js.length > 1000, 'expected expo entry bundle');

  // Root WASM must be proxied as binary — SPA HTML breaks WebAssembly.instantiate.
  const wasm = await fetch(`${BASE}/canvaskit.wasm`, {
    headers: { cookie: 'c8_proxy=1; c8u=mainnet', accept: '*/*' },
  });
  assert.equal(wasm.status, 200);
  const buf = Buffer.from(await wasm.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString('utf8'), '\0asm', `expected wasm magic, got ${buf.subarray(0, 8)}`);
  const ct = wasm.headers.get('content-type') ?? '';
  assert.doesNotMatch(ct, /text\/html/i);

  // After path-strip, CanvasKit resolves relative to /embedded/ → nested wasm 404s upstream.
  // Proxy must remap to /canvaskit.wasm or the Passkey approval canvas stays blank.
  const nested = await fetch(`${BASE}/embedded/canvaskit.wasm`, {
    headers: { cookie: 'c8_proxy=1; c8u=mainnet', accept: '*/*' },
  });
  assert.equal(nested.status, 200);
  assert.equal(nested.headers.get('x-c8-spa-proxy-status'), 'fallback-wasm-root');
  const nestedBuf = Buffer.from(await nested.arrayBuffer());
  assert.equal(
    nestedBuf.subarray(0, 4).toString('utf8'),
    '\0asm',
    `expected nested wasm remap magic, got ${nestedBuf.subarray(0, 8)}`,
  );
});
