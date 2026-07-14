export type ConnectionMode = 'standard' | 'rocky';

export function ConnectionModeNav({
  active,
  onStandard,
  onRocky,
}: {
  active: ConnectionMode;
  onStandard: () => void;
  onRocky: () => void;
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
    </div>
  );
}
