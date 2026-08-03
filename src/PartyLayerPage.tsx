import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ConnectButton,
  PartyLayerProvider,
  ThemeProvider,
  TransactionToast,
  useAccount,
  useSignMessage,
  useLedgerApi,
  usePartyLayer,
  useWallets,
  useRegistryStatus,
} from '@partylayer/react';
import {
  CANTON_NETWORKS,
  createPartyLayer,
  getBuiltinAdapters,
  PartyLayerError,
  SendAdapter,
  type CapabilityKey,
  type NetworkId,
  type TxReceipt,
  type WalletAdapter,
} from '@partylayer/sdk';
import './App.css';
import { ConnectionModeNav } from './ConnectionModeNav';
import {
  ConsoleDamlAdapter,
  isConsoleWalletId,
  queryConsoleCoinsBalance,
} from './console-daml-adapter';

/** Expand PartyLayer / wallet errors so toast/UI show cause + details, not only "Unknown error". */
function formatPartyLayerError(err: unknown): string {
  if (err instanceof PartyLayerError) {
    const parts = [`[${err.code}] ${err.message}`];
    if (err.details && Object.keys(err.details).length > 0) {
      try {
        parts.push(`details: ${JSON.stringify(err.details)}`);
      } catch {
        /* ignore */
      }
    }
    if (err.cause !== undefined) {
      if (err.cause instanceof Error) {
        parts.push(`cause: ${err.cause.name}: ${err.cause.message}`);
      } else {
        try {
          parts.push(`cause: ${JSON.stringify(err.cause)}`);
        } catch {
          parts.push(`cause: ${String(err.cause)}`);
        }
      }
    }
    return parts.join('\n');
  }
  if (err instanceof Error) {
    const cause =
      'cause' in err && err.cause !== undefined
        ? err.cause instanceof Error
          ? `\ncause: ${err.cause.name}: ${err.cause.message}`
          : `\ncause: ${(() => {
              try {
                return JSON.stringify(err.cause);
              } catch {
                return String(err.cause);
              }
            })()}`
        : '';
    return `${err.message}${cause}`;
  }
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (typeof o.message === 'string') {
      try {
        return `${o.message}\n${JSON.stringify(o, null, 2)}`;
      } catch {
        return o.message;
      }
    }
    try {
      return JSON.stringify(err, null, 2);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

type KitNetwork = 'devnet' | 'testnet' | 'mainnet';

const DEFAULT_NETWORK = ((import.meta.env.VITE_PARTYLAYER_NETWORK as string | undefined) ??
  'devnet') as KitNetwork;

/** Informal CAIP-2 aliases some wallets report (≠ PartyLayer's `canton:da-*`). */
const NETWORK_ALIASES: Record<string, KitNetwork> = {
  'canton:testnet': 'testnet',
  'canton:devnet': 'devnet',
  'canton:mainnet': 'mainnet',
  'canton:da-testnet': 'testnet',
  'canton:da-devnet': 'devnet',
  'canton:da-mainnet': 'mainnet',
  testnet: 'testnet',
  devnet: 'devnet',
  mainnet: 'mainnet',
};

/** Token Standard Holding interface — preferred ACS filter (docs/wallet-balances). */
const HOLDING_INTERFACE =
  '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding';

/** Loop-friendly Amulet template fallback when Holding interface returns empty. */
const AMULET_TEMPLATE = '#splice-amulet:Splice.Amulet:Amulet';

/** Builtin Ping template (fully-qualified — required by Loop). */
const PING_TEMPLATE = '#canton-builtin-admin-workflow-ping:Canton.Internal.Ping:Ping';

function caip2For(network: KitNetwork): string {
  return CANTON_NETWORKS[network] ?? `canton:${network}`;
}

/** Map CAIP-2 / short / alias strings back to a Kit short name when possible. */
function shortNetworkLabel(network: string | undefined): string | undefined {
  if (!network) return undefined;
  if (NETWORK_ALIASES[network]) return NETWORK_ALIASES[network];
  for (const [short, caip2] of Object.entries(CANTON_NETWORKS)) {
    if (caip2 === network) return short;
  }
  return network;
}

function toKitNetwork(network: string | undefined): KitNetwork | undefined {
  const short = shortNetworkLabel(network);
  if (short === 'devnet' || short === 'testnet' || short === 'mainnet') return short;
  return undefined;
}

/**
 * Best-effort display network after connect.
 * Prefer wallet/account → useAccount → session → Kit fallback.
 */
function resolveDisplayNetwork(args: {
  accountNetworkId?: string | null;
  hookNetworkId?: string | null;
  sessionNetwork?: string;
  kitNetwork: KitNetwork;
}): { value: string; fromKitFallback: boolean } {
  const { accountNetworkId, hookNetworkId, sessionNetwork, kitNetwork } = args;
  const kitCaip2 = caip2For(kitNetwork);
  const candidates = [accountNetworkId, hookNetworkId, sessionNetwork].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  const primary = candidates[0] ?? kitCaip2;
  const fromKitFallback =
    candidates.length === 0 ||
    candidates.every((v) => v === kitNetwork || v === kitCaip2 || shortNetworkLabel(v) === kitNetwork);
  return { value: primary, fromKitFallback };
}

function ledgerResponseText(result: unknown): string {
  if (!result || typeof result !== 'object') return JSON.stringify(result);
  const r = result as { response?: unknown };
  if (typeof r.response === 'string') return r.response;
  return JSON.stringify(result);
}

function parseAcsEntries(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>;
      if (Array.isArray(o.activeContracts)) return o.activeContracts;
      if (Array.isArray(o.acs)) return o.acs;
      if (Array.isArray(o.contracts)) return o.contracts;
    }
    return [];
  } catch {
    return [];
  }
}

/** Sum holdings from Token Standard interfaceViews, or Amulet createArgument. */
function summarizeHoldings(entries: unknown[]): {
  byInstrument: Record<string, number>;
  contractCount: number;
} {
  const byInstrument: Record<string, number> = {};
  let contractCount = 0;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;

    // Docs shape: contractEntry.JsActiveContract.createdEvent.interfaceViews[0].viewValue
    const created =
      ((e.contractEntry as Record<string, unknown> | undefined)?.JsActiveContract as
        | Record<string, unknown>
        | undefined)?.createdEvent ??
      (e.createdEvent as Record<string, unknown> | undefined) ??
      e;

    const views = (created as Record<string, unknown>)?.interfaceViews;
    if (Array.isArray(views) && views[0]) {
      const view = (views[0] as Record<string, unknown>).viewValue as
        | Record<string, unknown>
        | undefined;
      if (view) {
        const id =
          ((view.instrumentId as Record<string, unknown> | undefined)?.id as string | undefined) ??
          'unknown';
        const amt = parseFloat(String(view.amount ?? '0'));
        if (Number.isFinite(amt)) {
          byInstrument[id] = (byInstrument[id] ?? 0) + amt;
          contractCount += 1;
        }
        continue;
      }
    }

    // Loop ACS / Amulet template fallback: payload.amount.initialAmount
    const payload =
      (created as Record<string, unknown>)?.createArgument ??
      (created as Record<string, unknown>)?.createArguments ??
      (e.payload as Record<string, unknown> | undefined) ??
      e;
    const amount = (payload as Record<string, unknown> | undefined)?.amount as
      | Record<string, unknown>
      | undefined;
    const init = amount?.initialAmount;
    if (init !== undefined && init !== null) {
      const amt = parseFloat(String(init));
      if (Number.isFinite(amt)) {
        byInstrument.Amulet = (byInstrument.Amulet ?? 0) + amt;
        contractCount += 1;
      }
    }
  }

  return { byInstrument, contractCount };
}

function createPingCommands(party: string) {
  return [
    {
      CreateCommand: {
        templateId: PING_TEMPLATE,
        createArguments: {
          id: `ping-partylayer-${Date.now()}`,
          initiator: party,
          responder: party,
        },
      },
    },
  ];
}

/** CIP-0103 / Send prepareExecute* body (flat — not nested under signedTx). */
function createPingPreparePayload(party: string) {
  return {
    commandId: `ping-${Date.now()}`,
    commands: createPingCommands(party),
    actAs: [party],
    readAs: [] as string[],
    disclosedContracts: [] as unknown[],
  };
}

/** Loop TransactionPayload — passed as submitTransaction({ signedTx }). */
function createPingLoopSignedTx(party: string) {
  return {
    commands: createPingCommands(party),
    disclosedContracts: [] as unknown[],
    actAs: [party],
    readAs: [] as string[],
  };
}

function isLoopWallet(walletId: string | undefined): boolean {
  return (walletId ?? '').toLowerCase().includes('loop');
}

function PartyLayerDemo({
  kitNetwork,
  onKitNetworkChange,
}: {
  kitNetwork: KitNetwork;
  onKitNetworkChange: (n: KitNetwork) => void;
}) {
  const { isConnected, party, networkId, status, account, accounts } = useAccount();
  const { wallets, isLoading: walletsLoading, error: walletsError } = useWallets();
  const { status: registryStatus } = useRegistryStatus();
  const { signMessage, isSigning, error: signError } = useSignMessage();
  const { ledgerApi, isLoading: ledgerLoading, error: ledgerError } = useLedgerApi();
  const client = usePartyLayer();

  const [caps, setCaps] = useState<CapabilityKey[]>([]);
  const [sessionMeta, setSessionMeta] = useState<{
    walletId?: string;
    sessionNetwork?: string;
    networkMismatch?: { expected: string; actual: string };
  }>({});
  const [signInput, setSignInput] = useState('Hello from PartyLayer test dApp!');
  const [signResult, setSignResult] = useState<{ signature: string } | null>(null);
  const [holdings, setHoldings] = useState<{
    byInstrument: Record<string, number>;
    contractCount: number;
    path: string;
    raw: string;
  } | null>(null);
  const [holdingsError, setHoldingsError] = useState<string | null>(null);
  const [holdingsLoading, setHoldingsLoading] = useState(false);
  const [pingState, setPingState] = useState<{
    receipt?: TxReceipt;
    error?: string;
    status: 'idle' | 'pending' | 'success' | 'error';
  }>({ status: 'idle' });

  const canLedgerApi = caps.includes('ledgerApi');
  const canSubmit = caps.includes('submitTransaction');
  const canSignMessage = caps.length === 0 || caps.includes('signMessage');
  const kitCaip2 = caip2For(kitNetwork);
  const displayNetwork = resolveDisplayNetwork({
    accountNetworkId: account?.networkId,
    hookNetworkId: networkId,
    sessionNetwork: sessionMeta.sessionNetwork,
    kitNetwork,
  });
  const displayShort = shortNetworkLabel(displayNetwork.value);
  const lastWalletKitRef = useRef<KitNetwork | null>(null);

  // Remember wallet network while connected; apply as preferred Kit only after
  // disconnect (changing Kit network recreates the client and would drop the session).
  useEffect(() => {
    if (!isConnected) return;
    const mapped = toKitNetwork(
      account?.networkId ?? networkId ?? sessionMeta.sessionNetwork,
    );
    if (mapped) lastWalletKitRef.current = mapped;
  }, [isConnected, account?.networkId, networkId, sessionMeta.sessionNetwork]);

  useEffect(() => {
    if (isConnected) return;
    const mapped = lastWalletKitRef.current;
    if (mapped && mapped !== kitNetwork) onKitNetworkChange(mapped);
  }, [isConnected, kitNetwork, onKitNetworkChange]);

  useEffect(() => {
    if (!isConnected) {
      setCaps([]);
      setSessionMeta({});
      setPingState({ status: 'idle' });
      setHoldings(null);
      setHoldingsError(null);
      setHoldingsLoading(false);
      return;
    }
    let cancelled = false;
    client
      .getActiveSession()
      .then((session) => {
        if (cancelled || !session) return;
        setCaps(session.capabilitiesSnapshot ?? []);
        setSessionMeta({
          walletId: String(session.walletId),
          sessionNetwork: String(session.network),
          networkMismatch: session.networkMismatch,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setCaps([]);
          setSessionMeta({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isConnected, client, party]);

  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value);
  };

  // Loop may return `{ signature }` nested; unwrap to a string for React.
  function extractSignature(raw: unknown): string | null {
    let cur: unknown = raw;
    for (let i = 0; i < 3; i++) {
      if (typeof cur === 'string' && cur.length > 0) return cur;
      if (cur && typeof cur === 'object' && 'signature' in cur) {
        cur = (cur as { signature: unknown }).signature;
        continue;
      }
      break;
    }
    return null;
  }

  async function handleSign() {
    setSignResult(null);
    const result = await signMessage({ message: signInput });
    const signature = extractSignature(result?.signature ?? result);
    if (signature) setSignResult({ signature });
  }

  /**
   * Ledger query per PartyLayer wallet-balances docs + Console AUTH notes:
   * 0) Console: getCoinsBalance (token-standard; no raw ledger-api proxy)
   * 1) Full wallets: GET ledger-end → POST active-contracts (AUTH for Console)
   * 2) Loop / limited: POST /v2/state/acs with package-prefixed interface/template filter
   */
  async function handleQueryHoldings() {
    if (!party) return;
    setHoldings(null);
    setHoldingsError(null);
    setHoldingsLoading(true);

    const session = await client.getActiveSession();
    const sessionCaps = session?.capabilitiesSnapshot ?? caps;
    const walletId = String(session?.walletId ?? sessionMeta.walletId ?? '');
    const pathErrors: string[] = [];

    try {
    // Path 0 — Console native balances (avoids /api/v1/ledger-api 403 when proxy auth fails)
    if (isConsoleWalletId(walletId)) {
      try {
        const coins = await queryConsoleCoinsBalance();
        setHoldings(coins);
        return;
      } catch (e) {
        pathErrors.push(`Path 0 (Console getCoinsBalance): ${formatPartyLayerError(e)}`);
      }
    }

    if (!sessionCaps.includes('ledgerApi')) {
      setHoldingsError(
        (pathErrors.length ? pathErrors.join('\n\n') + '\n\n' : '') +
          `Connected wallet (${walletId || 'unknown'}) has no ledgerApi capability. ` +
          `Capabilities: [${sessionCaps.join(', ') || 'none'}].`,
      );
      return;
    }

    // Path A — AUTH'd active-contracts (Console docs: POST /v2/state/active-contracts AUTH=Yes)
    // ConsoleDamlAdapter.ledgerApi attaches JWT via ledgerAuth before proxying.
    try {
      const end = await ledgerApi({
        requestMethod: 'GET',
        resource: '/v2/state/ledger-end',
      });
      if (end) {
        const { offset } = JSON.parse(ledgerResponseText(end)) as { offset?: number | string };
        if (offset !== undefined) {
          const acs = await ledgerApi({
            requestMethod: 'POST',
            resource: '/v2/state/active-contracts',
            body: JSON.stringify({
              activeAtOffset: offset,
              eventFormat: {
                filtersByParty: {
                  [party]: {
                    cumulative: [
                      {
                        identifierFilter: {
                          InterfaceFilter: {
                            value: {
                              interfaceId: HOLDING_INTERFACE,
                              includeInterfaceView: true,
                            },
                          },
                        },
                      },
                    ],
                  },
                },
                verbose: false,
              },
            }),
          });
          if (acs) {
            const raw = ledgerResponseText(acs);
            const entries = parseAcsEntries(raw);
            const summary = summarizeHoldings(entries);
            if (summary.contractCount > 0 || entries.length >= 0) {
              setHoldings({
                ...summary,
                path: 'GET /v2/state/ledger-end → POST /v2/state/active-contracts (Holding, AUTH)',
                raw,
              });
              return;
            }
          }
        }
      }
    } catch (e) {
      pathErrors.push(`Path A (ledger-end + active-contracts AUTH): ${formatPartyLayerError(e)}`);
      // Fall through to Loop-compatible ACS (ledger-end unsupported on Loop).
    }

    // Path B — Loop-compatible ACS (also works as fallback): Holding interfaceId
    try {
      const holdingAcs = await ledgerApi({
        requestMethod: 'POST',
        resource: '/v2/state/acs',
        body: JSON.stringify({
          filter: {
            filtersByParty: {
              [party]: {
                inclusive: {
                  templateFilters: [{ interfaceId: HOLDING_INTERFACE }],
                },
              },
            },
          },
        }),
      });
      if (holdingAcs) {
        const raw = ledgerResponseText(holdingAcs);
        const entries = parseAcsEntries(raw);
        const summary = summarizeHoldings(entries);
        if (summary.contractCount > 0) {
          setHoldings({
            ...summary,
            path: 'POST /v2/state/acs (Holding interfaceId)',
            raw,
          });
          return;
        }
      }
    } catch (e) {
      pathErrors.push(`Path B (/v2/state/acs Holding): ${formatPartyLayerError(e)}`);
    }

    // Path C — Amulet template (Loop example app shape)
    try {
      const amuletAcs = await ledgerApi({
        requestMethod: 'POST',
        resource: '/v2/state/acs',
        body: JSON.stringify({
          filter: {
            filtersByParty: {
              [party]: {
                inclusive: {
                  templateFilters: [{ templateId: AMULET_TEMPLATE }],
                },
              },
            },
          },
        }),
      });
      if (amuletAcs) {
        const raw = ledgerResponseText(amuletAcs);
        const entries = parseAcsEntries(raw);
        const summary = summarizeHoldings(entries);
        setHoldings({
          ...summary,
          path: 'POST /v2/state/acs (Amulet template)',
          raw,
        });
        return;
      }
    } catch (e) {
      pathErrors.push(`Path C (/v2/state/acs Amulet): ${formatPartyLayerError(e)}`);
    }

    if (pathErrors.length > 0) {
      setHoldingsError(pathErrors.join('\n\n'));
    } else if (ledgerError) {
      setHoldingsError(formatPartyLayerError(ledgerError));
    } else {
      setHoldingsError('All ACS query paths returned empty / no response.');
    }
    } finally {
      setHoldingsLoading(false);
    }
  }

  async function handleCreatePing() {
    if (!party) return;
    setPingState({ status: 'pending' });

    try {
      const session = await client.getActiveSession();
      const sessionCaps = session?.capabilitiesSnapshot ?? caps;
      const walletId = String(session?.walletId ?? sessionMeta.walletId ?? '');

      if (!sessionCaps.includes('submitTransaction')) {
        setPingState({
          status: 'error',
          error:
            `Connected wallet (${walletId || 'unknown'}) lacks submitTransaction. ` +
            `Capabilities: [${sessionCaps.join(', ') || 'none'}]. ` +
            'Cantor8 / Bron need signTransaction instead.',
        });
        return;
      }

      // Call the client directly so errors throw (useSubmitTransaction swallows
      // and returns null, which races with React state and loses detail).
      const signedTx = isLoopWallet(walletId)
        ? createPingLoopSignedTx(party)
        : createPingPreparePayload(party);

      const receipt = await client.submitTransaction({ signedTx });
      setPingState({ status: 'success', receipt });
    } catch (e) {
      setPingState({
        status: 'error',
        error: formatPartyLayerError(e),
      });
    }
  }

  const toastStatus =
    pingState.status === 'pending'
      ? 'pending'
      : pingState.status === 'success'
        ? 'success'
        : pingState.status === 'error'
          ? 'error'
          : 'idle';

  return (
    <>
      <section className="card">
        <h2>Connection</h2>
        <div className="status-row">
          <span
            className={`status-dot ${isConnected ? 'green' : status === 'connecting' || status === 'reconnecting' ? 'yellow' : 'red'}`}
          />
          <span>
            {isConnected
              ? `Connected (${status})`
              : status === 'connecting' || status === 'reconnecting'
                ? `${status}…`
                : `Disconnected (${status})`}
          </span>
        </div>
        <div className="button-row partylayer-connect-row">
          <ConnectButton />
        </div>

        {isConnected ? (
          <div className="partylayer-network-row">
            <span className="account-label">Network:</span>
            <code className="account-value">
              {displayShort && displayShort !== displayNetwork.value
                ? `${displayShort} (${displayNetwork.value})`
                : displayNetwork.value}
            </code>
            {displayNetwork.fromKitFallback && (
              <span className="hint">
                {' '}
                — wallet did not report; using Kit fallback ({kitNetwork} / {kitCaip2})
              </span>
            )}
          </div>
        ) : (
          <div className="partylayer-network-row">
            <span className="account-label">Preferred Kit network:</span>
            <select
              className="verify-scheme"
              value={kitNetwork}
              title="Fallback for wallets that do not report a network (e.g. Loop). PartyLayerKit remounts on change."
              onChange={(e) => onKitNetworkChange(e.target.value as KitNetwork)}
            >
              <option value="devnet">devnet → {caip2For('devnet')}</option>
              <option value="testnet">testnet → {caip2For('testnet')}</option>
              <option value="mainnet">mainnet → {caip2For('mainnet')}</option>
            </select>
          </div>
        )}

        <div className="hint">
          <div>
            Uses <code>ConnectButton</code> with <code>networkEnforcement: &apos;off&apos;</code> so
            transactions follow the <strong>connected wallet&apos;s network</strong>. Preferred Kit
            network is only a fallback when the wallet does not report one (common with Loop).
          </div>
        </div>
        {registryStatus && (
          <div className="status-detail">
            <div className="status-grid">
              <div>
                <b>Registry:</b>{' '}
                <i>
                  {registryStatus.verified ? 'verified' : 'unverified'}
                  {registryStatus.stale ? ' (stale)' : ''}
                </i>
              </div>
              {registryStatus.channel && (
                <div>
                  <b>Channel:</b> <i>{registryStatus.channel}</i>
                </div>
              )}
            </div>
          </div>
        )}
        {isConnected && (
          <div className="status-detail">
            <div className="status-grid">
              {sessionMeta.walletId && (
                <div>
                  <b>Wallet:</b> <i>{sessionMeta.walletId}</i>
                </div>
              )}
              {caps.length > 0 && (
                <div>
                  <b>Capabilities:</b> <i>{caps.join(', ')}</i>
                </div>
              )}
            </div>
          </div>
        )}
        {sessionMeta.networkMismatch && (
          <div className="status-row">
            <span className="status-dot yellow" />
            <span>
              Kit preferred <code>{sessionMeta.networkMismatch.expected}</code>; wallet is on{' '}
              <code>{sessionMeta.networkMismatch.actual}</code>. Using the wallet network (enforcement
              off).
            </span>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Discovered Wallets {walletsLoading ? '(loading…)' : `(${wallets.length})`}</h2>
        {walletsError &&
          !('code' in walletsError && (walletsError as { code?: string }).code === 'NETWORK_MISMATCH') && (
          <div className="status-row">
            <span className="status-dot red" />
            <span>{walletsError.message}</span>
          </div>
        )}
        {wallets.length === 0 && !walletsLoading ? (
          <p className="hint">No wallets from the registry yet.</p>
        ) : (
          <ul className="partylayer-wallet-list">
            {wallets.map((w) => (
              <li key={w.walletId}>
                <code>{w.walletId}</code> — {w.name}
                {w.capabilities?.length ? (
                  <span className="hint"> ({w.capabilities.join(', ')})</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {isConnected && (
        <section className="card">
          <h2>Account</h2>
          <div className="balance-result" style={{ marginBottom: 12 }}>
            <div className="account-row account-row-meta">
              <span className="account-label">Network:</span>
              <code className="account-value">{displayNetwork.value}</code>
              {displayNetwork.fromKitFallback ? (
                <span className="hint"> (Kit fallback — wallet did not report)</span>
              ) : null}
            </div>
            <div className="account-row account-row-meta">
              <span className="account-label">Kit fallback:</span>
              <code className="account-value">
                {kitNetwork} ({kitCaip2})
              </code>
            </div>
            <div className="account-row account-row-meta">
              <span className="account-label">session.network:</span>
              <code className="account-value">{sessionMeta.sessionNetwork ?? '—'}</code>
            </div>
            <div className="account-row account-row-meta">
              <span className="account-label">useAccount.networkId:</span>
              <code className="account-value">{networkId ?? '—'}</code>
            </div>
          </div>
          <div className="accounts-list">
            {(accounts.length > 0 ? accounts : account ? [account] : []).map((acc) => (
              <div
                key={acc.partyId}
                className={`account-item ${acc.partyId === party ? 'primary' : ''}`}
              >
                <div className="account-row">
                  <span className="account-label">partyId:</span>
                  <code className="account-value">{acc.partyId}</code>
                  <button className="sign-copy" onClick={() => copy(acc.partyId)}>
                    Copy
                  </button>
                  {acc.partyId === party && <span className="badge badge-primary">primary</span>}
                </div>
                {acc.publicKey && (
                  <div className="account-row">
                    <span className="account-label">publicKey:</span>
                    <code className="account-value wrap">{acc.publicKey}</code>
                    <button className="sign-copy" onClick={() => copy(acc.publicKey!)}>
                      Copy
                    </button>
                  </div>
                )}
                {acc.networkId && (
                  <div className="account-row account-row-meta">
                    <span className="account-label">account.networkId:</span>
                    <code className="account-value">{acc.networkId}</code>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {isConnected && (
        <section className="card">
          <h2>Sign Message</h2>
          <p className="hint">
            Via <code>useSignMessage()</code> — supported on all built-in wallets in the{' '}
            <a href="https://partylayer.xyz/docs/wallets#capability-matrix" target="_blank" rel="noreferrer">
              capability matrix
            </a>
            .
          </p>
          <textarea
            className="sign-input"
            rows={3}
            value={signInput}
            onChange={(e) => setSignInput(e.target.value)}
            placeholder="Message to sign…"
            disabled={isSigning || !canSignMessage}
          />
          <div className="button-row">
            <button
              onClick={handleSign}
              disabled={isSigning || !signInput.trim() || !canSignMessage}
            >
              {isSigning ? 'Signing…' : 'Sign Message'}
            </button>
          </div>
          {signError && (
            <div className="status-row">
              <span className="status-dot red" />
              <span>{signError.message}</span>
            </div>
          )}
          {signResult && (
            <div className="sign-row">
              <span className="sign-row-label">signature:</span>
              <code className="sign-row-value wrap">{String(signResult.signature)}</code>
              <button className="sign-copy" onClick={() => copy(String(signResult.signature))}>
                Copy
              </button>
            </div>
          )}
        </section>
      )}

      {isConnected && (
        <section className="card">
          <h2>Ledger Query (Holdings)</h2>
          <p className="hint">
            Via <code>useLedgerApi()</code> / ACS —{' '}
            <a href="https://partylayer.xyz/docs/wallet-balances" target="_blank" rel="noreferrer">
              wallet balances guide
            </a>
            . Console: tries <code>getCoinsBalance</code> first, then AUTH&apos;d{' '}
            <code>POST /v2/state/active-contracts</code> (JWT via <code>ledgerAuth</code>). Other
            wallets: <code>ledger-end</code> + Holding interface; Loop falls back to{' '}
            <code>POST /v2/state/acs</code>.
          </p>
          {!canLedgerApi && caps.length > 0 && !isConsoleWalletId(sessionMeta.walletId) && (
            <p className="hint">
              Connected wallet (<code>{sessionMeta.walletId ?? 'unknown'}</code>) has no{' '}
              <code>ledgerApi</code> capability. Caps: <code>{caps.join(', ') || 'none'}</code>.
              Expected for Cantor8 / Walley.
            </p>
          )}
          <div className="button-row">
            <button
              onClick={handleQueryHoldings}
              disabled={
                holdingsLoading ||
                ledgerLoading ||
                !party ||
                (!canLedgerApi && !isConsoleWalletId(sessionMeta.walletId))
              }
              title={
                !canLedgerApi && !isConsoleWalletId(sessionMeta.walletId)
                  ? 'Wallet lacks ledgerApi capability'
                  : ''
              }
            >
              {holdingsLoading || ledgerLoading ? 'Querying…' : 'Query Holdings / Balance'}
            </button>
          </div>
          {(holdingsError || ledgerError) && (
            <div className="status-row" style={{ alignItems: 'flex-start' }}>
              <span className="status-dot red" />
              <pre className="hint" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                {holdingsError ?? formatPartyLayerError(ledgerError)}
              </pre>
            </div>
          )}
          {holdings && (
            <div className="balance-result">
              <div className="account-row account-row-meta">
                <span className="account-label">path:</span>
                <code className="account-value wrap">{holdings.path}</code>
              </div>
              <div className="account-row account-row-meta">
                <span className="account-label">contracts:</span>
                <span>{holdings.contractCount}</span>
              </div>
              {Object.keys(holdings.byInstrument).length === 0 ? (
                <p className="hint">No holdings found for this party / filter.</p>
              ) : (
                Object.entries(holdings.byInstrument).map(([instrument, amount]) => (
                  <div key={instrument} className="balance-row">
                    <span className="balance-label">{instrument}</span>
                    <span className="balance-total-value">
                      {amount.toLocaleString(undefined, { maximumFractionDigits: 10 })}
                    </span>
                  </div>
                ))
              )}
              <details className="balance-breakdown">
                <summary>Raw ACS response</summary>
                <pre>
                  {(() => {
                    try {
                      return JSON.stringify(JSON.parse(holdings.raw), null, 2);
                    } catch {
                      return holdings.raw;
                    }
                  })()}
                </pre>
              </details>
            </div>
          )}
        </section>
      )}

      {isConnected && (
        <section className="card">
          <h2>Submit Transaction</h2>
          <p className="hint">
            Uses <code>client.submitTransaction(&#123; signedTx &#125;)</code> (fused sign+submit).
            Loop gets a proprietary payload; Send / Console / Nightly get a flat CIP-0103
            ExecuteRequest. <code>SendAdapter</code> + <code>ConsoleDamlAdapter</code> are
            registered so <code>signedTx</code> is not double-wrapped. Template:{' '}
            <code>{PING_TEMPLATE}</code>.
          </p>
          {!canSubmit && caps.length > 0 && (
            <p className="hint">
              Connected wallet (<code>{sessionMeta.walletId ?? 'unknown'}</code>) has no{' '}
              <code>submitTransaction</code>. Caps: <code>{caps.join(', ') || 'none'}</code>.
            </p>
          )}
          <div className="button-row">
            <button
              onClick={handleCreatePing}
              disabled={pingState.status === 'pending' || !party || !canSubmit}
              title={!canSubmit ? 'Wallet lacks submitTransaction capability' : ''}
            >
              {pingState.status === 'pending' ? 'Submitting…' : 'Create Ping Contract'}
            </button>
          </div>

          <TransactionToast
            status={toastStatus}
            error={toastStatus === 'error' ? new Error(pingState.error ?? 'unknown error') : null}
            receipt={pingState.receipt ?? null}
          />
          {pingState.status === 'error' && pingState.error && (
            <pre
              className="hint"
              style={{ marginTop: 8, whiteSpace: 'pre-wrap', color: 'var(--error, #c44)' }}
            >
              {pingState.error}
            </pre>
          )}
          {toastStatus === 'success' && pingState.receipt && (
            <div className="balance-result" style={{ marginTop: 8 }}>
              <div className="account-row">
                <span className="account-label">transactionHash:</span>
                <code className="account-value wrap">{pingState.receipt.transactionHash}</code>
                <button
                  className="sign-copy"
                  onClick={() => copy(String(pingState.receipt!.transactionHash))}
                >
                  Copy
                </button>
              </div>
              {pingState.receipt.commandId && (
                <div className="account-row">
                  <span className="account-label">commandId:</span>
                  <code className="account-value wrap">{pingState.receipt.commandId}</code>
                  <button
                    className="sign-copy"
                    onClick={() => copy(String(pingState.receipt!.commandId))}
                  >
                    Copy
                  </button>
                </div>
              )}
              {pingState.receipt.updateId && (
                <div className="account-row">
                  <span className="account-label">updateId:</span>
                  <code className="account-value wrap">{pingState.receipt.updateId}</code>
                  <button
                    className="sign-copy"
                    onClick={() => copy(String(pingState.receipt!.updateId))}
                  >
                    Copy
                  </button>
                </div>
              )}
              <div className="account-row account-row-meta">
                <span className="account-label">submittedAt:</span>
                <code className="account-value">
                  {new Date(pingState.receipt.submittedAt).toLocaleString()}
                </code>
              </div>
            </div>
          )}
        </section>
      )}
    </>
  );
}

function PartyLayerClientProvider({
  network,
  adapters,
  children,
}: {
  network: KitNetwork;
  adapters: WalletAdapter[];
  children: ReactNode;
}) {
  const client = useMemo(() => {
    return createPartyLayer({
      network: network as NetworkId,
      // Follow the wallet: do not block sign/submit/ledger when Kit preferred ≠ wallet.
      // (Send often reports `canton:testnet`, which ≠ PartyLayer's `canton:da-testnet`.)
      networkEnforcement: 'off',
      // SDK ≥0.16 is silent by default; opt into console for this test dApp.
      logger: console,
      app: {
        name: 'Canton Test dApp',
        origin: typeof window !== 'undefined' ? window.location.origin : undefined,
      },
      adapters,
    });
  }, [network, adapters]);

  useEffect(() => {
    return () => {
      client.destroy();
    };
  }, [client]);

  return (
    <ThemeProvider theme="light">
      <PartyLayerProvider client={client} network={network}>
        {children}
      </PartyLayerProvider>
    </ThemeProvider>
  );
}

export function PartyLayerPage({
  onExit,
  onOpenRocky,
  onOpenConsole,
}: {
  onExit: () => void;
  onOpenRocky: () => void;
  onOpenConsole: () => void;
}) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const [kitNetwork, setKitNetwork] = useState<KitNetwork>(DEFAULT_NETWORK);
  // Send + Console are announce-only and NOT in getBuiltinAdapters(). Without
  // first-party adapters the SDK falls back to GenericAnnounceAdapter (no
  // ledgerApi for Console; broken signedTx nesting). Registering them also
  // skips the announce GenericAnnounceAdapter for those walletIds.
  const adapters = useMemo(
    () => [...getBuiltinAdapters(), new SendAdapter(), new ConsoleDamlAdapter()],
    [],
  );

  return (
    <div className="app">
      <h1>PartyLayer</h1>
      <p className="subtitle">
        PartyLayer SDK integration — <code>@partylayer/react</code> + registry-backed wallet
        discovery
      </p>

      <ConnectionModeNav
        active="partylayer"
        onStandard={onExit}
        onRocky={onOpenRocky}
        onPartyLayer={() => {}}
        onConsole={onOpenConsole}
      />

      <QueryClientProvider client={queryClient}>
        <PartyLayerClientProvider network={kitNetwork} adapters={adapters}>
          <PartyLayerDemo kitNetwork={kitNetwork} onKitNetworkChange={setKitNetwork} />
        </PartyLayerClientProvider>
      </QueryClientProvider>
    </div>
  );
}
