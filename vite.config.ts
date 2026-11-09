import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Cantor8 wallet hosting serves the SPA only at `/` (no rewrite for deep links).
 * `@cantor8/wallet-connect-sdk` still opens `${origin}/embedded/…`, which 404s.
 * Force popup opens to the origin root; the wallet then client-routes after handshake
 * (it detects popup mode via `window.opener`, not the `/embedded` path).
 */
function cantor8PopupRootPlugin(): Plugin {
  return {
    name: 'cantor8-popup-root',
    transform(code, id) {
      if (!id.includes('@cantor8/wallet-connect-sdk')) return;
      if (!code.includes('/embedded/')) return;
      return {
        code: code
          .replaceAll('`${this.origin}/embedded/`', '`${this.origin}/`')
          .replaceAll('new URL(null!=e?e:"",this.WALLET_EMBEDDED)', 'new URL("",this.WALLET_EMBEDDED)'),
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), cantor8PopupRootPlugin()],
  server: {
    port: 5180,
  },
});
