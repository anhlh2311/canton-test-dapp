const LEGACY_ASSET_SYMBOLS = new Set(['CC', 'USDCx', 'CBTC']);
const LEGACY_TRANSFER_ASSETS = [...LEGACY_ASSET_SYMBOLS].map((symbol) => ({
  assetId: null,
  symbol,
  label: symbol,
  canSend: true,
}));

export function getRockyUsdValue(balance) {
  if (!balance) return undefined;
  for (const key of ['usd_value', 'usd_price', 'price_usd', 'priceUsd']) {
    const value = balance[key];
    if (value !== undefined && value !== null && String(value) !== '') {
      return String(value);
    }
  }
  return undefined;
}

export function buildRockyAssetRows(catalog, balances) {
  const balanceByAssetId = new Map(
    balances
      .filter((balance) => balance.asset_id)
      .map((balance) => [balance.asset_id, balance]),
  );

  const catalogRows = catalog.map((asset) => {
    const balance = asset.asset_id ? balanceByAssetId.get(asset.asset_id) : undefined;
    return {
      key: asset.asset_id ?? `catalog:${asset.symbol}`,
      assetId: asset.asset_id,
      symbol: asset.symbol,
      label: asset.display_alias || asset.symbol,
      amount: balance?.amount ?? '0',
      usd: getRockyUsdValue(balance),
      canSend: Boolean(asset.asset_id && asset.enabled && asset.can_send),
    };
  });

  const catalogIds = new Set(catalog.map((asset) => asset.asset_id).filter(Boolean));
  const unmatchedBalanceRows = balances
    .filter((balance) => !balance.asset_id || !catalogIds.has(balance.asset_id))
    .map((balance, index) => ({
      key: balance.asset_id ?? `unknown:${index}`,
      assetId: balance.asset_id ?? null,
      symbol: balance.symbol,
      label: balance.display_alias || balance.symbol,
      amount: balance.amount ?? '0',
      usd: getRockyUsdValue(balance),
      canSend: false,
    }));

  return [...catalogRows, ...unmatchedBalanceRows];
}

export function buildRockyTransferOptions(catalog, catalogSupported) {
  if (!catalogSupported) return LEGACY_TRANSFER_ASSETS;

  return catalog
    .filter((asset) => asset.asset_id && asset.enabled && asset.can_send)
    .map((asset) => ({
      assetId: asset.asset_id,
      symbol: asset.symbol,
      label: asset.display_alias || asset.symbol,
      canSend: true,
    }));
}

export function assertValidRockyTransfer(to, amount, asset) {
  if (!to?.trim()) throw new Error('Recipient party is required.');

  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('Amount must be a positive number.');
  }

  const isLegacyAsset = !asset.assetId && LEGACY_ASSET_SYMBOLS.has(asset.symbol);
  if (!asset.canSend && !isLegacyAsset) {
    throw new Error(`Asset "${asset.label}" is not sendable.`);
  }
  if (!asset.assetId && !isLegacyAsset) {
    throw new Error(`Asset "${asset.label}" has no verified asset_id.`);
  }
}
