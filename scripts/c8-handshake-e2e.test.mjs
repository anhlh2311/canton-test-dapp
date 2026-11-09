/**
 * Prove the SPA proxy unblocks the SDK connect path:
 * 1) /embedded/ returns the Expo SPA (not Caddy 404)
 * 2) Proxied bundles include MessageListener + handshake-ack
 *
 * Full interactive handshake needs a real platform authenticator (Cantor8's
 * embedded layout gates on Web Secure Store / passkeys). Headless Chromium
 * cannot unlock that store, so we don't flake CI on WebAuthn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 18082;
const PROXY = `http://localhost:${PORT}`;

async function waitForProxy(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${PROXY}/embedded/?c8u=mainnet`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(100);
  }
  throw new Error('proxy did not become ready');
}

function startProxy(t) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/c8-spa-proxy.mjs')], {
    cwd: ROOT,
    env: { ...process.env, C8_PROXY_PORT: String(PORT), C8_UPSTREAM: 'https://wallet.cantor8.tech' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGTERM');
  });
  return child;
}

test('SPA proxy /embedded/?c8u=mainnet returns wallet SPA + upstream header', async (t) => {
  startProxy(t);
  await waitForProxy();
  const res = await fetch(`${PROXY}/embedded/?c8u=mainnet`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-c8-spa-proxy'), '1');
  assert.match(res.headers.get('x-c8-spa-proxy-upstream') ?? '', /wallet\.cantor8\.tech/);
  assert.match(res.headers.get('x-c8-spa-proxy-status') ?? '', /fallback-index|passthrough/);
  const html = await res.text();
  assert.match(html, /id=["']root["']/);
  assert.match(html, /_expo\/static\/js\/web\/entry-/);
});

test('proxied wallet bundles include MessageListener handshake protocol', async (t) => {
  startProxy(t);
  await waitForProxy();
  const html = await (await fetch(`${PROXY}/embedded/?c8u=mainnet`)).text();
  const scripts = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0, 'expected script tags in embed HTML');

  let found = false;
  for (const src of scripts) {
    const url = src.startsWith('http') ? src : `${PROXY}${src}`;
    const js = await (await fetch(url)).text();
    if (js.includes('MessageListener') && js.includes('handshake-ack')) {
      found = true;
      break;
    }
  }
  assert.equal(
    found,
    true,
    'MessageListener + handshake-ack must be reachable through the SPA proxy (SDK connect popup path)',
  );
});
