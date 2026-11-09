import { defineConfig, type Plugin, type Connect } from 'vite';
import react from '@vitejs/plugin-react';
import { cantor8SdkProxyPlugin } from './src/viteCantor8SdkPlugin';
import {
  proxySpaRequest,
  resolveUpstream,
  UPSTREAMS,
  COOKIE_NAME,
  readCookie,
} from './scripts/c8-spa-proxy-lib.mjs';

const PREFIX = '/__c8';
const C8_PROXY_COOKIE = 'c8_proxy';

function isDappPath(pathname: string): boolean {
  if (pathname === '/' || pathname === '/index.html') return true;
  if (pathname.startsWith('/assets/')) return true;
  if (pathname.startsWith('/api/')) return true;
  if (
    pathname.startsWith('/cantor8') ||
    pathname.startsWith('/rocky') ||
    pathname.startsWith('/partylayer') ||
    pathname.startsWith('/console') ||
    pathname.startsWith('/standard') ||
    pathname.startsWith('/src/') ||
    pathname.startsWith('/node_modules/') ||
    pathname.startsWith('/@') ||
    pathname.startsWith('/__vite')
  ) {
    return true;
  }
  return false;
}

function shouldProxy(pathname: string, hasProxyCookie: boolean): boolean {
  if (pathname === PREFIX || pathname.startsWith(`${PREFIX}/`)) return true;
  if (!hasProxyCookie) return false;
  if (isDappPath(pathname)) return false;
  if (pathname.startsWith('/_expo/')) return true;
  if (pathname.startsWith('/embedded')) return true;
  if (pathname.startsWith('/setup')) return true;
  if (pathname.startsWith('/trade')) return true;
  if (pathname === '/favicon.ico') return true;
  return false;
}

/** Dev + preview: same-origin /__c8 SPA proxy (mirrors middleware.js). */
function cantor8SameOriginProxyPlugin(): Plugin {
  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      const host = req.headers.host || 'localhost:5180';
      const url = new URL(req.url || '/', `http://${host}`);
      const hasProxyCookie = readCookie(req.headers.cookie, C8_PROXY_COOKIE) === '1';
      if (!shouldProxy(url.pathname, hasProxyCookie)) {
        next();
        return;
      }

      let pathname = url.pathname;
      const setCookies: string[] = [];
      if (pathname === PREFIX || pathname.startsWith(`${PREFIX}/`)) {
        pathname = pathname === PREFIX ? '/' : pathname.slice(PREFIX.length) || '/';
        const fromQuery = url.searchParams.get('c8u');
        const normalized =
          fromQuery === 'devnet' || fromQuery === 'dev'
            ? 'devnet'
            : fromQuery === 'testmainnet' || fromQuery === 'test'
              ? 'testmainnet'
              : 'mainnet';
        setCookies.push(
          `${C8_PROXY_COOKIE}=1; Path=/; SameSite=Lax; Max-Age=3600`,
          `${COOKIE_NAME}=${encodeURIComponent(normalized)}; Path=/; SameSite=Lax; Max-Age=3600`,
        );
      }

      const fromQuery = url.searchParams.get('c8u');
      const fromCookie = readCookie(req.headers.cookie, COOKIE_NAME);
      const upstream = resolveUpstream(fromQuery ?? fromCookie, UPSTREAMS.mainnet);
      const result = await proxySpaRequest({
        pathname,
        searchParams: url.searchParams,
        cookieHeader: req.headers.cookie,
        acceptHeader: req.headers.accept,
        userAgent: req.headers['user-agent'],
        defaultUpstream: upstream,
      });

      res.statusCode = result.status;
      for (const [key, value] of Object.entries(result.headers)) {
        if (key.toLowerCase() === 'set-cookie') continue;
        res.setHeader(key, value);
      }
      for (const cookie of setCookies) {
        res.appendHeader('Set-Cookie', cookie);
      }
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(result.body);
    } catch (err) {
      res.statusCode = 502;
      res.end(`c8 same-origin proxy error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    name: 'cantor8-same-origin-proxy-dev',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

/** Dev-only stand-in for /api/cantor8-embed-health. */
function cantor8EmbedHealthPlugin(): Plugin {
  return {
    name: 'cantor8-embed-health-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/api/cantor8-embed-health')) {
          next();
          return;
        }
        const network = new URL(url, 'http://localhost').searchParams.get('network') ?? 'mainnet';
        const host = req.headers.host || 'localhost:5180';
        const origin = network === 'local' ? 'http://localhost:8081' : `http://${host}`;
        const c8u = network === 'devnet' ? 'devnet' : 'mainnet';
        const embedUrl =
          network === 'local'
            ? `${origin}/embedded/?c8u=${c8u}`
            : `${origin}/__c8/embedded/?c8u=${c8u}`;
        try {
          const response = await fetch(embedUrl, {
            method: 'GET',
            redirect: 'manual',
            headers: { Accept: 'text/html', 'User-Agent': 'canton-test-dapp-embed-health' },
          });
          const body = await response.text();
          const ok =
            response.status >= 200 &&
            response.status < 300 &&
            /id=["']root["']/.test(body) &&
            /_expo\/static\/js\/web\/entry-/.test(body);
          res.setHeader('content-type', 'application/json');
          res.setHeader('cache-control', 'no-store');
          res.end(
            JSON.stringify({
              ok,
              status: response.status,
              network,
              origin,
              embedUrl,
              proxy: true,
              hint: ok
                ? 'Same-origin /__c8 SPA proxy is serving the wallet embed route.'
                : 'Same-origin /__c8 proxy did not return the wallet SPA.',
            }),
          );
        } catch (err) {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              ok: false,
              status: 0,
              network,
              origin,
              embedUrl,
              error: err instanceof Error ? err.message : String(err),
              hint: 'Failed to reach same-origin wallet embed URL.',
            }),
          );
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    cantor8SdkProxyPlugin(),
    cantor8SameOriginProxyPlugin(),
    cantor8EmbedHealthPlugin(),
  ],
  server: {
    port: 5180,
  },
});
