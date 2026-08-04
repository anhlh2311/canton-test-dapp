import { useState } from 'react';
import './App.css';
import { useCantor8Wallet, type Cantor8Status } from './useCantor8Wallet';
import { ConnectionModeNav } from './ConnectionModeNav';

const STATUS_LABEL: Record<Cantor8Status, string> = {
  idle: 'not connected',
  connecting: 'connecting…',
  connected: 'connected',
  error: 'error',
};

function statusDot(status: Cantor8Status): 'green' | 'yellow' | 'red' {
  if (status === 'connected') return 'green';
  if (status === 'error') return 'red';
  return 'yellow';
}

export function Cantor8Page({
  onExit,
  onOpenRocky,
  onOpenPartyLayer,
  onOpenConsole,
}: {
  onExit: () => void;
  onOpenRocky: () => void;
  onOpenPartyLayer: () => void;
  onOpenConsole: () => void;
}) {
  const c8 = useCantor8Wallet();
  const connected = c8.status === 'connected';

  const [txTo, setTxTo] = useState('');
  const [txAmount, setTxAmount] = useState('');
  const [txMemo, setTxMemo] = useState('');
  const [transferState, setTransferState] = useState<{
    loading: boolean;
    result?: string;
    error?: string;
  }>({ loading: false });

  const selectedAccount = c8.accounts.find((a) => a.partyId === c8.selectedPartyId);

  async function handleTransfer() {
    setTransferState({ loading: true });
    try {
      const { txId } = await c8.send({
        receiverPartyId: txTo.trim(),
        amount: txAmount.trim(),
        memo: txMemo.trim() || undefined,
      });
      setTransferState({ loading: false, result: `Submitted — txId: ${txId}` });
      setTxTo('');
      setTxAmount('');
      setTxMemo('');
    } catch (e) {
      setTransferState({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div className="app">
      <h1>Cantor8</h1>
      <p className="subtitle">
        Direct <code>@cantor8/wallet-connect-sdk</code> integration (not PartyLayer&apos;s Cantor8
        adapter). Docs:{' '}
        <a href="https://cantor8.mintlify.app/wallet-sdk/introduction" target="_blank" rel="noreferrer">
          Wallet SDK
        </a>
      </p>

      <ConnectionModeNav
        active="cantor8"
        onStandard={onExit}
        onRocky={onOpenRocky}
        onPartyLayer={onOpenPartyLayer}
        onConsole={onOpenConsole}
        onCantor8={() => {}}
      />

      {/* Network */}
      <section className="card">
        <h2>Network</h2>
        <div className="button-row">
          <button
            onClick={() => c8.setNetwork('devnet')}
            disabled={c8.status === 'connecting' || c8.network === 'devnet'}
          >
            devnet
          </button>
          <button
            onClick={() => c8.setNetwork('mainnet')}
            disabled={c8.status === 'connecting' || c8.network === 'mainnet'}
          >
            mainnet
          </button>
        </div>
        <p className="hint">
          Active network: <b>{c8.network}</b>. Switching networks tears down the current wallet
          session — reconnect afterward.
        </p>
      </section>

      {/* Connection */}
      <section className="card">
        <h2>Connection</h2>
        <div className="status-row">
          <span className={`status-dot ${statusDot(c8.status)}`} />
          <span>
            {STATUS_LABEL[c8.status]}
            {c8.walletVersion ? ` (v${c8.walletVersion})` : ''}
          </span>
        </div>
        <div className="button-row">
          <button onClick={connected ? c8.disconnect : c8.connect} disabled={c8.status === 'connecting'}>
            {c8.status === 'connecting' ? 'Connecting…' : connected ? 'Disconnect' : 'Connect Cantor8'}
          </button>
        </div>
        <p className="hint">
          Connect and Send both open a Cantor8 wallet popup and must be triggered by a direct user
          gesture (a click) — make sure popups are allowed for this site.
        </p>
        {c8.error && (
          <div className="status-row">
            <span className="status-dot red" />
            <span>{c8.error}</span>
          </div>
        )}
      </section>

      {connected && (
        <>
          {/* Instruments & accounts */}
          <section className="card">
            <h2>Instruments &amp; Accounts</h2>
            <div className="rocky-transfer-form">
              <label>
                Instrument
                <select
                  className="sign-input"
                  value={c8.selectedInstrumentId ?? ''}
                  onChange={(e) => c8.setSelectedInstrumentId(e.target.value || undefined)}
                  disabled={c8.instruments.length === 0}
                >
                  {c8.instruments.length === 0 && <option value="">No instruments</option>}
                  {c8.instruments.map((inst) => (
                    <option key={inst.instrumentId} value={inst.instrumentId}>
                      {inst.name} ({inst.symbol})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Party
                <select
                  className="sign-input"
                  value={c8.selectedPartyId ?? ''}
                  onChange={(e) => c8.setSelectedPartyId(e.target.value || undefined)}
                  disabled={c8.accounts.length === 0}
                >
                  {c8.accounts.length === 0 && <option value="">No accounts</option>}
                  {c8.accounts.map((acc) => (
                    <option key={acc.partyId} value={acc.partyId}>
                      {acc.accountName ?? acc.partyId}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="button-row">
              <button onClick={c8.refresh}>Refresh</button>
            </div>
            <div className="accounts-list">
              {selectedAccount ? (
                <div className="account-item primary">
                  <div className="account-row">
                    <span className="account-label">partyId:</span>
                    <code className="account-value wrap">{selectedAccount.partyId}</code>
                    <span className="badge badge-primary">selected</span>
                  </div>
                  {selectedAccount.accountName && (
                    <div className="account-row account-row-meta">
                      <span className="account-label">name:</span>
                      <code className="account-value">{selectedAccount.accountName}</code>
                    </div>
                  )}
                  {selectedAccount.holdings.length === 0 ? (
                    <div className="account-row account-row-meta">
                      <span className="account-label">holdings:</span>
                      <span className="account-value">none</span>
                    </div>
                  ) : (
                    selectedAccount.holdings.map((h) => (
                      <div key={h.instrumentId} className="account-row account-row-meta">
                        <span className="account-label">{h.instrumentId}:</span>
                        <span className="account-value">
                          {h.balance}
                          {h.balanceUsd ? ` (≈ $${h.balanceUsd})` : ''}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <p className="hint">No account selected yet.</p>
              )}
            </div>
          </section>

          {/* Transfer */}
          <section className="card">
            <h2>Transfer</h2>
            <p className="hint">
              Sends via the connected Cantor8 wallet — the wallet popup owns confirmation and
              signing. Requires a direct user gesture and popups allowed.
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
                disabled={transferState.loading || !txTo.trim() || !txAmount.trim()}
              >
                {transferState.loading ? 'Sending…' : 'Send'}
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

          {/* Tx status */}
          <section className="card">
            <h2>Tx Status</h2>
            {c8.lastTxId ? (
              <div className="accounts-list">
                <div className="account-item">
                  <div className="account-row">
                    <span className="account-label">txId:</span>
                    <code className="account-value wrap">{c8.lastTxId}</code>
                  </div>
                  <div className="account-row account-row-meta">
                    <span className="account-label">status:</span>
                    <span className="account-value">{c8.lastTxStatus ?? 'unknown'}</span>
                  </div>
                </div>
              </div>
            ) : (
              <p className="hint">No transfer submitted yet.</p>
            )}
            <div className="button-row">
              <button onClick={c8.refreshTxStatus} disabled={!c8.lastTxId}>
                Refresh Tx Status
              </button>
            </div>
          </section>
        </>
      )}

      {/* Event log */}
      <section className="card log-card">
        <h2>
          Event Log
          <button className="clear-btn" onClick={c8.clearEvents} disabled={c8.events.length === 0}>
            Clear
          </button>
        </h2>
        {c8.events.length === 0 ? (
          <p className="hint">No events yet — connect to start listening.</p>
        ) : (
          <div className="terminal-display">
            {c8.events.map((evt) => (
              <div key={evt.id} className="terminal-item">
                <div className="terminal-label">
                  {evt.type} ({new Date(evt.at).toLocaleTimeString()})
                </div>
                <div>{evt.summary}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
