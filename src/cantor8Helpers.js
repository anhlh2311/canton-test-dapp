export const CANTOR8_DAPP_NAME = 'Cantor8 Wallet Connect SDK Demo';

/** Public C8 Wallet URL (mainnet popup origin). */
export const CANTOR8_WALLET_URL = 'https://wallet.cantor8.tech/';

/**
 * Popup origin used by `@cantor8/wallet-connect-sdk@0.9.0` for each network.
 * (Devnet still uses the digik host in current SDK releases.)
 * @param {'devnet' | 'mainnet'} network
 * @returns {string}
 */
export function cantor8WalletOrigin(network) {
  return network === 'mainnet'
    ? 'https://wallet.cantor8.tech'
    : 'https://wallet.dev.digik.cantor8.tech';
}

/**
 * Official connect/approval popup URL (SDK `WALLET_EMBED_URL` = `/embedded`).
 * @param {'devnet' | 'mainnet'} network
 * @returns {string}
 */
export function cantor8WalletEmbedUrl(network) {
  return `${cantor8WalletOrigin(network)}/embedded/`;
}

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
      case 'INITIALIZATION_FAILED':
        return (
          'Wallet popup failed to initialize (handshake timeout or popup closed). ' +
          'C8 Wallet must serve the SPA at /embedded/ for the connection approval UI — ' +
          'a 404 there blocks connect(). Check dappName registration and network as well.'
        );
      case 'TRANSFER_PREPARE_FAILED':
      case 'TRANSFER_PREPARATION_FAILED':
      case 'TRANSFER_FAILED':
      case 'EXECUTION_FAILED':
        return 'Transfer failed — check inputs or ledger status.';
      case 'FETCH_INSTRUMENTS_FAILED':
      case 'GET_INSTRUMENTS_FAILED':
        return 'Failed to load instruments — retry while connected.';
      case 'FETCH_ACCOUNTS_FAILED':
      case 'GET_ACCOUNTS_FAILED':
        return 'Failed to load accounts — retry while connected.';
      case 'CHECK_TX_STATUS_FAILED':
      case 'FAILED_TO_FETCH_TRANSFER_STATUS':
        return 'Could not fetch transfer status — retry.';
      default:
        return message ? `${code}: ${message}` : code || 'Unknown Cantor8 error';
    }
  }
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'Unknown Cantor8 error';
}
