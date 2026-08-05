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
  signAndExecute: (input: {
    note: string;
    partyId: string;
    commandId: string;
    commandsJson: string;
    disclosedContracts?: string;
  }) => Promise<void>;
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
  // Set right before loadInstrumentsAndAccounts programmatically changes the
  // selected instrument, so the instrument-change effect below skips the
  // redundant getAccounts call for a fetch it already performed.
  const skipNextInstrumentEffectRef = useRef(false);
  // Monotonic id guarding against out-of-order getAccounts responses when the
  // user switches instruments in quick succession.
  const instrumentAccountsRequestIdRef = useRef(0);

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
      skipNextInstrumentEffectRef.current = true;
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
      if (!c8) {
        throw Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' });
      }
      await loadInstrumentsAndAccounts(c8);
    } catch (e) {
      setError(describeCantor8Error(e));
    }
  }, [loadInstrumentsAndAccounts]);

  // When instrument selection changes while connected, reload accounts.
  // Skipped once right after loadInstrumentsAndAccounts programmatically
  // sets selectedInstrumentId (initial connect / reconnect), since that
  // function already fetched accounts for this exact instrument.
  useEffect(() => {
    if (status !== 'connected' || !selectedInstrumentId || !providerRef.current) return;
    if (skipNextInstrumentEffectRef.current) {
      skipNextInstrumentEffectRef.current = false;
      return;
    }
    const requestId = ++instrumentAccountsRequestIdRef.current;
    void providerRef.current
      .getAccounts(selectedInstrumentId)
      .then(({ accounts: accts }) => {
        if (instrumentAccountsRequestIdRef.current !== requestId) return; // stale response
        setAccounts(accts);
        setSelectedPartyId((prev) =>
          accts.some((a) => a.partyId === prev) ? prev : accts[0]?.partyId,
        );
      })
      .catch((e) => {
        if (instrumentAccountsRequestIdRef.current !== requestId) return; // stale response
        setError(describeCantor8Error(e));
      });
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

  const signAndExecute = useCallback(
    async (input: {
      note: string;
      partyId: string;
      commandId: string;
      commandsJson: string;
      disclosedContracts?: string;
    }) => {
      const c8 = providerRef.current;
      if (!c8 || status !== 'connected') {
        throw Object.assign(new Error('Connect the wallet first.'), { code: 'NOT_CONNECTED' });
      }
      const note = input.note.trim();
      const partyId = input.partyId.trim();
      const commandId = input.commandId.trim();
      const commandsJson = input.commandsJson.trim();
      if (!note) throw new Error('Note is required.');
      if (!partyId) throw new Error('partyId is required.');
      if (!commandId) throw new Error('commandId is required.');
      if (!commandsJson) throw new Error('commandsJson is required.');
      try {
        JSON.parse(commandsJson);
      } catch {
        throw new Error('commandsJson must be valid JSON.');
      }
      const disclosedContracts = input.disclosedContracts?.trim() ?? '';
      if (disclosedContracts) {
        try {
          JSON.parse(disclosedContracts);
        } catch {
          throw new Error('disclosedContracts must be valid JSON (or empty).');
        }
      }
      try {
        await c8.signAndExecute({
          note,
          partyId,
          commandId,
          commandsJson,
          disclosedContracts,
        });
        pushEvent('signAndExecute', `Submitted commandId ${commandId}`);
      } catch (e) {
        const msg = describeCantor8Error(e);
        setError(msg);
        throw Object.assign(new Error(msg), {
          code: e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : undefined,
        });
      }
    },
    [pushEvent, status],
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
    signAndExecute,
    refreshTxStatus,
    clearEvents,
  };
}
