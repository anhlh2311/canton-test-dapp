/**
 * Shared SPA-fallback reverse-proxy for Cantor8's hosted wallet.
 * Public Caddy hosts 404 /embedded/; this returns /index.html for document 404s.
 */
import { URL } from 'node:url';

export const UPSTREAMS = {
  mainnet: 'https://wallet.cantor8.tech',
  devnet: 'https://wallet.dev.digik.cantor8.tech',
  testmainnet: 'https://wallet.main.digik.cantor8.tech',
};

export const COOKIE_NAME = 'c8u';

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

/**
 * @param {import('http').IncomingMessage | Request} req
 * @param {string} pathname
 */
export function isDocumentRequest(req, pathname) {
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
      k === 'set-cookie'
    ) {
      return;
    }
    out[key] = value;
  });
  out['cache-control'] = 'no-store';
  out['x-c8-spa-proxy'] = '1';
  out['x-c8-spa-proxy-status'] = statusForBody;
  return out;
}

/**
 * @param {string} upstreamBase
 * @param {string} pathWithQuery
 * @param {Record<string, string | string[] | undefined> | Headers} reqHeaders
 */
export async function fetchUpstream(upstreamBase, pathWithQuery, reqHeaders) {
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
    method: 'GET',
    headers,
    redirect: 'manual',
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf, url: target.toString() };
}

/**
 * @param {{
 *   pathname: string,
 *   searchParams: URLSearchParams,
 *   cookieHeader?: string | null,
 *   acceptHeader?: string | null,
 *   userAgent?: string | null,
 *   defaultUpstream?: string,
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
    }
  }

  const headers = copyProxyHeaders(
    upstreamRes.headers,
    servedFallback ? 'fallback-index' : 'passthrough',
  );
  headers['x-c8-spa-proxy-upstream'] = upstream;
  if (servedFallback) {
    headers['content-type'] = 'text/html; charset=utf-8';
  }
  if (setCookie) {
    headers['set-cookie'] = setCookie;
  }

  return {
    status: upstreamRes.status,
    headers,
    body: upstreamRes.buf,
    upstream,
    servedFallback,
    pathWithQuery,
  };
}
