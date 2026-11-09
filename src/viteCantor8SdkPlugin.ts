import type { Plugin } from 'vite';

/**
 * Rewrite `@cantor8/wallet-connect-sdk` so mainnet/devnet popups open on this
 * dApp origin under `/__c8/embedded/` (same-origin SPA proxy). Optional
 * `VITE_C8_SPA_PROXY_ORIGIN` still overrides to an external proxy host.
 */
export function cantor8SdkProxyPlugin(): Plugin {
  const external = (process.env.VITE_C8_SPA_PROXY_ORIGIN ?? '').trim().replace(/\/$/, '');

  return {
    name: 'cantor8-sdk-spa-proxy',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@cantor8/wallet-connect-sdk')) return null;
      let next = code;

      // Embed path: same-origin /__c8 (or /embedded on localhost:8081 standalone proxy).
      next = next.replace(
        /get WALLET_EMBEDDED\(\)\{return`\$\{this\.origin\}\/embedded\/`\}/,
        'get WALLET_EMBEDDED(){let q="";try{const u=sessionStorage.getItem("c8u");if(u)q="?c8u="+encodeURIComponent(u)}catch(e){}const local=/^https?:\\/\\/(localhost|127\\.0\\.0\\.1):8081$/.test(this.origin);return`${this.origin}${local?"/embedded/":"/__c8/embedded/"}${q}`}',
      );

      if (external) {
        const esc = JSON.stringify(external);
        for (const origin of [
          'https://wallet.cantor8.tech',
          'https://wallet.dev.digik.cantor8.tech',
          'https://wallet.main.digik.cantor8.tech',
          'http://localhost:8081',
        ]) {
          next = next.split(JSON.stringify(origin)).join(esc);
          next = next.split(`'${origin}'`).join(esc);
        }
      } else {
        // Point hosted networks at this page's origin so /__c8 middleware can proxy.
        const runtimeOrigin = '(typeof location<"u"?location.origin:"http://localhost:5180")';
        next = next.split('"https://wallet.cantor8.tech"').join(runtimeOrigin);
        next = next.split("'https://wallet.cantor8.tech'").join(runtimeOrigin);
        next = next.split('"https://wallet.dev.digik.cantor8.tech"').join(runtimeOrigin);
        next = next.split("'https://wallet.dev.digik.cantor8.tech'").join(runtimeOrigin);
        next = next.split('"https://wallet.main.digik.cantor8.tech"').join(runtimeOrigin);
        next = next.split("'https://wallet.main.digik.cantor8.tech'").join(runtimeOrigin);
      }

      return next === code ? null : next;
    },
  };
}
