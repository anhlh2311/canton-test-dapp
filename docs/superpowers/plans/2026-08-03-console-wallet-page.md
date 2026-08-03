# Console Wallet Dedicated Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/console/` docs-walkthrough page using `@console-wallet/dapp-sdk` for connect + JWT ledger-proxy actions.

**Architecture:** `ConsolePage` (UI) + `useConsoleWallet` (SDK/JWT). Top-level nav mode beside Standard / Rocky / PartyLayer. No PartyLayer on this route.

**Tech Stack:** React 19, Vite, `@console-wallet/dapp-sdk`, existing `App.css` harness patterns.

**Spec:** `docs/superpowers/specs/2026-08-03-console-wallet-page-design.md`

## Global Constraints

- Direct dependency on `@console-wallet/dapp-sdk` (2.x aligned with transitive PartyLayer version)
- Proxy via SDK `ledgerAuth` / `ledgerRefresh` / `ledgerApi` only (no raw host fetch)
- `ledgerApi` body is a JSON **string**; include `network` + `accessToken`
- Mask JWTs in UI; reuse Rocky-style cards / status dots
- PartyLayer Console path unchanged

## File Structure

| File | Responsibility |
|------|----------------|
| `src/useConsoleWallet.ts` | SDK session, JWT cache, ledger helpers |
| `src/ConsolePage.tsx` | Numbered walkthrough UI |
| `src/ConnectionModeNav.tsx` | Add Console mode |
| `src/App.tsx` | Route `/console/` + callbacks |
| `src/RockyPage.tsx` / `PartyLayerPage.tsx` | Pass Console nav |
| `package.json` | Direct SDK dependency |

---

### Task 1: Dependency + nav + routing scaffold

**Files:**
- Modify: `package.json`, `src/ConnectionModeNav.tsx`, `src/App.tsx`, `src/RockyPage.tsx`, `src/PartyLayerPage.tsx`
- Create: `src/ConsolePage.tsx` (stub)

- [ ] Add `@console-wallet/dapp-sdk` with yarn
- [ ] Extend `ConnectionMode` + nav button + callbacks
- [ ] Route `/console/` to stub page
- [ ] Verify `yarn tsc -b` and nav reaches stub

### Task 2: `useConsoleWallet` hook

**Files:**
- Create: `src/useConsoleWallet.ts`

- [ ] Availability, connect/disconnect, account/network refresh
- [ ] signMessage (base64), ledgerAuth/Refresh, ledgerApi with 403 retry
- [ ] getCoinsBalance, prepareExecuteAndWait Ping helper
- [ ] `formatConsoleError` for plain-object SDK errors
- [ ] Typecheck

### Task 3: Walkthrough UI

**Files:**
- Modify: `src/ConsolePage.tsx`

- [ ] Steps 1–9 per spec (connect → refresh token)
- [ ] Gate JWT steps until connected/authed
- [ ] Masked tokens + expandable raw JSON
- [ ] Typecheck + manual smoke

### Task 4: Commit

- [ ] Commit implementation (and plan if written)
