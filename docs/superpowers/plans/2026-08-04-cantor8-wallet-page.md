# Cantor8 Wallet Dedicated Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/cantor8/` connection mode that integrates `@cantor8/wallet-connect-sdk@0.4.0` directly (popup + `postMessage`) for connect, instruments/accounts, transfer, tx status, and an event log.

**Architecture:** Parallel mode like Rocky: `Cantor8Page` (UI) + `useCantor8Wallet` (provider lifecycle). Not PartyLayer’s `@partylayer/adapter-cantor8`. Network toggle recreates the provider. Phase B (`signAndExecute`) is deferred.

**Tech Stack:** React 19, TypeScript, Vite, `@cantor8/wallet-connect-sdk@0.4.0`, existing `App.css` / `ConnectionModeNav` patterns.

**Spec:** [docs/superpowers/specs/2026-08-04-cantor8-wallet-page-design.md](../specs/2026-08-04-cantor8-wallet-page-design.md)

## Global Constraints

- Direct dependency pin: `@cantor8/wallet-connect-sdk@0.4.0` (already transitive via PartyLayer; still add as direct)
- `dappName` exactly `"Cantor8 Wallet Connect SDK Demo"`
- `dappUrl` = `window.location.href`
- Default network `"devnet"`; UI toggle for `"mainnet"`
- `connect()` / `send()` only from user gestures (button clicks)
- Register event listeners before `connect()`
- Out of scope: `createSwapOffer`, `signAndExecute` (Phase B), CIP-0103 bridging, PartyLayer adapter changes
- No `Co-authored-by` on commits

## File Structure

| File | Responsibility |
|------|----------------|
| `src/cantor8Helpers.js` | Pure validation + `describeCantor8Error` |
| `src/cantor8Helpers.d.ts` | Types for helpers |
| `src/cantor8Helpers.test.mjs` | Unit tests for helpers |
| `src/useCantor8Wallet.ts` | `C8WalletProvider` lifecycle, events, data, send, status |
| `src/Cantor8Page.tsx` | Page UI sections |
| `src/ConnectionModeNav.tsx` | Add `cantor8` mode |
| `src/App.tsx` | Route `/cantor8/` + nav callbacks |
| `src/RockyPage.tsx` / `PartyLayerPage.tsx` / `ConsolePage.tsx` | Pass `onOpenCantor8` |
| `package.json` | Direct SDK dep + test script include |

---

### Task 1: Pure helpers + unit tests

**Files:**
- Create: `src/cantor8Helpers.js`
- Create: `src/cantor8Helpers.d.ts`
- Create: `src/cantor8Helpers.test.mjs`
- Modify: `package.json` (test script)

**Interfaces:**
- Produces:
  - `describeCantor8Error(e: unknown): string`
  - `assertValidCantor8Transfer(to: string, amount: string): number` — throws `Error` or returns parsed positive `number`
  - `CANTOR8_DAPP_NAME = "Cantor8 Wallet Connect SDK Demo"`

- [ ] **Step 1: Write the failing test**

Create `src/cantor8Helpers.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidCantor8Transfer,
  describeCantor8Error,
  CANTOR8_DAPP_NAME,
} from './cantor8Helpers.js';

test('CANTOR8_DAPP_NAME matches registered demo name', () => {
  assert.equal(CANTOR8_DAPP_NAME, 'Cantor8 Wallet Connect SDK Demo');
});

test('assertValidCantor8Transfer accepts positive amounts and trims party', () => {
  assert.equal(assertValidCantor8Transfer('  Party::Recv  ', '1.25'), 1.25);
});

test('assertValidCantor8Transfer rejects empty receiver', () => {
  assert.throws(() => assertValidCantor8Transfer('  ', '1'), /receiver/i);
});

test('assertValidCantor8Transfer rejects non-positive amount', () => {
  assert.throws(() => assertValidCantor8Transfer('Party::X', '0'), /amount/i);
  assert.throws(() => assertValidCantor8Transfer('Party::X', '-1'), /amount/i);
  assert.throws(() => assertValidCantor8Transfer('Party::X', 'abc'), /amount/i);
});

test('describeCantor8Error maps known codes', () => {
  assert.match(describeCantor8Error({ code: 'POPUP_BLOCKED', message: 'x' }), /popup/i);
  assert.match(describeCantor8Error({ code: 'USER_REJECTED', message: 'x' }), /dismissed|reject/i);
  assert.match(describeCantor8Error({ code: 'NOT_CONNECTED', message: 'x' }), /connect/i);
  assert.match(describeCantor8Error({ code: 'INSUFFICIENT_FUNDS', message: 'x' }), /balance|funds/i);
  assert.match(describeCantor8Error({ code: 'INIT_FAILED', message: 'x' }), /dappName|network|config/i);
  assert.match(
    describeCantor8Error({ code: 'TRANSFER_PREPARE_FAILED', message: 'x' }),
    /invalid|ledger|transfer/i,
  );
  assert.match(describeCantor8Error({ code: 'TRANSFER_FAILED', message: 'x' }), /invalid|ledger|transfer/i);
  assert.match(describeCantor8Error({ code: 'GET_INSTRUMENTS_FAILED', message: 'x' }), /instrument/i);
  assert.match(describeCantor8Error({ code: 'GET_ACCOUNTS_FAILED', message: 'x' }), /account/i);
  assert.match(describeCantor8Error({ code: 'CHECK_TX_STATUS_FAILED', message: 'x' }), /status/i);
});

test('describeCantor8Error falls back for unknown / Error / string', () => {
  assert.match(describeCantor8Error({ code: 'WEIRD', message: 'boom' }), /WEIRD/);
  assert.match(describeCantor8Error({ code: 'WEIRD', message: 'boom' }), /boom/);
  assert.equal(describeCantor8Error(new Error('plain')), 'plain');
  assert.equal(describeCantor8Error('raw'), 'raw');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/cantor8Helpers.test.mjs`

Expected: FAIL — `Cannot find module './cantor8Helpers.js'`

- [ ] **Step 3: Implement helpers**

Create `src/cantor8Helpers.js`:

```js
export const CANTOR8_DAPP_NAME = 'Cantor8 Wallet Connect SDK Demo';

/**
 * @param {string} to
 * @param {string} amount
 * @returns {number}
 */
export function assertValidCantor8Transfer(to, amount) {
  const receiver = String(to ?? '').trim();
  if (!receiver) {
    throw new Error('Receiver partyId is required.');
  }
  const parsed = Number(String(amount ?? '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Amount must be a positive number.');
  }
  return parsed;
}

/**
 * @param {unknown} e
 * @returns {string}
 */
export function describeCantor8Error(e) {
  if (e && typeof e === 'object' && 'code' in e) {
    const code = String(/** @type {{ code: unknown }} */ (e).code);
    const message =
      'message' in e && typeof /** @type {{ message: unknown }} */ (e).message === 'string'
        ? /** @type {{ message: string }} */ (e).message
        : '';
    switch (code) {
      case 'USER_REJECTED':
        return 'User dismissed the wallet popup — retry.';
      case 'POPUP_BLOCKED':
        return 'Browser blocked the wallet popup. Allow popups and trigger connect/send from a button click.';
      case 'NOT_CONNECTED':
        return 'Connect the wallet first.';
      case 'INSUFFICIENT_FUNDS':
        return 'Not enough balance for this transfer.';
      case 'INIT_FAILED':
        return 'Wallet provider failed to initialize. Check dappName / network config.';
      case 'TRANSFER_PREPARE_FAILED':
      case 'TRANSFER_FAILED':
        return 'Transfer failed — check inputs or ledger status.';
      case 'GET_INSTRUMENTS_FAILED':
        return 'Failed to load instruments — retry while connected.';
      case 'GET_ACCOUNTS_FAILED':
        return 'Failed to load accounts — retry while connected.';
      case 'CHECK_TX_STATUS_FAILED':
        return 'Could not fetch transfer status — retry.';
      default:
        return message ? `${code}: ${message}` : code || 'Unknown Cantor8 error';
    }
  }
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'Unknown Cantor8 error';
}
```

Create `src/cantor8Helpers.d.ts`:

```ts
export declare const CANTOR8_DAPP_NAME: 'Cantor8 Wallet Connect SDK Demo';

export declare function assertValidCantor8Transfer(to: string, amount: string): number;

export declare function describeCantor8Error(e: unknown): string;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/cantor8Helpers.test.mjs`

Expected: all tests PASS

- [ ] **Step 5: Update package.json test script**

Change:

```json
"test": "node --test src/rockyAssets.test.mjs"
```

to:

```json
"test": "node --test src/rockyAssets.test.mjs src/cantor8Helpers.test.mjs"
```

Run: `yarn test`

Expected: Rocky + Cantor8 helper tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/cantor8Helpers.js src/cantor8Helpers.d.ts src/cantor8Helpers.test.mjs package.json
git commit -m "$(cat <<'EOF'
Add Cantor8 transfer validation and error mapping helpers.

EOF
)"
```

If a hook appends `Co-authored-by:`, strip it with `git commit-tree` (do not keep the trailer).

---

### Task 2: Dependency + nav + routing scaffold

**Files:**
- Modify: `package.json`, `yarn.lock`
- Modify: `src/ConnectionModeNav.tsx`
- Modify: `src/App.tsx`
- Modify: `src/RockyPage.tsx`, `src/PartyLayerPage.tsx`, `src/ConsolePage.tsx`
- Create: `src/Cantor8Page.tsx` (stub)

**Interfaces:**
- Consumes: none from Task 1 yet
- Produces: route `/cantor8/` renders stub; nav has Cantor8 button; `onOpenCantor8` wired from all modes

- [ ] **Step 1: Add direct dependency**

Run:

```bash
yarn add @cantor8/wallet-connect-sdk@0.4.0
```

Verify `package.json` lists `"@cantor8/wallet-connect-sdk": "0.4.0"` (or `^0.4.0` if yarn resolves that way — prefer exact `0.4.0`).

- [ ] **Step 2: Extend ConnectionModeNav**

Replace `src/ConnectionModeNav.tsx` with:

```tsx
export type ConnectionMode = 'standard' | 'rocky' | 'partylayer' | 'console' | 'cantor8';

export function ConnectionModeNav({
  active,
  onStandard,
  onRocky,
  onPartyLayer,
  onConsole,
  onCantor8,
}: {
  active: ConnectionMode;
  onStandard: () => void;
  onRocky: () => void;
  onPartyLayer: () => void;
  onConsole: () => void;
  onCantor8: () => void;
}) {
  return (
    <div className="conn-mode-nav">
      <span className="conn-mode-label">Connection type:</span>
      <button
        className={`conn-mode-btn ${active === 'standard' ? 'active' : ''}`}
        onClick={onStandard}
        disabled={active === 'standard'}
      >
        Standard Wallets
      </button>
      <button
        className={`conn-mode-btn ${active === 'rocky' ? 'active' : ''}`}
        onClick={onRocky}
        disabled={active === 'rocky'}
      >
        Rocky Wallet
      </button>
      <button
        className={`conn-mode-btn ${active === 'partylayer' ? 'active' : ''}`}
        onClick={onPartyLayer}
        disabled={active === 'partylayer'}
      >
        PartyLayer
      </button>
      <button
        className={`conn-mode-btn ${active === 'console' ? 'active' : ''}`}
        onClick={onConsole}
        disabled={active === 'console'}
      >
        Console Wallet
      </button>
      <button
        className={`conn-mode-btn ${active === 'cantor8' ? 'active' : ''}`}
        onClick={onCantor8}
        disabled={active === 'cantor8'}
      >
        Cantor8
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Create stub Cantor8Page**

Create `src/Cantor8Page.tsx`:

```tsx
import './App.css';
import { ConnectionModeNav } from './ConnectionModeNav';

export function Cantor8Page({
  onExit,
  onOpenRocky,
  onOpenPartyLayer,
  onOpenConsole,
}: {
  onExit: () => void;
  onOpenRocky: () => void;
  onOpenPartyLayer: () => void;
  onOpenConsole: () => void;
}) {
  return (
    <div className="app">
      <h1>Cantor8</h1>
      <p className="subtitle">
        Cantor8 Wallet Connect SDK — <code>@cantor8/wallet-connect-sdk</code> popup +{' '}
        <code>postMessage</code>
      </p>
      <ConnectionModeNav
        active="cantor8"
        onStandard={onExit}
        onRocky={onOpenRocky}
        onPartyLayer={onOpenPartyLayer}
        onConsole={onOpenConsole}
        onCantor8={() => {}}
      />
      <section className="card">
        <h2>Scaffold</h2>
        <p className="hint">Hook and UI land in the next tasks.</p>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Wire App.tsx routing and callbacks**

1. Add import: `import { Cantor8Page } from './Cantor8Page';`
2. On `CantonDapp` props: add `onOpenCantor8: () => void` and pass `onCantor8={onOpenCantor8}` to `ConnectionModeNav`.
3. On each dedicated page branch, pass `onOpenCantor8={() => navigate('/cantor8/')}`.
4. Add route before the default return:

```tsx
  if (/^\/cantor8(\/|$)/i.test(path)) {
    return (
      <Cantor8Page
        onExit={() => navigate('/')}
        onOpenRocky={() => navigate('/rocky/')}
        onOpenPartyLayer={() => navigate('/partylayer/')}
        onOpenConsole={() => navigate('/console/')}
      />
    );
  }
```

5. Default `CantonDapp` call site:

```tsx
  return (
    <CantonDapp
      onOpenRocky={() => navigate('/rocky/')}
      onOpenPartyLayer={() => navigate('/partylayer/')}
      onOpenConsole={() => navigate('/console/')}
      onOpenCantor8={() => navigate('/cantor8/')}
    />
  );
```

Also update Rocky / PartyLayer / Console page props:

- Add `onOpenCantor8: () => void` to each page’s props
- Pass `onCantor8={onOpenCantor8}` into their `ConnectionModeNav`
- In `App.tsx` Rocky / PartyLayer / Console branches, pass `onOpenCantor8={() => navigate('/cantor8/')}`

Rocky branch example:

```tsx
  if (/^\/rocky(\/|$)/.test(path)) {
    return (
      <RockyPage
        onExit={() => navigate('/')}
        onOpenPartyLayer={() => navigate('/partylayer/')}
        onOpenConsole={() => navigate('/console/')}
        onOpenCantor8={() => navigate('/cantor8/')}
      />
    );
  }
```

Mirror for PartyLayer and Console.

- [ ] **Step 5: Typecheck and smoke nav**

Run: `yarn tsc -b`

Expected: exit 0

Run: `yarn dev` — open `/cantor8/`, click Cantor8 / Standard / Rocky / PartyLayer / Console nav buttons.

Expected: stub page loads; deep link works (vercel rewrite already covers `/(.*)`).

- [ ] **Step 6: Commit**

```bash
git add package.json yarn.lock src/ConnectionModeNav.tsx src/App.tsx src/Cantor8Page.tsx src/RockyPage.tsx src/PartyLayerPage.tsx src/ConsolePage.tsx
git commit -m "$(cat <<'EOF'
Add Cantor8 nav mode and /cantor8/ route scaffold.

EOF
)"
```

---

### Task 3: `useCantor8Wallet` hook

**Files:**
- Create: `src/useCantor8Wallet.ts`

**Interfaces:**
- Consumes: `CANTOR8_DAPP_NAME`, `assertValidCantor8Transfer`, `describeCantor8Error` from `./cantor8Helpers.js`; `C8WalletProvider` + types from `@cantor8/wallet-connect-sdk`
- Produces: `useCantor8Wallet()` returning `UseCantor8Wallet` (below)

```ts
export type Cantor8Network = 'devnet' | 'mainnet';
export type Cantor8Status = 'idle' | 'connecting' | 'connected' | 'error';

export type Cantor8EventLogEntry = {
  id: string;
  at: string; // ISO
  type: string;
  summary: string;
};

export interface UseCantor8Wallet {
  status: Cantor8Status;
  network: Cantor8Network;
  walletVersion: string | undefined;
  error: string | undefined;
  instruments: Array<{ instrumentId: string; name: string; symbol: string }>;
  accounts: Array<{
    partyId: string;
    accountName?: string;
    holdings: Array<{ instrumentId: string; balance: number; balanceUsd: number }>;
  }>;
  selectedInstrumentId: string | undefined;
  selectedPartyId: string | undefined;
  events: Cantor8EventLogEntry[];
  lastTxId: string | undefined;
  lastTxStatus: string | undefined;
  setNetwork: (network: Cantor8Network) => Promise<void>;
  setSelectedInstrumentId: (id: string | undefined) => void;
  setSelectedPartyId: (id: string | undefined) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
  send: (input: {
    receiverPartyId: string;
    amount: string;
    memo?: string;
  }) => Promise<{ txId: string }>;
  refreshTxStatus: () => Promise<void>;
  clearEvents: () => void;
}
```

- [ ] **Step 1: Implement the hook**

Create `src/useCantor8Wallet.ts` with this behavior (full file — implement exactly):

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  C8WalletProvider,
  type AccountInfoPayload,
  type InstrumentInfoPayload,
} from '@cantor8/wallet-connect-sdk';
import {
  assertValidCantor8Transfer,
  CANTOR8_DAPP_NAME,
  describeCantor8Error,
} from './cantor8Helpers.js';

export type Cantor8Network = 'devnet' | 'mainnet';
export type Cantor8Status = 'idle' | 'connecting' | 'connected' | 'error';

export type Cantor8EventLogEntry = {
  id: string;
  at: string;
  type: string;
  summary: string;
};

export interface UseCantor8Wallet {
  status: Cantor8Status;
  network: Cantor8Network;
  walletVersion: string | undefined;
  error: string | undefined;
  instruments: InstrumentInfoPayload[];
  accounts: AccountInfoPayload[];
  selectedInstrumentId: string | undefined;
  selectedPartyId: string | undefined;
  events: Cantor8EventLogEntry[];
  lastTxId: string | undefined;
  lastTxStatus: string | undefined;
  setNetwork: (network: Cantor8Network) => Promise<void>;
  setSelectedInstrumentId: (id: string | undefined) => void;
  setSelectedPartyId: (id: string | undefined) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
  send: (input: {
    receiverPartyId: string;
    amount: string;
    memo?: string;
  }) => Promise<{ txId: string }>;
  refreshTxStatus: () => Promise<void>;
  clearEvents: () => void;
}

function makeProvider(network: Cantor8Network): C8WalletProvider {
  return new C8WalletProvider({
    dappName: CANTOR8_DAPP_NAME,
    dappUrl: typeof window !== 'undefined' ? window.location.href : undefined,
    network,
  });
}

export function useCantor8Wallet(
  initialNetwork: Cantor8Network = 'devnet',
): UseCantor8Wallet {
  const [network, setNetworkState] = useState<Cantor8Network>(initialNetwork);
  const [status, setStatus] = useState<Cantor8Status>('idle');
  const [walletVersion, setWalletVersion] = useState<string>();
  const [error, setError] = useState<string>();
  const [instruments, setInstruments] = useState<InstrumentInfoPayload[]>([]);
  const [accounts, setAccounts] = useState<AccountInfoPayload[]>([]);
  const [selectedInstrumentId, setSelectedInstrumentId] = useState<string>();
  const [selectedPartyId, setSelectedPartyId] = useState<string>();
  const [events, setEvents] = useState<Cantor8EventLogEntry[]>([]);
  const [lastTxId, setLastTxId] = useState<string>();
  const [lastTxStatus, setLastTxStatus] = useState<string>();

  const providerRef = useRef<C8WalletProvider | null>(null);
  const unsubsRef = useRef<Array<() => boolean>>([]);
  const selectedInstrumentRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    selectedInstrumentRef.current = selectedInstrumentId;
  }, [selectedInstrumentId]);

  const pushEvent = useCallback((type: string, summary: string) => {
    setEvents((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        type,
        summary,
      },
      ...prev,
    ].slice(0, 100));
  }, []);

  const clearSessionData = useCallback(() => {
    setInstruments([]);
    setAccounts([]);
    setSelectedInstrumentId(undefined);
    setSelectedPartyId(undefined);
    setWalletVersion(undefined);
    setLastTxId(undefined);
    setLastTxStatus(undefined);
  }, []);

  const loadInstrumentsAndAccounts = useCallback(async (c8: C8WalletProvider) => {
    const { instruments: list } = await c8.getInstruments();
    setInstruments(list);
    const instrumentId = selectedInstrumentRef.current ?? list[0]?.instrumentId;
    if (instrumentId && selectedInstrumentRef.current !== instrumentId) {
      setSelectedInstrumentId(instrumentId);
      selectedInstrumentRef.current = instrumentId;
    }
    const { accounts: accts } = await c8.getAccounts(instrumentId);
    setAccounts(accts);
    setSelectedPartyId((prev) => prev ?? accts[0]?.partyId);
  }, []);

  const teardownProvider = useCallback(async () => {
    for (const unsub of unsubsRef.current) {
      try {
        unsub();
      } catch {
        /* ignore */
      }
    }
    unsubsRef.current = [];
    const current = providerRef.current;
    providerRef.current = null;
    if (current) {
      try {
        await current.disconnect();
      } catch {
        /* ignore */
      }
    }
  }, []);

  const attachListeners = useCallback(
    (c8: C8WalletProvider) => {
      const unsubs: Array<() => boolean> = [];
      unsubs.push(
        c8.on('connected', () => {
          setStatus('connected');
          setError(undefined);
          pushEvent('connected', 'Wallet connected');
          void (async () => {
            try {
              const st = await c8.status();
              setWalletVersion(st.walletVersion);
              await loadInstrumentsAndAccounts(c8);
            } catch (e) {
              setError(describeCantor8Error(e));
            }
          })();
        }),
      );
      unsubs.push(
        c8.on('disconnected', (e) => {
          setStatus('idle');
          clearSessionData();
          pushEvent('disconnected', e.reason ?? 'Wallet disconnected');
        }),
      );
      unsubs.push(
        c8.on('accountChanged', (e) => {
          pushEvent('accountChanged', `Accounts updated (${e.accounts.length})`);
          if (e.accounts.length) setAccounts(e.accounts);
          else void loadInstrumentsAndAccounts(c8).catch((err) => setError(describeCantor8Error(err)));
        }),
      );
      unsubs.push(
        c8.on('txInitiated', (e) => {
          if (e.txId) setLastTxId(e.txId);
          pushEvent('txInitiated', e.txId ? `txId ${e.txId}` : 'Transfer initiated');
        }),
      );
      unsubs.push(
        c8.on('txChanged', (e) => {
          setLastTxId(e.txId);
          setLastTxStatus(e.status);
          pushEvent('txChanged', `${e.txId} → ${e.status}`);
        }),
      );
      unsubs.push(
        c8.on('operationCanceled', (e) => {
          pushEvent('operationCanceled', e.reason);
          setError(describeCantor8Error({ code: 'USER_REJECTED', message: e.reason }));
        }),
      );
      unsubsRef.current = unsubs;
    },
    [clearSessionData, loadInstrumentsAndAccounts, pushEvent],
  );

  const ensureProvider = useCallback(
    (net: Cantor8Network) => {
      if (providerRef.current) return providerRef.current;
      const c8 = makeProvider(net);
      providerRef.current = c8;
      attachListeners(c8);
      return c8;
    },
    [attachListeners],
  );

  // Create provider on mount; tear down on unmount.
  useEffect(() => {
    ensureProvider(network);
    return () => {
      void teardownProvider();
    };
    // Mount-only bootstrap; network changes go through setNetwork.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setNetwork = useCallback(
    async (next: Cantor8Network) => {
      if (next === network) return;
      await teardownProvider();
      clearSessionData();
      setError(undefined);
      setStatus('idle');
      setNetworkState(next);
      const c8 = makeProvider(next);
      providerRef.current = c8;
      attachListeners(c8);
      pushEvent('network', `Switched to ${next}`);
    },
    [attachListeners, clearSessionData, network, pushEvent, teardownProvider],
  );

  const connect = useCallback(async () => {
    setError(undefined);
    setStatus('connecting');
    try {
      const c8 = ensureProvider(network);
      await c8.connect();
      const st = await c8.status();
      setWalletVersion(st.walletVersion);
      setStatus('connected');
      await loadInstrumentsAndAccounts(c8);
    } catch (e) {
      setStatus('error');
      setError(describeCantor8Error(e));
    }
  }, [ensureProvider, loadInstrumentsAndAccounts, network]);

  const disconnect = useCallback(async () => {
    setError(undefined);
    try {
      const c8 = providerRef.current;
      if (c8) await c8.disconnect();
    } catch (e) {
      setError(describeCantor8Error(e));
    } finally {
      clearSessionData();
      setStatus('idle');
    }
  }, [clearSessionData]);

  const refresh = useCallback(async () => {
    setError(undefined);
    try {
      const c8 = providerRef.current;
      if (!c8) throw { code: 'NOT_CONNECTED', message: 'not connected' };
      await loadInstrumentsAndAccounts(c8);
    } catch (e) {
      setError(describeCantor8Error(e));
    }
  }, [loadInstrumentsAndAccounts]);

  // When instrument selection changes while connected, reload accounts.
  useEffect(() => {
    if (status !== 'connected' || !selectedInstrumentId || !providerRef.current) return;
    void providerRef.current
      .getAccounts(selectedInstrumentId)
      .then(({ accounts: accts }) => {
        setAccounts(accts);
        setSelectedPartyId((prev) =>
          accts.some((a) => a.partyId === prev) ? prev : accts[0]?.partyId,
        );
      })
      .catch((e) => setError(describeCantor8Error(e)));
  }, [selectedInstrumentId, status]);

  const send = useCallback(
    async (input: { receiverPartyId: string; amount: string; memo?: string }) => {
      const c8 = providerRef.current;
      if (!c8 || status !== 'connected') {
        throw Object.assign(new Error('Connect the wallet first.'), { code: 'NOT_CONNECTED' });
      }
      const senderPartyId = selectedPartyId;
      const instrumentId = selectedInstrumentId;
      if (!senderPartyId || !instrumentId) {
        throw new Error('Select a sender party and instrument first.');
      }
      const amount = assertValidCantor8Transfer(input.receiverPartyId, input.amount);
      const memo = input.memo?.trim() || undefined;
      try {
        const { txId } = await c8.send({
          senderPartyId,
          instrumentId,
          amount,
          receiverPartyId: input.receiverPartyId.trim(),
          memo,
        });
        setLastTxId(txId);
        setLastTxStatus('pending');
        pushEvent('send', `Submitted txId ${txId}`);
        return { txId };
      } catch (e) {
        const msg = describeCantor8Error(e);
        setError(msg);
        throw new Error(msg);
      }
    },
    [pushEvent, selectedInstrumentId, selectedPartyId, status],
  );

  const refreshTxStatus = useCallback(async () => {
    const c8 = providerRef.current;
    const txId = lastTxId;
    if (!c8 || !txId) return;
    try {
      const res = await c8.checkTxStatusById({ txId });
      setLastTxStatus(res.status);
      pushEvent('checkTxStatusById', `${txId} → ${res.status}`);
    } catch (e) {
      setError(describeCantor8Error(e));
    }
  }, [lastTxId, pushEvent]);

  const clearEvents = useCallback(() => setEvents([]), []);

  return {
    status,
    network,
    walletVersion,
    error,
    instruments,
    accounts,
    selectedInstrumentId,
    selectedPartyId,
    events,
    lastTxId,
    lastTxStatus,
    setNetwork,
    setSelectedInstrumentId,
    setSelectedPartyId,
    connect,
    disconnect,
    refresh,
    send,
    refreshTxStatus,
    clearEvents,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `yarn tsc -b`

Expected: exit 0. If `InstrumentInfoPayload` / `AccountInfoPayload` import paths differ, import them from `@cantor8/wallet-connect-sdk` (re-exported via `./types` in `dist/index.d.ts`).

- [ ] **Step 3: Commit**

```bash
git add src/useCantor8Wallet.ts
git commit -m "$(cat <<'EOF'
Add useCantor8Wallet hook for C8 popup provider lifecycle.

EOF
)"
```

---

### Task 4: Cantor8Page UI (Phase A sections)

**Files:**
- Modify: `src/Cantor8Page.tsx`

**Interfaces:**
- Consumes: `useCantor8Wallet` / `Cantor8Status` from `./useCantor8Wallet`
- Produces: full Phase A UI

- [ ] **Step 1: Replace stub with full page**

Rewrite `src/Cantor8Page.tsx` to include these sections using existing `App.css` classes (`card`, `status-row`, `status-dot`, `button-row`, `hint`, `accounts-list`, `account-item`, `account-row`, `badge`):

1. Header + `ConnectionModeNav` (same as stub)
2. **Network** — two buttons `devnet` / `mainnet`; call `c8.setNetwork(...)`; disable while `status === 'connecting'`
3. **Connection** — status label + wallet version; Connect / Disconnect buttons calling `c8.connect` / `c8.disconnect`; show `c8.error`
4. When `status === 'connected'`:
   - **Instruments & accounts** — `<select>` for instrument (`c8.setSelectedInstrumentId`); `<select>` for party (`c8.setSelectedPartyId`); holdings list; Refresh button → `c8.refresh`
   - **Transfer** — receiver, amount, memo inputs; Submit calls `c8.send({ receiverPartyId, amount, memo })`; show result `txId` / error
   - **Tx status** — show `lastTxId` / `lastTxStatus`; button → `c8.refreshTxStatus`
5. **Event log** — list `c8.events` (type, time, summary); Clear → `c8.clearEvents`

Status labels:

```ts
const STATUS_LABEL: Record<Cantor8Status, string> = {
  idle: 'not connected',
  connecting: 'connecting…',
  connected: 'connected',
  error: 'error',
};
```

Status dot: `connected` → green; `error` → red; else yellow.

Keep subtitle pointing at SDK docs:

```tsx
<p className="subtitle">
  Direct <code>@cantor8/wallet-connect-sdk</code> integration (not PartyLayer&apos;s Cantor8
  adapter). Docs:{' '}
  <a href="https://cantor8.mintlify.app/wallet-sdk/introduction" target="_blank" rel="noreferrer">
    Wallet SDK
  </a>
</p>
```

Hints must state connect/send require a user gesture and popups must be allowed.

- [ ] **Step 2: Typecheck**

Run: `yarn tsc -b`

Expected: exit 0

- [ ] **Step 3: Manual smoke (devnet)**

Run: `yarn dev`

Checklist:

1. Nav to `/cantor8/` from Standard / Rocky / PartyLayer / Console
2. Connect opens C8 popup → status connected + version
3. Instruments/accounts/holdings render
4. Transfer (if funded) returns `txId`; Refresh status / `txChanged` updates log
5. Toggle `mainnet` → session resets; reconnect works on new network
6. Reject popup → user-facing mapped error
7. Confirm Network tab / console: no CIP-0103 / Rocky / PartyLayer calls from this page

- [ ] **Step 4: Commit**

```bash
git add src/Cantor8Page.tsx
git commit -m "$(cat <<'EOF'
Build Cantor8 page UI for connect, transfer, and events.

EOF
)"
```

---

### Task 5: Status doc (optional but recommended)

**Files:**
- Create: `docs/CANTOR8_WALLET_INTEGRATION.md`

- [ ] **Step 1: Write short status doc**

Mirror Rocky’s `docs/ROCKY_WALLET_INTEGRATION_PLAN.md` style: status, architecture mermaid, files, Phase A vs Phase B, manual checklist.

- [ ] **Step 2: Commit**

```bash
git add docs/CANTOR8_WALLET_INTEGRATION.md
git commit -m "$(cat <<'EOF'
Document Cantor8 dedicated page integration status.

EOF
)"
```

---

## Phase B (not in this plan)

After Phase A is verified on `devnet`, add a `signAndExecute` card to `Cantor8Page` and a `signAndExecute` method on `useCantor8Wallet`. Do not implement in this plan.

## Self-Review

| Spec requirement | Task |
|------------------|------|
| Direct npm `0.4.0` | Task 2 |
| `/cantor8/` + nav | Task 2 |
| `dappName` / `dappUrl` / default `devnet` + toggle | Tasks 1 + 3 + 4 |
| connect / instruments / accounts / send / status / events | Tasks 3 + 4 |
| Error code mapping | Task 1 + 3 |
| User-gesture connect/send | Task 3 + 4 hints |
| PartyLayer adapter untouched | All tasks (no PartyLayer adapter edits) |
| Phase B deferred | Explicit non-task |
| `createSwapOffer` out of scope | Not implemented |
| Helpers unit tests | Task 1 |
| vercel deep links | Existing rewrite; Task 2 smoke |

No TBD placeholders. Types aligned across Task 1 → 3 → 4 (`Cantor8Network`, `Cantor8Status`, `UseCantor8Wallet`, helper names).
