import type { Plugin } from 'vite';

/**
 * Rewrite `@cantor8/wallet-connect-sdk` popup origins through our SPA proxy and
 * append `?c8u=` from sessionStorage so the proxy can select mainnet vs digik.
 */
export function cantor8SdkProxyPlugin(): Plugin {
  const proxy = (process.env.VITE_C8_SPA_PROXY_ORIGIN ?? '').trim().replace(/\/$/, '');

  return {
    name: 'cantor8-sdk-spa-proxy',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@cantor8/wallet-connect-sdk')) return null;
      let next = code;

      // Embed URL: allow SPA proxy to read upstream hint from sessionStorage.
      next = next.replace(
        /get WALLET_EMBEDDED\(\)\{return`\$\{this\.origin\}\/embedded\/`\}/,
        'get WALLET_EMBEDDED(){let q="";try{const u=sessionStorage.getItem("c8u");if(u)q="?c8u="+encodeURIComponent(u)}catch(e){}return`${this.origin}/embedded/${q}`}',
      );

      if (proxy) {
        const esc = JSON.stringify(proxy);
        const origins = [
          'https://wallet.cantor8.tech',
          'https://wallet.dev.digik.cantor8.tech',
          'https://wallet.main.digik.cantor8.tech',
          'http://localhost:8081',
        ];
        for (const origin of origins) {
          next = next.split(JSON.stringify(origin)).join(esc);
          next = next.split(`'${origin}'`).join(esc);
        }
      }

      return next === code ? null : next;
    },
  };
}
