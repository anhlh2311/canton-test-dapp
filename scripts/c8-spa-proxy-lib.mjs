/**
 * Shared SPA-fallback reverse-proxy for Cantor8's hosted wallet.
 * Public Caddy hosts 404 /embedded/; this returns /index.html for document 404s.
 * Also same-origin API proxy for wallet-backend.* (mainnet CORS blocks the dApp origin).
 */
import { URL } from 'node:url';

export const UPSTREAMS = {
  mainnet: 'https://wallet.cantor8.tech',
  devnet: 'https://wallet.dev.digik.cantor8.tech',
  testmainnet: 'https://wallet.main.digik.cantor8.tech',
};

export const COOKIE_NAME = 'c8u';
export const API_PROXY_PREFIX = '/__c8api/h/';

/**
 * @param {string | null | undefined} value
 * @param {string} [fallback]
 */
export function resolveUpstream(value, fallback = UPSTREAMS.mainnet) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'dev' || key === 'devnet') return UPSTREAMS.devnet;
  if (key === 'testmainnet' || key === 'test') return UPSTREAMS.testmainnet;
  if (key === 'main' || key === 'mainnet') return UPSTREAMS.mainnet;
  if (key.startsWith('http://') || key.startsWith('https://')) return key.replace(/\/$/, '');
  return fallback;
}

/**
 * @param {string | null | undefined} cookieHeader
 * @param {string} name
 */
export function readCookie(cookieHeader, name) {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('=') || '');
  }
  return undefined;
}

const STATIC_EXT =
  /\.(wasm|data|mem|js|mjs|css|map|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf|json)$/i;

/**
 * Skia/CanvasKit (and DotLottie) often resolve wasm relative to the page URL.
 * On /embedded/ that becomes /embedded/canvaskit.wasm (404); the file lives at /canvaskit.wasm.
 * @param {string} pathname
 * @returns {string | null} root path like /canvaskit.wasm, or null if already root / not wasm
 */
export function wasmRootFallbackPath(pathname) {
  if (!pathname.toLowerCase().endsWith('.wasm')) return null;
  const base = pathname.split('/').filter(Boolean).pop();
  if (!base) return null;
  const root = `/${base}`;
  return pathname === root ? null : root;
}

/** @param {string} host */
export function isAllowedC8ApiHost(host) {
  return /^wallet-backend\.[a-z0-9.-]+\.cantor8\.tech$/i.test(String(host || ''));
}

/** Origin the backend CORS allowlist accepts (dApp origin is rejected on mainnet). */
export function spoofOriginForApiHost(host) {
  const h = String(host || '').toLowerCase();
  if (h.includes('.dev.')) return 'https://wallet.dev.digik.cantor8.tech';
  return 'https://wallet.cantor8.tech';
}

/**
 * @param {string} pathname
 * @returns {{ host: string, path: string } | null}
 */
export function parseApiProxyPath(pathname) {
  if (!pathname.startsWith(API_PROXY_PREFIX)) return null;
  const rest = pathname.slice(API_PROXY_PREFIX.length);
  if (!rest) return null;
  const slash = rest.indexOf('/');
  const host = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '/' : rest.slice(slash);
  if (!isAllowedC8ApiHost(host)) return null;
  return { host, path };
}

/**
 * Bridge injected into proxied wallet HTML:
 * 1) Strip /__c8 so Expo Router matches /embedded
 * 2) Rewrite wallet-backend.* fetches to same-origin /__c8api/h/... (CORS bypass)
 */
export function c8WalletBridgeScript() {
  return `<script>(function(){try{var p=location.pathname;if(p==="/__c8"||p.indexOf("/__c8/")===0){var n=p==="/__c8"?"/":p.slice(5)||"/";history.replaceState(null,"",n+location.search+location.hash)}}catch(e){}try{var P="/__c8api/h/";var RE=/^https:\\/\\/(wallet-backend\\.[a-z0-9.-]+\\.cantor8\\.tech)(\\/.*)?$/i;function rewrite(u){try{if(typeof u==="string"){var m=u.match(RE);return m?P+m[1]+(m[2]||"/"):u}if(u&&typeof Request!=="undefined"&&u instanceof Request){var m2=u.url.match(RE);return m2?new Request(P+m2[1]+(m2[2]||"/"),u):u}}catch(e){}return u}var of=window.fetch;window.fetch=function(i,init){return of.call(this,rewrite(i),init)};var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){var a=[].slice.call(arguments);if(typeof a[1]==="string")a[1]=rewrite(a[1]);return xo.apply(this,a)}}catch(e){}})();</script>`;
}

/**
 * @param {string} html
 */
export function injectC8WalletBridgeScript(html) {
  const snippet = c8WalletBridgeScript();
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${snippet}`);
  }
  return snippet + html;
}

/** @deprecated use injectC8WalletBridgeScript */
export function injectC8PathStripScript(html) {
  return injectC8WalletBridgeScript(html);
}

/**
 * @param {import('http').IncomingMessage | Request} req
 * @param {string} pathname
 */
export function isDocumentRequest(req, pathname) {
  // Never SPA-fallback binaries — HTML for .wasm breaks WebAssembly.instantiate.
  if (STATIC_EXT.test(pathname)) return false;
  const accept =
    typeof req.headers?.get === 'function'
      ? String(req.headers.get('accept') ?? '')
      : String(req.headers?.accept ?? '');
  if (accept.includes('text/html')) return true;
  if (pathname === '/' || pathname.endsWith('.html')) return true;
  const last = pathname.split('/').pop() ?? '';
  if (!last.includes('.')) return true;
  return false;
}

/**
 * @param {Headers | { forEach: Function }} upstreamHeaders
 * @param {string} statusForBody
 */
export function copyProxyHeaders(upstreamHeaders, statusForBody) {
  /** @type {Record<string, string>} */
  const out = {};
  upstreamHeaders.forEach((value, key) => {
    const k = String(key).toLowerCase();
    if (
      k === 'content-encoding' ||
      k === 'content-length' ||
      k === 'transfer-encoding' ||
      k === 'connection' ||
      k === 'content-security-policy' ||
      k === 'x-frame-options' ||
      k === 'set-cookie' ||
      k === 'access-control-allow-origin' ||
      k === 'access-control-allow-credentials'
    ) {
      return;
    }
    out[key] = value;
  });
  out['cache-control'] = 'no-store';
  out['x-c8-spa-proxy'] = '1';
  out['x-c8-spa-proxy-status'] = statusForBody;
  // Allow the Vite dApp (other origin) to health-check the standalone proxy.
  out['access-control-allow-origin'] = '*';
  return out;
}

/**
 * @param {string} upstreamBase
 * @param {string} pathWithQuery
 * @param {Record<string, string | string[] | undefined> | Headers} reqHeaders
 * @param {{ method?: string, body?: ArrayBuffer | Buffer | null }} [opts]
 */
export async function fetchUpstream(upstreamBase, pathWithQuery, reqHeaders, opts = {}) {
  const target = new URL(pathWithQuery, upstreamBase.endsWith('/') ? upstreamBase : `${upstreamBase}/`);
  /** @type {Record<string, string>} */
  const headers = {};
  if (typeof reqHeaders?.forEach === 'function') {
    reqHeaders.forEach((value, key) => {
      headers[key] = value;
    });
  } else {
    for (const [key, value] of Object.entries(reqHeaders ?? {})) {
      if (value == null) continue;
      headers[key] = Array.isArray(value) ? value.join(',') : String(value);
    }
  }
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  delete headers['cookie'];

  const res = await fetch(target, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ?? undefined,
    redirect: 'manual',
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf, url: target.toString() };
}

/**
 * Same-origin reverse proxy for wallet-backend.* (AppConfig etc.).
 * @param {{
 *   pathname: string,
 *   search?: string,
 *   method?: string,
 *   acceptHeader?: string | null,
 *   userAgent?: string | null,
 *   contentType?: string | null,
 *   authorization?: string | null,
 *   body?: ArrayBuffer | Buffer | null,
 * }} opts
 */
export async function proxyApiRequest(opts) {
  const parsed = parseApiProxyPath(opts.pathname);
  if (!parsed) {
    return {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-c8-spa-proxy': '1',
        'x-c8-spa-proxy-status': 'api-host-denied',
      },
      body: Buffer.from('c8 api proxy: host not allowed'),
    };
  }

  const search = opts.search ?? '';
  const pathWithQuery = `${parsed.path}${search}`;
  const spoofOrigin = spoofOriginForApiHost(parsed.host);
  const reqHeaders = {
    accept: opts.acceptHeader ?? 'application/json,*/*',
    'user-agent': opts.userAgent ?? 'c8-spa-proxy',
    origin: spoofOrigin,
    referer: `${spoofOrigin}/`,
  };
  if (opts.contentType) reqHeaders['content-type'] = opts.contentType;
  if (opts.authorization) reqHeaders.authorization = opts.authorization;

  const method = (opts.method ?? 'GET').toUpperCase();
  const upstreamRes = await fetchUpstream(`https://${parsed.host}`, pathWithQuery, reqHeaders, {
    method,
    body: method === 'GET' || method === 'HEAD' ? null : opts.body ?? null,
  });

  const headers = copyProxyHeaders(upstreamRes.headers, 'api-proxy');
  headers['x-c8-spa-proxy-upstream'] = `https://${parsed.host}`;
  headers['x-c8-api-spoof-origin'] = spoofOrigin;

  return {
    status: upstreamRes.status,
    headers,
    body: upstreamRes.buf,
    host: parsed.host,
  };
}

/**
 * @param {{
 *   pathname: string,
 *   searchParams: URLSearchParams,
 *   cookieHeader?: string | null,
 *   acceptHeader?: string | null,
 *   userAgent?: string | null,
 *   defaultUpstream?: string,
 *   stripC8Prefix?: boolean,
 *   injectBridge?: boolean,
 * }} opts
 */
export async function proxySpaRequest(opts) {
  const defaultUpstream = opts.defaultUpstream ?? UPSTREAMS.mainnet;
  const fromQuery = opts.searchParams.get('c8u');
  const fromCookie = readCookie(opts.cookieHeader, COOKIE_NAME);
  const upstream = resolveUpstream(fromQuery ?? fromCookie, defaultUpstream);
  const setCookie = fromQuery
    ? `${COOKIE_NAME}=${encodeURIComponent(
        fromQuery === 'devnet' || fromQuery === 'dev'
          ? 'devnet'
          : fromQuery === 'testmainnet' || fromQuery === 'test'
            ? 'testmainnet'
            : 'mainnet',
      )}; Path=/; SameSite=Lax; Max-Age=86400`
    : undefined;

  const pathWithQuery = `${opts.pathname}${opts.searchParams.toString() ? `?${opts.searchParams}` : ''}`;
  // Strip c8u from upstream query so Expo doesn't see it as a route param noise.
  const upstreamParams = new URLSearchParams(opts.searchParams);
  upstreamParams.delete('c8u');
  const upstreamPath =
    `${opts.pathname}${upstreamParams.toString() ? `?${upstreamParams}` : ''}` || '/';

  const reqHeaders = {
    accept: opts.acceptHeader ?? 'text/html',
    'user-agent': opts.userAgent ?? 'c8-spa-proxy',
  };

  let upstreamRes = await fetchUpstream(upstream, upstreamPath, reqHeaders);
  let servedFallback = false;
  /** @type {'passthrough' | 'fallback-index' | 'fallback-wasm-root'} */
  let proxyStatus = 'passthrough';

  const doc = isDocumentRequest(
    { headers: { accept: opts.acceptHeader ?? '' } },
    opts.pathname,
  );
  if (upstreamRes.status === 404 && doc) {
    const fallback = await fetchUpstream(upstream, '/index.html', {
      accept: 'text/html',
      'user-agent': reqHeaders['user-agent'],
    });
    if (fallback.status >= 200 && fallback.status < 300 && fallback.buf.length > 0) {
      upstreamRes = { ...fallback, status: 200 };
      servedFallback = true;
      proxyStatus = 'fallback-index';
    }
  }

  // Nested wasm 404 → retry /basename (CanvasKit after Passkey on /embedded/).
  const wasmRoot = wasmRootFallbackPath(opts.pathname);
  if (upstreamRes.status === 404 && wasmRoot) {
    const fallback = await fetchUpstream(upstream, wasmRoot, {
      accept: opts.acceptHeader ?? 'application/wasm,*/*',
      'user-agent': reqHeaders['user-agent'],
    });
    if (fallback.status >= 200 && fallback.status < 300 && fallback.buf.length > 4) {
      upstreamRes = { ...fallback, status: 200 };
      servedFallback = true;
      proxyStatus = 'fallback-wasm-root';
    }
  }

  const headers = copyProxyHeaders(upstreamRes.headers, proxyStatus);
  headers['x-c8-spa-proxy-upstream'] = upstream;
  if (proxyStatus === 'fallback-index') {
    headers['content-type'] = 'text/html; charset=utf-8';
  }
  if (proxyStatus === 'fallback-wasm-root' || (opts.pathname.endsWith('.wasm') && !servedFallback)) {
    headers['content-type'] = 'application/wasm';
  }
  if (setCookie) {
    headers['set-cookie'] = setCookie;
  }

  let body = upstreamRes.buf;
  const ct = headers['content-type'] ?? '';
  const isHtml = proxyStatus === 'fallback-index' || ct.includes('text/html');
  // Always inject path-strip + API rewrite into wallet HTML (CORS bypass for AppConfig).
  if (opts.injectBridge !== false && isHtml && body.length > 0) {
    const html = injectC8WalletBridgeScript(body.toString('utf8'));
    body = Buffer.from(html, 'utf8');
    headers['content-type'] = 'text/html; charset=utf-8';
    delete headers['content-length'];
  }

  return {
    status: upstreamRes.status,
    headers,
    body,
    upstream,
    servedFallback,
    pathWithQuery,
  };
}
