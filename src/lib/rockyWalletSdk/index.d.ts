// Vendored copy of the Rocky Wallet SDK type declarations.
// Source: ../_MISC/rocky_wallet_sdk/index.d.ts — re-sync if the source changes.
export declare const MINIMAL_CAPABLE_VERSION = "1.0.0";
export declare const ROCKY_WALLET_INITIALIZED_EVENT = "rockyWallet#initialized";
export declare const ROCKY_ASSET_SYMBOLS: readonly ["CC", "USDCx", "CBTC"];

export type RockyAssetSymbol = "CC" | "USDCx" | "CBTC";
export type RockyAssetInstrument =
  | RockyAssetSymbol
  | string
  | {
      instrument_id?: string;
      id?: string;
      [key: string]: unknown;
    };

export declare function resolveRockyAssetSymbol(instrument?: RockyAssetInstrument): RockyAssetSymbol;

export type ConnectVariant = "local" | "remote" | "combined";
export type AvailabilityStatus = "installed" | "notInstalled";
export type WalletVersion = `${number}.${number}.${number}`;

export type ConnectRequest = {
  icon?: string;
  name?: string;
  target?: ConnectVariant;
  timeoutMs?: number;
};

export type AvailabilityResponse = {
  status: AvailabilityStatus;
  currentVersion?: WalletVersion | string;
  minimalCapableVersion: WalletVersion | string;
  isExtensionCapableByVersion: boolean;
};

export type RockyAccount = {
  partyId: `${string}::${string}` | string;
  displayName?: string;
  username?: string;
  networkId?: string;
  namespace?: string;
  fingerprint?: string;
  externalSigningKey?: {
    algorithm?: string;
    publicKey?: string;
    fingerprint?: string;
  };
  [key: string]: unknown;
};

export type ConnectResponse = {
  isConnected: boolean;
  account?: RockyAccount;
  reason?: string;
  isNetworkConnected?: boolean;
  networkReason?: string;
};

export type StatusEvent = {
  connection: ConnectResponse;
  provider: {
    id: string;
    version: string;
    providerType: "browser" | string;
  };
  network?: {
    networkId: string;
  };
};

export type Network = {
  id?: string;
  networkId?: string;
  name?: string;
};

export type HexMessage = { hex: string };
export type Base64Message = { base64: string };
export type SignMessageRequest = {
  message: HexMessage | Base64Message | string;
  metaData?: Record<string, string>;
  metadata?: Record<string, string>;
  [key: string]: unknown;
};

export type SignLoginChallengeOptions = {
  app?: string;
  appName?: string;
  metaData?: Record<string, string>;
  metadata?: Record<string, string>;
  timeoutMs?: number;
  [key: string]: unknown;
};

export type SignedMessageResponse = string | undefined;

export type GetBalanceRequest = {
  party?: string;
  network?: string;
  [key: string]: unknown;
};

export type GetCoinsResponse = {
  tokens?: RockyTokenBalance[];
  items?: RockyTokenBalance[];
  [key: string]: unknown;
};

export type RockyTokenBalance = {
  symbol: RockyAssetSymbol | string;
  amount?: string;
  priceUsd?: string;
  price_usd?: string;
  [key: string]: unknown;
};

export type SignSendRequest = {
  from?: string;
  to: string;
  token: RockyAssetSymbol | string;
  amount: string;
  expireDate?: string;
  memo?: string;
  waitForFinalization?: number;
  [key: string]: unknown;
};

export type BuildTransferRequest = {
  fromParty?: string;
  toAddress?: string;
  to?: string;
  assetSymbol?: RockyAssetSymbol | string;
  token?: RockyAssetSymbol | string;
  amount: string;
  memo?: string;
  [key: string]: unknown;
};

export type BuildTransferResponse = {
  unsigned_payload: string;
  payload_hash: string;
  resolved_to_party?: string;
  asset_symbol?: RockyAssetSymbol | string;
  amount?: string;
  fee_asset_symbol?: string;
  feeAssetSymbol?: string;
  fee_amount?: string;
  feeAmount?: string;
  fee_to_party?: string;
  feeToParty?: string;
  total_debit_amount?: string;
  totalDebitAmount?: string;
  [key: string]: unknown;
};

export type SignSendResponse = {
  status: true | false;
  signature?: string;
  transferId?: string;
  [key: string]: unknown;
} | undefined;

export type OffersRequest = Record<string, unknown>;
export type OffersResponse = Record<string, unknown>;
export type SignInstructionChoiceRequest = Record<string, unknown>;
export type SignInstructionChoiceResponse = {
  status: true | false;
  signature?: string;
  [key: string]: unknown;
} | undefined;

export interface RockyWalletProvider {
  isRockyWallet?: boolean;
  version?: string;
  connect?: (request?: ConnectRequest) => Promise<ConnectResponse>;
  disconnect?: () => Promise<unknown>;
  getPrimaryAccount: () => Promise<RockyAccount | undefined>;
  getAccounts?: () => Promise<RockyAccount[] | undefined>;
  getActiveNetwork?: () => Promise<Network>;
  getCoinsBalance: (request?: GetBalanceRequest) => Promise<GetCoinsResponse>;
  signMessage: (request: SignMessageRequest) => Promise<SignedMessageResponse>;
  submitCommands: (request: SignSendRequest | Record<string, unknown>) => Promise<SignSendResponse>;
  buildTransfer?: (request: BuildTransferRequest | Record<string, unknown>) => Promise<BuildTransferResponse>;
  sendTransfer?: (request: SignSendRequest | BuildTransferRequest | Record<string, unknown>) => Promise<SignSendResponse>;
  transfer?: (to: string, amount: string | number, instrument: RockyAssetInstrument, options?: Record<string, unknown>) => Promise<SignSendResponse>;
  getNodeOffers: (request?: OffersRequest) => Promise<OffersResponse>;
  submitInstructionChoice: (request?: SignInstructionChoiceRequest) => Promise<SignInstructionChoiceResponse>;
}

export type RockyWalletSdkOptions = {
  provider?: RockyWalletProvider;
  window?: Window;
};

export type RockyWalletClientConfig = {
  appName?: string;
  onAccept?: (provider: RockyWalletProvider) => void;
  onReject?: () => void;
};

export declare class RockyWalletError extends Error {
  code: number;
  data?: unknown;
  constructor(message: string, options?: { code?: number; data?: unknown });
}

export declare function createRockyWalletSdk(options?: RockyWalletSdkOptions): RockyWalletSdk;

export type Unsubscribe = () => void;

export interface RockyWalletSdk {
  checkExtensionAvailability(options?: { timeoutMs?: number }): Promise<AvailabilityResponse>;
  getWalletVersion(options?: { timeoutMs?: number }): Promise<string>;
  connect(request?: ConnectRequest): Promise<ConnectResponse>;
  disconnect(options?: { timeoutMs?: number }): Promise<unknown>;
  isConnected(options?: { timeoutMs?: number }): Promise<ConnectResponse>;
  status(options?: { timeoutMs?: number }): Promise<StatusEvent>;
  getPrimaryAccount(options?: { timeoutMs?: number }): Promise<RockyAccount | undefined>;
  getActiveAccount(options?: { timeoutMs?: number }): Promise<RockyAccount | undefined>;
  getAccounts(options?: { timeoutMs?: number }): Promise<RockyAccount[] | undefined>;
  getActiveNetwork(options?: { timeoutMs?: number }): Promise<Network>;
  getWalletMetadata(options?: { timeoutMs?: number }): Promise<Record<string, unknown>>;
  getCoinsBalance(request?: GetBalanceRequest): Promise<GetCoinsResponse>;
  getBalance(request?: GetBalanceRequest): Promise<GetCoinsResponse>;
  getCoinsList(request?: GetBalanceRequest): Promise<{ items: Array<Record<string, unknown>> }>;
  signMessage(request: SignMessageRequest): Promise<SignedMessageResponse>;
  signLoginChallenge(challenge: string, options?: SignLoginChallengeOptions): Promise<SignedMessageResponse>;
  submitCommands(request: SignSendRequest | Record<string, unknown>): Promise<SignSendResponse>;
  buildTransfer(request: BuildTransferRequest | Record<string, unknown>): Promise<BuildTransferResponse>;
  sendTransfer(request: SignSendRequest | BuildTransferRequest | Record<string, unknown>): Promise<SignSendResponse>;
  transfer(to: string, amount: string | number, instrument: RockyAssetInstrument, options?: Record<string, unknown>): Promise<SignSendResponse>;
  getOffers(request?: OffersRequest): Promise<OffersResponse>;
  getNodeOffers(request?: OffersRequest): Promise<OffersResponse>;
  submitInstructionChoice(request?: SignInstructionChoiceRequest): Promise<SignInstructionChoiceResponse>;
  signBatch(...args: unknown[]): Promise<never>;
  encrypt(...args: unknown[]): Promise<never>;
  decrypt(...args: unknown[]): Promise<never>;
  ledgerAuth(...args: unknown[]): Promise<never>;
  ledgerRefresh(...args: unknown[]): Promise<never>;
  ledgerApi(...args: unknown[]): Promise<never>;
  getContracts(...args: unknown[]): Promise<never>;
  getTransfer(...args: unknown[]): Promise<never>;
  getTokenTransfers(...args: unknown[]): Promise<never>;
  getNodeTransfer(...args: unknown[]): Promise<never>;
  getNodeTransfers(...args: unknown[]): Promise<never>;
  prepareExecute(...args: unknown[]): Promise<never>;
  prepareExecuteAndWait(...args: unknown[]): Promise<never>;
  onAccountsChanged(onChange?: (account: RockyAccount | undefined) => void): Unsubscribe;
  onConnectionStatusChanged(onChange?: (status: ConnectResponse) => void): Unsubscribe;
  onTxStatusChanged(onChange?: (event: unknown) => void): Unsubscribe;
}

export interface RockyWalletClientWallet {
  transfer(to: string, amount: string | number, instrument: RockyAssetInstrument, options?: Record<string, unknown>): Promise<SignSendResponse>;
  signMessage(request: SignMessageRequest | string): Promise<SignedMessageResponse>;
  signLoginChallenge(challenge: string, options?: SignLoginChallengeOptions): Promise<SignedMessageResponse>;
  submitCommands(request: SignSendRequest | Record<string, unknown>): Promise<SignSendResponse>;
  buildTransfer(request: BuildTransferRequest | Record<string, unknown>): Promise<BuildTransferResponse>;
  sendTransfer(request: SignSendRequest | BuildTransferRequest | Record<string, unknown>): Promise<SignSendResponse>;
  getCoinsBalance(request?: GetBalanceRequest): Promise<GetCoinsResponse>;
}

export interface RockyWalletClient {
  readonly wallet: RockyWalletClientWallet;
  readonly sdk: RockyWalletSdk;
  readonly provider: RockyWalletProvider | null;
  init(config?: RockyWalletClientConfig): RockyWalletClient;
  autoConnect(options?: { timeoutMs?: number }): Promise<RockyAccount | undefined>;
  connect(request?: ConnectRequest): Promise<ConnectResponse>;
  disconnect(): Promise<{ status: true }>;
  getPrimaryAccount(options?: { timeoutMs?: number }): Promise<RockyAccount | undefined>;
  getActiveAccount(options?: { timeoutMs?: number }): Promise<RockyAccount | undefined>;
  getAccounts(options?: { timeoutMs?: number }): Promise<RockyAccount[] | undefined>;
  getActiveNetwork(options?: { timeoutMs?: number }): Promise<Network>;
  getCoinsBalance(request?: GetBalanceRequest): Promise<GetCoinsResponse>;
  signMessage(request: SignMessageRequest): Promise<SignedMessageResponse>;
  signLoginChallenge(challenge: string, options?: SignLoginChallengeOptions): Promise<SignedMessageResponse>;
  submitCommands(request: SignSendRequest | Record<string, unknown>): Promise<SignSendResponse>;
  buildTransfer(request: BuildTransferRequest | Record<string, unknown>): Promise<BuildTransferResponse>;
  sendTransfer(request: SignSendRequest | BuildTransferRequest | Record<string, unknown>): Promise<SignSendResponse>;
  transfer(to: string, amount: string | number, instrument: RockyAssetInstrument, options?: Record<string, unknown>): Promise<SignSendResponse>;
  getOffers(request?: OffersRequest): Promise<OffersResponse>;
  getNodeOffers(request?: OffersRequest): Promise<OffersResponse>;
  submitInstructionChoice(request?: SignInstructionChoiceRequest): Promise<SignInstructionChoiceResponse>;
}

export declare function createRockyWalletClient(options?: RockyWalletSdkOptions): RockyWalletClient;

export declare const rockyWallet: RockyWalletSdk;
export declare const rocky: RockyWalletClient;

export declare const utils: {
  equalBytes(a: Uint8Array, b: Uint8Array): boolean;
  base64ToBytes(base64: string): Uint8Array;
  base64ToHex(base64: string): string;
  toBase64(bytes: Uint8Array): string;
  hexToBase64(hex: string): string;
  hexToBytes(hex: string): Uint8Array;
  toHex(bytes: Uint8Array): string;
};

declare global {
  interface Window {
    rockyWallet?: RockyWalletProvider;
  }
}
