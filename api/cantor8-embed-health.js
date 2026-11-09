/**
 * Server-side check: does the Cantor8 wallet host (or SPA proxy) serve /embedded/ ?
 */
export default async function handler(req, res) {
  const network = String(req.query?.network ?? 'mainnet');
  const proxy = String(process.env.VITE_C8_SPA_PROXY_ORIGIN ?? '')
    .trim()
    .replace(/\/$/, '');
  const origin =
    network === 'local'
      ? proxy || 'http://localhost:8081'
      : proxy
        ? proxy
        : network === 'devnet'
          ? 'https://wallet.dev.digik.cantor8.tech'
          : 'https://wallet.cantor8.tech';
  const c8u = network === 'devnet' ? 'devnet' : 'mainnet';
  const usingProxy = Boolean(proxy) || network === 'local';
  const embedUrl = usingProxy ? `${origin}/embedded/?c8u=${c8u}` : `${origin}/embedded/`;

  try {
    const response = await fetch(embedUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'text/html', 'User-Agent': 'canton-test-dapp-embed-health' },
    });
    const ok = response.status >= 200 && response.status < 300;
    res.setHeader('cache-control', 'no-store');
    res.status(200).json({
      ok,
      status: response.status,
      network,
      origin,
      embedUrl,
      proxy: usingProxy,
      hint: ok
        ? 'Wallet embed route is reachable.'
        : 'Host returns non-OK for /embedded/. C8 Wallet Connect SDK connect() needs SPA fallback (try_files → index.html) — run yarn c8:proxy or deploy c8-proxy/.',
    });
  } catch (err) {
    res.status(200).json({
      ok: false,
      status: 0,
      network,
      origin,
      embedUrl,
      proxy: usingProxy,
      error: err instanceof Error ? err.message : String(err),
      hint: 'Failed to reach wallet embed URL.',
    });
  }
}
