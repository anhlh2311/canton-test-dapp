import { useEffect, useMemo, useState } from 'react';
import './App.css';
import { useRockyWallet, type RockyStatus } from './useRockyWallet';
import { buildRockyAssetRows, type RockyAssetOption } from './rockyAssets.js';
import { ConnectionModeNav } from './ConnectionModeNav';

const STATUS_LABEL: Record<RockyStatus, string> = {
  idle: 'not connected',
  unavailable: 'extension not found',
  incompatible: 'extension update required',
  available: 'detected — not connected',
  connecting: 'connecting…',
  connected: 'connected',
  error: 'error',
};

function statusDot(status: RockyStatus): 'green' | 'yellow' | 'red' {
  if (status === 'connected') return 'green';
  if (status === 'unavailable' || status === 'incompatible' || status === 'error') return 'red';
  return 'yellow';
}

function assetOptionValue(asset: RockyAssetOption): string {
  return asset.assetId ?? `legacy:${asset.symbol}`;
}

export function RockyPage({
  onExit,
  onOpenPartyLayer,
  onOpenConsole,
}: {
  onExit: () => void;
  onOpenPartyLayer: () => void;
  onOpenConsole: () => void;
}) {
  const rocky = useRockyWallet('Canton Test dApp');
  const connected = rocky.status === 'connected';

  const [txTo, setTxTo] = useState('');
  const [txAmount, setTxAmount] = useState('');
  const [txAssetKey, setTxAssetKey] = useState('');
  const [txMemo, setTxMemo] = useState('');
  const [transferState, setTransferState] = useState<{ loading: boolean; result?: string; error?: string }>({
    loading: false,
  });

  const [loginChallenge, setLoginChallenge] = useState(() => `login-${Math.random().toString(36).slice(2, 10)}`);
  const [signState, setSignState] = useState<{ loading: boolean; signature?: string; error?: string }>({
    loading: false,
  });

  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value);
  };

  const balanceRows = useMemo(
    () => buildRockyAssetRows(rocky.catalog, rocky.balances),
    [rocky.catalog, rocky.balances],
  );
  const txAsset = rocky.transferAssets.find(
    (asset) => assetOptionValue(asset) === txAssetKey,
  );

  useEffect(() => {
    if (!txAsset && rocky.transferAssets[0]) {
      setTxAssetKey(assetOptionValue(rocky.transferAssets[0]));
    }
  }, [rocky.transferAssets, txAsset]);

  async function handleTransfer() {
    if (!txAsset) {
      setTransferState({ loading: false, error: 'No sendable Rocky asset is available.' });
      return;
    }
    setTransferState({ loading: true });
    try {
      const res = await rocky.transfer(txTo.trim(), txAmount.trim(), txAsset, txMemo.trim() || undefined);
      const r = res as { transferId?: string } | undefined;
      setTransferState({
        loading: false,
        result: r?.transferId ? `Submitted — transferId: ${r.transferId}` : 'Submitted',
      });
      await rocky.refreshBalances();
    } catch (e) {
      setTransferState({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleSignLogin() {
    setSignState({ loading: true });
    try {
      const sig = await rocky.signLogin(loginChallenge.trim());
      setSignState({ loading: false, signature: sig ?? '' });
    } catch (e) {
      setSignState({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div className="app">
      <h1>Rocky Wallet</h1>
      <p className="subtitle">
        Rocky Wallet integration — talks to the extension injected at <code>window.rockyWallet</code>
      </p>

      <ConnectionModeNav
        active="rocky"
        onStandard={onExit}
        onRocky={() => {}}
        onPartyLayer={onOpenPartyLayer}
        onConsole={onOpenConsole}
      />

      {/* Connection */}
      <section className="card">
        <h2>Connection</h2>
        <div className="status-row">
          <span className={`status-dot ${statusDot(rocky.status)}`} />
          <span>
            {STATUS_LABEL[rocky.status]}
            {rocky.version ? ` (v${rocky.version})` : ''}
          </span>
        </div>
        <div className="button-row">
          <button
            onClick={connected ? rocky.disconnect : rocky.connect}
            disabled={
              rocky.status === 'connecting' ||
              rocky.status === 'unavailable' ||
              rocky.status === 'incompatible'
            }
            title={
              rocky.status === 'unavailable'
                ? 'Rocky Wallet extension not found'
                : rocky.status === 'incompatible'
                  ? 'Rocky Wallet 1.0.2 or later is required'
                  : ''
            }
          >
            {rocky.status === 'connecting' ? 'Connecting…' : connected ? 'Disconnect' : 'Connect Rocky'}
          </button>
        </div>
        <div className="hint">
          <div>
            Prompts the Rocky Wallet extension for a local Canton connection. This page is fully
            independent of the Standard (CIP-0103) wallets — nothing here touches the other extensions.
          </div>
        </div>
        {rocky.error && (
          <div className="status-row">
            <span className="status-dot red" />
            <span>{rocky.error}</span>
          </div>
        )}
      </section>

      {/* Account */}
      {connected && rocky.account && (
        <section className="card">
          <h2>Account</h2>
          <div className="accounts-list">
            <div className="account-item primary">
              <div className="account-row">
                <span className="account-label">partyId:</span>
                <code className="account-value">{rocky.account.partyId}</code>
                <button className="sign-copy" onClick={() => copy(rocky.account!.partyId)}>
                  Copy
                </button>
                <span className="badge badge-primary">rocky</span>
              </div>
              {rocky.account.displayName && (
                <div className="account-row account-row-meta">
                  <span className="account-label">displayName:</span>
                  <code className="account-value">{rocky.account.displayName}</code>
                </div>
              )}
              {rocky.account.username && (
                <div className="account-row account-row-meta">
                  <span className="account-label">username:</span>
                  <code className="account-value">{rocky.account.username}</code>
                </div>
              )}
              {rocky.account.externalSigningKey?.publicKey && (
                <div className="account-row">
                  <span className="account-label">publicKey:</span>
                  <code className="account-value wrap">{rocky.account.externalSigningKey.publicKey}</code>
                  <button
                    className="sign-copy"
                    onClick={() => copy(rocky.account!.externalSigningKey!.publicKey!)}
                  >
                    Copy
                  </button>
                </div>
              )}
              {rocky.account.networkId && (
                <div className="account-row account-row-meta">
                  <span className="account-label">network:</span>
                  <code className="account-value">{rocky.account.networkId}</code>
                </div>
              )}
              {rocky.account.externalSigningKey?.fingerprint && (
                <div className="account-row account-row-meta">
                  <span className="account-label">fingerprint:</span>
                  <code className="account-value wrap">{rocky.account.externalSigningKey.fingerprint}</code>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Balances */}
      {connected && (
        <section className="card">
          <h2>Balances</h2>
          <p className="hint">
            Wallet balances are joined to the Rocky asset catalog by exact <code>asset_id</code>.
            Auto-refreshed on connect.
          </p>
          <div className="button-row">
            <button onClick={rocky.refreshBalances} disabled={rocky.balancesLoading}>
              {rocky.balancesLoading ? 'Refreshing…' : 'Refresh Balances'}
            </button>
          </div>
          <div className="balance-result">
            {balanceRows.map((row) => (
              <div key={row.key} className="balance-row">
                <span className="balance-label">
                  {row.label}
                  {row.label !== row.symbol ? ` (${row.symbol})` : ''}
                </span>
                <span className="balance-total-value">
                  {row.amount}
                  {row.usd ? <span className="balance-usd"> ≈ ${row.usd}</span> : null}
                </span>
              </div>
            ))}
            {(rocky.balances.length > 0 || rocky.catalog.length > 0) && (
              <details className="balance-breakdown">
                <summary>Raw catalog and balance responses</summary>
                <pre>
                  {JSON.stringify(
                    { catalog: rocky.catalog, balances: rocky.balances },
                    null,
                    2,
                  )}
                </pre>
              </details>
            )}
          </div>
        </section>
      )}

      {/* Transfer */}
      {connected && (
        <section className="card">
          <h2>Transfer</h2>
          <p className="hint">
            Sendable assets come from Rocky's catalog and use the wallet-issued <code>asset_id</code>.
            The Extension owns the confirmation, signing, and submission flow.
          </p>
          <div className="rocky-transfer-form">
            <label>
              Recipient party
              <input
                className="sign-input"
                value={txTo}
                onChange={(e) => setTxTo(e.target.value)}
                placeholder="alice::1220abc..."
              />
            </label>
            <div className="rocky-transfer-row">
              <label>
                Amount
                <input
                  className="sign-input"
                  value={txAmount}
                  onChange={(e) => setTxAmount(e.target.value)}
                  placeholder="0.0"
                  inputMode="decimal"
                />
              </label>
              <label>
                Asset
                <select
                  className="sign-input"
                  value={txAssetKey}
                  onChange={(e) => setTxAssetKey(e.target.value)}
                >
                  {rocky.transferAssets.map((asset) => (
                    <option key={assetOptionValue(asset)} value={assetOptionValue(asset)}>
                      {asset.label}
                      {asset.label !== asset.symbol ? ` (${asset.symbol})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Memo (optional)
              <input
                className="sign-input"
                value={txMemo}
                onChange={(e) => setTxMemo(e.target.value)}
                placeholder="invoice #42"
              />
            </label>
          </div>
          <div className="button-row">
            <button
              onClick={handleTransfer}
              disabled={
                transferState.loading ||
                !txAsset ||
                !txTo.trim() ||
                !txAmount.trim()
              }
            >
              {transferState.loading ? 'Sending…' : `Send ${txAsset?.label ?? 'asset'}`}
            </button>
          </div>
          {transferState.result && (
            <div className="status-row">
              <span className="status-dot green" />
              <span>{transferState.result}</span>
            </div>
          )}
          {transferState.error && (
            <div className="status-row">
              <span className="status-dot red" />
              <span>{transferState.error}</span>
            </div>
          )}
        </section>
      )}

      {/* Login signature */}
      {connected && (
        <section className="card">
          <h2>Login Signature</h2>
          <p className="hint">
            Signs a login challenge via Rocky <code>signLoginChallenge()</code> — the SDK UTF-8 encodes
            it to hex and stamps <code>metaData.purpose = "authentication"</code>.
          </p>
          <div className="rocky-transfer-form">
            <label>
              Challenge (nonce)
              <input
                className="sign-input"
                value={loginChallenge}
                onChange={(e) => setLoginChallenge(e.target.value)}
                placeholder="nonce-from-server"
              />
            </label>
          </div>
          <div className="button-row">
            <button onClick={handleSignLogin} disabled={signState.loading || !loginChallenge.trim()}>
              {signState.loading ? 'Signing…' : 'Sign Login Challenge'}
            </button>
          </div>
          {signState.signature && (
            <div className="balance-result">
              <div className="account-row">
                <span className="account-label">signature:</span>
                <code className="account-value wrap">{signState.signature}</code>
                <button className="sign-copy" onClick={() => copy(signState.signature!)}>
                  Copy
                </button>
              </div>
            </div>
          )}
          {signState.error && (
            <div className="status-row">
              <span className="status-dot red" />
              <span>{signState.error}</span>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
