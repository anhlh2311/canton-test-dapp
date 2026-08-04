import './App.css';
import { ConnectionModeNav } from './ConnectionModeNav';

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
  return (
    <div className="app">
      <h1>Cantor8</h1>
      <p className="subtitle">
        Cantor8 Wallet Connect SDK — <code>@cantor8/wallet-connect-sdk</code> popup +{' '}
        <code>postMessage</code>
      </p>
      <ConnectionModeNav
        active="cantor8"
        onStandard={onExit}
        onRocky={onOpenRocky}
        onPartyLayer={onOpenPartyLayer}
        onConsole={onOpenConsole}
        onCantor8={() => {}}
      />
      <section className="card">
        <h2>Scaffold</h2>
        <p className="hint">Hook and UI land in the next tasks.</p>
      </section>
    </div>
  );
}
