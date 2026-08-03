export type ConnectionMode = 'standard' | 'rocky' | 'partylayer' | 'console';

export function ConnectionModeNav({
  active,
  onStandard,
  onRocky,
  onPartyLayer,
  onConsole,
}: {
  active: ConnectionMode;
  onStandard: () => void;
  onRocky: () => void;
  onPartyLayer: () => void;
  onConsole: () => void;
}) {
  return (
    <div className="conn-mode-nav">
      <span className="conn-mode-label">Connection type:</span>
      <button
        className={`conn-mode-btn ${active === 'standard' ? 'active' : ''}`}
        onClick={onStandard}
        disabled={active === 'standard'}
      >
        Standard Wallets
      </button>
      <button
        className={`conn-mode-btn ${active === 'rocky' ? 'active' : ''}`}
        onClick={onRocky}
        disabled={active === 'rocky'}
      >
        Rocky Wallet
      </button>
      <button
        className={`conn-mode-btn ${active === 'partylayer' ? 'active' : ''}`}
        onClick={onPartyLayer}
        disabled={active === 'partylayer'}
      >
        PartyLayer
      </button>
      <button
        className={`conn-mode-btn ${active === 'console' ? 'active' : ''}`}
        onClick={onConsole}
        disabled={active === 'console'}
      >
        Console Wallet
      </button>
    </div>
  );
}
