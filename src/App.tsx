import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import './App.css';
import * as sdk from '@canton-network/dapp-sdk';
import type { ProviderAdapter } from '@canton-network/core-wallet-discovery';
import { CantonWcAdapter } from './walletconnect-canton-adapter';

const WC_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;
const WC_PROPOSED_CHAINS = ((import.meta.env.VITE_CANTON_CHAIN_ID as string | undefined) ?? 'canton:devnet')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Public Splice Scan API URLs per Canton network. Used as a fallback for
// balance queries when the wallet denies canton_ledgerApi proxy and doesn't
// expose ledger URL / custom balance methods (typical for restricted WC
// mobile wallets like askardex-wallet). Override with VITE_SCAN_API_URL.
//
// DA mainnet SVs are listed in splice-wallet-kernel/api-specs/assets.json.
// We pick sync.global as the default — switch via env var if CORS rejects.
const KNOWN_SCAN_URLS_BY_NETWORK: Record<string, string> = {
  'canton:da-mainnet': 'https://scan.sv-1.global.canton.network.sync.global/api/scan',
  'canton:da-devnet': 'https://scan.sv-1.dev.global.canton.network.sync.global/api/scan',
  'canton:da-testnet': 'https://scan.sv-1.test.global.canton.network.sync.global/api/scan',
};

function getConfiguredScanUrl(networkId: string | undefined): string | undefined {
  const envOverride = (import.meta.env.VITE_SCAN_API_URL as string | undefined)?.trim();
  if (envOverride) return envOverride.replace(/\/$/, '');
  if (!networkId) return undefined;
  const known = KNOWN_SCAN_URLS_BY_NETWORK[networkId];
  return known ? known.replace(/\/$/, '') : undefined;
}

// ============================================================
// Log infrastructure
// ============================================================
interface LogEntry {
  id: number;
  time: string;
  type: 'info' | 'success' | 'error';
  message: string;
}

let logId = 0;

// ============================================================
// Raw PostMessage helpers (for extension-only testing)
// ============================================================
const WalletEvent = {
  REQUEST: 'SPLICE_WALLET_REQUEST',
  RESPONSE: 'SPLICE_WALLET_RESPONSE',
  EXT_READY: 'SPLICE_WALLET_EXT_READY',
  EXT_ACK: 'SPLICE_WALLET_EXT_ACK',
} as const;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

let requestId = 0;

function rpcRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = `test-dapp-${++requestId}`;
    const listener = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data;
      if (data?.type !== WalletEvent.RESPONSE) return;
      const response = data.response as JsonRpcResponse;
      if (response.id !== id) return;
      window.removeEventListener('message', listener);
      if (response.error) {
        reject(new Error(`RPC Error ${response.error.code}: ${response.error.message}`));
      } else {
        resolve(response.result as T);
      }
    };
    window.addEventListener('message', listener);
    window.postMessage(
      {
        type: WalletEvent.REQUEST,
        request: { jsonrpc: '2.0' as const, id, method, params },
      },
      '*',
    );
    // Longer timeout for methods that require user approval in the wallet popup
    const timeoutMs = ['connect', 'signMessage', 'signTransaction'].includes(method) ? 60_000 : 10_000;
    setTimeout(() => {
      window.removeEventListener('message', listener);
      reject(new Error(`Request "${method}" timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });
}

function detectExtension(): Promise<boolean> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.data?.type === WalletEvent.EXT_ACK) {
        window.removeEventListener('message', listener);
        resolve(true);
      }
    };
    window.addEventListener('message', listener);
    window.postMessage({ type: WalletEvent.EXT_READY }, '*');
    setTimeout(() => {
      window.removeEventListener('message', listener);
      resolve(false);
    }, 2_000);
  });
}

// ============================================================
// Ping contract command builder (from splice-wallet-kernel Ping example)
// ============================================================
// wallet-gateway-remote ≥ 1.1.0 returns BOTH ids on prepareExecute, encoded
// in the userUrl query string:
//   http://.../approve/index.html?transactionId=<UUID>&commandId=<UUID>&closeafteraction
// - transactionId: gateway-store primary key (use for user-API lookups:
//   execute / getTransaction / deleteTransaction).
// - commandId: app-level id, echoed from params or auto-generated (use for
//   UI/audit correlation in the dApp's own data plane).
// We return null fields rather than throwing — older gateways may omit
// either query param.
// Surfaces rejection values that aren't `Error` instances — the dApp SDK
// propagates JSON-RPC errors as `{ code, message, data? }` (and sometimes
// nested under `.error`), and `String(obj)` gives the useless "[object
// Object]". Walks a few common shapes; falls back to JSON.stringify.
function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e === null || e === undefined) return String(e);
  if (typeof e !== 'object') return String(e);
  const obj = e as Record<string, unknown>;
  const fromShape = (o: Record<string, unknown>) => {
    const msg = typeof o.message === 'string' ? (o.message as string) : undefined;
    const code = typeof o.code === 'number' || typeof o.code === 'string' ? o.code : undefined;
    if (msg !== undefined) return code !== undefined ? `${code}: ${msg}` : msg;
    return null;
  };
  const top = fromShape(obj);
  if (top !== null) return top;
  if (obj.error && typeof obj.error === 'object') {
    const nested = fromShape(obj.error as Record<string, unknown>);
    if (nested !== null) return nested;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return '[unstringifiable]';
  }
}

function parseUserUrlIds(userUrl: string | undefined): { transactionId: string | null; commandId: string | null } {
  if (!userUrl) return { transactionId: null, commandId: null };
  try {
    const params = new URL(userUrl).searchParams;
    return {
      transactionId: params.get('transactionId'),
      commandId: params.get('commandId'),
    };
  } catch {
    return { transactionId: null, commandId: null };
  }
}

function createPingCommand(ledgerApiVersion: string | undefined, party: string) {
  const packageName = ledgerApiVersion?.startsWith('3.3.')
    ? 'AdminWorkflows'
    : 'canton-builtin-admin-workflow-ping';
  return {
    commands: [
      {
        CreateCommand: {
          templateId: `#${packageName}:Canton.Internal.Ping:Ping`,
          createArguments: {
            id: `ping-test-${Date.now()}`,
            initiator: party,
            responder: party,
          },
        },
      },
    ],
  };
}

// ============================================================
// Pretty JSON formatter
// ============================================================
function prettyjson(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

// ============================================================
// Event types
// ============================================================
interface AllEvent {
  id: number;
  type: 'TxChanged' | 'StatusChanged' | 'AccountsChanged';
  timestamp: Date;
  data: unknown;
}

interface WindowMsg {
  id: number;
  type: string;
  origin: string;
  timestamp: Date;
  data: unknown;
}

let eventId = 0;
let msgId = 0;

// ============================================================
// Main App
// ============================================================
type TabId = 'accounts' | 'sign' | 'ledger-query' | 'ledger-submit' | 'events' | 'messages' | 'raw';

type SignMode = 'sdk' | 'raw';

interface SignedMessage {
  id: number;
  timestamp: Date;
  message: string;
  signature: string;
  mode: SignMode;
  publicKey?: string;
  rawResponse?: unknown;
}

type SignScheme = 'auto' | 'utf8' | 'ginkgo';

interface VerifyState {
  publicKey: string;
  result: 'valid' | 'invalid' | { error: string } | null;
  format?: KeyFormat;
  scheme?: SignScheme;
  matchedScheme?: 'utf8' | 'ginkgo';
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

async function preImageBytes(message: string, scheme: 'utf8' | 'ginkgo'): Promise<Uint8Array> {
  const msgBytes = new TextEncoder().encode(message);
  if (scheme === 'utf8') return msgBytes;
  // Ginkgo signMessage quirk:
  //   1. sha256(utf8(message))            -> 32 bytes
  //   2. hex-encode                        -> 64-char hex string
  //   3. base64Decode(that hex string)     -> 48 bytes (the bytes actually signed)
  // Reason: ginkgo passes a hex digest to core-signing-lib's signTransactionHash,
  // which in turn calls naclUtil.decodeBase64() on its input.
  const digest = await sha256(msgBytes);
  const hexHash = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  return base64ToBytes(hexHash);
}

let signId = 0;

// ============================================================
// Amulet balance query (active contracts via Ledger API)
// ============================================================
interface AmuletBalance {
  total: number;
  contractCount: number;
  amounts: string[];
  queriedAt: Date;
}

// JSON Ledger API's /v2/state/active-contracts response shape varies by Canton
// version: sometimes a JSON array, sometimes NDJSON, sometimes wrapped in an
// envelope object. Try each in turn so the consumer doesn't have to care.
function parseAcsEntries(response: string): unknown[] {
  const trimmed = response.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.acs)) return obj.acs;
      if (Array.isArray(obj.contracts)) return obj.contracts;
      if (Array.isArray(obj.contractEntries)) return obj.contractEntries;
      // Single-entry envelope → wrap so caller sees a uniform array.
      return [parsed];
    }
    return [];
  } catch {
    // Likely NDJSON. One JSON object per non-empty line.
    return trimmed
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((x): x is unknown => x !== null);
  }
}

// An ACS entry contains a CreatedEvent somewhere; the exact nesting depends on
// Canton version (JsActiveContract vs. bare createdEvent). Probe for both.
function extractAmuletInitialAmount(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const contractEntry = (e.contractEntry as Record<string, unknown> | undefined) ?? e;
  const active = (contractEntry?.JsActiveContract as Record<string, unknown> | undefined) ?? contractEntry;
  const created = (active?.createdEvent as Record<string, unknown> | undefined) ?? (e.createdEvent as Record<string, unknown> | undefined);
  if (!created) return null;
  const arg =
    (created.createArgument as Record<string, unknown> | undefined) ??
    (created.createArguments as Record<string, unknown> | undefined);
  if (!arg) return null;
  const amount = arg.amount as Record<string, unknown> | undefined;
  const init = amount?.initialAmount;
  if (init === undefined || init === null) return null;
  return String(init);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '').trim();
  if (clean.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(clean.substr(i * 2, 2), 16);
    if (Number.isNaN(b)) throw new Error(`invalid hex at offset ${i * 2}`);
    out[i] = b;
  }
  return out;
}

function base64ToBytes(s: string): Uint8Array {
  // Accept base64url (-, _) and missing padding; normalize before atob.
  let b64 = s.trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type KeyFormat = 'hex' | 'base64' | 'base64url';

function parseBytesAuto(input: string, label = 'input'): { bytes: Uint8Array; format: KeyFormat } {
  const clean = input.trim().replace(/\s+/g, '');
  if (!clean) throw new Error(`${label}: empty`);
  const looksLikeHex = /^(0x)?[0-9a-fA-F]+$/.test(clean);
  const isBase64url = /[-_]/.test(clean) && !/[+/]/.test(clean);
  const looksLikeBase64 = /[+/=]/.test(clean) || isBase64url || /^[A-Za-z0-9+/=_-]+$/.test(clean);
  // Prefer hex when unambiguous (only hex chars + even length).
  if (looksLikeHex && clean.replace(/^0x/i, '').length % 2 === 0) {
    return { bytes: hexToBytes(clean), format: 'hex' };
  }
  if (looksLikeBase64) {
    return { bytes: base64ToBytes(clean), format: isBase64url ? 'base64url' : 'base64' };
  }
  throw new Error(`${label}: does not look like hex or base64`);
}

function App() {
  const [activeTab, setActiveTab] = useState<TabId>('accounts');
  const [extensionDetected, setExtensionDetected] = useState<boolean | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  // SDK connection state
  const [statusEvent, setStatusEvent] = useState<sdk.dappAPI.StatusEvent>();
  const [accounts, setAccounts] = useState<sdk.dappAPI.Wallet[]>([]);
  const [ledgerApiVersion, setLedgerApiVersion] = useState<string>();
  const [loading, setLoading] = useState<string | null>(null);

  // Events & messages state
  const [events, setEvents] = useState<AllEvent[]>([]);
  const [windowMessages, setWindowMessages] = useState<WindowMsg[]>([]);

  // Ledger query/submit state
  const [queryResponses, setQueryResponses] = useState<Array<{ timestamp: Date; data: unknown }>>([]);
  const [balance, setBalance] = useState<AmuletBalance | null>(null);
  // Latest prepareExecute response, surfaced in the Ledger Submit tab so
  // the user can copy both ids and correlate with the wallet popup / backend.
  const [lastPrepareExecute, setLastPrepareExecute] = useState<{
    timestamp: Date;
    userUrl: string | undefined;
    transactionId: string | null;
    commandId: string | null;
  } | null>(null);
  const [transactions, setTransactions] = useState<sdk.dappAPI.TxChangedEvent[]>([]);

  // WalletConnect state
  const [wcUri, setWcUri] = useState<string | null>(null);
  const [wcQrDataUrl, setWcQrDataUrl] = useState<string | null>(null);
  const [wcCopied, setWcCopied] = useState(false);

  // Sign Message state
  const [signMessageInput, setSignMessageInput] = useState('Hello from Canton Test dApp!');
  const [signedMessages, setSignedMessages] = useState<SignedMessage[]>([]);
  const [signMode, setSignMode] = useState<SignMode>('sdk');
  const [verifyState, setVerifyState] = useState<Record<number, VerifyState>>({});

  const wcAdapter = useMemo(() => {
    if (!WC_PROJECT_ID) return null;
    return new CantonWcAdapter({
      projectId: WC_PROJECT_ID,
      proposedChains: WC_PROPOSED_CHAINS,
      metadata: {
        name: 'Canton Test dApp',
        description: 'CIP-0103 prototype with WalletConnect',
        url: window.location.origin,
        icons: [],
      },
      onUri: (uri) => setWcUri(uri),
    });
  }, []);

  const isConnected = statusEvent?.connection?.isConnected ?? false;
  const isNetworkConnected = statusEvent?.connection?.isNetworkConnected ?? false;
  const connectionReason = statusEvent?.connection?.reason ?? '';
  // "Locked" is a soft state: wallet still reachable but signing is gated until
  // the user unlocks. CIP-0103 doesn't fix the exact reason string, so match on
  // common variants emitted by Ginkgo / splice-wallet-kernel forks.
  const isLocked = !isConnected && /lock|expir|sess/i.test(connectionReason);
  // Captures the last-seen statusEvent so onStatus can compute a diff and only
  // log the fields that actually changed (network switches vs. lock vs. plain
  // refresh look identical otherwise).
  const prevStatusRef = useRef<sdk.dappAPI.StatusEvent | undefined>(undefined);
  const primaryParty = accounts.find((a) => a.primary)?.partyId;
  // Canonical source of the connected user's Ed25519 public key. Sourced from
  // `Wallet.publicKey` on listAccounts / accountsChanged, NOT from the
  // signMessage response — CIP-0103 mandates signMessage returns just
  // { signature }. Cleared on disconnect because `accounts` is set to [].
  const primaryPubKey = accounts.find((a) => a.primary)?.publicKey;

  const addLog = useCallback((type: LogEntry['type'], message: string) => {
    const id = ++logId;
    setLogs((prev) => [
      ...prev,
      { id, time: new Date().toLocaleTimeString(), type, message },
    ]);
  }, []);

  // Detect extension on mount
  useEffect(() => {
    addLog('info', 'Detecting Canton Wallet extension...');
    detectExtension().then((found) => {
      setExtensionDetected(found);
      addLog(found ? 'success' : 'error', found ? 'Extension detected (EXT_ACK)' : 'Extension not found');
    });
  }, [addLog]);

  // Initialize SDK on mount — register extension adapter + optional WalletConnect adapter, restore persisted session
  useEffect(() => {
    const adapters: ProviderAdapter[] = [new sdk.ExtensionAdapter()];
    if (wcAdapter) adapters.push(wcAdapter as unknown as ProviderAdapter);
    sdk.init({ additionalAdapters: adapters })
      .then(() => sdk.status())
      .then((s) => {
        setStatusEvent(s);
        prevStatusRef.current = s;
      })
      .catch(() => {});
  }, [wcAdapter]);

  // Subscribe to SDK events when connected
  useEffect(() => {
    if (!isConnected) return;

    const onStatus = (event: sdk.dappAPI.StatusEvent) => {
      // Snapshot the previous status BEFORE updating, so we can compute a diff.
      const prev = prevStatusRef.current;
      prevStatusRef.current = event;
      setStatusEvent(event);
      const eid = ++eventId;
      setEvents((evs) => [{ id: eid, type: 'StatusChanged', timestamp: new Date(), data: event }, ...evs]);

      const fmt = (v: unknown) => (v === undefined ? 'undefined' : String(v));
      const changes: string[] = [];
      if (prev?.connection.isConnected !== event.connection.isConnected) {
        changes.push(`isConnected ${fmt(prev?.connection.isConnected)} → ${fmt(event.connection.isConnected)}`);
      }
      if (prev?.connection.isNetworkConnected !== event.connection.isNetworkConnected) {
        changes.push(`isNetworkConnected ${fmt(prev?.connection.isNetworkConnected)} → ${fmt(event.connection.isNetworkConnected)}`);
      }
      if (prev?.network?.networkId !== event.network?.networkId) {
        changes.push(`networkId ${prev?.network?.networkId ?? 'none'} → ${event.network?.networkId ?? 'none'}`);
      }
      if (event.connection.reason && prev?.connection.reason !== event.connection.reason) {
        changes.push(`reason="${event.connection.reason}"`);
      }
      if (event.connection.networkReason && prev?.connection.networkReason !== event.connection.networkReason) {
        changes.push(`networkReason="${event.connection.networkReason}"`);
      }
      addLog('info', `[Event] statusChanged ${changes.length ? changes.join(', ') : '(no visible change)'}`);
    };

    const onAccounts = (event: sdk.dappAPI.AccountsChangedEvent) => {
      setAccounts(event);
      const eid = ++eventId;
      setEvents((prev) => [{ id: eid, type: 'AccountsChanged', timestamp: new Date(), data: event }, ...prev]);
      addLog('info', `[Event] accountsChanged → ${event.length} account(s)`);
    };

    const onTx = (event: sdk.dappAPI.TxChangedEvent) => {
      const eid = ++eventId;
      setTransactions((prev) => [event, ...prev]);
      setEvents((prev) => [{ id: eid, type: 'TxChanged', timestamp: new Date(), data: event }, ...prev]);
      addLog('info', `[Event] txChanged → ${prettyjson(event)}`);
    };

    sdk.onStatusChanged(onStatus);
    sdk.onAccountsChanged(onAccounts);
    sdk.onTxChanged(onTx);

    return () => {
      sdk.removeOnStatusChanged(onStatus);
      sdk.removeOnAccountsChanged(onAccounts);
      sdk.removeOnTxChanged(onTx);
    };
  }, [isConnected, addLog]);

  // Fetch accounts when connected
  useEffect(() => {
    if (isConnected) {
      sdk.listAccounts()
        .then((accs) => setAccounts(accs))
        .catch((err) => addLog('error', `listAccounts failed: ${formatErr(err)}`));
    }
  }, [isConnected, addLog]);

  // Fetch ledger API version when network-connected
  useEffect(() => {
    if (isNetworkConnected) {
      sdk.ledgerApi({ requestMethod: 'get', resource: '/v2/version' })
        .then((result) => {
          const version = JSON.parse(result.response).version;
          setLedgerApiVersion(version);
          addLog('success', `Ledger API version: ${version}`);
        })
        .catch(() => {});
    }
  }, [isNetworkConnected, addLog]);

  // Window message monitor
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const id = ++msgId;
      const type = event.data?.type || 'unknown';
      setWindowMessages((prev) => [
        { id, type, origin: event.origin, timestamp: new Date(), data: event.data },
        ...prev,
      ]);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Render QR code whenever a WalletConnect URI arrives
  useEffect(() => {
    if (!wcUri) {
      setWcQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(wcUri, { width: 256, margin: 2 })
      .then(setWcQrDataUrl)
      .catch((e) => addLog('error', `[WC] QR render failed: ${formatErr(e)}`));
  }, [wcUri, addLog]);

  // Auto-close QR modal when the session is established
  useEffect(() => {
    if (isConnected && wcUri) setWcUri(null);
  }, [isConnected, wcUri]);

  // -- Connection handlers --

  async function handleRawConnect() {
    setLoading('raw-connect');
    addLog('info', '[Raw RPC] Direct postMessage connect...');
    try {
      const result = await rpcRequest<{ isConnected: boolean; reason: string }>('connect');
      addLog('success', `[Raw RPC] connect → ${prettyjson(result)}`);
    } catch (e) {
      addLog('error', `[Raw RPC] connect failed: ${formatErr(e)}`);
    } finally {
      setLoading(null);
    }
  }

  async function handleConnect() {
    setLoading('connect');
    addLog('info', '[SDK] sdk.connect() — opening wallet picker...');
    try {
      const connectResult = await sdk.connect();
      addLog('success', `[SDK] connect → ${prettyjson(connectResult)}`);
      const s = await sdk.status();
      setStatusEvent(s);
    } catch (e) {
      addLog('error', `[SDK] connect failed: ${formatErr(e)}`);
    } finally {
      setLoading(null);
    }
  }

  async function handleConnectExtension() {
    setLoading('connect-ext');
    addLog('info', '[SDK] sdk.connect() — extension-only picker...');
    try {
      // Re-init with only extension adapters so the picker shows extension options only
      await sdk.init({ defaultAdapters: [new sdk.ExtensionAdapter()] });
      const connectResult = await sdk.connect();
      addLog('success', `[SDK] connect (extension) → ${prettyjson(connectResult)}`);
      const s = await sdk.status();
      setStatusEvent(s);
    } catch (e) {
      addLog('error', `[SDK] connect (extension) failed: ${formatErr(e)}`);
    } finally {
      setLoading(null);
    }
  }

  async function handleConnectWalletConnect() {
    if (!wcAdapter) {
      addLog('error', '[WC] Missing VITE_WALLETCONNECT_PROJECT_ID — set it in .env.local');
      return;
    }
    setLoading('connect-wc');
    addLog('info', '[SDK] sdk.connect() — WalletConnect (chain decided by wallet)...');
    try {
      await sdk.init({ defaultAdapters: [wcAdapter as unknown as ProviderAdapter] });
      const connectResult = await sdk.connect();
      addLog('success', `[SDK] connect (WalletConnect) → ${prettyjson(connectResult)}`);
      const s = await sdk.status();
      setStatusEvent(s);
    } catch (e) {
      addLog('error', `[SDK] connect (WalletConnect) failed: ${formatErr(e)}`);
    } finally {
      setWcUri(null);
      setLoading(null);
    }
  }

  async function handleCopyWcUri() {
    if (!wcUri) return;
    try {
      await navigator.clipboard.writeText(wcUri);
      setWcCopied(true);
      setTimeout(() => setWcCopied(false), 1500);
    } catch (e) {
      addLog('error', `[WC] Copy failed: ${formatErr(e)}`);
    }
  }

  async function handleDisconnect() {
    setLoading('disconnect');
    addLog('info', '[SDK] sdk.disconnect()...');
    try {
      await sdk.disconnect();
      addLog('success', '[SDK] disconnected');
      setStatusEvent(undefined);
      setAccounts([]);
      setLedgerApiVersion(undefined);
      setTransactions([]);
    } catch (e) {
      addLog('error', `[SDK] disconnect failed: ${formatErr(e)}`);
    } finally {
      setLoading(null);
    }
  }

  // CIP-0103 spec: result is `{ signature: string }`. Pre-spec Ginkgo builds
  // returned `{ signature, publicKey, fingerprint }`; older raw-RPC paths return
  // a bare string. We accept all three shapes but only read `signature` —
  // `publicKey` is sourced from listAccounts (see primaryPubKey).
  function extractSignatureFromResponse(raw: unknown): { signature: string } {
    if (typeof raw === 'string') return { signature: raw };
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      const signature = typeof obj.signature === 'string' ? obj.signature : '';
      if (!signature) throw new Error(`No signature in response: ${JSON.stringify(raw)}`);
      return { signature };
    }
    throw new Error(`Unexpected signMessage response: ${JSON.stringify(raw)}`);
  }

  async function handleSignMessage() {
    const message = signMessageInput;
    if (!message) {
      addLog('error', '[sign] message is empty');
      return;
    }
    setLoading('sign');
    const preview = message.length > 60 ? message.slice(0, 60) + '…' : message;
    const tag = signMode === 'sdk' ? '[SDK]' : '[Raw]';
    addLog('info', `${tag} signMessage("${preview}")...`);
    try {
      let raw: unknown;
      if (signMode === 'sdk') {
        const provider = sdk.getConnectedProvider();
        if (!provider) throw new Error('No connected provider — connect via Picker / Extension / WalletConnect first');
        raw = await provider.request({ method: 'signMessage', params: { message } });
      } else {
        if (!extensionDetected) throw new Error('Extension not detected — Raw RPC requires the extension');
        raw = await rpcRequest('signMessage', { message });
      }
      const { signature } = extractSignatureFromResponse(raw);
      const id = ++signId;
      // Per CIP-0103, the response is just { signature } — publicKey comes from
      // the cached primary account (sourced from listAccounts / accountsChanged).
      const cachedPubKey = primaryPubKey ?? '';
      setSignedMessages((prev) => [
        {
          id,
          timestamp: new Date(),
          message,
          signature,
          mode: signMode,
          publicKey: cachedPubKey || undefined,
          rawResponse: raw,
        },
        ...prev,
      ]);
      if (cachedPubKey) {
        setVerifyState((prev) => ({ ...prev, [id]: { publicKey: cachedPubKey, result: null } }));
      }
      addLog(
        'success',
        `${tag} signMessage → ${signature.slice(0, 32)}...` +
          (cachedPubKey ? ' (pubKey from listAccounts cache)' : ' (no cached primary pubKey)'),
      );
    } catch (e) {
      addLog('error', `signMessage failed: ${formatErr(e)}`);
    } finally {
      setLoading(null);
    }
  }

  async function handleCopySignature(sig: string) {
    try {
      await navigator.clipboard.writeText(sig);
      addLog('info', 'signature copied');
    } catch (e) {
      addLog('error', `Copy failed: ${formatErr(e)}`);
    }
  }

  function updateVerifyPubKey(id: number, publicKey: string) {
    setVerifyState((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), publicKey, result: null } }));
  }

  function updateVerifyScheme(id: number, scheme: SignScheme) {
    setVerifyState((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { publicKey: '', result: null }), scheme, result: null } }));
  }

  async function handleVerify(sm: SignedMessage) {
    const state = verifyState[sm.id] ?? { publicKey: sm.publicKey ?? '', result: null };
    const pubKeyInput = state.publicKey.trim();
    if (!pubKeyInput) {
      setVerifyState((prev) => ({ ...prev, [sm.id]: { ...state, result: { error: 'Public key required (hex or base64)' } } }));
      return;
    }
    try {
      const { ed25519 } = await import('@noble/curves/ed25519.js');
      const { bytes: sig, format: sigFormat } = parseBytesAuto(sm.signature, 'signature');
      const { bytes: pub, format } = parseBytesAuto(pubKeyInput, 'pubKey');
      if (sig.length !== 64) throw new Error(`Signature is ${sig.length} bytes (${sigFormat}), expected 64 (Ed25519)`);
      if (pub.length !== 32) throw new Error(`Public key is ${pub.length} bytes (${format}), expected 32 (Ed25519)`);

      const chosen: SignScheme = state.scheme ?? 'auto';
      const schemesToTry: Array<'utf8' | 'ginkgo'> = chosen === 'auto' ? ['utf8', 'ginkgo'] : [chosen];
      let matched: 'utf8' | 'ginkgo' | null = null;
      for (const s of schemesToTry) {
        const preImage = await preImageBytes(sm.message, s);
        if (ed25519.verify(sig, preImage, pub)) {
          matched = s;
          break;
        }
      }
      const ok = matched !== null;
      setVerifyState((prev) => ({
        ...prev,
        [sm.id]: {
          publicKey: pubKeyInput,
          result: ok ? 'valid' : 'invalid',
          format,
          scheme: chosen,
          matchedScheme: matched ?? undefined,
        },
      }));
      addLog(
        ok ? 'success' : 'error',
        `[verify] #${sm.id} (sig=${sigFormat}, pubKey=${format}, scheme=${matched ?? `none/${schemesToTry.join('|')}`}) → ${ok ? 'valid' : 'invalid'}`,
      );
    } catch (e) {
      const error = formatErr(e);
      setVerifyState((prev) => ({ ...prev, [sm.id]: { publicKey: pubKeyInput, result: { error } } }));
      addLog('error', `[verify] #${sm.id} failed: ${error}`);
    }
  }

  async function handleRefreshStatus() {
    addLog('info', '[SDK] sdk.status()...');
    try {
      const result = await sdk.status();
      setStatusEvent(result);
      addLog('success', `[SDK] status → ${prettyjson(result)}`);
    } catch (e) {
      addLog('error', `[SDK] status failed: ${formatErr(e)}`);
    }
  }

  // -- Ledger handlers --

  async function handleQueryPackageVersion() {
    if (!primaryParty) return;
    setLoading('query');
    addLog('info', '[Ledger] Querying preferred package version...');
    try {
      const packageName = ledgerApiVersion?.startsWith('3.3.')
        ? 'AdminWorkflows'
        : 'canton-builtin-admin-workflow-ping';
      const qs = new URLSearchParams([
        ['package-name', packageName],
        ['parties', primaryParty],
      ]).toString();
      const result = await sdk.ledgerApi({
        requestMethod: 'get',
        resource: `/v2/interactive-submission/preferred-package-version?${qs}`,
      });
      const data = JSON.parse(result.response);
      setQueryResponses((prev) => [{ timestamp: new Date(), data }, ...prev]);
      addLog('success', `[Ledger] Query result: ${prettyjson(data)}`);
    } catch (e) {
      addLog('error', `[Ledger] Query failed: ${formatErr(e)}`);
    } finally {
      setLoading(null);
    }
  }

  // Read-path helper that works for both extension wallets (proxy through
  // canton_ledgerApi) and WalletConnect mobile wallets (call the Canton Ledger
  // API directly with the URL + Bearer token the wallet hands back via
  // canton_status / canton_getActiveNetwork).
  //
  // Try the proxy first — it's the spec-default and is what Ginkgo/extensions
  // expect. If the wallet returns 4100 "Access denied for ledger resource"
  // (common for /v2/state/* paths on restricted WC mobile wallets), fall back
  // to a direct HTTP fetch using statusEvent.network.{ledgerApi, accessToken}.
  async function callLedgerApi(
    method: 'get' | 'post',
    resource: string,
    bodyParam?: unknown,
  ): Promise<{ response: string }> {
    try {
      const r = (await sdk.ledgerApi({
        requestMethod: method,
        resource,
        // sdk types narrow body to a specific shape; relax for arbitrary JSON.
        body: bodyParam as never,
      })) as Record<string, unknown>;
      const response =
        typeof r?.response === 'string' ? (r.response as string) : JSON.stringify(r);
      return { response };
    } catch (e) {
      const msg = formatErr(e);
      const isAccessDenied = /\b4100\b|access denied|denied for ledger resource/i.test(msg);
      if (!isAccessDenied) throw e;

      const ledgerUrl = statusEvent?.network?.ledgerApi;
      const token = statusEvent?.network?.accessToken;
      if (!ledgerUrl) {
        throw new Error(
          `Wallet denied ${resource} via canton_ledgerApi AND did not expose statusEvent.network.ledgerApi for a direct-HTTP fallback`,
        );
      }
      addLog(
        'info',
        `[Ledger] Proxy denied ${resource} (${msg}); falling back to direct HTTP at ${ledgerUrl}`,
      );

      const url = `${ledgerUrl.replace(/\/$/, '')}${resource.startsWith('/') ? resource : '/' + resource}`;
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (method === 'post') headers['Content-Type'] = 'application/json';
      let res: Response;
      try {
        res = await fetch(url, {
          method: method.toUpperCase(),
          headers,
          body: method === 'post' && bodyParam !== undefined ? JSON.stringify(bodyParam) : undefined,
        });
      } catch (fetchErr) {
        // Bare fetch failure is almost always CORS on the ledger gateway.
        throw new Error(
          `Direct HTTP to ${url} failed (likely CORS — the ledger gateway must allow origin ${window.location.origin}): ${formatErr(fetchErr)}`,
        );
      }
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Direct HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
      }
      return { response: text };
    }
  }

  // Candidate wallet-side methods to probe for direct balance reads on
  // WC mobile wallets. These aren't in the CIP-0103 standard, but specific
  // wallet implementations (Splice-CN-style backends) may expose one of them.
  // We probe each via signClient.request and use whichever doesn't throw.
  const WC_BALANCE_PROBE_METHODS = [
    'canton_getBalance',
    'canton_getAmuletBalance',
    'canton_getWalletBalance',
    'canton_listAmulets',
    'canton_listHoldings',
    'splice_getBalance',
    'splice_listHoldings',
  ];

  // Walk a heterogeneous wallet response looking for the first plausible
  // balance-like number. Handles:
  //   - { balance: "123.45" } or { balance: 123.45 }
  //   - { total: ... }, { amount: ... }, { totalAmount: ... }
  //   - { balances: [{ amount, instrumentId: {id: "Amulet"} }, ...] }
  //   - { amulets: [{ amount: { initialAmount } }, ...] }
  //   - { holdings: [{ amount: ... }, ...] }
  // Returns { total, contractCount?, amounts[] } or null if nothing matches.
  function extractBalanceFromWalletResponse(result: unknown): {
    total: number;
    amounts: string[];
  } | null {
    if (result === null || result === undefined) return null;
    if (typeof result === 'string') {
      const n = Number(result);
      return Number.isFinite(n) ? { total: n, amounts: [result] } : null;
    }
    if (typeof result === 'number') return { total: result, amounts: [String(result)] };
    if (typeof result !== 'object') return null;
    const obj = result as Record<string, unknown>;

    // Direct scalar fields.
    for (const k of ['balance', 'total', 'amount', 'totalAmount', 'totalBalance', 'walletBalance']) {
      const v = obj[k];
      if (typeof v === 'string' || typeof v === 'number') {
        const n = Number(v);
        if (Number.isFinite(n)) return { total: n, amounts: [String(v)] };
      }
    }

    // Array-shaped (amulets / holdings / balances).
    for (const k of ['amulets', 'holdings', 'balances', 'contracts', 'data']) {
      const v = obj[k];
      if (!Array.isArray(v)) continue;
      const amounts: string[] = [];
      let total = 0;
      for (const item of v) {
        if (item === null || typeof item !== 'object') continue;
        const it = item as Record<string, unknown>;
        // Try common amount locations.
        const rawAmt =
          (it.amount && typeof it.amount === 'object'
            ? ((it.amount as Record<string, unknown>).initialAmount ?? (it.amount as Record<string, unknown>).amount)
            : it.amount) ??
          it.balance ??
          it.total ??
          it.value;
        if (rawAmt === undefined || rawAmt === null) continue;
        const s = String(rawAmt);
        amounts.push(s);
        const n = Number(s);
        if (Number.isFinite(n)) total += n;
      }
      if (amounts.length > 0) return { total, amounts };
    }

    return null;
  }

  // Splice Scan API balance flow (public, no wallet involvement).
  // Two GETs against `<scanUrl>/v0/...`:
  //   1. /v0/closed-rounds  → array of recent closed mining rounds (latest is what
  //                            we need; the deprecated /v0/wallet-balance is
  //                            "balance as of end of round N")
  //   2. /v0/wallet-balance?party_id=...&asOfEndOfRound=N
  //
  // Defensive about response shapes — closed-rounds might be a JSON array,
  // an object with `closed_rounds`, or wrapped in ContractWithState envelopes.
  async function queryBalanceViaScan(scanUrl: string, partyId: string): Promise<AmuletBalance & { asOfEndOfRound: number }> {
    const fetchJson = async (url: string): Promise<unknown> => {
      let res: Response;
      try {
        res = await fetch(url);
      } catch (e) {
        throw new Error(
          `Scan API fetch failed (likely CORS — origin ${window.location.origin} must be allowed by ${new URL(scanUrl).origin}): ${
            formatErr(e)
          }`,
        );
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${text.slice(0, 200)}`);
      try { return JSON.parse(text); } catch { return text; }
    };

    addLog('info', `[Balance] Scan: GET ${scanUrl}/v0/closed-rounds`);
    const roundsResp = await fetchJson(`${scanUrl}/v0/closed-rounds`);
    const roundsArr =
      Array.isArray(roundsResp)
        ? roundsResp
        : (roundsResp as Record<string, unknown> | null)?.closed_rounds ??
          (roundsResp as Record<string, unknown> | null)?.rounds ??
          [];
    if (!Array.isArray(roundsArr) || roundsArr.length === 0) {
      throw new Error(`No closed rounds in response: ${JSON.stringify(roundsResp).slice(0, 200)}`);
    }
    // Pick the highest round number. Each entry might be a ContractWithState
    // ({contract:{payload:{round:{number:"42"}}}}) or a flatter shape — probe.
    const extractRoundNumber = (entry: unknown): number | null => {
      if (entry === null || entry === undefined) return null;
      if (typeof entry === 'number') return entry;
      if (typeof entry === 'string') { const n = Number(entry); return Number.isFinite(n) ? n : null; }
      if (typeof entry !== 'object') return null;
      const e = entry as Record<string, unknown>;
      const payload =
        ((e.contract as Record<string, unknown> | undefined)?.payload as Record<string, unknown> | undefined) ??
        (e.payload as Record<string, unknown> | undefined) ??
        e;
      const round =
        (payload?.round as Record<string, unknown> | undefined) ??
        (payload as Record<string, unknown> | undefined);
      const num = round?.number ?? round?.round ?? payload?.round_number;
      if (num === undefined || num === null) return null;
      const n = Number(num);
      return Number.isFinite(n) ? n : null;
    };
    const roundNumbers = roundsArr.map(extractRoundNumber).filter((n): n is number => n !== null);
    if (roundNumbers.length === 0) {
      throw new Error(`Could not extract round numbers from: ${JSON.stringify(roundsArr).slice(0, 300)}`);
    }
    const asOfEndOfRound = Math.max(...roundNumbers);
    addLog('info', `[Balance] Latest closed round: ${asOfEndOfRound}`);

    const balanceUrl = `${scanUrl}/v0/wallet-balance?party_id=${encodeURIComponent(partyId)}&asOfEndOfRound=${asOfEndOfRound}`;
    addLog('info', `[Balance] Scan: GET ${balanceUrl}`);
    const balanceResp = await fetchJson(balanceUrl) as Record<string, unknown>;
    const raw = balanceResp?.wallet_balance;
    if (raw === undefined || raw === null) {
      throw new Error(`No wallet_balance in response: ${JSON.stringify(balanceResp).slice(0, 200)}`);
    }
    const amountStr = String(raw);
    const total = Number(amountStr);
    if (!Number.isFinite(total)) throw new Error(`Invalid wallet_balance value: ${amountStr}`);

    return {
      total,
      contractCount: 1,
      amounts: [amountStr],
      queriedAt: new Date(),
      asOfEndOfRound,
    };
  }

  async function handleQueryBalance() {
    if (!primaryParty) {
      addLog('error', '[Balance] No primary party — wait for accounts to load');
      return;
    }
    setLoading('balance');
    const providerType = statusEvent?.provider?.providerType;
    addLog('info', `[Balance] Querying for ${primaryParty} (provider: ${providerType ?? 'unknown'})...`);

    // Path A: WC mobile wallets — probe custom wallet methods. The standard
    // canton_ledgerApi is denied with 4100 for /v2/state/* on most WC wallets,
    // and there's no spec method for balance, so we try wallet-specific
    // extensions and surface every attempt in the log.
    if (providerType === 'mobile' && wcAdapter) {
      try {
        let hit: { method: string; result: unknown } | null = null;
        for (const method of WC_BALANCE_PROBE_METHODS) {
          try {
            addLog('info', `[Balance] Probe → ${method}({partyId})`);
            const result = await wcAdapter.rawRequest(method, { partyId: primaryParty });
            addLog(
              'success',
              `[Balance] ${method} OK → ${JSON.stringify(result).slice(0, 200)}`,
            );
            hit = { method, result };
            break;
          } catch (e) {
            const msg = formatErr(e);
            addLog('info', `[Balance] ${method} → ${msg.slice(0, 120)}`);
          }
        }
        if (!hit) {
          // Wallet method probe exhausted — try public Splice Scan API instead.
          const networkId = statusEvent?.network?.networkId;
          const scanUrl = getConfiguredScanUrl(networkId);
          if (!scanUrl) {
            addLog(
              'error',
              `[Balance] No probed method succeeded and no Scan API URL for network "${networkId ?? 'unknown'}". Set VITE_SCAN_API_URL in .env.local to enable the Scan fallback.`,
            );
            return;
          }
          addLog('info', `[Balance] Wallet has no balance method; falling back to Splice Scan API at ${scanUrl}`);
          try {
            const scanned = await queryBalanceViaScan(scanUrl, primaryParty);
            setBalance(scanned);
            addLog(
              'success',
              `[Balance] via Scan API (asOfEndOfRound=${scanned.asOfEndOfRound}): total = ${scanned.total}`,
            );
          } catch (scanErr) {
            addLog('error', `[Balance] Scan API failed: ${formatErr(scanErr)}`);
          }
          return;
        }
        const parsed = extractBalanceFromWalletResponse(hit.result);
        if (!parsed) {
          addLog(
            'error',
            `[Balance] ${hit.method} returned but I couldn't find a balance field in the response: ${JSON.stringify(
              hit.result,
            ).slice(0, 300)}`,
          );
          return;
        }
        setBalance({
          total: parsed.total,
          contractCount: parsed.amounts.length,
          amounts: parsed.amounts,
          queriedAt: new Date(),
        });
        addLog(
          'success',
          `[Balance] via ${hit.method}: ${parsed.amounts.length} entry(ies); total = ${parsed.total}`,
        );
      } finally {
        setLoading(null);
      }
      return;
    }

    // Path B: extensions / remote gateways — keep the existing canton_ledgerApi
    // + /v2/state/active-contracts flow. Falls through to the helper below.
    addLog('info', `[Balance] Using canton_ledgerApi proxy (extension/remote path)`);

    // sdk.ledgerApi() returns LedgerApiResult = { [k: string]: any }. Convention
    // is { response: "<json-string>" }, but different gateways may return the
    // body already parsed, or attach it under a different field. Normalize.
    const body = (r: unknown): unknown => {
      if (!r || typeof r !== 'object') return r;
      const o = r as Record<string, unknown>;
      if (typeof o.response === 'string') {
        try { return JSON.parse(o.response); } catch { return o.response; }
      }
      return o.response ?? o;
    };

    // The gateway may return offset as a number, a string, or wrapped in
    // { absolute }. Try each shape; reject objects we can't unwrap.
    const extractOffset = (data: unknown): number | string | undefined => {
      if (data === null || data === undefined) return undefined;
      if (typeof data === 'number' || typeof data === 'string') return data;
      if (typeof data === 'object') {
        const o = data as Record<string, unknown>;
        if (typeof o.offset === 'number' || typeof o.offset === 'string') return o.offset;
        if (o.offset && typeof o.offset === 'object') {
          const inner = o.offset as Record<string, unknown>;
          if (typeof inner.absolute === 'number' || typeof inner.absolute === 'string') return inner.absolute;
        }
      }
      return undefined;
    };

    // Step 1: best-effort fetch of the ledger end. Failure here does NOT block
    // the ACS query — we just call it without `activeAtOffset` and let the
    // gateway/Canton resolve "now" itself.
    let activeAtOffset: number | string | undefined = undefined;
    try {
      addLog('info', '[Balance] GET /v2/state/ledger-end');
      const endResp = await callLedgerApi('get', '/v2/state/ledger-end');
      const endData = body(endResp);
      addLog('info', `[Balance] ledger-end → ${JSON.stringify(endData).slice(0, 200)}`);
      activeAtOffset = extractOffset(endData);
      if (activeAtOffset === undefined) {
        addLog('info', '[Balance] no extractable offset; will POST active-contracts without one');
      }
    } catch (e) {
      addLog('info', `[Balance] ledger-end unavailable (${formatErr(e)}); continuing without offset`);
    }

    // Step 2: query active contracts. ALWAYS attempted, regardless of step 1.
    try {
      const acsBody: Record<string, unknown> = {
        filter: {
          filtersByParty: {
            [primaryParty]: {
              cumulative: [
                {
                  identifierFilter: {
                    TemplateFilter: {
                      value: {
                        templateId: '#splice-amulet:Splice.Amulet:Amulet',
                        includeCreatedEventBlob: false,
                      },
                    },
                  },
                },
              ],
            },
          },
        },
        verbose: false,
      };
      if (activeAtOffset !== undefined) acsBody.activeAtOffset = activeAtOffset;

      addLog(
        'info',
        `[Balance] POST /v2/state/active-contracts ${
          activeAtOffset === undefined ? '(no activeAtOffset)' : `(activeAtOffset=${activeAtOffset})`
        }`,
      );
      const acsResp = await callLedgerApi('post', '/v2/state/active-contracts', acsBody);
      const rawResponse =
        typeof (acsResp as Record<string, unknown>)?.response === 'string'
          ? ((acsResp as Record<string, unknown>).response as string)
          : JSON.stringify(body(acsResp) ?? acsResp);
      addLog('info', `[Balance] active-contracts ← ${rawResponse.slice(0, 200)}${rawResponse.length > 200 ? '…' : ''}`);

      const entries = parseAcsEntries(rawResponse);
      const amounts: string[] = [];
      let total = 0;
      for (const entry of entries) {
        const amt = extractAmuletInitialAmount(entry);
        if (amt === null) continue;
        amounts.push(amt);
        const n = Number(amt);
        if (!Number.isNaN(n)) total += n;
      }

      setBalance({ total, contractCount: amounts.length, amounts, queriedAt: new Date() });
      addLog(
        'success',
        `[Balance] parsed ${entries.length} entry(ies), ${amounts.length} with amount; total = ${total}`,
      );
    } catch (e) {
      addLog('error', `[Balance] active-contracts failed: ${formatErr(e)}`);
    } finally {
      setLoading(null);
    }
  }

  async function handleCreatePing() {
    if (!primaryParty) return;
    setLoading('submit');
    addLog('info', `[Ledger] Creating Ping contract (party: ${primaryParty})...`);
    try {
      const result = (await sdk.prepareExecute({
        actAs: [primaryParty],
        ...createPingCommand(ledgerApiVersion, primaryParty),
      })) as { userUrl?: string } | null | undefined;
      const userUrl = result?.userUrl;
      const ids = parseUserUrlIds(userUrl);
      setLastPrepareExecute({ timestamp: new Date(), userUrl, ...ids });
      addLog(
        'success',
        `[Ledger] prepareExecute completed — transactionId=${ids.transactionId ?? 'n/a'}, commandId=${ids.commandId ?? 'n/a'}`,
      );
      if (userUrl) addLog('info', `[Ledger] approval URL: ${userUrl}`);
    } catch (e) {
      addLog('error', `[Ledger] prepareExecute failed: ${formatErr(e)}`);
    } finally {
      setLoading(null);
    }
  }

  async function handleHybridPing() {
    if (!primaryParty) return;
    setLoading('hybrid');
    try {
      // Step 1: Prepare via Gateway's ledgerApi proxy
      addLog('info', '[Hybrid] Preparing transaction...');
      const prepareBody = {
        commands: createPingCommand(ledgerApiVersion, primaryParty).commands,
        commandId: `ping-${Date.now()}`,
        userId: statusEvent?.session?.userId,
        actAs: [primaryParty],
        readAs: [],
        synchronizerId: '',
        verboseHashing: false,
        packageIdSelectionPreference: [],
      };

      const prepareResult = await sdk.ledgerApi({
        requestMethod: 'post',
        resource: '/v2/interactive-submission/prepare',
        body: prepareBody,
      });
      const { preparedTransactionHash, preparedTransaction } = JSON.parse(
        prepareResult.response,
      );
      addLog('success', `[Hybrid] Prepared → hash: ${preparedTransactionHash.substring(0, 24)}...`);

      // Step 2: Sign via extension (postMessage)
      addLog('info', '[Hybrid] Signing via extension...');
      const { signature, fingerprint } = await rpcRequest<{
        signature: string;
        publicKey: string;
        fingerprint: string;
      }>('signTransaction', { transactionHash: preparedTransactionHash });
      addLog('success', `[Hybrid] Signed → fingerprint: ${fingerprint.substring(0, 16)}...`);

      // Step 3: Execute via Gateway's ledgerApi proxy
      addLog('info', '[Hybrid] Executing transaction...');
      const executeBody = {
        userId: statusEvent?.session?.userId,
        preparedTransaction,
        hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2',
        submissionId: `ping-${Date.now()}`,
        deduplicationPeriod: { Empty: {} },
        partySignatures: {
          signatures: [
            {
              party: primaryParty,
              signatures: [
                {
                  signature,
                  signedBy: fingerprint,
                  format: 'SIGNATURE_FORMAT_CONCAT',
                  signingAlgorithmSpec: 'SIGNING_ALGORITHM_SPEC_ED25519',
                },
              ],
            },
          ],
        },
      };

      const executeResult = await sdk.ledgerApi({
        requestMethod: 'post',
        resource: '/v2/interactive-submission/execute',
        body: executeBody,
      });
      addLog('success', `[Hybrid] Transaction executed → ${executeResult.response}`);
    } catch (e) {
      addLog('error', `[Hybrid] Failed: ${formatErr(e)}`);
    } finally {
      setLoading(null);
    }
  }

  // -- Render --

  const tabs: { id: TabId; label: string }[] = [
    { id: 'accounts', label: 'Accounts' },
    { id: 'sign', label: 'Sign Message' },
    { id: 'ledger-query', label: 'Ledger Query' },
    { id: 'ledger-submit', label: 'Ledger Submit' },
    { id: 'events', label: `Events (${events.length})` },
    { id: 'messages', label: `Messages (${windowMessages.length})` },
    { id: 'raw', label: 'Raw RPC' },
  ];

  return (
    <div className="app">
      <h1>Canton Test dApp</h1>
      <p className="subtitle">CIP-0103 Prototype — Wallet connection, ledger query, and transaction signing</p>

      {/* Extension Detection */}
      <section className="card">
        <h2>Extension Detection</h2>
        <div className="status-row">
          <span className={`status-dot ${extensionDetected === true ? 'green' : extensionDetected === false ? 'red' : 'yellow'}`} />
          <span>
            {extensionDetected === null
              ? 'Detecting...'
              : extensionDetected
                ? 'Canton Wallet extension detected'
                : 'Extension not found'}
          </span>
        </div>
      </section>

      {/* Connection + Status */}
      <section className="card">
        <h2>Connection</h2>
        <div className="status-row">
          <span className={`status-dot ${isConnected ? 'green' : isLocked ? 'yellow' : 'red'}`} />
          <span>
            {isConnected
              ? `Connected (${statusEvent?.provider?.providerType ?? 'unknown'})`
              : isLocked
                ? `Locked${connectionReason ? `: ${connectionReason}` : ''}`
                : `Disconnected${connectionReason ? `: ${connectionReason}` : ''}`}
          </span>
        </div>
        <div className="button-row">
          <button onClick={handleConnect} disabled={!!loading}>
            {loading === 'connect' ? 'Connecting...' : 'Connect (Picker)'}
          </button>
          <button onClick={handleConnectExtension} disabled={!!loading || !extensionDetected}>
            {loading === 'connect-ext' ? 'Connecting...' : 'Connect Extension'}
          </button>
          <button
            onClick={handleConnectWalletConnect}
            disabled={!!loading || !wcAdapter}
            title={!wcAdapter ? 'Set VITE_WALLETCONNECT_PROJECT_ID in .env.local' : ''}
          >
            {loading === 'connect-wc' ? 'Connecting...' : 'Connect WalletConnect'}
          </button>
          <button onClick={handleRawConnect} disabled={!!loading || !extensionDetected}>
            {loading === 'raw-connect' ? 'Connecting...' : 'Connect (Raw RPC)'}
          </button>
          <button onClick={handleDisconnect} disabled={!!loading || !isConnected}>
            {loading === 'disconnect' ? '...' : 'Disconnect'}
          </button>
          <button onClick={handleRefreshStatus} disabled={!!loading}>
            Refresh Status
          </button>
        </div>
        <div className="hint">
          <div><b>Connect (Picker)</b> — Opens the SDK wallet picker with all available wallets.</div>
          <div><b>Connect Extension</b> — Opens the SDK wallet picker with extension-only options.</div>
          <div><b>Connect WalletConnect</b> — CIP-0103 over WalletConnect v2. Wallet picks the network. Scan the QR with a Canton mobile wallet.</div>
          <div><b>Connect (Raw RPC)</b> — Direct CIP-0103 JSON-RPC via postMessage (extension only, bypasses SDK).</div>
        </div>

        {statusEvent && (
          <div className="status-detail">
            <div className="status-grid">
              {statusEvent.provider && (
                <>
                  <div><b>Provider:</b> <i>{statusEvent.provider.id} ({statusEvent.provider.providerType ?? 'unknown'})</i></div>
                  {statusEvent.provider.url && (
                    <div><b>Provider URL:</b> <i>{statusEvent.provider.url}</i></div>
                  )}
                </>
              )}
              {statusEvent.network && (
                <>
                  <div><b>Network:</b> <i>{statusEvent.network.networkId}</i></div>
                  {statusEvent.network.ledgerApi && (
                    <div><b>Ledger API:</b> <i>{statusEvent.network.ledgerApi}</i></div>
                  )}
                </>
              )}
              {statusEvent.session && (
                <div><b>Session:</b> <i>{statusEvent.session.userId || 'authenticated'}</i></div>
              )}
              {ledgerApiVersion && (
                <div><b>Ledger Version:</b> <i>{ledgerApiVersion}</i></div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Tab Switcher */}
      <div className="tab-bar">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'accounts' && (
        <AccountsTab
          accounts={accounts}
          primaryParty={primaryParty}
          balance={balance}
          balanceLoading={loading === 'balance'}
          onQueryBalance={handleQueryBalance}
          onCopy={async (value, label) => {
            try {
              await navigator.clipboard.writeText(value);
              addLog('info', `[accounts] ${label} copied`);
            } catch (e) {
              addLog('error', `Copy failed: ${formatErr(e)}`);
            }
          }}
        />
      )}

      {activeTab === 'sign' && (
        <section className="card">
          <h2>Sign Message</h2>
          {!isConnected ? (
            <p className="hint">Connect to a wallet to sign messages.</p>
          ) : (
            <>
              <div className="sign-mode-row">
                <span className="sign-mode-label">Mode:</span>
                <label className={`sign-mode-opt ${signMode === 'sdk' ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="signMode"
                    value="sdk"
                    checked={signMode === 'sdk'}
                    onChange={() => setSignMode('sdk')}
                    disabled={!!loading}
                  />
                  <span>SDK</span>
                  <span className="sign-mode-hint">via <code>provider.request</code> — works with Extension and WalletConnect</span>
                </label>
                <label
                  className={`sign-mode-opt ${signMode === 'raw' ? 'active' : ''} ${!extensionDetected ? 'disabled' : ''}`}
                  title={!extensionDetected ? 'Raw RPC requires the browser extension' : ''}
                >
                  <input
                    type="radio"
                    name="signMode"
                    value="raw"
                    checked={signMode === 'raw'}
                    onChange={() => setSignMode('raw')}
                    disabled={!!loading || !extensionDetected}
                  />
                  <span>Raw RPC</span>
                  <span className="sign-mode-hint">direct postMessage — extension only</span>
                </label>
              </div>
              <textarea
                className="sign-input"
                rows={3}
                value={signMessageInput}
                onChange={(e) => setSignMessageInput(e.target.value)}
                placeholder="Message to sign…"
                disabled={!!loading}
              />
              <div className="button-row">
                <button onClick={handleSignMessage} disabled={!!loading || !signMessageInput || (signMode === 'raw' && !extensionDetected)}>
                  {loading === 'sign' ? 'Signing…' : `Sign (${signMode === 'sdk' ? 'SDK' : 'Raw'})`}
                </button>
                <button
                  onClick={() => { setSignedMessages([]); setVerifyState({}); }}
                  disabled={!!loading || signedMessages.length === 0}
                >
                  Clear
                </button>
              </div>
              {signedMessages.length > 0 && (
                <div className="terminal-display">
                  <p className="terminal-count">Signatures: {signedMessages.length}</p>
                  {signedMessages.map((s) => {
                    const vs = verifyState[s.id] ?? { publicKey: s.publicKey ?? '', result: null };
                    return (
                      <div key={s.id} className="terminal-item">
                        <div className="terminal-label">
                          #{s.id} <span className="sign-mode-badge">{s.mode.toUpperCase()}</span> ({s.timestamp.toLocaleTimeString()})
                        </div>
                        <div className="sign-row">
                          <span className="sign-row-label">message:</span>
                          <code className="sign-row-value">{s.message}</code>
                        </div>
                        <div className="sign-row">
                          <span className="sign-row-label">signature:</span>
                          <code className="sign-row-value wrap">{s.signature}</code>
                          <button className="sign-copy" onClick={() => handleCopySignature(s.signature)}>Copy</button>
                        </div>
                        {s.publicKey && (
                          <div className="sign-row">
                            <span className="sign-row-label">pubKey (cached):</span>
                            <code className="sign-row-value wrap">{s.publicKey}</code>
                          </div>
                        )}
                        <div className="verify-block">
                          <div className="sign-row">
                            <span className="sign-row-label">verify pubKey:</span>
                            <input
                              className="verify-input"
                              type="text"
                              value={vs.publicKey}
                              onChange={(e) => updateVerifyPubKey(s.id, e.target.value)}
                              placeholder="Ed25519 public key — hex (64 chars) or base64 (~44 chars)"
                            />
                            <select
                              className="verify-scheme"
                              value={vs.scheme ?? 'auto'}
                              onChange={(e) => updateVerifyScheme(s.id, e.target.value as SignScheme)}
                              title="Pre-image scheme: which bytes the wallet actually signed"
                            >
                              <option value="auto">scheme: auto</option>
                              <option value="utf8">utf-8 (spec)</option>
                              <option value="ginkgo">ginkgo quirk</option>
                            </select>
                            <button className="sign-copy" onClick={() => handleVerify(s)}>Verify</button>
                          </div>
                          {vs.result === 'valid' && (
                            <div className="verify-result verify-valid">
                              ✓ Signature valid (Ed25519, pubKey={vs.format}, scheme={vs.matchedScheme})
                              {vs.matchedScheme === 'ginkgo' && (
                                <span className="verify-note"> — bytes signed = base64Decode(hex(sha256(utf8(msg))))</span>
                              )}
                            </div>
                          )}
                          {vs.result === 'invalid' && (
                            <div className="verify-result verify-invalid">
                              ✗ Signature does not match (pubKey={vs.format}, tried {vs.scheme === 'auto' ? 'utf-8 + ginkgo' : vs.scheme})
                            </div>
                          )}
                          {vs.result && typeof vs.result === 'object' && 'error' in vs.result && (
                            <div className="verify-result verify-error">⚠ {vs.result.error}</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {activeTab === 'ledger-query' && (
        <section className="card">
          <h2>Ledger Query</h2>
          {!isConnected ? (
            <p className="hint">Connect to a wallet to query the ledger.</p>
          ) : (
            <>
              <div className="button-row">
                <button onClick={handleQueryPackageVersion} disabled={!!loading || !primaryParty}>
                  {loading === 'query' ? 'Querying...' : 'Query Preferred Package Version'}
                </button>
              </div>
              <p className="hint">
                Calls sdk.ledgerApi() to GET /v2/interactive-submission/preferred-package-version
              </p>
              {queryResponses.length > 0 && (
                <div className="terminal-display">
                  <p className="terminal-count">Total queries: {queryResponses.length}</p>
                  {queryResponses.map((item, i) => (
                    <div key={i} className="terminal-item">
                      <div className="terminal-label">
                        Query #{queryResponses.length - i} ({item.timestamp.toLocaleTimeString()})
                      </div>
                      <pre>{prettyjson(item.data)}</pre>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {activeTab === 'ledger-submit' && (
        <section className="card">
          <h2>Ledger Submission</h2>
          {!isConnected ? (
            <p className="hint">Connect to a wallet to submit transactions.</p>
          ) : (
            <>
              <div className="button-row">
                <button onClick={handleCreatePing} disabled={!!loading || !primaryParty}>
                  {loading === 'submit' ? 'Submitting...' : 'Create Ping Contract'}
                </button>
                <button
                  onClick={handleHybridPing}
                  disabled={!!loading || !primaryParty || !extensionDetected}
                  title={!extensionDetected ? 'Requires both Gateway (Discovery) and extension' : ''}
                >
                  {loading === 'hybrid' ? 'Hybrid Signing...' : 'Hybrid Ping'}
                </button>
              </div>
              <p className="hint">
                "Create Ping" uses sdk.prepareExecute(). "Hybrid Ping" prepares via ledgerApi, signs via extension (postMessage), executes via ledgerApi.
              </p>
              {lastPrepareExecute && (
                <div className="balance-result">
                  <div className="account-row account-row-meta">
                    <span className="account-label">prepared at:</span>
                    <span className="account-value">{lastPrepareExecute.timestamp.toLocaleTimeString()}</span>
                  </div>
                  <div className="account-row">
                    <span className="account-label">transactionId:</span>
                    <code className="account-value wrap">{lastPrepareExecute.transactionId ?? '(not in userUrl)'}</code>
                    {lastPrepareExecute.transactionId && (
                      <button
                        className="sign-copy"
                        onClick={() => navigator.clipboard.writeText(lastPrepareExecute.transactionId as string).catch(() => {})}
                      >Copy</button>
                    )}
                  </div>
                  <div className="account-row">
                    <span className="account-label">commandId:</span>
                    <code className="account-value wrap">{lastPrepareExecute.commandId ?? '(not in userUrl)'}</code>
                    {lastPrepareExecute.commandId && (
                      <button
                        className="sign-copy"
                        onClick={() => navigator.clipboard.writeText(lastPrepareExecute.commandId as string).catch(() => {})}
                      >Copy</button>
                    )}
                  </div>
                  {lastPrepareExecute.userUrl && (
                    <div className="account-row account-row-meta">
                      <span className="account-label">userUrl:</span>
                      <code className="account-value wrap">{lastPrepareExecute.userUrl}</code>
                    </div>
                  )}
                </div>
              )}
              {transactions.length > 0 && (
                <div className="terminal-display">
                  <p className="terminal-count">Transactions: {transactions.length}</p>
                  {transactions.map((tx, i) => (
                    <div key={i} className="terminal-item">
                      <pre>{prettyjson(tx)}</pre>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {activeTab === 'events' && (
        <section className="card">
          <h2>SDK Events</h2>
          {!isConnected ? (
            <p className="hint">Connect to a wallet to see real-time events.</p>
          ) : events.length === 0 ? (
            <p className="hint">Listening for statusChanged, accountsChanged, txChanged...</p>
          ) : (
            <div className="terminal-display">
              {events.map((evt) => (
                <div key={evt.id} className="terminal-item">
                  <div className={`terminal-label event-${evt.type}`}>
                    {evt.type} ({evt.timestamp.toLocaleTimeString()})
                  </div>
                  <pre>{prettyjson(evt.data)}</pre>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {activeTab === 'messages' && (
        <section className="card">
          <h2>Window Messages</h2>
          {windowMessages.length === 0 ? (
            <p className="hint">Listening for all window.postMessage events...</p>
          ) : (
            <div className="terminal-display">
              {windowMessages.map((msg) => (
                <div key={msg.id} className="terminal-item">
                  <div className={`terminal-label msg-type-${msg.type}`}>
                    {msg.type} <span className="msg-origin">({msg.origin})</span> ({msg.timestamp.toLocaleTimeString()})
                  </div>
                  <pre>{prettyjson(msg.data)}</pre>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {activeTab === 'raw' && (
        <RawTab extensionDetected={extensionDetected} addLog={addLog} />
      )}

      {/* WalletConnect QR Modal */}
      {wcUri && (
        <div className="wc-modal-overlay" onClick={() => setWcUri(null)}>
          <div className="wc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="wc-modal-header">
              <h3>Scan with your Canton wallet</h3>
              <button className="wc-modal-close" onClick={() => setWcUri(null)} aria-label="Close">×</button>
            </div>
            <div className="wc-qr-container">
              {wcQrDataUrl ? (
                <img src={wcQrDataUrl} alt="WalletConnect QR" className="wc-qr" />
              ) : (
                <div className="wc-qr-placeholder">Generating QR…</div>
              )}
            </div>
            <p className="wc-modal-hint">
              Open a CIP-0103-compatible Canton wallet on your phone and scan the code, or copy the URI below.
            </p>
            <div className="wc-uri-row">
              <code className="wc-uri">{wcUri}</code>
              <button onClick={handleCopyWcUri}>{wcCopied ? 'Copied!' : 'Copy URI'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Log */}
      <section className="card log-card">
        <h2>
          Log
          <button className="clear-btn" onClick={() => setLogs([])}>Clear</button>
        </h2>
        <div className="log-box">
          {logs.map((entry) => (
            <div key={entry.id} className={`log-entry ${entry.type}`}>
              <span className="log-time">{entry.time}</span>
              <span className="log-msg">{entry.message}</span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </section>
    </div>
  );
}

// ============================================================
// Accounts Tab
// ============================================================
function AccountsTab({
  accounts,
  primaryParty,
  balance,
  balanceLoading,
  onQueryBalance,
  onCopy,
}: {
  accounts: sdk.dappAPI.Wallet[];
  primaryParty?: string;
  balance: AmuletBalance | null;
  balanceLoading: boolean;
  onQueryBalance: () => void;
  onCopy: (value: string, label: string) => void;
}) {
  if (accounts.length === 0) {
    return (
      <section className="card">
        <h2>Accounts</h2>
        <p className="hint">No accounts — connect to a wallet first.</p>
      </section>
    );
  }

  const sorted = [...accounts].sort((a, b) => {
    if (a.primary && !b.primary) return -1;
    if (!a.primary && b.primary) return 1;
    if (a.disabled && !b.disabled) return 1;
    if (!a.disabled && b.disabled) return -1;
    return 0;
  });

  return (
    <>
      <section className="card">
        <h2>Accounts ({accounts.length})</h2>
        <div className="accounts-list">
          {sorted.map((acc) => (
            <div
              key={acc.partyId}
              className={`account-item ${acc.primary ? 'primary' : ''} ${acc.disabled ? 'disabled' : ''}`}
            >
              <div className="account-row">
                <span className="account-label">partyId:</span>
                <code className="account-value">{acc.partyId}</code>
                <button className="sign-copy" onClick={() => onCopy(acc.partyId, 'partyId')}>Copy</button>
                {acc.primary && <span className="badge badge-primary">primary</span>}
                {acc.disabled && <span className="badge badge-disabled">disabled</span>}
              </div>
              {acc.publicKey && (
                <div className="account-row">
                  <span className="account-label">publicKey:</span>
                  <code className="account-value wrap">{acc.publicKey}</code>
                  <button className="sign-copy" onClick={() => onCopy(acc.publicKey, 'publicKey')}>Copy</button>
                </div>
              )}
              {acc.namespace && (
                <div className="account-row account-row-meta">
                  <span className="account-label">namespace:</span>
                  <code className="account-value wrap">{acc.namespace}</code>
                </div>
              )}
              {acc.networkId && (
                <div className="account-row account-row-meta">
                  <span className="account-label">network:</span>
                  <code className="account-value">{acc.networkId}</code>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Wallet Balance</h2>
        <p className="hint">
          Queries <code>sdk.ledgerApi()</code> for active <code>#splice-amulet:Splice.Amulet:Amulet</code>
          contracts owned by your primary party, then sums their <code>amount.initialAmount</code> fields.
        </p>
        <div className="button-row">
          <button onClick={onQueryBalance} disabled={balanceLoading || !primaryParty}>
            {balanceLoading ? 'Querying…' : 'Query Wallet Balance'}
          </button>
        </div>
        {balance && (
          <div className="balance-result">
            <div className="balance-total">
              <span className="balance-total-label">Total (Σ initialAmount)</span>
              <span className="balance-total-value">
                {balance.total.toLocaleString(undefined, { maximumFractionDigits: 10 })} CC
              </span>
            </div>
            <div className="balance-row balance-row-meta">
              <span className="balance-label">Active contracts:</span>
              <span>{balance.contractCount}</span>
            </div>
            <div className="balance-row balance-row-meta">
              <span className="balance-label">Queried at:</span>
              <span>{balance.queriedAt.toLocaleTimeString()}</span>
            </div>
            {balance.amounts.length > 0 && (
              <details className="balance-breakdown">
                <summary>Per-contract initial amounts ({balance.amounts.length})</summary>
                <ul>
                  {balance.amounts.map((a, i) => (
                    <li key={i}>
                      <code>{a}</code>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {balance.contractCount === 0 && (
              <p className="hint balance-empty">
                No active Amulet contracts found — wallet balance is 0 for this template.
              </p>
            )}
          </div>
        )}
      </section>

    </>
  );
}

// ============================================================
// Raw PostMessage Tab
// ============================================================
interface TabProps {
  extensionDetected: boolean | null;
  addLog: (type: LogEntry['type'], message: string) => void;
}

function RawTab({ extensionDetected, addLog }: TabProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const [rawAccounts, setRawAccounts] = useState<{ partyId: string; primary: boolean }[]>([]);
  const [signature, setSignature] = useState<string | null>(null);

  async function handleDisconnect() {
    setLoading('disconnect');
    addLog('info', '[Raw] disconnect()...');
    try {
      await rpcRequest('disconnect');
      addLog('success', '[Raw] disconnect → OK');
      setRawAccounts([]);
      setSignature(null);
    } catch (e) {
      addLog('error', `[Raw] disconnect failed: ${formatErr(e)}`);
    } finally {
      setLoading(null);
    }
  }

  async function handleStatus() {
    setLoading('status');
    addLog('info', '[Raw] status()...');
    try {
      const result = await rpcRequest('status');
      addLog('success', `[Raw] status → ${prettyjson(result)}`);
    } catch (e) {
      addLog('error', `[Raw] status failed: ${formatErr(e)}`);
    } finally {
      setLoading(null);
    }
  }

  async function handleGetActiveNetwork() {
    setLoading('getActiveNetwork');
    addLog('info', '[Raw] getActiveNetwork()...');
    try {
      const result = await rpcRequest('getActiveNetwork');
      addLog('success', `[Raw] getActiveNetwork → ${prettyjson(result)}`);
    } catch (e) {
      addLog('error', `[Raw] getActiveNetwork failed: ${formatErr(e)}`);
    } finally {
      setLoading(null);
    }
  }

  async function handleListAccounts() {
    setLoading('listAccounts');
    addLog('info', '[Raw] listAccounts()...');
    try {
      const result = await rpcRequest<{ partyId: string; primary: boolean }[]>('listAccounts');
      addLog('success', `[Raw] listAccounts → ${prettyjson(result)}`);
      setRawAccounts(result);
    } catch (e) {
      addLog('error', `[Raw] listAccounts failed: ${formatErr(e)}`);
    } finally {
      setLoading(null);
    }
  }

  async function handleGetPrimaryAccount() {
    setLoading('getPrimaryAccount');
    addLog('info', '[Raw] getPrimaryAccount()...');
    try {
      const result = await rpcRequest<{ partyId: string; primary: boolean }>('getPrimaryAccount');
      addLog('success', `[Raw] getPrimaryAccount → ${prettyjson(result)}`);
    } catch (e) {
      addLog('error', `[Raw] getPrimaryAccount failed: ${formatErr(e)}`);
    } finally {
      setLoading(null);
    }
  }

  async function handleSignMessage() {
    setLoading('signMessage');
    const testMessage = 'Hello from Canton Test dApp!';
    addLog('info', `[Raw] signMessage("${testMessage}")...`);
    try {
      const result = await rpcRequest<string>('signMessage', { message: testMessage });
      addLog('success', `[Raw] signMessage → ${result}`);
      setSignature(result);
    } catch (e) {
      addLog('error', `[Raw] signMessage failed: ${formatErr(e)}`);
    } finally {
      setLoading(null);
    }
  }

  return (
    <>
      <section className="card">
        <h2>Raw RPC Testing</h2>
        <p className="hint">Raw CIP-0103 JSON-RPC calls via postMessage (use "Connect (Raw RPC)" above to connect first)</p>
        <div className="button-row">
          <button onClick={handleDisconnect} disabled={!!loading || !extensionDetected}>
            {loading === 'disconnect' ? '...' : 'Disconnect'}
          </button>
          <button onClick={handleStatus} disabled={!!loading || !extensionDetected}>
            {loading === 'status' ? '...' : 'Status'}
          </button>
          <button onClick={handleGetActiveNetwork} disabled={!!loading || !extensionDetected}>
            {loading === 'getActiveNetwork' ? '...' : 'Get Network'}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Raw Accounts</h2>
        <div className="button-row">
          <button onClick={handleListAccounts} disabled={!!loading || !extensionDetected}>
            {loading === 'listAccounts' ? '...' : 'List Accounts'}
          </button>
          <button onClick={handleGetPrimaryAccount} disabled={!!loading || !extensionDetected}>
            {loading === 'getPrimaryAccount' ? '...' : 'Get Primary'}
          </button>
        </div>
        {rawAccounts.length > 0 && (
          <div className="result-box">
            {rawAccounts.map((a) => (
              <div key={a.partyId}>
                <strong>{a.primary ? '(primary) ' : ''}</strong>
                <code>{a.partyId}</code>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Raw Sign Message</h2>
        <button onClick={handleSignMessage} disabled={!!loading || !extensionDetected}>
          {loading === 'signMessage' ? 'Signing...' : 'Sign Test Message'}
        </button>
        {signature && (
          <div className="result-box">
            <strong>Signature:</strong>
            <code className="wrap">{signature}</code>
          </div>
        )}
      </section>
    </>
  );
}

export default App;
