import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

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
          res.setHeader('content-type', 'application/json');
          res.setHeader('cache-control', 'no-store');
          res.end(
            JSON.stringify({
              ok,
              status: response.status,
              network,
              origin,
              embedUrl,
              hint: ok
                ? 'Wallet embed route is reachable.'
                : 'Host returns non-OK for /embedded/. C8 Wallet Connect SDK connect() needs SPA fallback on this host.',
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
  plugins: [react(), cantor8EmbedHealthPlugin()],
  server: {
    port: 5180,
  },
});
