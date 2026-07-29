import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  MINIMAL_CAPABLE_VERSION,
  RockyWalletError,
  rockyWallet,
  type RockyAccount,
  type RockyAssetDescriptor,
  type RockyTokenBalance,
} from '@rocky-wallet/dapp-sdk';
import {
  assertValidRockyTransfer,
  buildRockyTransferOptions,
  type RockyAssetOption,
} from './rockyAssets.js';

export type RockyStatus =
  | 'idle'
  | 'unavailable'
  | 'incompatible'
  | 'available'
  | 'connecting'
  | 'connected'
  | 'error';

export interface UseRockyWallet {
  status: RockyStatus;
  account: RockyAccount | undefined;
  catalog: RockyAssetDescriptor[];
  catalogSupported: boolean;
  balances: RockyTokenBalance[];
  balancesLoading: boolean;
  version: string | undefined;
  error: string | undefined;
  transferAssets: RockyAssetOption[];
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refreshBalances: () => Promise<void>;
  transfer: (
    to: string,
    amount: string,
    asset: RockyAssetOption,
    memo?: string,
  ) => Promise<unknown>;
  signLogin: (challenge: string) => Promise<string | undefined>;
}

export function useRockyWallet(appName = 'Canton Test dApp'): UseRockyWallet {
  const [status, setStatus] = useState<RockyStatus>('idle');
  const [account, setAccount] = useState<RockyAccount | undefined>();
  const [catalog, setCatalog] = useState<RockyAssetDescriptor[]>([]);
  const [catalogSupported, setCatalogSupported] = useState(true);
  const [balances, setBalances] = useState<RockyTokenBalance[]>([]);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [version, setVersion] = useState<string>();
  const [error, setError] = useState<string>();

  const transferAssets = useMemo(
    () => buildRockyTransferOptions(catalog, catalogSupported),
    [catalog, catalogSupported],
  );

  const checkAvailability = useCallback(async (): Promise<boolean> => {
    try {
      const availability = await rockyWallet.checkExtensionAvailability({
        timeoutMs: 1500,
      });
      setVersion(availability.currentVersion);

      if (availability.status !== 'installed') {
        setStatus('unavailable');
        setError('Rocky Wallet Extension is not installed.');
        return false;
      }
      if (!availability.isExtensionCapableByVersion) {
        setStatus('incompatible');
        setError(
          `Rocky Wallet ${MINIMAL_CAPABLE_VERSION} or later is required; found ${
            availability.currentVersion ?? 'an unknown version'
          }.`,
        );
        return false;
      }

      setStatus((current) => (current === 'connected' ? current : 'available'));
      setError(undefined);
      return true;
    } catch (e) {
      setStatus('unavailable');
      setError(describeRockyError(e));
      return false;
    }
  }, []);

  // This hook only mounts on /rocky/. Availability detection waits for Rocky's
  // injection-ready event but does not connect, unlock, or touch other wallets.
  useEffect(() => {
    void checkAvailability();
  }, [checkAvailability]);

  const connect = useCallback(async () => {
    if (!(await checkAvailability())) return;
    setStatus('connecting');
    setError(undefined);
    try {
      const res = await rockyWallet.connect({
        name: appName,
        target: 'local',
        timeoutMs: 3000,
      });
      if (res.isConnected && res.account) {
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
  }, [appName, checkAvailability]);

  const disconnect = useCallback(async () => {
    try {
      await rockyWallet.disconnect();
    } finally {
      setAccount(undefined);
      setCatalog([]);
      setBalances([]);
      setError(undefined);
      setStatus('available');
    }
  }, []);

  const refreshBalances = useCallback(async () => {
    if (!account) return;
    setBalancesLoading(true);
    try {
      const [balanceResponse, catalogResult] = await Promise.all([
        rockyWallet.getCoinsBalance({ party: account.partyId }),
        rockyWallet
          .getAssetCatalog()
          .then((assets) => ({ assets, supported: true }))
          .catch((catalogError: unknown) => {
            if (catalogError instanceof RockyWalletError && catalogError.code === 4200) {
              return { assets: [], supported: false };
            }
            throw catalogError;
          }),
      ]);
      setBalances(balanceResponse.tokens ?? balanceResponse.items ?? []);
      setCatalog(catalogResult.assets);
      setCatalogSupported(catalogResult.supported);
      setError(undefined);
    } catch (e) {
      setError(describeRockyError(e));
    } finally {
      setBalancesLoading(false);
    }
  }, [account]);

  const transfer = useCallback(
    async (to: string, amount: string, asset: RockyAssetOption, memo?: string) => {
      assertValidRockyTransfer(to, amount, asset);
      if (asset.assetId) {
        return rockyWallet.transfer({
          asset_id: asset.assetId,
          symbol: asset.symbol,
          to,
          amount,
          memo,
        });
      }
      return rockyWallet.transfer(to, amount, asset.symbol, { memo });
    },
    [],
  );

  const signLogin = useCallback(
    async (challenge: string) => {
      return rockyWallet.signLoginChallenge(challenge, { app: appName });
    },
    [appName],
  );

  // Auto-fetch balances once connected and whenever the active party changes.
  useEffect(() => {
    if (status === 'connected') void refreshBalances();
  }, [status, account?.partyId, refreshBalances]);

  return {
    status,
    account,
    catalog,
    catalogSupported,
    balances,
    balancesLoading,
    version,
    error,
    transferAssets,
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
        return 'Wallet request rejected or confirmation closed.';
      case 4200:
        return 'Not supported by this wallet version.';
      case 4900:
        return 'Rocky Wallet is unavailable, locked, or disconnected.';
      case -32602:
        return `Invalid request: ${e.message}`;
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}
