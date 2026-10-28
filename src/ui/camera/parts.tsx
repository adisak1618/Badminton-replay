// Small pieces of the camera screens: the link chip (R-DISP-9), the hold-to-stop button (R-REC-7) and the
// camera menu.
import { useEffect, useRef, useState } from 'react';
import type { LinkState } from '../../link/source';
import { HOLD_TO_STOP_MS } from '../../recording/config';

const LINK: Record<LinkState, { text: string; cls: string }> = {
  unpaired: { text: 'not paired', cls: 'bg-red/25 text-red' },
  connecting: { text: 'connecting', cls: 'bg-amber/20 text-amber' },
  paired: { text: 'link ok', cls: 'bg-ok/20 text-ok' },
  reconnecting: { text: 'reconnecting', cls: 'bg-amber/20 text-amber' },
  lost: { text: 'link lost', cls: 'bg-red/25 text-red' },
  offline: { text: 'offline', cls: 'bg-red/25 text-red' },
};

export function LinkChip({ link, demo }: { link: LinkState; demo: boolean }) {
  const l = LINK[link];
  return (
    <span className={`rounded-full px-3 py-1 text-sm font-semibold whitespace-nowrap ${l.cls}`} data-testid="link-chip">
      {demo && link === 'paired' ? 'demo: this phone' : l.text}
    </span>
  );
}

/** Stop needs a 1 s press and hold; a tap does nothing (R-REC-7). */
export function HoldButton({ onHold, label, disabled }: { onHold: () => void; label: string; disabled?: boolean }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  useEffect(() => cancel, []);
  return (
    <button
      className="relative flex size-[88px] shrink-0 flex-col items-center justify-center overflow-hidden rounded-full border-4 border-[#444] bg-red text-sm leading-tight font-bold text-white disabled:opacity-40"
      disabled={disabled}
      aria-label={label}
      onPointerDown={(e) => {
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // synthetic or already-released pointer
        }
        setHolding(true);
        timer.current = setTimeout(() => {
          timer.current = null;
          setHolding(false);
          onHold();
        }, HOLD_TO_STOP_MS);
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      {holding && <span className="hold-fill absolute inset-0 bg-black/45" style={{ animationDuration: `${HOLD_TO_STOP_MS}ms` }} />}
      <span className="relative">hold to</span>
      <span className="relative text-base">STOP</span>
    </button>
  );
}

export function CameraMenu({
  demo,
  paired,
  recording,
  onPair,
  onUnpair,
  onDemo,
  onRecordings,
  onLeave,
  onUpdate,
  onClose,
}: {
  demo: boolean;
  paired: boolean;
  recording: boolean;
  onPair: () => void;
  onUnpair: () => void;
  onDemo: () => void;
  onRecordings: () => void;
  onLeave: () => void;
  onUpdate: (() => void) | null;
  onClose: () => void;
}) {
  const row = 'btn min-h-14 w-full bg-pan2 text-left';
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 p-3" onClick={onClose}>
      <div
        className="sheet grid max-h-full w-[min(560px,100%)] grid-cols-2 gap-2 overflow-y-auto p-3"
        role="dialog"
        aria-label="Camera menu"
        onClick={(e) => e.stopPropagation()}
      >
        {paired ? (
          <button className={row} onClick={onUnpair}>
            Unpair the scoreboard
          </button>
        ) : (
          <button className={row} onClick={onPair} data-testid="menu-pair">
            Pair with the scoreboard…
          </button>
        )}
        <button className={row} aria-pressed={demo} onClick={onDemo}>
          Demo score (this phone): <b>{demo ? 'on' : 'off'}</b>
        </button>
        <button className={row} onClick={onRecordings} disabled={recording}>
          Recordings
        </button>
        <button className={row} onClick={onLeave} disabled={recording}>
          Change role
        </button>
        {onUpdate && (
          <button className={`${row} bg-pri/40`} onClick={onUpdate} disabled={recording}>
            Update the app (reloads)
          </button>
        )}
        <button className={`${row} btn-ghost bg-transparent`} onClick={onClose}>
          Close
        </button>
        <p className="col-span-2 text-sm text-mut">
          Demo score lets this phone play the scoreboard too: a small panel on the preview scores points, undoes, and
          sends REC and Stop the way the paired scoreboard phone does. While it is on, the overlay follows it.
        </p>
      </div>
    </div>
  );
}
