/**
 * Same-origin /__c8api proxy for wallet-backend (mainnet CORS blocks the dApp origin).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseApiProxyPath,
  isAllowedC8ApiHost,
  proxyApiRequest,
  injectC8WalletBridgeScript,
} from './c8-spa-proxy-lib.mjs';

test('parseApiProxyPath extracts allowlisted wallet-backend hosts', () => {
  assert.deepEqual(
    parseApiProxyPath('/__c8api/h/wallet-backend.main.digik.cantor8.tech/api/config/version_v2'),
    { host: 'wallet-backend.main.digik.cantor8.tech', path: '/api/config/version_v2' },
  );
  assert.equal(parseApiProxyPath('/__c8api/h/evil.example.com/api'), null);
  assert.equal(isAllowedC8ApiHost('wallet-backend.dev.digik.cantor8.tech'), true);
  assert.equal(isAllowedC8ApiHost('evil.com'), false);
});

test('proxyApiRequest fetches AppConfig via spoofed wallet Origin', async () => {
  const result = await proxyApiRequest({
    pathname: '/__c8api/h/wallet-backend.main.digik.cantor8.tech/api/config/version_v2',
    method: 'GET',
    acceptHeader: 'application/json',
    userAgent: 'c8-api-proxy-test',
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers['x-c8-spa-proxy-status'], 'api-proxy');
  assert.equal(result.headers['x-c8-api-spoof-origin'], 'https://wallet.cantor8.tech');
  const json = JSON.parse(result.body.toString('utf8'));
  assert.ok(json.app_min_version || json.app_max_version, 'expected AppConfig fields');
});

test('injectC8WalletBridgeScript rewrites wallet-backend fetches', () => {
  const html = injectC8WalletBridgeScript('<html><head></head><body></body></html>');
  assert.match(html, /__c8api\/h\//);
  assert.match(html, /wallet-backend/);
  assert.match(html, /history\.replaceState/);
  assert.match(html, /window\.fetch/);
});
