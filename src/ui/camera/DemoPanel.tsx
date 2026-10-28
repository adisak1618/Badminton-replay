// "Demo score": this phone plays the scoreboard for the camera (same-phone source). It drives the Phase 1
// match store directly and sends REC/Stop through the source like the scoreboard phone will (D11).
import { useState, useSyncExternalStore } from 'react';
import { configFromSetup, DEFAULT_SETUP, other, type Team } from '../../engine';
import type { LocalSource } from '../../link/local';
import { store } from '../../match/live';
import { loadLastSetup } from '../../match/prefs';
import { elapsed } from '../format';

export function DemoPanel({ source }: { source: LocalSource }) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const report = useSyncExternalStore(source.watch, () => source.lastReport);
  const ack = useSyncExternalStore(source.watch, () => source.lastAck);
  const [open, setOpen] = useState(true);
  const { match, state: s } = snap;
  const btn = 'btn min-h-10 px-3 py-1 text-sm';

  const start = () => store.start(configFromSetup(loadLastSetup() ?? DEFAULT_SETUP));
  const point = (team: Team) => store.emit({ type: 'point', team });

  if (!open)
    return (
      <button className="btn absolute bottom-2 left-2 z-20 min-h-10 bg-pan/95 text-sm" onClick={() => setOpen(true)}>
        Demo score ›
      </button>
    );
  return (
    <div
      className="absolute bottom-2 left-2 z-20 flex w-[300px] max-w-[calc(100%-1rem)] flex-col gap-2 rounded-xl border border-line bg-pan/95 p-2 text-sm"
      data-testid="demo-panel"
    >
      <div className="flex items-center justify-between font-semibold">
        <span>Demo score (this phone)</span>
        <span className="flex items-center gap-2 text-xs text-mut">
          not recorded
          <button className="btn btn-ghost min-h-8 px-2 py-0" onClick={() => setOpen(false)} aria-label="Hide the demo panel">
            ‹
          </button>
        </span>
      </div>
      {!match || !s ? (
        <button className={`${btn} btn-pri`} onClick={start}>
          Start demo match
        </button>
      ) : (
        <>
          {s.phase === 'playing' || s.phase === 'interval' ? (
            <div className="grid grid-cols-2 gap-2">
              {[s.leftTeam, other(s.leftTeam)].map((t) => (
                <button key={t} className={btn} style={{ background: `${match.config.teams[t].color}40` }} onClick={() => point(t)} data-testid={`demo-point-${t}`}>
                  {match.config.teams[t].name} +1 ({s.score[t]})
                </button>
              ))}
            </div>
          ) : s.phase === 'gameOver' ? (
            <button className={`${btn} btn-pri`} onClick={() => store.emit({ type: 'game.start', game: s.game + 1 })}>
              Start game {s.game + 1}
            </button>
          ) : (
            <button className={`${btn} btn-pri`} onClick={start}>
              New demo match
            </button>
          )}
          <div className="grid grid-cols-4 gap-1.5">
            <button className={btn} onClick={() => store.undo()} disabled={!store.canUndo()} data-testid="demo-undo">
              ↶ Undo
            </button>
            <button className={btn} onClick={() => store.redo()} disabled={!store.canRedo()}>
              ↷ Redo
            </button>
            <button className={btn} onClick={() => store.emit({ type: 'sides.swap' })}>
              Ends
            </button>
            <button className={btn} onClick={start} data-testid="demo-new">
              New
            </button>
          </div>
        </>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button className={btn} onClick={() => source.command('rec.start')} data-testid="demo-rec">
          ● Remote REC
        </button>
        <button className={btn} onClick={() => source.command('rec.stop')} data-testid="demo-stop">
          ■ Remote stop
        </button>
      </div>
      <div className="text-xs text-mut" data-testid="demo-report">
        camera reports: <b className="text-fg">{report.state}</b>
        {report.segment ? ` · segment ${report.segment}` : ''}
        {report.elapsedMs != null && report.state === 'recording' ? ` · ${elapsed(report.elapsedMs)}` : ''}
        {report.error ? ` · ${report.error}` : ''}
        {ack ? ` · last command ${ack.ok ? 'ok' : `refused: ${ack.error}`}` : ''}
      </div>
    </div>
  );
}
