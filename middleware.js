/**
 * Vercel Edge Middleware: same-origin Cantor8 SPA proxy under /__c8/*.
 *
 * Public wallet hosts 404 /embedded/. The SDK popup opens
 * `${location.origin}/__c8/embedded/?c8u=…` on this dApp instead; we reverse-proxy
 * the real wallet with SPA fallback. A short-lived cookie also proxies Expo
 * absolute navigations and root static assets (e.g. /canvaskit.wasm).
 */
const UPSTREAMS = {
  mainnet: 'https://wallet.cantor8.tech',
  devnet: 'https://wallet.dev.digik.cantor8.tech',
  testmainnet: 'https://wallet.main.digik.cantor8.tech',
};
const C8U_COOKIE = 'c8u';
const C8_PROXY_COOKIE = 'c8_proxy';
const PREFIX = '/__c8';

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
  // Vite hashed assets live under /assets/index-*. Do not proxy those.
  if (pathname.startsWith('/assets/')) return true;
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
      k === 'set-cookie'
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

async function proxyToWallet(request, upstreamPath, upstreamBase, setCookies, stripPrefix) {
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
  let servedFallback = false;
  const pathname = new URL(upstreamPath, 'http://local').pathname;

  if (upstreamRes.status === 404 && isDocumentRequest(request, pathname)) {
    const fallback = await fetch(new URL('/index.html', `${upstreamBase}/`), {
      method: 'GET',
      headers: { accept: 'text/html', 'user-agent': ua ?? 'c8-spa-proxy' },
      redirect: 'manual',
    });
    if (fallback.ok) {
      upstreamRes = fallback;
      servedFallback = true;
    }
  }

  const headers = stripHopByHop(upstreamRes.headers);
  headers.set('x-c8-spa-proxy-status', servedFallback ? 'fallback-index' : 'passthrough');
  headers.set('x-c8-spa-proxy-upstream', upstreamBase);
  if (servedFallback) headers.set('content-type', 'text/html; charset=utf-8');
  // Ensure wasm is not served as text/html if upstream mislabels.
  if (pathname.endsWith('.wasm') && !servedFallback) {
    headers.set('content-type', 'application/wasm');
  }
  for (const c of setCookies) headers.append('set-cookie', c);

  if (request.method === 'HEAD') {
    return new Response(null, { status: servedFallback ? 200 : upstreamRes.status, headers });
  }

  let body = await upstreamRes.arrayBuffer();
  // Expo Router matches /embedded, not /__c8/embedded — rewrite the visible path
  // before the wallet app boots so MessageListener mounts and handshake can complete.
  const ct = headers.get('content-type') ?? '';
  if (stripPrefix && (servedFallback || ct.includes('text/html'))) {
    const html = new TextDecoder().decode(body);
    const snippet =
      '<script>(function(){try{var p=location.pathname;if(p==="/__c8"||p.indexOf("/__c8/")===0){var n=p==="/__c8"?"/":p.slice(5)||"/";history.replaceState(null,"",n+location.search+location.hash)}}catch(e){}})();</script>';
    const rewritten = /<head[\s>]/i.test(html)
      ? html.replace(/<head([^>]*)>/i, `<head$1>${snippet}`)
      : snippet + html;
    body = new TextEncoder().encode(rewritten);
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.delete('content-length');
  }

  return new Response(body, {
    status: servedFallback ? 200 : upstreamRes.status,
    headers,
  });
}

export default async function middleware(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return;
  }

  const url = new URL(request.url);
  const { pathname, search } = url;
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
  let stripPrefix = false;

  if (pathname === PREFIX || pathname.startsWith(`${PREFIX}/`)) {
    stripPrefix = true;
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

  return proxyToWallet(request, upstreamPath, upstream, setCookies, stripPrefix);
}

export const config = {
  // Broad matcher so root *.wasm (canvaskit) is intercepted when c8_proxy cookie is set.
  matcher: [
    '/__c8',
    '/__c8/:path*',
    '/_expo/:path*',
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
