import { useState, type ReactNode } from 'react';
import './App.css';
import { ConnectionModeNav } from './ConnectionModeNav';
import {
  formatConsoleError,
  maskToken,
  useConsoleWallet,
  type ConsoleConnectTarget,
} from './useConsoleWallet';

type StepResult = {
  ok: boolean;
  label: string;
  raw?: string;
  error?: string;
};

function statusDot(status: string): 'green' | 'yellow' | 'red' {
  if (status === 'connected') return 'green';
  if (status === 'unavailable' || status === 'error') return 'red';
  return 'yellow';
}

function StepCard({
  n,
  title,
  hint,
  children,
  result,
}: {
  n: number;
  title: string;
  hint: string;
  children: ReactNode;
  result?: StepResult | null;
}) {
  return (
    <section className="card">
      <h2>
        {n}. {title}
      </h2>
      <p className="hint">{hint}</p>
      {children}
      {result?.error && (
        <pre className="hint" style={{ whiteSpace: 'pre-wrap', color: 'var(--error, #c44)' }}>
          {result.error}
        </pre>
      )}
      {result?.ok && result.label && (
        <div className="status-row">
          <span className="status-dot green" />
          <span>{result.label}</span>
        </div>
      )}
      {result?.raw && (
        <details className="balance-breakdown">
          <summary>Raw response</summary>
          <pre>{result.raw}</pre>
        </details>
      )}
    </section>
  );
}

export function ConsolePage({
  onExit,
  onOpenRocky,
  onOpenPartyLayer,
  onOpenCantor8,
}: {
  onExit: () => void;
  onOpenRocky: () => void;
  onOpenPartyLayer: () => void;
  onOpenCantor8: () => void;
}) {
  const cw = useConsoleWallet();
  const connected = cw.status === 'connected';
  const hasTokens = Boolean(cw.tokens?.accessToken);

  const [signInput, setSignInput] = useState('Hello from Console walkthrough');
  const [txTo, setTxTo] = useState('');
  const [txAmount, setTxAmount] = useState('');
  const [txMemo, setTxMemo] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [stepResults, setStepResults] = useState<Record<string, StepResult>>({});

  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value);
  };

  async function runStep(key: string, label: string, fn: () => Promise<unknown>) {
    setBusy(key);
    cw.setError(undefined);
    try {
      const out = await fn();
      const raw = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
      setStepResults((prev) => ({
        ...prev,
        [key]: { ok: true, label, raw },
      }));
    } catch (e) {
      setStepResults((prev) => ({
        ...prev,
        [key]: { ok: false, label: '', error: formatConsoleError(e) },
      }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="app">
      <h1>Console Wallet</h1>
      <p className="subtitle">
        Docs walkthrough —{' '}
        <a href="https://www.npmjs.com/package/@console-wallet/dapp-sdk" target="_blank" rel="noreferrer">
          @console-wallet/dapp-sdk
        </a>{' '}
        +{' '}
        <a href="https://consolewallet.io/develop/ledger" target="_blank" rel="noreferrer">
          Ledger API proxy
        </a>
      </p>

      <ConnectionModeNav
        active="console"
        onStandard={onExit}
        onRocky={onOpenRocky}
        onPartyLayer={onOpenPartyLayer}
        onConsole={() => {}}
        onCantor8={onOpenCantor8}
      />

      <StepCard
        n={1}
        title="Setup & connect"
        hint="Check extension availability, choose local / remote / combined, then connect. Remote/QR uses Console’s relay — if you hit HTTP 429, wait ~30–60s or switch to local. Connect times out so the UI cannot freeze forever."
        result={stepResults.connect}
      >
        <div className="status-row">
          <span className={`status-dot ${statusDot(cw.status)}`} />
          <span>
            {cw.status}
            {cw.availability
              ? ` — extension ${cw.availability.installed ? 'installed' : 'not installed'}`
              : ''}
            {cw.status === 'connecting' || busy === 'connect'
              ? ' (waiting for wallet / QR — use Cancel if stuck)'
              : ''}
          </span>
        </div>
        {cw.error && (
          <pre className="hint" style={{ whiteSpace: 'pre-wrap', color: 'var(--error, #c44)' }}>
            {cw.error}
          </pre>
        )}
        <div className="partylayer-network-row">
          <span className="account-label">Connect target:</span>
          <select
            className="verify-scheme"
            value={cw.target}
            disabled={connected || cw.status === 'connecting' || busy === 'connect'}
            onChange={(e) => cw.setTarget(e.target.value as ConsoleConnectTarget)}
          >
            <option value="combined">combined (extension preferred)</option>
            <option value="local">local (extension only)</option>
            <option value="remote">remote (QR / mobile)</option>
          </select>
        </div>
        <div className="button-row">
          <button
            onClick={() =>
              runStep('avail', 'Availability checked', () => cw.checkAvailability())
            }
            disabled={busy !== null || cw.status === 'connecting'}
          >
            {busy === 'avail' ? 'Checking…' : 'Check extension'}
          </button>
          {cw.status === 'connecting' || busy === 'connect' ? (
            <button
              onClick={async () => {
                await cw.cancelConnect();
                setBusy(null);
                setStepResults((prev) => ({
                  ...prev,
                  connect: {
                    ok: false,
                    label: '',
                    error: 'Connect cancelled. Wait before retrying remote/QR if you saw 429.',
                  },
                }));
              }}
            >
              Cancel connect
            </button>
          ) : (
            <button
              onClick={() =>
                runStep('connect', connected ? 'Disconnected' : 'Connected', async () => {
                  if (connected) {
                    await cw.disconnect();
                    return { disconnected: true };
                  }
                  await cw.connect();
                  return { account: cw.account, network: cw.network };
                })
              }
              disabled={busy !== null || cw.status === 'unavailable'}
            >
              {connected ? 'Disconnect' : 'Connect'}
            </button>
          )}
        </div>
        {stepResults.avail?.raw && (
          <details className="balance-breakdown">
            <summary>Availability raw</summary>
            <pre>{stepResults.avail.raw}</pre>
          </details>
        )}
      </StepCard>

      <StepCard
        n={2}
        title="Session"
        hint="Primary account and active network from the Console SDK after connect."
      >
        {!connected ? (
          <p className="hint">Connect in step 1 first.</p>
        ) : (
          <div className="status-detail">
            <div className="status-grid">
              <div>
                <b>partyId:</b>{' '}
                <code className="account-value wrap">{cw.account?.partyId}</code>{' '}
                <button className="sign-copy" onClick={() => copy(cw.account?.partyId ?? '')}>
                  Copy
                </button>
              </div>
              <div>
                <b>publicKey:</b>{' '}
                <code className="account-value wrap">{cw.account?.publicKey}</code>
              </div>
              <div>
                <b>network.id:</b> <code>{cw.network?.id ?? '—'}</code>
              </div>
              <div>
                <b>networkId:</b> <code>{cw.network?.networkId ?? cw.account?.networkId ?? '—'}</code>
              </div>
              <div>
                <b>baseUrl:</b> <code className="wrap">{cw.network?.baseUrl ?? '—'}</code>
              </div>
            </div>
            <div className="button-row">
              <button
                onClick={() =>
                  runStep('session', 'Session refreshed', () => cw.refreshSession())
                }
                disabled={busy !== null}
              >
                {busy === 'session' ? 'Refreshing…' : 'Refresh session'}
              </button>
            </div>
          </div>
        )}
      </StepCard>

      <StepCard
        n={3}
        title="Sign message"
        hint="SDK signMessage with base64 payload (Console-validated shape)."
        result={stepResults.sign}
      >
        <textarea
          className="sign-input"
          rows={2}
          value={signInput}
          onChange={(e) => setSignInput(e.target.value)}
          disabled={!connected || busy !== null}
        />
        <div className="button-row">
          <button
            onClick={() =>
              runStep('sign', 'Message signed', () => cw.signMessage(signInput))
            }
            disabled={!connected || busy !== null || !signInput.trim()}
          >
            {busy === 'sign' ? 'Signing…' : 'Sign message'}
          </button>
        </div>
      </StepCard>

      <StepCard
        n={4}
        title="Ledger auth (JWT)"
        hint="ledgerAuth challenge-response — access ~10m, refresh ~7d. Required for AUTH=Yes ledger proxy routes."
        result={stepResults.auth}
      >
        <div className="button-row">
          <button
            onClick={() =>
              runStep('auth', 'Ledger tokens obtained', async () => {
                const t = await cw.ledgerAuth();
                return {
                  accessToken: maskToken(t.accessToken),
                  refreshToken: maskToken(t.refreshToken),
                  network: t.network,
                  partyId: t.partyId,
                };
              })
            }
            disabled={!connected || busy !== null}
          >
            {busy === 'auth' ? 'Authenticating…' : 'Run ledgerAuth'}
          </button>
        </div>
        {cw.tokens && (
          <div className="status-detail">
            <div className="account-row">
              <span className="account-label">accessToken:</span>
              <code>{maskToken(cw.tokens.accessToken)}</code>
              <button className="sign-copy" onClick={() => copy(cw.tokens!.accessToken)}>
                Copy
              </button>
            </div>
            <div className="account-row">
              <span className="account-label">refreshToken:</span>
              <code>{maskToken(cw.tokens.refreshToken)}</code>
              <button className="sign-copy" onClick={() => copy(cw.tokens!.refreshToken)}>
                Copy
              </button>
            </div>
          </div>
        )}
      </StepCard>

      <StepCard
        n={5}
        title="Verify connectivity"
        hint="Authenticated ledgerApi GET /v2/version via Console proxy."
        result={stepResults.version}
      >
        <div className="button-row">
          <button
            onClick={() =>
              runStep('version', 'Ledger version OK', () =>
                cw.ledgerApi({ requestMethod: 'GET', resource: '/v2/version' }),
              )
            }
            disabled={!connected || busy !== null}
            title={!hasTokens ? 'Will run ledgerAuth automatically if needed' : ''}
          >
            {busy === 'version' ? 'Calling…' : 'GET /v2/version'}
          </button>
        </div>
      </StepCard>

      <StepCard
        n={6}
        title="Ledger offset"
        hint="Try GET /v2/state/ledger-end first, then GET /v2/ledger-end (Console quick start)."
        result={stepResults.ledgerEnd}
      >
        <div className="button-row">
          <button
            onClick={() =>
              runStep('ledgerEnd', 'Ledger end OK', () => cw.getLedgerEnd())
            }
            disabled={!connected || busy !== null}
          >
            {busy === 'ledgerEnd' ? 'Calling…' : 'Get ledger-end'}
          </button>
        </div>
      </StepCard>

      <StepCard
        n={7}
        title="Active contracts / balance"
        hint="AUTH’d POST /v2/state/active-contracts, plus Console getCoinsBalance (token-standard)."
        result={stepResults.acs}
      >
        <div className="button-row">
          <button
            onClick={() =>
              runStep('acs', 'Active contracts queried', async () => {
                const end = await cw.getLedgerEnd();
                const parsed = JSON.parse(end.response) as { offset?: number | string };
                if (parsed.offset === undefined) {
                  throw new Error(`No offset in ledger-end response: ${end.response}`);
                }
                const party = cw.account?.partyId;
                if (!party) throw new Error('No partyId');
                const acs = await cw.queryActiveContracts(party, parsed.offset);
                return { ledgerEndPath: end.tried ?? end.resource, acs };
              })
            }
            disabled={!connected || busy !== null}
          >
            {busy === 'acs' ? 'Querying…' : 'POST active-contracts'}
          </button>
          <button
            onClick={() =>
              runStep('coins', 'Coins balance OK', () => cw.getCoinsBalance())
            }
            disabled={!connected || busy !== null}
          >
            {busy === 'coins' ? 'Querying…' : 'getCoinsBalance'}
          </button>
        </div>
        {stepResults.coins?.raw && (
          <details className="balance-breakdown">
            <summary>getCoinsBalance raw</summary>
            <pre>{stepResults.coins.raw}</pre>
          </details>
        )}
        {stepResults.coins?.error && (
          <pre className="hint" style={{ whiteSpace: 'pre-wrap', color: 'var(--error, #c44)' }}>
            {stepResults.coins.error}
          </pre>
        )}
      </StepCard>

      <StepCard
        n={8}
        title="Transfer CC"
        hint="Console SDK submitCommands (SignSendRequest) — from = connected party, token = CC. Extension prompts to approve. Solely @console-wallet/dapp-sdk; not PartyLayer / ledger proxy."
        result={stepResults.transfer}
      >
        {!connected ? (
          <p className="hint">Connect in step 1 first.</p>
        ) : (
          <div className="rocky-transfer-form">
            <div className="account-row account-row-meta">
              <span className="account-label">from:</span>
              <code className="account-value wrap">{cw.account?.partyId ?? '—'}</code>
            </div>
            <label className="hint">
              To (party id)
              <input
                className="sign-input"
                style={{ display: 'block', width: '100%', marginTop: 4 }}
                value={txTo}
                onChange={(e) => setTxTo(e.target.value)}
                placeholder="receiver::1220…"
                disabled={busy !== null}
              />
            </label>
            <div className="rocky-transfer-row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label className="hint" style={{ flex: '1 1 120px' }}>
                Amount (CC)
                <input
                  className="sign-input"
                  style={{ display: 'block', width: '100%', marginTop: 4 }}
                  value={txAmount}
                  onChange={(e) => setTxAmount(e.target.value)}
                  placeholder="1.5"
                  disabled={busy !== null}
                />
              </label>
              <label className="hint" style={{ flex: '2 1 200px' }}>
                Memo (optional)
                <input
                  className="sign-input"
                  style={{ display: 'block', width: '100%', marginTop: 4 }}
                  value={txMemo}
                  onChange={(e) => setTxMemo(e.target.value)}
                  placeholder="Payment for services"
                  disabled={busy !== null}
                />
              </label>
            </div>
            <p className="hint">Offer expires in 24h (expireDate ISO). waitForFinalization = 5000ms.</p>
            <div className="button-row">
              <button
                onClick={() =>
                  runStep('transfer', 'CC transfer submitted', () =>
                    cw.transferCc({
                      to: txTo,
                      amount: txAmount,
                      memo: txMemo || undefined,
                    }),
                  )
                }
                disabled={
                  busy !== null || !connected || !txTo.trim() || !txAmount.trim()
                }
              >
                {busy === 'transfer' ? 'Sending…' : 'Send CC'}
              </button>
            </div>
          </div>
        )}
      </StepCard>

      <StepCard
        n={9}
        title="Submit Ping"
        hint="prepareExecuteAndWait with Canton.Internal.Ping (fused sign+submit)."
        result={stepResults.ping}
      >
        <div className="button-row">
          <button
            onClick={() => runStep('ping', 'Ping submitted', () => cw.createPing())}
            disabled={!connected || busy !== null}
          >
            {busy === 'ping' ? 'Submitting…' : 'Create Ping contract'}
          </button>
        </div>
      </StepCard>

      <StepCard
        n={10}
        title="Refresh token"
        hint="ledgerRefresh with the same publicKey; older refresh tokens become invalid."
        result={stepResults.refresh}
      >
        <div className="button-row">
          <button
            onClick={() =>
              runStep('refresh', 'Tokens refreshed', async () => {
                const t = await cw.ledgerRefresh();
                return {
                  accessToken: maskToken(t.accessToken),
                  refreshToken: maskToken(t.refreshToken),
                };
              })
            }
            disabled={!connected || !hasTokens || busy !== null}
          >
            {busy === 'refresh' ? 'Refreshing…' : 'ledgerRefresh'}
          </button>
        </div>
      </StepCard>
    </div>
  );
}
