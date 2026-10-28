// S5 menu: full-height rows of at least 56 px. Ending or replacing a live match asks once more. The camera
// rows pair, unpair, and start or stop the camera phone's recording (D11). With point reasons on (D15): the
// rally list, whether this phone asks, and how soon an untagged popup closes. The match's own match.json.
import { useState } from 'react';
import type { MatchConfig, MatchState } from '../engine';
import { TAG_CLOSE_OPTIONS, type Prefs } from '../match/prefs';
import { CameraMenuRows } from './CameraLink';
import { DiagSheet } from './DiagSheet';

export function Menu({
  s,
  prefs,
  setPrefs,
  onClose,
  onCorrect,
  onSwapEnds,
  onEndMatch,
  onNewMatch,
  onUpdate,
  onPair,
  reasons,
  onRallyList,
  onExport,
}: {
  config: MatchConfig;
  s: MatchState;
  prefs: Prefs;
  setPrefs: (p: Prefs) => void;
  onClose: () => void;
  onCorrect: () => void;
  onSwapEnds: () => void;
  onEndMatch: () => void;
  onNewMatch: () => void;
  onUpdate: (() => void) | null;
  onPair: () => void;
  /** The match asks why points were won. */
  reasons: boolean;
  onRallyList: () => void;
  onExport: () => void;
}) {
  const [confirm, setConfirm] = useState<'end' | 'new' | null>(null);
  const [diag, setDiag] = useState(false);
  const over = s.phase === 'matchOver';
  const row = 'btn min-h-14 w-full bg-pan2 text-left';
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 p-3" onClick={onClose}>
      <div
        className="sheet grid max-h-full w-[min(640px,100%)] grid-cols-2 gap-2 overflow-y-auto p-3"
        role="dialog"
        aria-label="Menu"
        onClick={(e) => e.stopPropagation()}
      >
        <CameraMenuRows row={row} onPair={onPair} />
        <button className={row} onClick={onCorrect}>
          Correct score
        </button>
        <button className={row} onClick={onSwapEnds}>
          Swap ends
        </button>
        <button className={row} aria-pressed={prefs.sound} onClick={() => setPrefs({ ...prefs, sound: !prefs.sound })}>
          Sound: <b>{prefs.sound ? 'on' : 'off'}</b>
        </button>
        <button className={row} aria-pressed={prefs.voice} onClick={() => setPrefs({ ...prefs, voice: !prefs.voice })}>
          Voice: <b>{prefs.voice ? 'on' : 'off'}</b>
        </button>
        <button className={row} onClick={() => setPrefs({ ...prefs, lang: prefs.lang === 'en' ? 'th' : 'en' })}>
          Voice language: <b>{prefs.lang === 'en' ? 'English' : 'ไทย (Thai)'}</b>
        </button>
        {reasons && (
          <>
            <button className={row} onClick={onRallyList} data-testid="menu-rally-list">
              🏷 Rally list · tag points
            </button>
            <button
              className={row}
              aria-pressed={prefs.askReasons}
              onClick={() => setPrefs({ ...prefs, askReasons: !prefs.askReasons })}
              data-testid="menu-ask-reasons"
            >
              Ask why after each point (this phone): <b>{prefs.askReasons ? 'on' : 'off'}</b>
            </button>
            <button
              className={row}
              onClick={() => {
                const i = TAG_CLOSE_OPTIONS.indexOf(prefs.tagCloseS);
                setPrefs({ ...prefs, tagCloseS: TAG_CLOSE_OPTIONS[(i + 1) % TAG_CLOSE_OPTIONS.length] });
              }}
            >
              Untagged popup hides after: <b>{prefs.tagCloseS ? `${prefs.tagCloseS} s` : 'never'}</b>
            </button>
          </>
        )}
        <button className={row} onClick={onExport} data-testid="menu-export">
          Export this match (match.json)
        </button>
        {!over && (
          <button
            className={`${row} ${confirm === 'end' ? 'bg-red/30' : ''}`}
            onClick={() => (confirm === 'end' ? onEndMatch() : setConfirm('end'))}
          >
            {confirm === 'end' ? 'Tap again to end the match' : 'End match'}
          </button>
        )}
        <button
          className={`${row} ${confirm === 'new' ? 'bg-red/30' : ''}`}
          onClick={() => (over || confirm === 'new' ? onNewMatch() : setConfirm('new'))}
        >
          {confirm === 'new' ? 'Tap again: this match is left behind' : 'New match'}
        </button>
        {onUpdate && (
          <button className={`${row} bg-pri/40`} onClick={onUpdate}>
            Update the app {over ? '' : '(reloads)'}
          </button>
        )}
        <button className={row} onClick={() => setDiag(true)}>
          Pairing diagnostics
        </button>
        <button className={`${row} btn-ghost bg-transparent`} onClick={onClose}>
          Close
        </button>
      </div>
      {diag && <DiagSheet role="scoreboard" onClose={() => setDiag(false)} />}
    </div>
  );
}
