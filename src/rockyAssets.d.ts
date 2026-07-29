import type {
  RockyAssetDescriptor,
  RockyTokenBalance,
} from '@rocky-wallet/dapp-sdk';

export interface RockyAssetOption {
  assetId: string | null;
  symbol: string;
  label: string;
  canSend: boolean;
}

export interface RockyAssetRow extends RockyAssetOption {
  key: string;
  amount: string;
  usd?: string;
}

export declare function getRockyUsdValue(
  balance?: RockyTokenBalance,
): string | undefined;

export declare function buildRockyAssetRows(
  catalog: RockyAssetDescriptor[],
  balances: RockyTokenBalance[],
): RockyAssetRow[];

export declare function buildRockyTransferOptions(
  catalog: RockyAssetDescriptor[],
  catalogSupported: boolean,
): RockyAssetOption[];

export declare function assertValidRockyTransfer(
  to: string,
  amount: string,
  asset: RockyAssetOption,
): void;
