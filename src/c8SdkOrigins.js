/**
 * Resolve the wallet popup origin used with `@cantor8/wallet-connect-sdk`.
 *
 * Mainnet/devnet use this dApp's origin + `/__c8` SPA proxy (see middleware.js).
 * `local` still targets `http://localhost:8081` (`yarn c8:proxy`).
 * Optional `VITE_C8_SPA_PROXY_ORIGIN` overrides to an external proxy host.
 *
 * @param {'devnet' | 'mainnet' | 'local'} network
 * @returns {string}
 */
export function resolveCantor8WalletOrigin(network) {
  const external = String(import.meta.env.VITE_C8_SPA_PROXY_ORIGIN ?? '')
    .trim()
    .replace(/\/$/, '');
  if (network === 'local') {
    return external || 'http://localhost:8081';
  }
  if (external) return external;
  if (typeof location !== 'undefined' && location.origin) return location.origin;
  return 'http://localhost:5180';
}

/**
 * Connect popup URL. Same-origin path is `/__c8/embedded/?c8u=…`.
 *
 * @param {'devnet' | 'mainnet' | 'local'} network
 * @returns {string}
 */
export function resolveCantor8WalletEmbedUrl(network) {
  const origin = resolveCantor8WalletOrigin(network);
  const c8u = network === 'devnet' ? 'devnet' : 'mainnet';
  const local = /^https?:\/\/(localhost|127\.0\.0\.1):8081$/.test(origin);
  const path = local ? '/embedded/' : '/__c8/embedded/';
  return `${origin}${path}?c8u=${c8u}`;
}

/**
 * Hint the SDK / middleware which upstream wallet host to use.
 *
 * @param {'devnet' | 'mainnet' | 'local'} network
 */
export function prepareCantor8ProxyHint(network) {
  try {
    const c8u = network === 'devnet' ? 'devnet' : 'mainnet';
    sessionStorage.setItem('c8u', c8u);
  } catch {
    /* ignore */
  }
}
