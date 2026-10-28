// The scoreboard's view of the camera phone: the link chip with the camera's REC state (R-DISP-9) and whether
// another scoreboard is linked too (D14) for the S3 top bar, and the remote REC rows for S5 (D11, R-PAIR-6).
import { useState, useSyncExternalStore } from 'react';
import type { LinkState, RecReport } from '../link/source';
import { scoreboardPairing } from '../pairing/live';
import { LinkChip } from './camera/parts';
import { mismatchText } from './pairText';
import { elapsed } from './format';
import { useNow } from './useNow';

export function useCameraLink() {
  const { link, board } = scoreboardPairing();
  const l = useSyncExternalStore(link.subscribe, link.getSnapshot);
  const b = useSyncExternalStore(board.subscribe, board.getSnapshot);
  return { link, board, l, b };
}

/** Elapsed recording time: frozen at the last report while the link is down. */
export function recElapsed(rec: RecReport & { at: number }, now: number, live: boolean): number {
  return (rec.elapsedMs ?? 0) + (live ? Math.max(0, now - rec.at) : 0);
}

function RecBadge({ rec, now, live }: { rec: (RecReport & { at: number }) | null; now: number; live: boolean }) {
  if (!rec) return null;
  if (rec.state === 'recording')
    return (
      <span className={`flex items-center gap-1.5 font-bold tabular-nums ${live ? 'text-red' : 'text-mut'}`} data-testid="cam-rec">
        <span className={live ? 'rec-dot' : ''}>●</span> REC {elapsed(recElapsed(rec, now, live))}
      </span>
    );
  if (rec.state === 'stopping') return <span data-testid="cam-rec">saving…</span>;
  if (rec.state === 'error')
    return (
      <span className="text-amber" data-testid="cam-rec" title={rec.error}>
        REC stopped
      </span>
    );
  return (
    <span className="text-mut" data-testid="cam-rec">
      REC idle
    </span>
  );
}

/**
 * The chip's words: "syncing" until the camera's whole match has arrived after an open, and while the link is
 * down the seconds since the camera last sent anything, so a score shown then is never taken for a live one.
 */
export function chipText(state: LinkState, synced: boolean, syncedAt: number | null, now: number): string | undefined {
  if (state === 'paired') return synced ? undefined : 'syncing…';
  if ((state === 'reconnecting' || state === 'lost' || state === 'offline') && syncedAt != null)
    return `${state === 'reconnecting' ? 'reconnecting' : state === 'lost' ? 'link lost' : 'offline'} · ${Math.max(0, Math.round((now - syncedAt) / 1000))} s`;
  return undefined;
}

/** S3 top bar: "pair camera" when unpaired, else the link chip and the camera's REC state. */
export function CameraStatus({ onPair }: { onPair: () => void }) {
  const { l, b } = useCameraLink();
  const down = l.state === 'reconnecting' || l.state === 'lost' || l.state === 'offline';
  const now = useNow(1000, b.rec?.state === 'recording' || down);
  if (l.state === 'unpaired' && !l.mismatch)
    return (
      <button className="btn btn-ghost min-h-9 rounded-full px-3 py-1 text-sm" onClick={onPair} data-testid="pair-chip">
        Pair camera
      </button>
    );
  return (
    <button className="flex items-center gap-2 rounded-full" onClick={onPair} aria-label="Camera link">
      {l.mismatch ? (
        <span className="rounded-full bg-red/25 px-3 py-1 text-sm font-semibold text-red" data-testid="link-chip" title={mismatchText(l.mismatch)}>
          update app
        </span>
      ) : (
        <LinkChip link={l.state} demo={false} text={chipText(l.state, b.synced, b.syncedAt ?? l.downSince, now)} />
      )}
      {b.others > 0 && l.state === 'paired' && (
        <span className="text-mut" data-testid="others" title="Another scoreboard is linked to the same camera">
          +{b.others} scoreboard
        </span>
      )}
      <RecBadge rec={b.rec} now={now} live={l.state === 'paired'} />
    </button>
  );
}

/** S5 rows: start/stop the camera's recording, its answer, pair or unpair. */
export function CameraMenuRows({ row, onPair }: { row: string; onPair: () => void }) {
  const { link, board, l, b } = useCameraLink();
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  if (l.state === 'unpaired')
    return (
      <button className={row} onClick={onPair} data-testid="menu-pair">
        Pair with the camera…
      </button>
    );
  const recording = b.rec?.state === 'recording';
  const cmd = b.cmd;
  const answer = !cmd
    ? null
    : !cmd.ack
      ? 'Waiting for the camera…'
      : cmd.ack.ok
        ? cmd.action === 'rec.start'
          ? 'Camera is recording ✓'
          : 'Camera stopped recording ✓'
        : `Camera: ${cmd.ack.error ?? 'failed'}`;
  return (
    <>
      <button
        className={`${row} ${recording ? 'bg-red/30' : ''}`}
        disabled={l.state !== 'paired'}
        onClick={() => board.command(recording ? 'rec.stop' : 'rec.start')}
        data-testid="menu-rec"
      >
        {recording ? '■ Stop recording on the camera' : '● Start recording on the camera'}
        {answer && <span className="block text-sm font-normal text-mut" data-testid="menu-rec-answer">{answer}</span>}
      </button>
      <button
        className={`${row} ${confirmUnpair ? 'bg-red/30' : ''}`}
        onClick={() => {
          if (!confirmUnpair) return setConfirmUnpair(true);
          link.unpair();
          board.clear();
        }}
        data-testid="menu-unpair"
      >
        {/* The camera died without a goodbye: leaving clears its state here (the match stays on this phone). */}
        {l.state === 'paired' ? (confirmUnpair ? 'Tap again to unpair the camera' : 'Unpair the camera') : confirmUnpair ? 'Tap again to leave' : 'Leave: forget the camera'}
      </button>
    </>
  );
}
