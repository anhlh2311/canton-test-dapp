/**
 * Vercel Edge Middleware: same-origin Cantor8 SPA proxy under /__c8/*.
 *
 * Public wallet hosts 404 /embedded/. The SDK popup opens
 * `${location.origin}/__c8/embedded/?c8u=…` on this dApp instead; we reverse-proxy
 * the real wallet with SPA fallback. A short-lived cookie also proxies Expo
 * absolute navigations and root static assets (e.g. /canvaskit.wasm).
 * Nested wasm (e.g. /embedded/canvaskit.wasm) 404s on the wallet host — CanvasKit
 * resolves relative to /embedded/ after path-strip; we fall back to /canvaskit.wasm.
 *
 * Wallet-backend APIs CORS-allow only wallet.* origins (mainnet rejects this dApp).
 * Injected bridge rewrites those fetches to /__c8api/h/{host}/… which we proxy with
 * a spoofed wallet Origin.
 */
const UPSTREAMS = {
  mainnet: 'https://wallet.cantor8.tech',
  devnet: 'https://wallet.dev.digik.cantor8.tech',
  testmainnet: 'https://wallet.main.digik.cantor8.tech',
};
const C8U_COOKIE = 'c8u';
const C8_PROXY_COOKIE = 'c8_proxy';
const PREFIX = '/__c8';
const API_PREFIX = '/__c8api/h/';

/** Static extensions that belong to the wallet popup (never SPA-fallback). */
const WALLET_STATIC_EXT =
  /\.(wasm|data|mem|js|mjs|css|map|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf|json)$/i;

function resolveUpstream(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'dev' || key === 'devnet') return UPSTREAMS.devnet;
  if (key === 'testmainnet' || key === 'test') return UPSTREAMS.testmainnet;
  if (key === 'main' || key === 'mainnet') return UPSTREAMS.mainnet;
  return UPSTREAMS.mainnet;
}

function readCookie(header, name) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('=') || '');
  }
  return undefined;
}

function isDocumentRequest(request, pathname) {
  // Never SPA-fallback binaries / static assets — HTML here breaks WebAssembly.
  if (WALLET_STATIC_EXT.test(pathname)) return false;
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('text/html')) return true;
  if (pathname === '/' || pathname.endsWith('.html')) return true;
  const last = pathname.split('/').pop() ?? '';
  return !last.includes('.');
}

/** Paths that belong to this Vite dApp — never proxy these. */
function isDappPath(pathname) {
  if (pathname === '/' || pathname === '/index.html') return true;
  // Vite hashed bundles are /assets/index-*. Wallet Expo assets are /assets/assets/* —
  // those must be proxied (otherwise fonts/images become SPA HTML and fail to decode).
  if (pathname.startsWith('/assets/') && !pathname.startsWith('/assets/assets/')) return true;
  if (pathname.startsWith('/api/')) return true;
  if (
    pathname === '/cantor8' ||
    pathname.startsWith('/cantor8/') ||
    pathname === '/rocky' ||
    pathname.startsWith('/rocky/') ||
    pathname === '/partylayer' ||
    pathname.startsWith('/partylayer/') ||
    pathname === '/console' ||
    pathname.startsWith('/console/') ||
    pathname === '/standard' ||
    pathname.startsWith('/standard/')
  ) {
    return true;
  }
  if (pathname.startsWith('/src/') || pathname.startsWith('/node_modules/') || pathname.startsWith('/@')) {
    return true;
  }
  return false;
}

function shouldProxyWalletPath(pathname, hasProxyCookie) {
  if (pathname.startsWith(`${PREFIX}/`) || pathname === PREFIX) return true;
  if (!hasProxyCookie) return false;
  if (isDappPath(pathname)) return false;
  if (pathname.startsWith('/_expo/')) return true;
  // Wallet Expo static fonts/images (e.g. InterTight.ttf, embedded icon.png).
  if (pathname.startsWith('/assets/assets/')) return true;
  if (pathname.startsWith('/embedded')) return true;
  if (pathname.startsWith('/setup')) return true;
  if (pathname.startsWith('/trade')) return true;
  if (pathname.startsWith('/(embedded)')) return true;
  if (pathname === '/favicon.ico') return true;
  // Root CanvasKit / DotLottie WASM and similar static files next to the SPA.
  if (WALLET_STATIC_EXT.test(pathname)) return true;
  return false;
}

function stripHopByHop(headers) {
  const out = new Headers();
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
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
    out.set(key, value);
  });
  out.set('cache-control', 'no-store');
  out.set('x-c8-spa-proxy', '1');
  out.set('access-control-allow-origin', '*');
  return out;
}

/** @returns {string | null} */
function wasmRootFallbackPath(pathname) {
  if (!pathname.toLowerCase().endsWith('.wasm')) return null;
  const base = pathname.split('/').filter(Boolean).pop();
  if (!base) return null;
  const root = `/${base}`;
  return pathname === root ? null : root;
}

function isAllowedC8ApiHost(host) {
  return /^wallet-backend\.[a-z0-9.-]+\.cantor8\.tech$/i.test(String(host || ''));
}

function spoofOriginForApiHost(host) {
  const h = String(host || '').toLowerCase();
  if (h.includes('.dev.')) return 'https://wallet.dev.digik.cantor8.tech';
  return 'https://wallet.cantor8.tech';
}

function c8WalletBridgeScript() {
  return `<script>(function(){try{var p=location.pathname;if(p==="/__c8"||p.indexOf("/__c8/")===0){var n=p==="/__c8"?"/":p.slice(5)||"/";history.replaceState(null,"",n+location.search+location.hash)}}catch(e){}try{var P="/__c8api/h/";var RE=/^https:\\/\\/(wallet-backend\\.[a-z0-9.-]+\\.cantor8\\.tech)(\\/.*)?$/i;function rewrite(u){try{if(typeof u==="string"){var m=u.match(RE);return m?P+m[1]+(m[2]||"/"):u}if(u&&typeof Request!=="undefined"&&u instanceof Request){var m2=u.url.match(RE);return m2?new Request(P+m2[1]+(m2[2]||"/"),u):u}}catch(e){}return u}var of=window.fetch;window.fetch=function(i,init){return of.call(this,rewrite(i),init)};var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){var a=[].slice.call(arguments);if(typeof a[1]==="string")a[1]=rewrite(a[1]);return xo.apply(this,a)}}catch(e){}})();</script>`;
}

async function proxyWalletApi(request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(API_PREFIX)) {
    return new Response('c8 api proxy: bad path', { status: 404 });
  }
  const rest = url.pathname.slice(API_PREFIX.length);
  const slash = rest.indexOf('/');
  const host = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '/' : rest.slice(slash);
  if (!isAllowedC8ApiHost(host)) {
    return new Response('c8 api proxy: host not allowed', {
      status: 404,
      headers: { 'x-c8-spa-proxy-status': 'api-host-denied' },
    });
  }

  const spoofOrigin = spoofOriginForApiHost(host);
  const target = new URL(`${path}${url.search}`, `https://${host}/`);
  const forwardHeaders = new Headers();
  const accept = request.headers.get('accept');
  const ua = request.headers.get('user-agent');
  const contentType = request.headers.get('content-type');
  const authorization = request.headers.get('authorization');
  if (accept) forwardHeaders.set('accept', accept);
  if (ua) forwardHeaders.set('user-agent', ua);
  if (contentType) forwardHeaders.set('content-type', contentType);
  if (authorization) forwardHeaders.set('authorization', authorization);
  forwardHeaders.set('origin', spoofOrigin);
  forwardHeaders.set('referer', `${spoofOrigin}/`);

  const method = request.method.toUpperCase();
  const init = {
    method,
    headers: forwardHeaders,
    redirect: 'manual',
  };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = await request.arrayBuffer();
  }

  const upstreamRes = await fetch(target, init);
  const headers = stripHopByHop(upstreamRes.headers);
  headers.set('x-c8-spa-proxy-status', 'api-proxy');
  headers.set('x-c8-spa-proxy-upstream', `https://${host}`);
  headers.set('x-c8-api-spoof-origin', spoofOrigin);

  if (method === 'HEAD') {
    return new Response(null, { status: upstreamRes.status, headers });
  }
  return new Response(await upstreamRes.arrayBuffer(), {
    status: upstreamRes.status,
    headers,
  });
}

async function proxyToWallet(request, upstreamPath, upstreamBase, setCookies) {
  const target = new URL(upstreamPath, `${upstreamBase}/`);
  target.searchParams.delete('c8u');

  const forwardHeaders = new Headers();
  const accept = request.headers.get('accept');
  const ua = request.headers.get('user-agent');
  if (accept) forwardHeaders.set('accept', accept);
  if (ua) forwardHeaders.set('user-agent', ua);

  let upstreamRes = await fetch(target, {
    method: 'GET',
    headers: forwardHeaders,
    redirect: 'manual',
  });
  /** @type {'passthrough' | 'fallback-index' | 'fallback-wasm-root'} */
  let proxyStatus = 'passthrough';
  const pathname = new URL(upstreamPath, 'http://local').pathname;

  if (upstreamRes.status === 404 && isDocumentRequest(request, pathname)) {
    const fallback = await fetch(new URL('/index.html', `${upstreamBase}/`), {
      method: 'GET',
      headers: { accept: 'text/html', 'user-agent': ua ?? 'c8-spa-proxy' },
      redirect: 'manual',
    });
    if (fallback.ok) {
      upstreamRes = fallback;
      proxyStatus = 'fallback-index';
    }
  }

  const wasmRoot = wasmRootFallbackPath(pathname);
  if (upstreamRes.status === 404 && wasmRoot) {
    const fallback = await fetch(new URL(wasmRoot, `${upstreamBase}/`), {
      method: 'GET',
      headers: {
        accept: accept ?? 'application/wasm,*/*',
        'user-agent': ua ?? 'c8-spa-proxy',
      },
      redirect: 'manual',
    });
    if (fallback.ok) {
      upstreamRes = fallback;
      proxyStatus = 'fallback-wasm-root';
    }
  }

  const headers = stripHopByHop(upstreamRes.headers);
  headers.set('x-c8-spa-proxy-status', proxyStatus);
  headers.set('x-c8-spa-proxy-upstream', upstreamBase);
  if (proxyStatus === 'fallback-index') headers.set('content-type', 'text/html; charset=utf-8');
  // Ensure wasm is not served as text/html if upstream mislabels.
  if (pathname.endsWith('.wasm') && proxyStatus !== 'fallback-index') {
    headers.set('content-type', 'application/wasm');
  }
  for (const c of setCookies) headers.append('set-cookie', c);

  const okStatus = proxyStatus !== 'passthrough' ? 200 : upstreamRes.status;

  if (request.method === 'HEAD') {
    return new Response(null, { status: okStatus, headers });
  }

  let body = await upstreamRes.arrayBuffer();
  // Expo path-strip + wallet-backend fetch rewrite before the wallet app boots.
  const ct = headers.get('content-type') ?? '';
  const isHtml = proxyStatus === 'fallback-index' || ct.includes('text/html');
  if (isHtml) {
    const html = new TextDecoder().decode(body);
    const snippet = c8WalletBridgeScript();
    const rewritten = /<head[\s>]/i.test(html)
      ? html.replace(/<head([^>]*)>/i, `<head$1>${snippet}`)
      : snippet + html;
    body = new TextEncoder().encode(rewritten);
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.delete('content-length');
  }

  return new Response(body, {
    status: okStatus,
    headers,
  });
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const { pathname, search } = url;

  // API proxy: all methods (wallet AppConfig / vault calls).
  if (pathname.startsWith('/__c8api/')) {
    return proxyWalletApi(request);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return;
  }

  const cookieHeader = request.headers.get('cookie') ?? '';
  const hasProxyCookie = readCookie(cookieHeader, C8_PROXY_COOKIE) === '1';
  const fromQuery = url.searchParams.get('c8u');
  const fromCookie = readCookie(cookieHeader, C8U_COOKIE);
  const upstream = resolveUpstream(fromQuery ?? fromCookie);

  if (!shouldProxyWalletPath(pathname, hasProxyCookie)) {
    return;
  }

  const setCookies = [];
  let upstreamPath = `${pathname}${search}`;

  if (pathname === PREFIX || pathname.startsWith(`${PREFIX}/`)) {
    const stripped = pathname === PREFIX ? '/' : pathname.slice(PREFIX.length) || '/';
    upstreamPath = `${stripped}${search}`;
    const c8u =
      fromQuery === 'devnet' || fromQuery === 'dev'
        ? 'devnet'
        : fromQuery === 'testmainnet' || fromQuery === 'test'
          ? 'testmainnet'
          : fromQuery || fromCookie || 'mainnet';
    const normalized =
      c8u === 'devnet' || c8u === 'dev'
        ? 'devnet'
        : c8u === 'testmainnet' || c8u === 'test'
          ? 'testmainnet'
          : 'mainnet';
    setCookies.push(
      `${C8_PROXY_COOKIE}=1; Path=/; SameSite=Lax; Max-Age=3600`,
      `${C8U_COOKIE}=${encodeURIComponent(normalized)}; Path=/; SameSite=Lax; Max-Age=3600`,
    );
  }

  return proxyToWallet(request, upstreamPath, upstream, setCookies);
}

export const config = {
  // Broad matcher so root *.wasm (canvaskit) is intercepted when c8_proxy cookie is set.
  matcher: [
    '/__c8',
    '/__c8/:path*',
    '/__c8api',
    '/__c8api/:path*',
    '/_expo/:path*',
    '/assets/assets/:path*',
    '/embedded',
    '/embedded/:path*',
    '/setup',
    '/setup/:path*',
    '/trade',
    '/trade/:path*',
    '/favicon.ico',
    '/:file*.wasm',
    '/:file*.data',
    '/:file*.mem',
  ],
};
