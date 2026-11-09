#!/usr/bin/env node
/**
 * Reverse-proxy Cantor8's hosted wallet with SPA fallback.
 *
 * Public hosts return HTTP 404 for /embedded/ (SDK connect popup path). This
 * proxy returns /index.html for document 404s so `network: "local"` works.
 *
 *   node scripts/c8-spa-proxy.mjs
 *   C8_UPSTREAM=https://wallet.dev.digik.cantor8.tech C8_PROXY_PORT=8081 node scripts/c8-spa-proxy.mjs
 */
import http from 'node:http';
import { URL } from 'node:url';

const UPSTREAM = process.env.C8_UPSTREAM ?? 'https://wallet.cantor8.tech';
const PORT = Number(process.env.C8_PROXY_PORT ?? 8081);

async function fetchUpstream(pathWithQuery, reqHeaders) {
  const target = new URL(pathWithQuery, UPSTREAM);
  const headers = { ...reqHeaders };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  const res = await fetch(target, {
    method: 'GET',
    headers,
    redirect: 'manual',
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf };
}

function isDocumentRequest(req) {
  const accept = String(req.headers.accept ?? '');
  if (accept.includes('text/html')) return true;
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/' || pathname.endsWith('.html')) return true;
  // Expo client routes usually have no file extension.
  const last = pathname.split('/').pop() ?? '';
  if (!last.includes('.')) return true;
  return false;
}

function copyHeaders(upstreamHeaders, statusForBody) {
  const out = {};
  upstreamHeaders.forEach((value, key) => {
    const k = key.toLowerCase();
    if (
      k === 'content-encoding' ||
      k === 'content-length' ||
      k === 'transfer-encoding' ||
      k === 'connection' ||
      k === 'content-security-policy' ||
      k === 'x-frame-options'
    ) {
      return;
    }
    out[key] = value;
  });
  out['cache-control'] = 'no-store';
  out['x-c8-spa-proxy'] = '1';
  out['x-c8-spa-proxy-status'] = String(statusForBody);
  return out;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }

    const pathWithQuery = req.url || '/';
    let upstream = await fetchUpstream(pathWithQuery, req.headers);
    let servedFallback = false;

    if (upstream.status === 404 && isDocumentRequest(req)) {
      const fallback = await fetchUpstream('/index.html', {
        accept: 'text/html',
        'user-agent': req.headers['user-agent'] ?? 'c8-spa-proxy',
      });
      if (fallback.status >= 200 && fallback.status < 300 && fallback.buf.length > 0) {
        upstream = { ...fallback, status: 200 };
        servedFallback = true;
      }
    }

    const headers = copyHeaders(upstream.headers, servedFallback ? 'fallback-index' : 'passthrough');
    if (servedFallback) {
      headers['content-type'] = 'text/html; charset=utf-8';
    }
    res.writeHead(upstream.status, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(upstream.buf);
  } catch (err) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`c8-spa-proxy error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

server.listen(PORT, () => {
  console.log(`[c8-spa-proxy] listening on http://localhost:${PORT}`);
  console.log(`[c8-spa-proxy] upstream ${UPSTREAM}`);
  console.log(`[c8-spa-proxy] try http://localhost:${PORT}/embedded/`);
});
