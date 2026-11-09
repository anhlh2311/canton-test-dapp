export declare const CANTOR8_DAPP_NAME: 'Cantor8 Wallet Connect SDK Demo';

export declare const CANTOR8_WALLET_URL: 'https://wallet.cantor8.tech/';

export declare function cantor8WalletOrigin(network: 'devnet' | 'mainnet'): string;

export declare function assertValidCantor8Transfer(to: string, amount: string): number;

export declare function describeCantor8Error(e: unknown): string;
