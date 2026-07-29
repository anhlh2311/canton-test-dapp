import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidRockyTransfer,
  buildRockyAssetRows,
  buildRockyTransferOptions,
  getRockyUsdValue,
} from './rockyAssets.js';

test('joins catalog and balances by exact asset_id and preserves duplicate symbols', () => {
  const catalog = [
    {
      asset_id: 'asset-usd-a',
      asset_type: 'token_standard',
      symbol: 'USD',
      name: 'USD Alpha',
      display_alias: 'USDA',
      registry_name: null,
      decimals: 6,
      enabled: true,
      can_send: true,
    },
    {
      asset_id: 'asset-usd-b',
      asset_type: 'token_standard',
      symbol: 'USD',
      name: 'USD Beta',
      display_alias: 'USDB',
      registry_name: null,
      decimals: 6,
      enabled: true,
      can_send: true,
    },
  ];
  const balances = [
    { asset_id: 'asset-usd-b', symbol: 'USD', amount: '2.5', usd_value: '2.50' },
    { asset_id: 'asset-usd-a', symbol: 'USD', amount: '1.5', usd_price: '1.00' },
  ];

  assert.deepEqual(buildRockyAssetRows(catalog, balances), [
    {
      key: 'asset-usd-a',
      assetId: 'asset-usd-a',
      symbol: 'USD',
      label: 'USDA',
      amount: '1.5',
      usd: '1.00',
      canSend: true,
    },
    {
      key: 'asset-usd-b',
      assetId: 'asset-usd-b',
      symbol: 'USD',
      label: 'USDB',
      amount: '2.5',
      usd: '2.50',
      canSend: true,
    },
  ]);
});

test('keeps an unknown holding separate instead of joining it by symbol', () => {
  const rows = buildRockyAssetRows(
    [
      {
        asset_id: 'configured-usd',
        asset_type: 'token_standard',
        symbol: 'USD',
        name: 'Configured USD',
        display_alias: 'USD',
        registry_name: null,
        decimals: 6,
        enabled: true,
        can_send: true,
      },
    ],
    [{ asset_id: null, symbol: 'USD', amount: '9' }],
  );

  assert.equal(rows[0].amount, '0');
  assert.equal(rows[1].assetId, null);
  assert.equal(rows[1].amount, '9');
  assert.equal(rows[1].canSend, false);
});

test('reads all USD spellings documented by Rocky 1.0.2', () => {
  assert.equal(getRockyUsdValue({ symbol: 'CC', usd_price: '0.15' }), '0.15');
  assert.equal(getRockyUsdValue({ symbol: 'CC', usd_value: '1.50' }), '1.50');
  assert.equal(getRockyUsdValue({ symbol: 'CC', price_usd: '0.16' }), '0.16');
  assert.equal(getRockyUsdValue({ symbol: 'CC', priceUsd: '0.17' }), '0.17');
});

test('uses asset_id catalog options and only falls back to canonical legacy assets', () => {
  const catalog = [
    {
      asset_id: 'sendable',
      asset_type: 'token_standard',
      symbol: 'USD',
      name: 'USD',
      display_alias: 'USDX',
      registry_name: null,
      decimals: 6,
      enabled: true,
      can_send: true,
    },
    {
      asset_id: 'receive-only',
      asset_type: 'token_standard',
      symbol: 'EUR',
      name: 'EUR',
      display_alias: null,
      registry_name: null,
      decimals: 6,
      enabled: true,
      can_send: false,
    },
  ];

  assert.deepEqual(buildRockyTransferOptions(catalog, true), [
    {
      assetId: 'sendable',
      symbol: 'USD',
      label: 'USDX',
      canSend: true,
    },
  ]);
  assert.deepEqual(
    buildRockyTransferOptions([], false).map((asset) => asset.symbol),
    ['CC', 'USDCx', 'CBTC'],
  );
});

test('validates dynamic and legacy transfer asset identities', () => {
  assert.doesNotThrow(() =>
    assertValidRockyTransfer('alice::1220abc', '1.25', {
      assetId: 'asset-123',
      symbol: 'USD',
      label: 'USD',
      canSend: true,
    }),
  );
  assert.doesNotThrow(() =>
    assertValidRockyTransfer('alice::1220abc', '1', {
      assetId: null,
      symbol: 'CC',
      label: 'CC',
      canSend: true,
    }),
  );
  assert.throws(
    () =>
      assertValidRockyTransfer('alice::1220abc', '1', {
        assetId: null,
        symbol: 'UNVERIFIED',
        label: 'UNVERIFIED',
        canSend: false,
      }),
    /not sendable/i,
  );
  assert.throws(
    () =>
      assertValidRockyTransfer('alice::1220abc', '0', {
        assetId: 'asset-123',
        symbol: 'USD',
        label: 'USD',
        canSend: true,
      }),
    /positive/i,
  );
});
