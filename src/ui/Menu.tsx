// S5 menu: full-height rows of at least 56 px. Ending or replacing a live match asks once more. The camera
// rows pair, unpair, and start or stop the camera phone's recording (D11).
import { useState } from 'react';
import type { MatchConfig, MatchState } from '../engine';
import type { Prefs } from '../match/prefs';
import { CameraMenuRows } from './CameraLink';

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
}) {
  const [confirm, setConfirm] = useState<'end' | 'new' | null>(null);
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
        <button className={`${row} btn-ghost bg-transparent`} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
