/**
 * Console Wallet adapter for PartyLayer integration testing.
 *
 * Extends ConsoleAdapter with:
 * 1. submitTransaction → prepareExecuteAndWait (Daml commands, not CC submitCommands)
 * 2. ledgerApi → authenticated Console proxy (network + accessToken + string body)
 *
 * Published @partylayer/adapter-console omits Console's required ledgerApi auth
 * fields, which surfaces as `baseUrl` undefined / 403 Forbidden on
 * https://devnet.consolewallet.io/api/v1/ledger-api.
 */

import { ConsoleAdapter } from '@partylayer/sdk';
import type {
  AdapterContext,
  LedgerApiParams,
  LedgerApiResult,
  Session,
  SubmitTransactionParams,
  TxReceipt,
} from '@partylayer/sdk';

type ConsoleWalletApi = (typeof import('@console-wallet/dapp-sdk'))['consoleWallet'];
type ConsoleNetwork = Awaited<ReturnType<ConsoleWalletApi['getActiveNetwork']>>;
type ConsoleNetworkId = ConsoleNetwork extends { id: infer I } ? I : string;

let consoleWalletPromise: Promise<ConsoleWalletApi> | undefined;
function getConsoleWallet(): Promise<ConsoleWalletApi> {
  if (!consoleWalletPromise) {
    consoleWalletPromise = import('@console-wallet/dapp-sdk').then((m) => m.consoleWallet);
  }
  return consoleWalletPromise;
}

function formatUnknown(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isForbiddenOrAuthError(err: unknown): boolean {
  const text = formatUnknown(err).toLowerCase();
  return (
    text.includes('403') ||
    text.includes('forbidden') ||
    text.includes('unauthorized') ||
    text.includes('session_expired') ||
    text.includes('refresh_token') ||
    text.includes('auth')
  );
}

type LedgerTokenBundle = {
  accessToken: string;
  refreshToken: string;
  network: ConsoleNetworkId;
  publicKey: string;
  partyId: string;
};

/** Console-native balance API (indexer) — does not use raw /api/v1/ledger-api. */
export async function queryConsoleCoinsBalance(): Promise<{
  byInstrument: Record<string, number>;
  contractCount: number;
  raw: string;
  path: string;
}> {
  const wallet = await getConsoleWallet();
  const account = await wallet.getPrimaryAccount();
  const network = await wallet.getActiveNetwork();
  if (!account?.partyId || !network?.id) {
    throw new Error('Console getCoinsBalance: missing primary account or active network');
  }

  const coins = await wallet.getCoinsBalance({
    party: account.partyId,
    network: network.id,
  });

  const byInstrument: Record<string, number> = {};
  for (const token of coins.tokens ?? []) {
    const symbol = token.symbol || token.id || 'unknown';
    byInstrument[symbol] = (byInstrument[symbol] ?? 0) + parseFloat(token.balance ?? '0');
  }

  return {
    byInstrument,
    contractCount: coins.tokens?.length ?? 0,
    raw: JSON.stringify(coins, null, 2),
    path: 'consoleWallet.getCoinsBalance (authenticated token-standard balances)',
  };
}

export function isConsoleWalletId(walletId: string | undefined): boolean {
  return (walletId ?? '').toLowerCase().includes('console');
}

export class ConsoleDamlAdapter extends ConsoleAdapter {
  private ledgerTokens: LedgerTokenBundle | null = null;

  /**
   * Authenticated Console ledger proxy.
   *
   * Console's LedgerApiRequest requires `{ network, accessToken, requestMethod,
   * resource, body }` where `body` is a JSON **string**. Active-contracts
   * (POST /v2/state/active-contracts) is AUTH=Yes per Console docs.
   */
  async ledgerApi(
    ctx: AdapterContext,
    session: Session,
    params: LedgerApiParams,
  ): Promise<LedgerApiResult> {
    const requestMethod = String(params.requestMethod).toLowerCase() === 'post' ? 'POST' : 'GET';
    const body =
      params.body === undefined || params.body === null
        ? ''
        : typeof params.body === 'string'
          ? params.body
          : JSON.stringify(params.body);

    ctx.logger?.debug?.('ConsoleDamlAdapter: authenticated ledgerApi', {
      sessionId: session.sessionId,
      requestMethod,
      resource: params.resource,
    });

    try {
      return await this.callLedgerApiAuthed(requestMethod, params.resource, body, false);
    } catch (err) {
      if (isForbiddenOrAuthError(err)) {
        // Access token is 10 minutes; 403 ForbiddenException is Console's expired-token shape.
        this.ledgerTokens = null;
        try {
          return await this.callLedgerApiAuthed(requestMethod, params.resource, body, true);
        } catch (retryErr) {
          const wrapped = new Error(
            `Console ledgerApi failed after re-auth (${params.resource}): ${formatUnknown(retryErr)}`,
          );
          (wrapped as Error & { cause?: unknown }).cause = retryErr;
          throw wrapped;
        }
      }
      const wrapped = new Error(
        `Console ledgerApi failed (${params.resource}): ${formatUnknown(err)}`,
      );
      (wrapped as Error & { cause?: unknown }).cause = err;
      throw wrapped;
    }
  }

  async submitTransaction(
    ctx: AdapterContext,
    session: Session,
    params: SubmitTransactionParams,
  ): Promise<TxReceipt> {
    const payload = params.signedTx as {
      commands?: unknown[];
      commandId?: string;
      actAs?: string[];
      readAs?: string[];
      disclosedContracts?: unknown[];
      synchronizerId?: string;
      packageIdSelectionPreference?: string[];
    };

    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.commands)) {
      throw new Error(
        'Console submitTransaction expects a Daml ExecuteRequest as signedTx ' +
          `(commands/actAs/…). Received: ${formatUnknown(params.signedTx)}`,
      );
    }

    ctx.logger?.debug?.('ConsoleDamlAdapter: prepareExecuteAndWait', {
      sessionId: session.sessionId,
      commandId: payload.commandId,
    });

    try {
      const wallet = await getConsoleWallet();
      const { tx } = await wallet.prepareExecuteAndWait(
        payload as Parameters<ConsoleWalletApi['prepareExecuteAndWait']>[0],
      );

      const updateId =
        tx && typeof tx === 'object' && tx.payload && typeof tx.payload.updateId === 'string'
          ? tx.payload.updateId
          : '';
      const commandId =
        tx && typeof tx === 'object' && typeof tx.commandId === 'string'
          ? tx.commandId
          : String(payload.commandId ?? '');

      if (!updateId) {
        throw new Error(
          'Console prepareExecuteAndWait returned no updateId. ' +
            `Received: ${formatUnknown(tx)}`,
        );
      }

      return {
        transactionHash: updateId as TxReceipt['transactionHash'],
        submittedAt: Date.now(),
        commandId: commandId || undefined,
        updateId,
      };
    } catch (err) {
      const detail = formatUnknown(err);
      const wrapped = new Error(`Console prepareExecuteAndWait failed: ${detail}`);
      (wrapped as Error & { cause?: unknown }).cause = err;
      throw wrapped;
    }
  }

  private async ensureLedgerTokens(forceRefresh: boolean): Promise<LedgerTokenBundle> {
    const wallet = await getConsoleWallet();
    const account = await wallet.getPrimaryAccount();
    const network = await wallet.getActiveNetwork();

    if (!account?.partyId || !account.publicKey) {
      throw new Error('Console ledgerAuth: primary account missing partyId/publicKey');
    }
    if (!network?.id) {
      throw new Error(
        'Console ledgerAuth: getActiveNetwork() returned no id (baseUrl/network config unavailable)',
      );
    }
    if (!network.baseUrl) {
      throw new Error(
        `Console ledgerAuth: active network "${String(network.id)}" has no baseUrl — ` +
          'extension network metadata is incomplete',
      );
    }

    if (
      !forceRefresh &&
      this.ledgerTokens &&
      this.ledgerTokens.network === network.id &&
      this.ledgerTokens.partyId === account.partyId &&
      this.ledgerTokens.publicKey === account.publicKey
    ) {
      return this.ledgerTokens;
    }

    if (
      forceRefresh &&
      this.ledgerTokens?.refreshToken &&
      this.ledgerTokens.network === network.id &&
      this.ledgerTokens.publicKey === account.publicKey
    ) {
      try {
        const refreshed = await wallet.ledgerRefresh({
          refreshToken: this.ledgerTokens.refreshToken,
          publicKey: account.publicKey,
          network: network.id,
        });
        this.ledgerTokens = {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          network: network.id,
          publicKey: account.publicKey,
          partyId: account.partyId,
        };
        return this.ledgerTokens;
      } catch {
        // Fall through to full ledgerAuth.
      }
    }

    // Challenge-response login (may prompt in the extension). Required for AUTH=Yes
    // resources like POST /v2/state/active-contracts.
    const login = await wallet.ledgerAuth({
      publicKey: account.publicKey,
      partyId: account.partyId,
      network: network.id,
    });

    this.ledgerTokens = {
      accessToken: login.accessToken,
      refreshToken: login.refreshToken,
      network: network.id,
      publicKey: account.publicKey,
      partyId: account.partyId,
    };
    return this.ledgerTokens;
  }

  private async callLedgerApiAuthed(
    requestMethod: 'GET' | 'POST',
    resource: string,
    body: string,
    forceRefresh: boolean,
  ): Promise<LedgerApiResult> {
    const wallet = await getConsoleWallet();
    const tokens = await this.ensureLedgerTokens(forceRefresh);

    const result = await wallet.ledgerApi({
      requestMethod,
      resource,
      body,
      query: '',
      path: '',
      network: tokens.network,
      accessToken: tokens.accessToken,
    } as Parameters<ConsoleWalletApi['ledgerApi']>[0]);

    if (typeof result === 'string') return { response: result };
    if (result && typeof result === 'object' && 'response' in result) {
      const response = (result as { response?: unknown }).response;
      return {
        response: typeof response === 'string' ? response : JSON.stringify(response ?? null),
      };
    }
    return { response: JSON.stringify(result ?? null) };
  }
}
