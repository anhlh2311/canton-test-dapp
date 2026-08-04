export const CANTOR8_DAPP_NAME = 'Cantor8 Wallet Connect SDK Demo';

/**
 * @param {string} to
 * @param {string} amount
 * @returns {number}
 */
export function assertValidCantor8Transfer(to, amount) {
  const receiver = String(to ?? '').trim();
  if (!receiver) {
    throw new Error('Receiver partyId is required.');
  }
  const parsed = Number(String(amount ?? '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Amount must be a positive number.');
  }
  return parsed;
}

/**
 * @param {unknown} e
 * @returns {string}
 */
export function describeCantor8Error(e) {
  if (e && typeof e === 'object' && 'code' in e) {
    const code = String(/** @type {{ code: unknown }} */ (e).code);
    const message =
      'message' in e && typeof /** @type {{ message: unknown }} */ (e).message === 'string'
        ? /** @type {{ message: string }} */ (e).message
        : '';
    switch (code) {
      case 'USER_REJECTED':
        return 'User dismissed the wallet popup — retry.';
      case 'POPUP_BLOCKED':
        return 'Browser blocked the wallet popup. Allow popups and trigger connect/send from a button click.';
      case 'NOT_CONNECTED':
        return 'Connect the wallet first.';
      case 'INSUFFICIENT_FUNDS':
        return 'Not enough balance for this transfer.';
      case 'INIT_FAILED':
        return 'Wallet provider failed to initialize. Check dappName / network config.';
      case 'TRANSFER_PREPARE_FAILED':
      case 'TRANSFER_FAILED':
        return 'Transfer failed — check inputs or ledger status.';
      case 'GET_INSTRUMENTS_FAILED':
        return 'Failed to load instruments — retry while connected.';
      case 'GET_ACCOUNTS_FAILED':
        return 'Failed to load accounts — retry while connected.';
      case 'CHECK_TX_STATUS_FAILED':
        return 'Could not fetch transfer status — retry.';
      default:
        return message ? `${code}: ${message}` : code || 'Unknown Cantor8 error';
    }
  }
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'Unknown Cantor8 error';
}
