/**
 * Server-side check: does the Cantor8 wallet host serve /embedded/ ?
 * Avoids browser CORS limits on HEAD/GET to wallet origins.
 */
export default async function handler(req, res) {
  const network = String(req.query?.network ?? 'mainnet');
  const origin =
    network === 'devnet'
      ? 'https://wallet.dev.digik.cantor8.tech'
      : network === 'local'
        ? 'http://localhost:8081'
        : 'https://wallet.cantor8.tech';
  const embedUrl = `${origin}/embedded/`;

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
      hint: ok
        ? 'Wallet embed route is reachable.'
        : 'Host returns non-OK for /embedded/. C8 Wallet Connect SDK connect() needs SPA fallback (try_files → index.html) on this host.',
    });
  } catch (err) {
    res.status(200).json({
      ok: false,
      status: 0,
      network,
      origin,
      embedUrl,
      error: err instanceof Error ? err.message : String(err),
      hint: 'Failed to reach wallet embed URL.',
    });
  }
}
