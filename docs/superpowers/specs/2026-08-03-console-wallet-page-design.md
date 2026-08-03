# Console Wallet Dedicated Page — Design

**Date:** 2026-08-03  
**Status:** Approved for implementation (pending spec review)  
**Repo:** canton-test-dapp  
**Route:** `/console/`

## Goal

Add a top-level **Console Wallet** connection mode that walks through Console’s official integration guides:

1. **`@console-wallet/dapp-sdk`** — extension / QR connect, CIP-0103-compatible methods  
2. **Ledger API proxy** ([consolewallet.io/develop/ledger](https://consolewallet.io/develop/ledger)) — JWT challenge-response auth + authenticated ledger calls  

The page is a docs-style numbered walkthrough (not PartyLayer). PartyLayer’s Console path stays unchanged.

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Integration path | **Both** — SDK connect + JWT / ledger-proxy actions |
| UI shape | **Docs walkthrough** — numbered steps matching Console quick start |
| Placement | **Top-level** — `/console/` + nav button next to Standard / Rocky / PartyLayer |
| Implementation style | Thin page + `useConsoleWallet` hook wrapping `@console-wallet/dapp-sdk` |
| Proxy calls | Via SDK `ledgerAuth` / `ledgerRefresh` / `ledgerApi` (not raw `fetch` to Console hosts) |

## Architecture

```
ConnectionModeNav ──► /console/ ──► ConsolePage
                                      │
                                      ▼
                               useConsoleWallet
                                      │
                                      ▼
                          @console-wallet/dapp-sdk
                          (postMessage / QR relay)
```

- **`ConsolePage`** — presentation only: steps, buttons, status, raw JSON, errors  
- **`useConsoleWallet`** — all SDK calls, session state, JWT token cache, error normalization  
- No PartyLayer / CIP-0103 dapp-sdk adapters on this page  

## Routing & navigation

1. Extend `ConnectionMode` with `'console'`.  
2. Add “Console Wallet” button to `ConnectionModeNav`.  
3. In `App.tsx`, route `/console/` (and `/console`) to `ConsolePage`, same History API pattern as Rocky / PartyLayer.  
4. Existing `vercel.json` rewrite already covers deep links.  
5. Wire `onOpenConsole` (or equivalent) from Standard / Rocky / PartyLayer nav callbacks.

## Dependency

Add **`@console-wallet/dapp-sdk`** as a **direct** dependency in `package.json` (today it is only transitive via PartyLayer). Prefer a recent 2.x aligned with what PartyLayer already pulls, unless a newer compatible release is required.

## Hook API (`useConsoleWallet`)

Suggested surface (names may be refined during implementation):

| Capability | Behavior |
|------------|----------|
| Availability | `checkExtensionAvailability()` on mount / refresh |
| Connect | `connect({ name, icon?, target })` with `target`: `local` \| `remote` \| `combined` (default `combined`) |
| Disconnect | `disconnect()`; clear JWT cache |
| Status / account / network | `status()`, `getPrimaryAccount()`, `getActiveNetwork()` |
| Sign message | `signMessage` (base64 path preferred — matches Console LIVE behavior) |
| Ledger auth | `ledgerAuth({ publicKey, partyId, network })` → cache `accessToken` / `refreshToken` |
| Refresh | `ledgerRefresh` with same `publicKey`; rotate cache |
| Ledger API | `ledgerApi({ requestMethod, resource, body, network, accessToken })` — body as **JSON string** |
| Balance | `getCoinsBalance({ party, network })` |
| Submit | `prepareExecuteAndWait` with flat ExecuteRequest (Ping template) |

**Token cache:** in-memory on the hook instance (and optionally `sessionStorage` for refresh across reloads — implement if low-cost; not required for v1). On 403 / Forbidden from ledger proxy, clear access token, try refresh once, then full `ledgerAuth`.

**Errors:** normalize SDK plain-object errors `{ name, message, details }` into readable strings for the UI (same problem we hit on PartyLayer).

## Page walkthrough steps

Each step: short description, primary action button(s), loading state, success/error, expandable raw response. Gate steps that need connection or JWT behind clear disabled + hint text.

| # | Step | Actions |
|---|------|---------|
| 1 | **Setup & connect** | Check extension; select target; Connect / Disconnect |
| 2 | **Session** | Show partyId, publicKey, network (id / CAIP-2 / baseUrl) |
| 3 | **Sign message** | Input + Sign via SDK |
| 4 | **Ledger auth** | Run `ledgerAuth`; show masked tokens + expiry note (access ~10m, refresh ~7d) |
| 5 | **Verify connectivity** | AUTH’d `GET /v2/version` via `ledgerApi` |
| 6 | **Ledger offset** | AUTH’d ledger-end: try `GET /v2/state/ledger-end` first (Canton JSON API / PartyLayer balances guide); on failure try `GET /v2/ledger-end` (Console quick-start curl). UI hint shows which path succeeded. |
| 7 | **Active contracts** | AUTH’d `POST /v2/state/active-contracts` with party filter; optional secondary **getCoinsBalance** button |
| 8 | **Submit Ping** | `prepareExecuteAndWait` with `#canton-builtin-admin-workflow-ping:Canton.Internal.Ping:Ping` |
| 9 | **Refresh token** | `ledgerRefresh`; show new masked tokens |

Links in the page header/footer:

- [Console dApp SDK (npm)](https://www.npmjs.com/package/@console-wallet/dapp-sdk)  
- [Ledger API proxy docs](https://consolewallet.io/develop/ledger)  

## UI / UX constraints

- Reuse existing `App.css` patterns (cards, status dots, button rows, hints) — match Rocky / PartyLayer harness look, not a new marketing design system.  
- Mask JWT display: show first/last ~8 chars only; Copy full token available.  
- Do not store private keys; signing stays in the extension / mobile wallet.

## Files to add / change

| File | Change |
|------|--------|
| `src/ConsolePage.tsx` | **New** — walkthrough UI |
| `src/useConsoleWallet.ts` | **New** — SDK hook |
| `src/ConnectionModeNav.tsx` | Add Console mode + callback |
| `src/App.tsx` | Route `/console/`; pass nav callbacks |
| `src/RockyPage.tsx` / `PartyLayerPage.tsx` / Standard page | Pass through Console nav callback |
| `package.json` | Direct `@console-wallet/dapp-sdk` dependency |

Optional (only if helpful during impl): small shared `formatWalletError` util — avoid duplicating PartyLayer’s formatter unless needed.

## Out of scope

- Changing PartyLayer Console / `ConsoleDamlAdapter` behavior  
- Full Console SDK catalog (encrypt/decrypt, transfers history, WC-only flows beyond `target: remote`)  
- Raw HTTP `init-auth` / `login` against Console hosts (SDK wraps this)  
- Automated e2e against a live extension  

## Success criteria

1. User can open `/console/` from the connection mode nav (and deep-link after deploy).  
2. With Console extension installed, user completes connect → session → sign → ledger auth → version / ledger-end → active-contracts (or clear AUTH error) → Ping submit → token refresh.  
3. Errors from Console are readable (message + optional details), not opaque “Unknown error”.  
4. PartyLayer / Standard / Rocky modes still work and can navigate to Console.

## Testing plan (manual)

1. Local `yarn dev` — navigate Standard ↔ Console ↔ Rocky ↔ PartyLayer.  
2. Extension not installed — availability shows not installed; connect fails clearly.  
3. Extension installed — full walkthrough on devnet.  
4. After deploy — hard refresh `/console/` (SPA rewrite).  
5. Ledger auth expiry — wait or force refresh path; confirm 403 recovery via refresh/re-auth.
