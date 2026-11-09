/**
 * Smoke-test: public Cantor8 hosts 404 /embedded/, while our SPA proxy serves it.
 * Run: node --test scripts/c8-embed-smoke.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 18081;
const PROXY = `http://127.0.0.1:${PORT}`;

async function waitForProxy(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${PROXY}/`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(100);
  }
  throw new Error('proxy did not become ready');
}

test('public wallet.cantor8.tech /embedded/ is still 404 (hosting bug)', async () => {
  const res = await fetch('https://wallet.cantor8.tech/embedded/', {
    method: 'GET',
    redirect: 'manual',
  });
  assert.equal(res.status, 404);
});

test('SPA proxy serves /embedded/ as the wallet SPA (200 + root mount)', async (t) => {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, 'scripts/c8-spa-proxy.mjs')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        C8_PROXY_PORT: String(PORT),
        C8_UPSTREAM: 'https://wallet.cantor8.tech',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  t.after(() => {
    child.kill('SIGTERM');
  });

  await waitForProxy();

  const res = await fetch(`${PROXY}/embedded/?c8u=mainnet`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-c8-spa-proxy'), '1');
  const html = await res.text();
  assert.match(html, /id=["']root["']/);
  assert.match(html, /_expo\/static\/js\/web\/entry-/);
});
