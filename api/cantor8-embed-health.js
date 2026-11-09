/**
 * Server-side check: can this deployment serve /__c8/embedded/ (same-origin SPA proxy)?
 */
export default async function handler(req, res) {
  const network = String(req.query?.network ?? 'mainnet');
  const external = String(process.env.VITE_C8_SPA_PROXY_ORIGIN ?? '')
    .trim()
    .replace(/\/$/, '');

  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const proto = String(req.headers['x-forwarded-proto'] || 'https');
  const selfOrigin = host ? `${proto}://${host}` : '';

  const origin =
    network === 'local'
      ? external || 'http://localhost:8081'
      : external || selfOrigin || 'http://localhost:5180';

  const c8u = network === 'devnet' ? 'devnet' : 'mainnet';
  const local = /^https?:\/\/(localhost|127\.0\.0\.1):8081$/.test(origin);
  const embedUrl = local
    ? `${origin}/embedded/?c8u=${c8u}`
    : `${origin}/__c8/embedded/?c8u=${c8u}`;

  try {
    const response = await fetch(embedUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'text/html', 'User-Agent': 'canton-test-dapp-embed-health' },
    });
    const body = await response.text();
    const looksLikeWallet =
      response.status >= 200 &&
      response.status < 300 &&
      /id=["']root["']/.test(body) &&
      /_expo\/static\/js\/web\/entry-/.test(body);
    res.setHeader('cache-control', 'no-store');
    res.status(200).json({
      ok: looksLikeWallet,
      status: response.status,
      network,
      origin,
      embedUrl,
      proxy: true,
      hint: looksLikeWallet
        ? 'Same-origin /__c8 SPA proxy is serving the wallet embed route.'
        : 'Same-origin /__c8 proxy did not return the wallet SPA. Check middleware.js deployment.',
    });
  } catch (err) {
    res.status(200).json({
      ok: false,
      status: 0,
      network,
      origin,
      embedUrl,
      proxy: true,
      error: err instanceof Error ? err.message : String(err),
      hint: 'Failed to reach same-origin wallet embed URL.',
    });
  }
}
