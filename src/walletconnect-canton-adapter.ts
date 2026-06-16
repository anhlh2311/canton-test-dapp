import SignClient from '@walletconnect/sign-client';
import type { SessionTypes } from '@walletconnect/types';

const CANTON_WC_METHODS = [
  'canton_prepareSignExecute',
  'canton_listAccounts',
  'canton_getPrimaryAccount',
  'canton_getActiveNetwork',
  'canton_status',
  'canton_ledgerApi',
  'canton_signMessage',
];

const CANTON_WC_EVENTS = ['accountsChanged', 'statusChanged', 'chainChanged'];

export interface CantonWcAdapterConfig {
  projectId: string;
  metadata: {
    name: string;
    description: string;
    url: string;
    icons: string[];
  };
  /**
   * Placeholder chains advertised in `optionalNamespaces.canton.chains`.
   * WC v2's SignClient requires at least one entry. Because we use
   * `optionalNamespaces` (not required), the wallet is free to approve with
   * its actual operator-defined chain — we read the real chain back from
   * `session.namespaces.canton.chains[0]` after approval. Defaults to
   * `['canton:devnet']` if omitted.
   */
  proposedChains?: string[];
  onUri?: (uri: string) => void;
}

type AnyListener = (...args: unknown[]) => void;
type SignClientInstance = Awaited<ReturnType<typeof SignClient.init>>;

/**
 * Spec-compliant Canton WalletConnect adapter.
 *
 * Differences from sdk.WalletConnectAdapter:
 *  1. Uses `optionalNamespaces` without hardcoded chains — the wallet approves
 *     whichever Canton network it supports (operator-defined IDs).
 *  2. Derives the runtime `chainId` from `session.namespaces.canton.chains[0]`
 *     after approval, so subsequent `signClient.request(...)` calls route to
 *     the chain the wallet actually approved.
 */
export class CantonWcAdapter {
  readonly providerId = 'walletconnect-custom';
  readonly name = 'WalletConnect';
  readonly type = 'mobile' as const;
  readonly icon: string | undefined = undefined;

  private readonly projectId: string;
  private readonly metadata: CantonWcAdapterConfig['metadata'];
  private readonly proposedChains: string[];
  private readonly onUri?: (uri: string) => void;

  private signClient: SignClientInstance | null = null;
  private initPromise: Promise<SignClientInstance> | null = null;
  private session: SessionTypes.Struct | null = null;
  private chainId: string | null = null;

  private listeners: Record<string, AnyListener[]> = {};
  private eventBuffer: Map<string, unknown[][]> = new Map();

  constructor(config: CantonWcAdapterConfig) {
    this.projectId = config.projectId;
    this.metadata = config.metadata;
    this.proposedChains =
      config.proposedChains && config.proposedChains.length > 0
        ? config.proposedChains
        : ['canton:devnet'];
    this.onUri = config.onUri;
  }

  // ── ProviderAdapter ──────────────────────────────────────────────

  getInfo() {
    return {
      providerId: this.providerId,
      name: this.name,
      type: this.type,
      icon: this.icon,
      description: 'Connect via WalletConnect (Canton spec)',
      reuseGlobalWalletPopup: true,
    };
  }

  async detect(): Promise<boolean> {
    return true;
  }

  provider(): this {
    return this;
  }

  teardown(): void {
    /* noop */
  }

  async restore(): Promise<this | null> {
    const client = await this.initSignClient();
    const cantonSession = client.session
      .getAll()
      .find((s) => s.namespaces?.canton !== undefined);
    if (!cantonSession) return null;
    this.session = cantonSession;
    this.chainId = cantonSession.namespaces.canton?.chains?.[0] ?? null;
    this.setupSessionEvents();
    return this;
  }

  // ── Provider<DappRpcTypes> ──────────────────────────────────────

  async request(args: { method: string; params?: unknown }): Promise<unknown> {
    if (args.method === 'connect') {
      if (!this.session) await this.establishSession();
      const status = this.emitConnected();
      return status.connection;
    }

    if (args.method === 'disconnect') {
      this.emitDisconnected('User disconnected');
      if (this.signClient && this.session) {
        try {
          await this.signClient.disconnect({
            topic: this.session.topic,
            reason: { code: 6000, message: 'User disconnected' },
          });
        } catch {
          /* swallow */
        }
      }
      this.session = null;
      this.chainId = null;
      return null;
    }

    if (args.method === 'status' && !this.session) {
      return {
        provider: { id: this.providerId, providerType: this.type },
        connection: { isConnected: false, isNetworkConnected: false },
      };
    }

    if (!this.session) {
      throw new Error('WalletConnect session not established');
    }

    if (args.method === 'prepareExecute' || args.method === 'prepareExecuteAndWait') {
      const result = await this.wcRequest('prepareSignExecute', args.params);
      this.emit('txChanged', result);
      return { tx: result };
    }

    return this.wcRequest(args.method, args.params);
  }

  on(event: string, listener: AnyListener): this {
    (this.listeners[event] ??= []).push(listener);
    const buffered = this.eventBuffer.get(event);
    if (buffered) {
      for (const args of buffered) listener(...args);
      this.eventBuffer.delete(event);
    }
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const ls = this.listeners[event];
    if (ls && ls.length > 0) {
      ls.forEach((l) => l(...args));
      return true;
    }
    if (!this.eventBuffer.has(event)) this.eventBuffer.set(event, []);
    this.eventBuffer.get(event)!.push(args);
    return false;
  }

  removeListener(event: string, listenerToRemove: AnyListener): this {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((l) => l !== listenerToRemove);
    }
    return this;
  }

  // ── Public escape hatch ──────────────────────────────────────────

  /**
   * Send an arbitrary WC method to the wallet, bypassing the CIP-0103
   * `canton_` prefix that {@link wcRequest} adds. Use this to probe for
   * wallet-specific extension methods (e.g. `canton_getBalance`) that aren't
   * part of the standard CANTON_WC_METHODS list. The exact method string you
   * pass is what's sent on the wire — include any `canton_` / `splice_` /
   * `wallet_` prefix yourself.
   *
   * Errors propagate verbatim from `signClient.request`, so callers can probe
   * a list of candidates and pick whichever doesn't throw.
   */
  async rawRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.signClient || !this.session || !this.chainId) {
      throw new Error('WalletConnect session not established');
    }
    return this.signClient.request({
      topic: this.session.topic,
      chainId: this.chainId,
      request: { method, params: params ?? {} },
    });
  }

  // ── Internals ────────────────────────────────────────────────────

  private async wcRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.signClient || !this.session || !this.chainId) {
      throw new Error('WalletConnect session not established');
    }
    try {
      return await this.signClient.request({
        topic: this.session.topic,
        chainId: this.chainId,
        request: { method: `canton_${method}`, params: params ?? {} },
      });
    } catch (err) {
      const errObj = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
      const message =
        err instanceof Error
          ? err.message
          : typeof errObj.message === 'string'
            ? errObj.message
            : String(err);
      const code = typeof errObj.code === 'number' ? errObj.code : -32603;
      const wrapped = new Error(`RPC error: ${code} - ${message}`);
      (wrapped as Error & { cause?: unknown }).cause = err;
      throw wrapped;
    }
  }

  private emitConnected() {
    const status = {
      provider: { id: this.providerId, providerType: this.type },
      connection: { isConnected: true, isNetworkConnected: true },
    };
    this.emit('statusChanged', status);
    return status;
  }

  private emitDisconnected(reason: string) {
    this.emit('statusChanged', {
      provider: { id: this.providerId, providerType: this.type },
      connection: { isConnected: false, isNetworkConnected: false, reason },
    });
  }

  private async initSignClient(): Promise<SignClientInstance> {
    if (this.signClient) return this.signClient;
    if (this.initPromise) return this.initPromise;
    this.initPromise = SignClient.init({
      projectId: this.projectId,
      metadata: this.metadata,
    });
    this.signClient = await this.initPromise;
    this.signClient.on('session_delete', () => {
      this.emitDisconnected('Session deleted by wallet');
      this.session = null;
      this.chainId = null;
    });
    return this.signClient;
  }

  private setupSessionEvents() {
    if (!this.signClient) return;
    this.signClient.on('session_event', (event) => {
      const { name, data } = event.params.event as { name: string; data: unknown };
      this.emit(name, data);
    });
  }

  private async establishSession() {
    const client = await this.initSignClient();
    // Per Canton WC spec: do NOT specify chains. Wallet approves with whatever
    // Canton network it actually supports.
    // WC v2 SignClient validates `chains` is non-empty. We advertise a
    // placeholder via optionalNamespaces; per CAIP-25, the wallet may approve
    // with any chains in the `canton` namespace it actually supports — we
    // read the real chain back from session.namespaces.canton.chains.
    const { uri, approval } = await client.connect({
      optionalNamespaces: {
        canton: {
          chains: this.proposedChains,
          methods: CANTON_WC_METHODS,
          events: CANTON_WC_EVENTS,
        },
      },
    });
    if (uri) this.onUri?.(uri);
    this.session = await approval();
    // eslint-disable-next-line no-console
    console.log('[CantonWcAdapter] Approved session.namespaces:', JSON.stringify(this.session.namespaces, null, 2));
    const cantonNs = this.session.namespaces.canton;
    const approvedChains = cantonNs?.chains ?? [];
    if (approvedChains.length === 0) {
      // Fallback: derive chains from approved accounts (CAIP-10: `<ns>:<chainId>:<addr>`)
      const accounts = cantonNs?.accounts ?? [];
      const derived = Array.from(
        new Set(
          accounts
            .map((a) => {
              const parts = a.split(':');
              return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : null;
            })
            .filter((x): x is string => x !== null),
        ),
      );
      if (derived.length === 0) {
        throw new Error(
          `Wallet approved canton namespace but provided neither chains nor accounts. Approved namespaces: ${Object.keys(
            this.session.namespaces,
          ).join(', ') || '(none)'}`,
        );
      }
      this.chainId = derived[0];
    } else {
      this.chainId = approvedChains[0];
    }
    this.setupSessionEvents();
  }
}
