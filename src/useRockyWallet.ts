import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createRockyWalletClient,
  RockyWalletError,
  ROCKY_ASSET_SYMBOLS,
  type RockyAccount,
  type RockyAssetSymbol,
  type RockyTokenBalance,
} from './lib/rockyWalletSdk/index.js';

export type RockyStatus =
  | 'idle'
  | 'unavailable'
  | 'available'
  | 'connecting'
  | 'connected'
  | 'error';

export interface UseRockyWallet {
  status: RockyStatus;
  account: RockyAccount | undefined;
  balances: RockyTokenBalance[];
  balancesLoading: boolean;
  version: string | undefined;
  error: string | undefined;
  assets: readonly RockyAssetSymbol[];
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refreshBalances: () => Promise<void>;
  transfer: (
    to: string,
    amount: string,
    asset: RockyAssetSymbol,
    memo?: string,
  ) => Promise<unknown>;
  signLogin: (challenge: string) => Promise<string | undefined>;
}

export function useRockyWallet(appName = 'Canton Test dApp'): UseRockyWallet {
  const [status, setStatus] = useState<RockyStatus>('idle');
  const [account, setAccount] = useState<RockyAccount | undefined>();
  const [balances, setBalances] = useState<RockyTokenBalance[]>([]);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [version, setVersion] = useState<string>();
  const [error, setError] = useState<string>();

  // The client captures `window` at construction, so build it lazily inside the
  // component (Vite SPA — no SSR — but keep the guard explicit) and never use
  // the module-level `rocky` singleton (audit finding M4).
  const client = useMemo(
    () => (typeof window !== 'undefined' ? createRockyWalletClient() : null),
    [],
  );
  const initedRef = useRef(false);

  const init = useCallback(() => {
    if (!client || initedRef.current) return;
    client.init({
      appName,
      onAccept: (p) => setVersion(String(p.version ?? '')),
      onReject: () => setStatus('available'),
    });
    initedRef.current = true;
  }, [client, appName]);

  // Passive, non-invasive availability check on mount. We deliberately do NOT
  // open the provider, register listeners, or auto-connect here — all access to
  // window.rockyWallet is deferred until the user explicitly clicks connect().
  // This keeps Rocky completely inert for users of other wallets (e.g. Ginkgo /
  // Splice) so it can never touch their connection or signing flows.
  useEffect(() => {
    if (!client) {
      setStatus('unavailable');
      return;
    }
    if (typeof window !== 'undefined' && window.rockyWallet) {
      setStatus('available');
    }
  }, [client]);

  const connect = useCallback(async () => {
    if (!client) return;
    init(); // lazy: first provider access happens here, on explicit user action
    setStatus('connecting');
    setError(undefined);
    try {
      // Pass only known-safe keys — never spread untrusted data that could
      // override `target` and promote a remote connection (audit H2).
      const res = await client.connect({ target: 'local', timeoutMs: 3000 });
      if (res.isConnected) {
        setAccount(res.account);
        setStatus('connected');
      } else {
        setStatus('available');
        setError(res.reason ?? 'Not connected');
      }
    } catch (e) {
      setStatus('error');
      setError(describeRockyError(e));
    }
  }, [client, init]);

  const disconnect = useCallback(async () => {
    if (!client) return;
    try {
      await client.disconnect();
    } finally {
      setAccount(undefined);
      setBalances([]);
      setError(undefined);
      setStatus('available');
    }
  }, [client]);

  const refreshBalances = useCallback(async () => {
    if (!client) return;
    setBalancesLoading(true);
    try {
      const res = await client.wallet.getCoinsBalance();
      setBalances(res.tokens ?? res.items ?? []);
    } catch (e) {
      setError(describeRockyError(e));
    } finally {
      setBalancesLoading(false);
    }
  }, [client]);

  const transfer = useCallback(
    async (to: string, amount: string, asset: RockyAssetSymbol, memo?: string) => {
      if (!client) throw new Error('Rocky Wallet unavailable');
      assertValidTransfer(to, amount, asset);
      return client.wallet.transfer(to, amount, asset, { memo });
    },
    [client],
  );

  const signLogin = useCallback(
    async (challenge: string) => {
      if (!client) throw new Error('Rocky Wallet unavailable');
      return client.signLoginChallenge(challenge, { app: appName });
    },
    [client, appName],
  );

  // Auto-fetch balances once connected and whenever the active party changes.
  useEffect(() => {
    if (status === 'connected') void refreshBalances();
  }, [status, account?.partyId, refreshBalances]);

  // Keep UI in sync with wallet-driven changes (account switch, lock/unlock).
  // Only subscribe once the user has connected Rocky, so no window listeners
  // are registered for users who never opt into Rocky.
  useEffect(() => {
    if (!client || status !== 'connected') return;
    const offs = [
      client.sdk.onAccountsChanged((a) => {
        setAccount(a);
        setStatus(a ? 'connected' : 'available');
      }),
      client.sdk.onConnectionStatusChanged((s) =>
        setStatus(s?.isConnected ? 'connected' : 'available'),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [client, status]);

  return {
    status,
    account,
    balances,
    balancesLoading,
    version,
    error,
    assets: ROCKY_ASSET_SYMBOLS,
    connect,
    disconnect,
    refreshBalances,
    transfer,
    signLogin,
  };
}

export function describeRockyError(e: unknown): string {
  if (e instanceof RockyWalletError) {
    switch (e.code) {
      case 4001:
        return 'Connection rejected in the wallet.';
      case 4200:
        return 'Not supported by this wallet version.';
      case 4900:
        return 'Rocky Wallet not installed or locked.';
      case -32602:
        return `Invalid request: ${e.message}`;
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

// Guards audit findings M1 (unknown instrument silently becomes CC) and
// L4 (no amount validation) before anything reaches the extension.
export function assertValidTransfer(to: string, amount: string, asset: RockyAssetSymbol): void {
  if (!to?.trim()) throw new Error('Recipient party is required.');
  if (!(ROCKY_ASSET_SYMBOLS as readonly string[]).includes(asset)) {
    throw new Error(`Unknown asset "${asset}". Choose one of ${ROCKY_ASSET_SYMBOLS.join(', ')}.`);
  }
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Amount must be a positive number.');
}
