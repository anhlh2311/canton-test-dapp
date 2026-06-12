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
      .then((s) => setStatusEvent(s))
      .catch(() => {});
  }, [wcAdapter]);

  // Subscribe to SDK events when connected
  useEffect(() => {
    if (!isConnected) return;

    const onStatus = (event: sdk.dappAPI.StatusEvent) => {
      setStatusEvent(event);
      const eid = ++eventId;
      setEvents((prev) => [{ id: eid, type: 'StatusChanged', timestamp: new Date(), data: event }, ...prev]);
      addLog('info', `[Event] statusChanged → connected=${event.connection?.isConnected}`);
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
        .catch((err) => addLog('error', `listAccounts failed: ${err instanceof Error ? err.message : String(err)}`));
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
      .catch((e) => addLog('error', `[WC] QR render failed: ${e instanceof Error ? e.message : String(e)}`));
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
      addLog('error', `[Raw RPC] connect failed: ${e instanceof Error ? e.message : String(e)}`);
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
      addLog('error', `[SDK] connect failed: ${e instanceof Error ? e.message : String(e)}`);
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
      addLog('error', `[SDK] connect (extension) failed: ${e instanceof Error ? e.message : String(e)}`);
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
      addLog('error', `[SDK] connect (WalletConnect) failed: ${e instanceof Error ? e.message : String(e)}`);
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
      addLog('error', `[WC] Copy failed: ${e instanceof Error ? e.message : String(e)}`);
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
      addLog('error', `[SDK] disconnect failed: ${e instanceof Error ? e.message : String(e)}`);
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
      addLog('error', `signMessage failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(null);
    }
  }

  async function handleCopySignature(sig: string) {
    try {
      await navigator.clipboard.writeText(sig);
      addLog('info', 'signature copied');
    } catch (e) {
      addLog('error', `Copy failed: ${e instanceof Error ? e.message : String(e)}`);
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
      const error = e instanceof Error ? e.message : String(e);
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
      addLog('error', `[SDK] status failed: ${e instanceof Error ? e.message : String(e)}`);
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
      addLog('error', `[Ledger] Query failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(null);
    }
  }

  async function handleCreatePing() {
    if (!primaryParty) return;
    setLoading('submit');
    addLog('info', `[Ledger] Creating Ping contract (party: ${primaryParty})...`);
    try {
      await sdk.prepareExecute(createPingCommand(ledgerApiVersion, primaryParty));
      addLog('success', '[Ledger] prepareExecute completed');
    } catch (e) {
      addLog('error', `[Ledger] prepareExecute failed: ${e instanceof Error ? e.message : String(e)}`);
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
      addLog('error', `[Hybrid] Failed: ${e instanceof Error ? e.message : String(e)}`);
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
          <span className={`status-dot ${isConnected ? 'green' : 'red'}`} />
          <span>{isConnected ? `Connected (${statusEvent?.provider?.providerType ?? 'unknown'})` : 'Disconnected'}</span>
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
          onCopy={async (value, label) => {
            try {
              await navigator.clipboard.writeText(value);
              addLog('info', `[accounts] ${label} copied`);
            } catch (e) {
              addLog('error', `Copy failed: ${e instanceof Error ? e.message : String(e)}`);
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
  onCopy,
}: {
  accounts: sdk.dappAPI.Wallet[];
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
      addLog('error', `[Raw] disconnect failed: ${e instanceof Error ? e.message : String(e)}`);
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
      addLog('error', `[Raw] status failed: ${e instanceof Error ? e.message : String(e)}`);
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
      addLog('error', `[Raw] getActiveNetwork failed: ${e instanceof Error ? e.message : String(e)}`);
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
      addLog('error', `[Raw] listAccounts failed: ${e instanceof Error ? e.message : String(e)}`);
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
      addLog('error', `[Raw] getPrimaryAccount failed: ${e instanceof Error ? e.message : String(e)}`);
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
      addLog('error', `[Raw] signMessage failed: ${e instanceof Error ? e.message : String(e)}`);
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
