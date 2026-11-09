# Cantor8 SPA proxy

Root-origin reverse proxy that adds the missing Caddy `try_files` for
`/embedded/` so `@cantor8/wallet-connect-sdk` connect popups can load.

## Deploy

From this folder:

```bash
npx vercel --prod
```

Set the resulting HTTPS origin as `VITE_C8_SPA_PROXY_ORIGIN` on the test dapp
build (no trailing slash).

## Local

Prefer the repo-root script instead:

```bash
yarn c8:proxy
```
