// Vendored copy of the Rocky Wallet SDK (zero-dependency ES module).
// Source: ../_MISC/rocky_wallet_sdk/index.js — re-sync if the source changes.
export const MINIMAL_CAPABLE_VERSION = "1.0.0";
export const ROCKY_WALLET_INITIALIZED_EVENT = "rockyWallet#initialized";
export const ROCKY_ASSET_SYMBOLS = Object.freeze(["CC", "USDCx", "CBTC"]);

const DEFAULT_TIMEOUT_MS = 1000;

export class RockyWalletError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "RockyWalletError";
    this.code = options.code ?? 4900;
    if (options.data !== undefined) this.data = options.data;
  }
}

export function createRockyWalletSdk(options = {}) {
  const injectedProvider = options.provider;
  const injectedWindow = options.window;

  async function getProvider(callOptions = {}) {
    assertNoWalletSecrets(callOptions, "provider options");
    if (injectedProvider) return injectedProvider;
    return resolveInjectedProvider(injectedWindow || globalThis.window, callOptions);
  }

  async function getPrimaryAccount(callOptions = {}) {
    const provider = await getProvider(callOptions);
    return callProviderMethod(provider, "getPrimaryAccount");
  }

  async function getActiveNetwork(callOptions = {}) {
    const provider = await getProvider(callOptions);
    if (typeof provider.getActiveNetwork === "function") {
      return callProviderMethod(provider, "getActiveNetwork");
    }
    return { id: "CANTON_NETWORK", name: "Canton Mainnet" };
  }

  const sdk = {
    async checkExtensionAvailability(callOptions = {}) {
      try {
        const provider = await getProvider(callOptions);
        const currentVersion = getProviderVersion(provider);
        return {
          status: "installed",
          currentVersion,
          minimalCapableVersion: MINIMAL_CAPABLE_VERSION,
          isExtensionCapableByVersion: compareVersions(currentVersion, MINIMAL_CAPABLE_VERSION),
        };
      } catch (error) {
        const normalized = toRockyWalletError(error);
        if (normalized.code === -32602) throw normalized;
        return {
          status: "notInstalled",
          minimalCapableVersion: MINIMAL_CAPABLE_VERSION,
          isExtensionCapableByVersion: false,
        };
      }
    },

    async getWalletVersion(callOptions = {}) {
      const provider = await getProvider(callOptions);
      return getProviderVersion(provider);
    },

    async connect(request = {}) {
      const provider = await getProvider(request);
      if (typeof provider.connect !== "function") {
        throw new RockyWalletError("Rocky Wallet provider does not support connect", { code: 4200 });
      }
      return callProviderMethod(provider, "connect", request);
    },

    async disconnect(callOptions = {}) {
      const provider = await getProvider(callOptions);
      if (typeof provider.disconnect === "function") {
        return callProviderMethod(provider, "disconnect");
      }
      return { status: true };
    },

    async isConnected(callOptions = {}) {
      try {
        const account = await getPrimaryAccount(callOptions);
        return { isConnected: Boolean(account), account };
      } catch (error) {
        const normalized = toRockyWalletError(error);
        if (normalized.code === -32602) throw normalized;
        return {
          isConnected: false,
          reason: normalized.message,
        };
      }
    },

    async status(callOptions = {}) {
      const provider = await getProvider(callOptions);
      const network = await getActiveNetwork(callOptions);
      const connection = await sdk.isConnected(callOptions);
      return {
        connection,
        provider: {
          id: "rocky-wallet-extension",
          version: getProviderVersion(provider),
          providerType: "browser",
        },
        network: {
          networkId: network.id || network.networkId || "CANTON_NETWORK",
        },
      };
    },

    getPrimaryAccount,

    async getActiveAccount(callOptions = {}) {
      return getPrimaryAccount(callOptions);
    },

    async getAccounts(callOptions = {}) {
      const provider = await getProvider(callOptions);
      if (typeof provider.getAccounts === "function") {
        return callProviderMethod(provider, "getAccounts");
      }
      const account = await callProviderMethod(provider, "getPrimaryAccount");
      return account ? [account] : undefined;
    },

    getActiveNetwork,

    async getWalletMetadata(callOptions = {}) {
      const provider = await getProvider(callOptions);
      return {
        id: "rocky-wallet",
        name: "Rocky Wallet",
        target: "local",
        icon: "",
        version: getProviderVersion(provider),
      };
    },

    async getCoinsBalance(request = {}) {
      const provider = await getProvider(request);
      return callProviderMethod(provider, "getCoinsBalance", request);
    },

    async getBalance(request = {}) {
      return sdk.getCoinsBalance(request);
    },

    async getCoinsList(request = {}) {
      const result = await sdk.getCoinsBalance(request);
      return { items: result?.tokens || result?.items || [] };
    },

    async signMessage(request) {
      const provider = await getProvider(request || {});
      return callProviderMethod(provider, "signMessage", request);
    },

    async signLoginChallenge(challenge, options = {}) {
      const provider = await getProvider(options);
      return callProviderMethod(provider, "signMessage", buildLoginChallengeSignRequest(challenge, options));
    },

    async submitCommands(request) {
      const provider = await getProvider(request || {});
      return callProviderMethod(provider, "submitCommands", request);
    },

    async buildTransfer(request = {}) {
      const provider = await getProvider(request);
      return callProviderMethod(provider, "buildTransfer", request);
    },

    async sendTransfer(request = {}) {
      const provider = await getProvider(request);
      if (typeof provider.sendTransfer === "function") {
        return callProviderMethod(provider, "sendTransfer", request);
      }
      return callProviderMethod(provider, "submitCommands", request);
    },

    async transfer(to, amount, instrument, options = {}) {
      const provider = await getProvider(options);
      const token = resolveRockyAssetSymbol(instrument);
      if (typeof provider.transfer === "function") {
        return callProviderMethod(provider, "transfer", to, amount, token, options);
      }
      const request = {
        to,
        amount: String(amount),
        token,
        memo: options.memo || options.message || "",
        options,
      };
      if (typeof provider.sendTransfer === "function") {
        return callProviderMethod(provider, "sendTransfer", request);
      }
      return callProviderMethod(provider, "submitCommands", request);
    },

    async getNodeOffers(request = {}) {
      const provider = await getProvider(request);
      return callProviderMethod(provider, "getNodeOffers", request);
    },

    async submitInstructionChoice(request = {}) {
      const provider = await getProvider(request);
      return callProviderMethod(provider, "submitInstructionChoice", request);
    },

    async getOffers(request = {}) {
      return sdk.getNodeOffers(request);
    },

    async getTransfer() {
      return unsupported("getTransfer");
    },

    async getTokenTransfers() {
      return unsupported("getTokenTransfers");
    },

    async getNodeTransfer() {
      return unsupported("getNodeTransfer");
    },

    async getNodeTransfers() {
      return unsupported("getNodeTransfers");
    },

    async signBatch() {
      return unsupported("signBatch");
    },

    async encrypt() {
      return unsupported("encrypt");
    },

    async decrypt() {
      return unsupported("decrypt");
    },

    async ledgerAuth() {
      return unsupported("ledgerAuth");
    },

    async ledgerRefresh() {
      return unsupported("ledgerRefresh");
    },

    async ledgerApi() {
      return unsupported("ledgerApi");
    },

    async getContracts() {
      return unsupported("getContracts");
    },

    async prepareExecute() {
      return unsupported("prepareExecute");
    },

    async prepareExecuteAndWait() {
      return unsupported("prepareExecuteAndWait");
    },

    onAccountsChanged(onChange) {
      return subscribeToWindowEvent(injectedWindow || globalThis.window, "rockyWallet#accountsChanged", onChange);
    },

    onConnectionStatusChanged(onChange) {
      return subscribeToWindowEvent(injectedWindow || globalThis.window, "rockyWallet#connectionStatusChanged", onChange);
    },

    onTxStatusChanged(onChange) {
      return subscribeToWindowEvent(injectedWindow || globalThis.window, "rockyWallet#txStatusChanged", onChange);
    },
  };

  return sdk;
}

export const rockyWallet = createRockyWalletSdk();

export function createRockyWalletClient(options = {}) {
  const sdk = createRockyWalletSdk(options);
  let initialized = false;
  let appName = "Rocky dApp";
  let onAccept = null;
  let onReject = null;
  let activeProvider = null;

  async function getClientProvider(callOptions = {}) {
    assertNoWalletSecrets(callOptions, "provider options");
    if (options.provider) return options.provider;
    return resolveInjectedProvider(options.window || globalThis.window, callOptions);
  }

  function requireProvider() {
    if (!activeProvider) {
      throw new RockyWalletError("SDK not connected. Call connect() and wait for acceptance first.", { code: 4900 });
    }
    return activeProvider;
  }

  const wallet = {
    async transfer(recipient, amount, instrument, transferOptions = {}) {
      const provider = requireProvider();
      const token = resolveRockyAssetSymbol(instrument);
      if (typeof provider.transfer === "function") {
        return callProviderMethod(provider, "transfer", recipient, amount, token, transferOptions);
      }
      const request = {
        to: recipient,
        amount: String(amount),
        token,
        memo: transferOptions.memo || transferOptions.message || "",
        options: transferOptions,
      };
      if (typeof provider.sendTransfer === "function") {
        return callProviderMethod(provider, "sendTransfer", request);
      }
      return callProviderMethod(provider, "submitCommands", request);
    },

    async signMessage(message) {
      return callProviderMethod(requireProvider(), "signMessage", message);
    },

    async signLoginChallenge(challenge, options = {}) {
      return callProviderMethod(requireProvider(), "signMessage", buildLoginChallengeSignRequest(challenge, options));
    },

    async submitCommands(command) {
      return callProviderMethod(requireProvider(), "submitCommands", command);
    },

    async buildTransfer(command) {
      return callProviderMethod(requireProvider(), "buildTransfer", command);
    },

    async sendTransfer(command) {
      const provider = requireProvider();
      if (typeof provider.sendTransfer === "function") {
        return callProviderMethod(provider, "sendTransfer", command);
      }
      return callProviderMethod(provider, "submitCommands", command);
    },

    async getCoinsBalance(request = {}) {
      return callProviderMethod(requireProvider(), "getCoinsBalance", request);
    },
  };

  const client = {
    wallet,
    sdk,

    get provider() {
      return activeProvider;
    },

    init(config = {}) {
      if (!options.provider && !getMaybeWindow(options.window)) {
        throw new RockyWalletError(
          "RockyWalletClient can only be initialized in a browser environment or with an injected provider.",
          { code: 4900 },
        );
      }
      initialized = true;
      appName = config.appName || appName;
      onAccept = typeof config.onAccept === "function" ? config.onAccept : null;
      onReject = typeof config.onReject === "function" ? config.onReject : null;
      return client;
    },

    async autoConnect(callOptions = {}) {
      ensureInitialized(initialized);
      try {
        const provider = await getClientProvider(callOptions);
        const account = await callProviderMethod(provider, "getPrimaryAccount");
        if (account) {
          activeProvider = provider;
          onAccept?.(provider);
        }
        return account;
      } catch (error) {
        const normalized = toRockyWalletError(error);
        if (normalized.code === 4900) return undefined;
        throw normalized;
      }
    },

    async connect(request = {}) {
      ensureInitialized(initialized);
      const provider = await getClientProvider(request);
      try {
        const response = await callProviderMethod(provider, "connect", {
          name: request.name || appName,
          icon: request.icon,
          target: request.target || "local",
          ...request,
        });
        if (response?.isConnected !== false) {
          activeProvider = provider;
          onAccept?.(provider);
        }
        return response;
      } catch (error) {
        onReject?.();
        throw toRockyWalletError(error);
      }
    },

    async disconnect() {
      ensureInitialized(initialized);
      if (activeProvider) {
        if (typeof activeProvider.disconnect === "function") {
          await callProviderMethod(activeProvider, "disconnect");
        }
      }
      activeProvider = null;
      return { status: true };
    },

    getPrimaryAccount(...args) {
      return sdk.getPrimaryAccount(...args);
    },

    getActiveAccount(...args) {
      return sdk.getActiveAccount(...args);
    },

    getAccounts(...args) {
      return sdk.getAccounts(...args);
    },

    getActiveNetwork(...args) {
      return sdk.getActiveNetwork(...args);
    },

    getCoinsBalance(...args) {
      return sdk.getCoinsBalance(...args);
    },

    signMessage(...args) {
      return sdk.signMessage(...args);
    },

    signLoginChallenge(...args) {
      return sdk.signLoginChallenge(...args);
    },

    submitCommands(...args) {
      return sdk.submitCommands(...args);
    },

    buildTransfer(...args) {
      return sdk.buildTransfer(...args);
    },

    sendTransfer(...args) {
      return sdk.sendTransfer(...args);
    },

    transfer(...args) {
      return sdk.transfer(...args);
    },

    getOffers(...args) {
      return sdk.getOffers(...args);
    },

    getNodeOffers(...args) {
      return sdk.getNodeOffers(...args);
    },

    submitInstructionChoice(...args) {
      return sdk.submitInstructionChoice(...args);
    },
  };

  return client;
}

export const rocky = createRockyWalletClient();

export const utils = {
  equalBytes(a, b) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
    if (a.length !== b.length) return false;
    return a.every((value, index) => value === b[index]);
  },

  base64ToBytes(base64) {
    const binary = decodeBase64(base64);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  },

  base64ToHex(base64) {
    return utils.toHex(utils.base64ToBytes(base64));
  },

  toBase64(bytes) {
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    return encodeBase64(binary);
  },

  hexToBase64(hex) {
    return utils.toBase64(utils.hexToBytes(hex));
  },

  hexToBytes(hex) {
    const clean = String(hex || "").replace(/^0x/i, "");
    if (clean.length % 2 !== 0) throw new RockyWalletError("hex string must have an even length", { code: -32602 });
    const matches = clean.match(/.{1,2}/g) || [];
    return Uint8Array.from(matches, (byte) => Number.parseInt(byte, 16));
  },

  toHex(bytes) {
    return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  },
};

function buildLoginChallengeSignRequest(challenge, options = {}) {
  if (typeof challenge !== "string" || !challenge.trim()) {
    throw new RockyWalletError("login challenge must be a non-empty string", { code: -32602 });
  }

  return {
    message: { hex: utf8ToHex(challenge) },
    metaData: {
      purpose: "authentication",
      app: options.app || options.appName || "Rocky Exchange",
      ...(options.metadata || {}),
      ...(options.metaData || {}),
    },
  };
}

function utf8ToHex(value) {
  return utils.toHex(new TextEncoder().encode(value));
}

function resolveInjectedProvider(win, options = {}) {
  const provider = getInjectedProvider(win);
  if (provider) return Promise.resolve(provider);
  if (!win?.addEventListener) return Promise.reject(new RockyWalletError("Rocky Wallet extension is not installed", { code: 4900 }));

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      win.removeEventListener?.(ROCKY_WALLET_INITIALIZED_EVENT, onInitialized);
      clearTimeout(timeout);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onInitialized = () => {
      const nextProvider = getInjectedProvider(win);
      if (nextProvider) settle(resolve, nextProvider);
    };
    const timeout = setTimeout(() => {
      settle(reject, new RockyWalletError("Rocky Wallet extension is not installed", { code: 4900 }));
    }, timeoutMs);
    win.addEventListener(ROCKY_WALLET_INITIALIZED_EVENT, onInitialized);
  });
}

function getInjectedProvider(win) {
  const provider = win?.rockyWallet;
  if (!provider) return null;
  if (provider.isRockyWallet || typeof provider.connect === "function") return provider;
  return null;
}

function getProviderVersion(provider) {
  return String(provider?.version || MINIMAL_CAPABLE_VERSION);
}

function compareVersions(actual, minimum) {
  const actualParts = String(actual).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const minimumParts = String(minimum).split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const left = actualParts[index] || 0;
    const right = minimumParts[index] || 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

export function resolveRockyAssetSymbol(instrument) {
  const id = String(instrument?.instrument_id || instrument?.id || instrument || "CC").toUpperCase();
  if (id.includes("USDC")) return "USDCx";
  if (id.includes("BTC")) return "CBTC";
  return "CC";
}

function subscribeToWindowEvent(win, eventName, onChange) {
  if (!win?.addEventListener || typeof onChange !== "function") return () => {};
  const handler = (event) => onChange(event.detail ?? event.data ?? event);
  win.addEventListener(eventName, handler);
  return () => win.removeEventListener?.(eventName, handler);
}

function unsupported(method) {
  throw new RockyWalletError(`${method} is not supported by the Rocky Wallet extension yet`, { code: 4200 });
}

async function callProviderMethod(provider, method, ...args) {
  const fn = provider?.[method];
  if (typeof fn !== "function") {
    throw new RockyWalletError(`Rocky Wallet provider does not support ${method}`, { code: 4200 });
  }
  for (const arg of args) {
    assertNoWalletSecrets(arg, method);
  }
  try {
    return await fn.apply(provider, args);
  } catch (error) {
    throw toRockyWalletError(error);
  }
}

function toRockyWalletError(error) {
  if (error instanceof RockyWalletError) return error;
  const originalCode = error?.code;
  return new RockyWalletError(error?.message || "Rocky Wallet request failed", {
    code: normalizeErrorCode(originalCode, error?.message),
    data: originalCode && typeof originalCode === "string" ? { ...(error?.data || {}), causeCode: originalCode } : error?.data,
  });
}

// Substrings that flag a request field as carrying wallet secret material. Matched as
// substrings (not exact keys) so variants like `seedPhrase`, `privateKeyHex`,
// `backupPhrase`, `walletSeed`, `xprv`, `wif`, `keystore` are all caught.
//
// NOTE: this is a footgun guard for well-behaved integrators, NOT a security boundary.
// The SDK runs inside the (untrusted) page, so a malicious dApp can bypass it entirely
// by calling window.rockyWallet directly or shipping a patched SDK. The real guarantee
// is that the extension never accepts or returns secret material regardless of input.
const FORBIDDEN_WALLET_SECRET_FRAGMENTS = [
  "mnemonic",
  "seedphrase",
  "seed",
  "privatekey",
  "secretkey",
  "walletpassword",
  "passphrase",
  "decryptedvault",
  "recoveryphrase",
  "backupphrase",
  "keystore",
  "xprv",
  "wif",
];

function assertNoWalletSecrets(value, method, seen = new WeakSet(), path = "") {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.replace(/[_\-\s]/g, "").toLowerCase();
    const nextPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_WALLET_SECRET_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment))) {
      throw new RockyWalletError(
        `Rocky Wallet SDK request for ${method} must not include wallet secret field ${nextPath}; wallet secrets must stay inside the extension.`,
        { code: -32602 },
      );
    }
    assertNoWalletSecrets(nested, method, seen, nextPath);
  }
}

function normalizeErrorCode(code, message = "") {
  if (typeof code === "number") return code;
  if (code === "USER_REJECTED" || code === "REJECTED" || /reject/i.test(String(message))) return 4001;
  if (code === "POPUP_CLOSED" || /closed/i.test(String(message))) return 4001;
  if (code === "UNSUPPORTED" || code === "METHOD_NOT_SUPPORTED") return 4200;
  if (code === "DISCONNECTED" || code === "LOCKED" || /not installed|locked|not connected/i.test(String(message))) return 4900;
  return -32603;
}

function ensureInitialized(initialized) {
  if (!initialized) {
    throw new RockyWalletError("SDK not initialized. Call init() first.", { code: 4900 });
  }
}

function getMaybeWindow(injectedWindow) {
  return injectedWindow || (typeof globalThis.window === "undefined" ? undefined : globalThis.window);
}

function encodeBase64(binary) {
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(binary, "binary").toString("base64");
}

function decodeBase64(base64) {
  if (typeof atob === "function") return atob(base64);
  return Buffer.from(base64, "base64").toString("binary");
}
