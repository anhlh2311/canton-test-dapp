/**
 * Resolve the wallet popup origin used with `@cantor8/wallet-connect-sdk`.
 *
 * When `VITE_C8_SPA_PROXY_ORIGIN` is set (build-time), mainnet/devnet popups go
 * through our SPA-fallback proxy so `/embedded/` returns the Expo app instead
 * of Caddy's HTTP 404.
 *
 * @param {'devnet' | 'mainnet' | 'local'} network
 * @returns {string}
 */
export function resolveCantor8WalletOrigin(network) {
  const proxy = String(import.meta.env.VITE_C8_SPA_PROXY_ORIGIN ?? '')
    .trim()
    .replace(/\/$/, '');
  if (network === 'local') {
    return proxy || 'http://localhost:8081';
  }
  if (proxy) return proxy;
  if (network === 'mainnet') return 'https://wallet.cantor8.tech';
  return 'https://wallet.dev.digik.cantor8.tech';
}

/**
 * Official connect popup URL, including `c8u` when using the SPA proxy so the
 * proxy can pin the upstream wallet (mainnet vs digik) via cookie.
 *
 * @param {'devnet' | 'mainnet' | 'local'} network
 * @returns {string}
 */
export function resolveCantor8WalletEmbedUrl(network) {
  const origin = resolveCantor8WalletOrigin(network);
  const proxy = String(import.meta.env.VITE_C8_SPA_PROXY_ORIGIN ?? '')
    .trim()
    .replace(/\/$/, '');
  const usingProxy = Boolean(proxy) || network === 'local';
  if (!usingProxy) return `${origin}/embedded/`;
  const c8u = network === 'devnet' ? 'devnet' : 'mainnet';
  return `${origin}/embedded/?c8u=${c8u}`;
}

/**
 * Hint the SDK (via sessionStorage) which upstream the SPA proxy should use.
 * Safe no-op when sessionStorage is unavailable.
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
