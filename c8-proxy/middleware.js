/**
 * Vercel Edge Middleware: SPA-fallback reverse proxy for Cantor8 wallet.
 * Deploy this folder as its own Vercel project (root directory = c8-proxy).
 */
const UPSTREAMS = {
  mainnet: 'https://wallet.cantor8.tech',
  devnet: 'https://wallet.dev.digik.cantor8.tech',
  testmainnet: 'https://wallet.main.digik.cantor8.tech',
};
const COOKIE_NAME = 'c8u';

function resolveUpstream(value, fallback) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'dev' || key === 'devnet') return UPSTREAMS.devnet;
  if (key === 'testmainnet' || key === 'test') return UPSTREAMS.testmainnet;
  if (key === 'main' || key === 'mainnet') return UPSTREAMS.mainnet;
  if (key.startsWith('http://') || key.startsWith('https://')) return key.replace(/\/$/, '');
  return fallback;
}

function readCookie(cookieHeader, name) {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('=') || '');
  }
  return undefined;
}

function isDocumentRequest(req, pathname) {
  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('text/html')) return true;
  if (pathname === '/' || pathname.endsWith('.html')) return true;
  const last = pathname.split('/').pop() ?? '';
  return !last.includes('.');
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

export default async function middleware(request) {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const defaultUpstream = resolveUpstream(
    process.env.C8_UPSTREAM,
    UPSTREAMS.mainnet,
  );
  const fromQuery = url.searchParams.get('c8u');
  const fromCookie = readCookie(request.headers.get('cookie'), COOKIE_NAME);
  const upstream = resolveUpstream(fromQuery ?? fromCookie, defaultUpstream);

  const upstreamParams = new URLSearchParams(url.searchParams);
  upstreamParams.delete('c8u');
  const upstreamPath = `${url.pathname}${upstreamParams.toString() ? `?${upstreamParams}` : ''}`;

  const forwardHeaders = new Headers();
  const accept = request.headers.get('accept');
  const ua = request.headers.get('user-agent');
  if (accept) forwardHeaders.set('accept', accept);
  if (ua) forwardHeaders.set('user-agent', ua);

  let upstreamRes = await fetch(new URL(upstreamPath, `${upstream}/`), {
    method: 'GET',
    headers: forwardHeaders,
    redirect: 'manual',
  });
  let servedFallback = false;

  if (upstreamRes.status === 404 && isDocumentRequest(request, url.pathname)) {
    const fallback = await fetch(new URL('/index.html', `${upstream}/`), {
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
  headers.set('x-c8-spa-proxy-upstream', upstream);
  if (servedFallback) headers.set('content-type', 'text/html; charset=utf-8');
  if (fromQuery) {
    const normalized =
      fromQuery === 'devnet' || fromQuery === 'dev'
        ? 'devnet'
        : fromQuery === 'testmainnet' || fromQuery === 'test'
          ? 'testmainnet'
          : 'mainnet';
    headers.append(
      'set-cookie',
      `${COOKIE_NAME}=${encodeURIComponent(normalized)}; Path=/; SameSite=Lax; Max-Age=86400`,
    );
  }

  if (request.method === 'HEAD') {
    return new Response(null, { status: servedFallback ? 200 : upstreamRes.status, headers });
  }

  return new Response(await upstreamRes.arrayBuffer(), {
    status: servedFallback ? 200 : upstreamRes.status,
    headers,
  });
}

export const config = {
  matcher: '/:path*',
};
