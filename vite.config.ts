import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { cantor8SdkProxyPlugin } from './src/viteCantor8SdkPlugin';

/** Dev-only stand-in for /api/cantor8-embed-health (Vercel serverless in prod). */
function cantor8EmbedHealthPlugin(): Plugin {
  return {
    name: 'cantor8-embed-health-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/api/cantor8-embed-health')) {
          next();
          return;
        }
        const network = new URL(url, 'http://localhost').searchParams.get('network') ?? 'mainnet';
        const proxy = (process.env.VITE_C8_SPA_PROXY_ORIGIN ?? '').trim().replace(/\/$/, '');
        const origin =
          network === 'local'
            ? proxy || 'http://localhost:8081'
            : proxy
              ? proxy
              : network === 'devnet'
                ? 'https://wallet.dev.digik.cantor8.tech'
                : 'https://wallet.cantor8.tech';
        const c8u = network === 'devnet' ? 'devnet' : 'mainnet';
        const embedUrl =
          proxy || network === 'local' ? `${origin}/embedded/?c8u=${c8u}` : `${origin}/embedded/`;
        try {
          const response = await fetch(embedUrl, {
            method: 'GET',
            redirect: 'manual',
            headers: { Accept: 'text/html', 'User-Agent': 'canton-test-dapp-embed-health' },
          });
          const ok = response.status >= 200 && response.status < 300;
          res.setHeader('content-type', 'application/json');
          res.setHeader('cache-control', 'no-store');
          res.end(
            JSON.stringify({
              ok,
              status: response.status,
              network,
              origin,
              embedUrl,
              proxy: Boolean(proxy) || network === 'local',
              hint: ok
                ? 'Wallet embed route is reachable.'
                : 'Host returns non-OK for /embedded/. Run yarn c8:proxy and use local, or set VITE_C8_SPA_PROXY_ORIGIN.',
            }),
          );
        } catch (err) {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              ok: false,
              status: 0,
              network,
              origin,
              embedUrl,
              error: err instanceof Error ? err.message : String(err),
              hint: 'Failed to reach wallet embed URL.',
            }),
          );
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), cantor8SdkProxyPlugin(), cantor8EmbedHealthPlugin()],
  server: {
    port: 5180,
  },
});
