/**
 * Vercel Edge Middleware: same-origin Cantor8 SPA proxy under /__c8/*.
 *
 * Public wallet hosts 404 /embedded/. The SDK popup opens
 * `${location.origin}/__c8/embedded/?c8u=…` on this dApp instead; we reverse-proxy
 * the real wallet with SPA fallback. A short-lived cookie also proxies Expo
 * absolute navigations (/_expo/*, /embedded/*, /setup/*, …) from that popup.
 */
const UPSTREAMS = {
  mainnet: 'https://wallet.cantor8.tech',
  devnet: 'https://wallet.dev.digik.cantor8.tech',
  testmainnet: 'https://wallet.main.digik.cantor8.tech',
};
const C8U_COOKIE = 'c8u';
const C8_PROXY_COOKIE = 'c8_proxy';
const PREFIX = '/__c8';

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
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('text/html')) return true;
  if (pathname === '/' || pathname.endsWith('.html')) return true;
  const last = pathname.split('/').pop() ?? '';
  return !last.includes('.');
}

/** Paths that belong to this Vite dApp — never proxy these. */
function isDappPath(pathname) {
  if (pathname === '/' || pathname === '/index.html') return true;
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
  return out;
}

async function proxyToWallet(request, upstreamPath, upstreamBase, setCookies) {
  const upstreamParams = new URL(upstreamPath, 'http://local').searchParams;
  // keep search on upstreamPath as provided
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
  for (const c of setCookies) headers.append('set-cookie', c);

  if (request.method === 'HEAD') {
    return new Response(null, { status: servedFallback ? 200 : upstreamRes.status, headers });
  }
  return new Response(await upstreamRes.arrayBuffer(), {
    status: servedFallback ? 200 : upstreamRes.status,
    headers,
  });
}

export default async function middleware(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return; // fall through
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
  ],
};
