#!/usr/bin/env node
/**
 * Reverse-proxy Cantor8's hosted wallet with SPA fallback + API CORS bridge.
 *
 *   yarn c8:proxy
 *   C8_UPSTREAM=https://wallet.dev.digik.cantor8.tech C8_PROXY_PORT=8081 yarn c8:proxy
 *
 * Select upstream per-request with ?c8u=mainnet|devnet (sets cookie for assets).
 */
import http from 'node:http';
import { URL } from 'node:url';
import {
  proxySpaRequest,
  proxyApiRequest,
  resolveUpstream,
  UPSTREAMS,
} from './c8-spa-proxy-lib.mjs';

const DEFAULT_UPSTREAM = resolveUpstream(process.env.C8_UPSTREAM, UPSTREAMS.mainnet);
const PORT = Number(process.env.C8_PROXY_PORT ?? 8081);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

    if (url.pathname.startsWith('/__c8api/')) {
      const chunks = [];
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        await new Promise((resolve, reject) => {
          req.on('data', (c) => chunks.push(Buffer.from(c)));
          req.on('end', () => resolve());
          req.on('error', reject);
        });
      }
      const result = await proxyApiRequest({
        pathname: url.pathname,
        search: url.search,
        method: req.method,
        acceptHeader: req.headers.accept,
        userAgent: req.headers['user-agent'],
        contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null,
        authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : null,
        body: chunks.length ? Buffer.concat(chunks) : null,
      });
      res.writeHead(result.status, result.headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(result.body);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }

    const result = await proxySpaRequest({
      pathname: url.pathname,
      searchParams: url.searchParams,
      cookieHeader: req.headers.cookie,
      acceptHeader: req.headers.accept,
      userAgent: req.headers['user-agent'],
      defaultUpstream: DEFAULT_UPSTREAM,
      injectBridge: true,
    });

    res.writeHead(result.status, result.headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(result.body);
  } catch (err) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`c8-spa-proxy error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

server.listen(PORT, () => {
  console.log(`[c8-spa-proxy] listening on http://localhost:${PORT}`);
  console.log(`[c8-spa-proxy] default upstream ${DEFAULT_UPSTREAM}`);
  console.log(`[c8-spa-proxy] try http://localhost:${PORT}/embedded/?c8u=mainnet`);
});
