/**
 * Console Wallet adapter for PartyLayer integration testing.
 *
 * Registers the official ConsoleAdapter for connect / ledgerApi / signMessage,
 * but overrides submitTransaction to use Console's CIP-0103
 * `prepareExecuteAndWait` (Daml commands). The published ConsoleAdapter still
 * routes submit through `submitCommands`, which is the CC-transfer helper
 * (`from`/`to`/`amount`) and cannot create Ping contracts.
 *
 * Remove this override once `@partylayer/adapter-console` ships the
 * prepareExecuteAndWait path.
 */

import { ConsoleAdapter } from '@partylayer/sdk';
import type {
  AdapterContext,
  Session,
  SubmitTransactionParams,
  TxReceipt,
} from '@partylayer/sdk';

type ConsoleWalletApi = (typeof import('@console-wallet/dapp-sdk'))['consoleWallet'];

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

export class ConsoleDamlAdapter extends ConsoleAdapter {
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
}
