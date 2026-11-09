/**
 * Unit + live upstream check for nested CanvasKit wasm remapping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { proxySpaRequest, wasmRootFallbackPath, UPSTREAMS } from './c8-spa-proxy-lib.mjs';

test('wasmRootFallbackPath remaps nested wasm to basename at root', () => {
  assert.equal(wasmRootFallbackPath('/embedded/canvaskit.wasm'), '/canvaskit.wasm');
  assert.equal(wasmRootFallbackPath('/_expo/static/js/web/canvaskit.wasm'), '/canvaskit.wasm');
  assert.equal(wasmRootFallbackPath('/canvaskit.wasm'), null);
  assert.equal(wasmRootFallbackPath('/embedded/index.html'), null);
});

test('proxySpaRequest remaps /embedded/canvaskit.wasm to root wasm', async () => {
  const result = await proxySpaRequest({
    pathname: '/embedded/canvaskit.wasm',
    searchParams: new URLSearchParams('c8u=mainnet'),
    acceptHeader: 'application/wasm,*/*',
    userAgent: 'c8-wasm-fallback-test',
    defaultUpstream: UPSTREAMS.mainnet,
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers['x-c8-spa-proxy-status'], 'fallback-wasm-root');
  assert.equal(result.headers['content-type'], 'application/wasm');
  assert.equal(result.body.subarray(0, 4).toString('utf8'), '\0asm');
  assert.ok(result.body.length > 1_000_000, 'expected full canvaskit.wasm');
});
