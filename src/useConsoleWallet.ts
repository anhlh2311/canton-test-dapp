/**
 * Console Wallet hook — official @console-wallet/dapp-sdk integration.
 *
 * Used by /console/ walkthrough page (not PartyLayer). Handles connect,
 * signMessage, JWT ledgerAuth/refresh, authenticated ledgerApi, balances,
 * and prepareExecuteAndWait.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { consoleWallet } from '@console-wallet/dapp-sdk';

export type ConsoleConnectTarget = 'local' | 'remote' | 'combined';

type ConsoleNetwork = {
  id: string;
  networkId?: string;
  name?: string;
  baseUrl?: string;
  shortName?: string;
};

export type ConsoleStatus =
  | 'idle'
  | 'unavailable'
  | 'available'
  | 'connecting'
  | 'connected'
  | 'error';

export type ConsoleAccount = {
  partyId: string;
  publicKey: string;
  hint?: string;
  networkId?: string;
};

type LedgerTokenBundle = {
  accessToken: string;
  refreshToken: string;
  network: string;
  publicKey: string;
  partyId: string;
};

export type ConsoleLedgerResult = {
  response: string;
  resource: string;
};

const PING_TEMPLATE = '#canton-builtin-admin-workflow-ping:Canton.Internal.Ping:Ping';
const APP_NAME = 'Canton Test dApp — Console';

export function formatConsoleError(err: unknown): string {
  if (err instanceof Error) {
    const cause =
      'cause' in err && err.cause !== undefined
        ? `\ncause: ${formatConsoleError(err.cause)}`
        : '';
    return `${err.message}${cause}`;
  }
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const status = o.status;
    const name = typeof o.name === 'string' ? o.name : '';
    const msg =
      (typeof o.message === 'string' && o.message) ||
      (typeof o.error === 'string' && o.error) ||
      '';
    const is429 =
      status === 429 ||
      name.toLowerCase().includes('throttl') ||
      msg.toLowerCase().includes('too many requests');
    if (is429) {
      return (
        'Console QR relay rate-limited (HTTP 429 Too Many Requests). ' +
        'Wait ~30–60s before retrying remote/QR connect, or switch target to local (extension).' +
        (msg ? `\n${msg}` : '')
      );
    }
    try {
      return msg ? `${msg}\n${JSON.stringify(o, null, 2)}` : JSON.stringify(o, null, 2);
    } catch {
      return msg || String(err);
    }
  }
  return String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `${label} timed out after ${Math.round(ms / 1000)}s. ` +
            'QR/mobile relay may be waiting on the phone or rate-limited (429). ' +
            'Cancel, wait, then retry — or use local (extension) target.',
        ),
      );
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

function connectTimeoutMs(target: ConsoleConnectTarget): number {
  // Remote/QR waits for the user to scan; still bound so the UI cannot freeze forever.
  if (target === 'remote') return 90_000;
  if (target === 'combined') return 60_000;
  return 30_000;
}

export function maskToken(token: string | undefined): string {
  if (!token) return '—';
  if (token.length <= 20) return `${token.slice(0, 4)}…`;
  return `${token.slice(0, 8)}…${token.slice(-8)}`;
}

function toBase64Message(message: string): string {
  const bytes = new TextEncoder().encode(message);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function isForbiddenOrAuthError(err: unknown): boolean {
  const text = formatConsoleError(err).toLowerCase();
  return (
    text.includes('403') ||
    text.includes('forbidden') ||
    text.includes('unauthorized') ||
    text.includes('session_expired') ||
    text.includes('refresh_token')
  );
}

export function useConsoleWallet() {
  const [status, setStatus] = useState<ConsoleStatus>('idle');
  const [availability, setAvailability] = useState<{
    installed: boolean;
    capable?: boolean;
    raw?: unknown;
  } | null>(null);
  const [target, setTarget] = useState<ConsoleConnectTarget>('combined');
  const [account, setAccount] = useState<ConsoleAccount | null>(null);
  const [network, setNetwork] = useState<ConsoleNetwork | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [tokens, setTokens] = useState<LedgerTokenBundle | null>(null);
  const tokensRef = useRef<LedgerTokenBundle | null>(null);
  /** Bumped to ignore late connect/refreshSession results after cancel. */
  const connectGenRef = useRef(0);

  useEffect(() => {
    tokensRef.current = tokens;
  }, [tokens]);

  const refreshSession = useCallback(async () => {
    // Remote relay calls (esp. GET_ACTIVE_NETWORK) can hang or 429 — bound each probe.
    const settled = await Promise.allSettled([
      withTimeout(consoleWallet.getPrimaryAccount(), 15_000, 'getPrimaryAccount'),
      withTimeout(consoleWallet.getActiveNetwork(), 15_000, 'getActiveNetwork'),
      withTimeout(consoleWallet.status(), 15_000, 'status'),
    ]);
    const primary = settled[0].status === 'fulfilled' ? settled[0].value : undefined;
    const activeNetwork = settled[1].status === 'fulfilled' ? settled[1].value : undefined;
    const st = settled[2].status === 'fulfilled' ? settled[2].value : undefined;

    const sessionWarnings = settled
      .map((r, i) => {
        if (r.status !== 'rejected') return null;
        const label = ['getPrimaryAccount', 'getActiveNetwork', 'status'][i];
        return `${label}: ${formatConsoleError(r.reason)}`;
      })
      .filter(Boolean);

    if (primary?.partyId) {
      setAccount({
        partyId: primary.partyId,
        publicKey: primary.publicKey,
        hint: primary.hint,
        networkId: String(primary.networkId ?? ''),
      });
    } else {
      setAccount(null);
    }
    setNetwork((activeNetwork as ConsoleNetwork | undefined) ?? null);
    const connected = Boolean(
      st && typeof st === 'object' && 'isConnected' in st
        ? (st as { isConnected?: boolean }).isConnected
        : primary?.partyId,
    );
    if (connected && primary?.partyId) setStatus('connected');
    if (sessionWarnings.length > 0) {
      setError(`Session partially loaded (relay may be rate-limited):\n${sessionWarnings.join('\n')}`);
    }
    return { primary, activeNetwork, connected, sessionWarnings };
  }, []);

  const checkAvailability = useCallback(async () => {
    try {
      const res = await withTimeout(
        consoleWallet.checkExtensionAvailability(),
        8_000,
        'checkExtensionAvailability',
      );
      const installed = res.status === 'installed';
      setAvailability({
        installed,
        capable: res.isExtensionCapableByVersion,
        raw: res,
      });
      setStatus((cur) => {
        if (cur === 'connected' || cur === 'connecting') return cur;
        return installed ? 'available' : 'unavailable';
      });
      setError(undefined);
      return res;
    } catch (e) {
      setAvailability({ installed: false, raw: e });
      setStatus((cur) => (cur === 'connected' || cur === 'connecting' ? cur : 'unavailable'));
      setError(formatConsoleError(e));
      return null;
    }
  }, []);

  useEffect(() => {
    void checkAvailability();
  }, [checkAvailability]);

  const cancelConnect = useCallback(async () => {
    connectGenRef.current += 1;
    try {
      await consoleWallet.disconnect();
    } catch {
      /* best-effort — tears down QR session if possible */
    }
    setTokens(null);
    tokensRef.current = null;
    setStatus(availability?.installed ? 'available' : 'unavailable');
    setError('Connect cancelled. If you hit 429, wait before retrying remote/QR.');
  }, [availability?.installed]);

  const connect = useCallback(async () => {
    const gen = ++connectGenRef.current;
    setStatus('connecting');
    setError(undefined);
    const timeoutMs = connectTimeoutMs(target);
    try {
      const res = await withTimeout(
        consoleWallet.connect({
          name: APP_NAME,
          target,
        }),
        timeoutMs,
        `Connect (${target})`,
      );
      if (gen !== connectGenRef.current) {
        throw new Error('Connect cancelled');
      }

      const ok =
        res && typeof res === 'object' && 'isConnected' in res
          ? Boolean((res as { isConnected: boolean }).isConnected)
          : false;
      if (!ok) {
        setStatus('available');
        setError('Connect did not return connected status');
        return;
      }
      // Do not block "connected" on hung GET_ACTIVE_NETWORK after QR approve.
      try {
        await refreshSession();
      } catch (sessionErr) {
        setError(
          `Connected, but session refresh failed:\n${formatConsoleError(sessionErr)}`,
        );
      }
      if (gen !== connectGenRef.current) {
        throw new Error('Connect cancelled');
      }
      setStatus('connected');
    } catch (e) {
      if (gen !== connectGenRef.current) {
        throw new Error('Connect cancelled');
      }
      try {
        await consoleWallet.disconnect();
      } catch {
        /* ignore */
      }
      setStatus(availability?.installed ? 'available' : 'error');
      setError(formatConsoleError(e));
      throw e;
    }
  }, [availability?.installed, refreshSession, target]);

  const disconnect = useCallback(async () => {
    connectGenRef.current += 1;
    try {
      await consoleWallet.disconnect();
    } catch {
      /* best-effort */
    }
    setAccount(null);
    setNetwork(null);
    setTokens(null);
    tokensRef.current = null;
    setError(undefined);
    setStatus(availability?.installed ? 'available' : 'unavailable');
  }, [availability?.installed]);

  const signMessage = useCallback(async (message: string) => {
    const signed = await consoleWallet.signMessage({
      message: { base64: toBase64Message(message) },
    });
    return signed;
  }, []);

  const ensureLedgerTokens = useCallback(
    async (forceRefresh = false): Promise<LedgerTokenBundle> => {
      const primary = account ?? (await consoleWallet.getPrimaryAccount());
      const activeNetwork = network ?? (await consoleWallet.getActiveNetwork());
      if (!primary?.partyId || !primary.publicKey) {
        throw new Error('Connect Console Wallet first (missing partyId / publicKey)');
      }
      if (!activeNetwork?.id) {
        throw new Error('Console getActiveNetwork() returned no id');
      }
      if (!activeNetwork.baseUrl) {
        throw new Error(
          `Active network "${String(activeNetwork.id)}" has no baseUrl — extension network metadata incomplete`,
        );
      }

      const cached = tokensRef.current;
      if (
        !forceRefresh &&
        cached &&
        cached.network === activeNetwork.id &&
        cached.partyId === primary.partyId &&
        cached.publicKey === primary.publicKey
      ) {
        return cached;
      }

      if (
        forceRefresh &&
        cached?.refreshToken &&
        cached.network === activeNetwork.id &&
        cached.publicKey === primary.publicKey
      ) {
        try {
          const refreshed = await consoleWallet.ledgerRefresh({
            refreshToken: cached.refreshToken,
            publicKey: primary.publicKey,
            network: activeNetwork.id as never,
          });
          const bundle: LedgerTokenBundle = {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            network: String(activeNetwork.id),
            publicKey: primary.publicKey,
            partyId: primary.partyId,
          };
          setTokens(bundle);
          tokensRef.current = bundle;
          return bundle;
        } catch {
          /* fall through to ledgerAuth */
        }
      }

      const login = await consoleWallet.ledgerAuth({
        publicKey: primary.publicKey,
        partyId: primary.partyId,
        network: activeNetwork.id as never,
      });
      const bundle: LedgerTokenBundle = {
        accessToken: login.accessToken,
        refreshToken: login.refreshToken,
        network: String(activeNetwork.id),
        publicKey: primary.publicKey,
        partyId: primary.partyId,
      };
      setTokens(bundle);
      tokensRef.current = bundle;
      return bundle;
    },
    [account, network],
  );

  const ledgerAuth = useCallback(async () => {
    const bundle = await ensureLedgerTokens(true);
    return bundle;
  }, [ensureLedgerTokens]);

  const ledgerRefresh = useCallback(async () => {
    const bundle = await ensureLedgerTokens(true);
    return bundle;
  }, [ensureLedgerTokens]);

  const ledgerApi = useCallback(
    async (args: {
      requestMethod: 'GET' | 'POST';
      resource: string;
      body?: string | Record<string, unknown>;
    }): Promise<ConsoleLedgerResult> => {
      const body =
        args.body === undefined || args.body === null
          ? ''
          : typeof args.body === 'string'
            ? args.body
            : JSON.stringify(args.body);

      const callOnce = async (forceRefresh: boolean) => {
        const t = await ensureLedgerTokens(forceRefresh);
        const result = await consoleWallet.ledgerApi({
          requestMethod: args.requestMethod,
          resource: args.resource,
          body,
          query: '',
          path: '',
          network: t.network,
          accessToken: t.accessToken,
        } as Parameters<typeof consoleWallet.ledgerApi>[0]);

        if (typeof result === 'string') {
          return { response: result, resource: args.resource };
        }
        if (result && typeof result === 'object' && 'response' in result) {
          const response = (result as { response?: unknown }).response;
          return {
            response: typeof response === 'string' ? response : JSON.stringify(response ?? null),
            resource: args.resource,
          };
        }
        return { response: JSON.stringify(result ?? null), resource: args.resource };
      };

      try {
        return await callOnce(false);
      } catch (e) {
        if (!isForbiddenOrAuthError(e)) throw e;
        setTokens(null);
        tokensRef.current = null;
        return await callOnce(true);
      }
    },
    [ensureLedgerTokens],
  );

  const getLedgerEnd = useCallback(async () => {
    const paths = ['/v2/state/ledger-end', '/v2/ledger-end'] as const;
    const errors: string[] = [];
    for (const resource of paths) {
      try {
        const result = await ledgerApi({ requestMethod: 'GET', resource });
        return { ...result, tried: resource };
      } catch (e) {
        errors.push(`${resource}: ${formatConsoleError(e)}`);
      }
    }
    throw new Error(`ledger-end failed:\n${errors.join('\n')}`);
  }, [ledgerApi]);

  const queryActiveContracts = useCallback(
    async (partyId: string, activeAtOffset: number | string) => {
      return ledgerApi({
        requestMethod: 'POST',
        resource: '/v2/state/active-contracts',
        body: {
          activeAtOffset,
          filter: {
            filtersByParty: {
              [partyId]: {
                cumulative: [
                  {
                    identifierFilter: {
                      WildcardFilter: {
                        value: { includeCreatedEventBlob: true },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      });
    },
    [ledgerApi],
  );

  const getCoinsBalance = useCallback(async () => {
    const primary = account ?? (await consoleWallet.getPrimaryAccount());
    const activeNetwork = network ?? (await consoleWallet.getActiveNetwork());
    if (!primary?.partyId || !activeNetwork?.id) {
      throw new Error('Missing party or network for getCoinsBalance');
    }
    return consoleWallet.getCoinsBalance({
      party: primary.partyId,
      network: activeNetwork.id as never,
    });
  }, [account, network]);

  const createPing = useCallback(async () => {
    const primary = account ?? (await consoleWallet.getPrimaryAccount());
    if (!primary?.partyId) throw new Error('Not connected');
    const party = primary.partyId;
    const commandId = `ping-console-${Date.now()}`;
    return consoleWallet.prepareExecuteAndWait({
      commandId,
      commands: [
        {
          CreateCommand: {
            templateId: PING_TEMPLATE,
            createArguments: {
              id: commandId,
              initiator: party,
              responder: party,
            },
          },
        },
      ],
      actAs: [party],
      readAs: [],
      disclosedContracts: [],
    });
  }, [account]);

  return {
    status,
    availability,
    target,
    setTarget,
    account,
    network,
    error,
    setError,
    tokens,
    checkAvailability,
    connect,
    cancelConnect,
    disconnect,
    refreshSession,
    signMessage,
    ledgerAuth,
    ledgerRefresh,
    ledgerApi,
    getLedgerEnd,
    queryActiveContracts,
    getCoinsBalance,
    createPing,
  };
}

export type UseConsoleWallet = ReturnType<typeof useConsoleWallet>;
