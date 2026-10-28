// C2 pairing (ux-design.md): the camera phone shows a QR code and the six-digit room code, waits for the
// scoreboard, and closes itself once paired. The code renews by itself before the helper forgets it.
import { useEffect, useState } from 'react';
import type { LinkSnapshot } from '../../pairing/link';
import { pairUrl, qrSvg } from '../../pairing/qr';
import { DiagChip } from '../DiagSheet';
import { mismatchText, pairErrorText, SLOW_CONNECT_MS, slowConnectText } from '../pairText';
import { useNow } from '../useNow';

export function PairPanel({ l, onNewCode, onClose }: { l: LinkSnapshot; onNewCode: () => void; onClose: () => void }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [answeredAt, setAnsweredAt] = useState<number | null>(null);
  const code = l.room?.code ?? null;
  const paired = l.state === 'paired';
  const now = useNow(1000, !paired);

  useEffect(() => {
    setSvg(null);
    if (!code) return;
    let live = true;
    void qrSvg(pairUrl(code)).then((s) => live && setSvg(s));
    return () => {
      live = false;
    };
  }, [code]);

  // The room is gone once the scoreboard has answered; from then on we are connecting.
  useEffect(() => {
    if (!code && l.state === 'connecting' && !l.busy && !l.error) setAnsweredAt((t) => t ?? Date.now());
    if (code || paired) setAnsweredAt(null);
  }, [code, l.state, l.busy, l.error, paired]);

  useEffect(() => {
    if (!paired) return;
    const id = setTimeout(onClose, 1500);
    return () => clearTimeout(id);
  }, [paired, onClose]);

  const left = l.room ? Math.max(0, Math.round((l.room.expiresAt - now) / 1000)) : 0;
  const status = l.mismatch
    ? mismatchText(l.mismatch)
    : l.error
      ? pairErrorText(l.error)
      : paired
        ? 'Paired with the scoreboard ✓'
        : l.busy
          ? 'Preparing a code…'
          : code
            ? `Waiting for the scoreboard… (code valid ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')})`
            : answeredAt != null && now - answeredAt > SLOW_CONNECT_MS
              ? slowConnectText(l.net)
              : 'Connecting…';

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center gap-5 bg-black/90 p-4" role="dialog" aria-label="Pair with the scoreboard">
      {code && (
        <div className="size-[min(200px,70vh)] shrink-0 overflow-hidden rounded-lg bg-white p-1" data-testid="pair-qr">
          {svg && <div className="size-full [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />}
        </div>
      )}
      <div className="flex max-w-md min-w-0 flex-col gap-2">
        <b className="text-lg">Pair with the scoreboard</b>
        {code && (
          <div className="text-5xl font-bold tracking-[0.25em] tabular-nums" data-testid="pair-code">
            {code}
          </div>
        )}
        {code && <p className="text-sm text-mut">On the scoreboard phone: Pair camera, then scan this code or type the digits.</p>}
        <p className={l.error || l.mismatch ? 'text-amber' : paired ? 'font-semibold text-ok' : 'text-fg'} role="status" data-testid="pair-status">
          {status}
        </p>
        <div className="flex gap-2">
          {!paired && (
            <button className="btn btn-ghost" onClick={onNewCode} disabled={l.busy}>
              {l.error || l.mismatch ? 'Try again' : 'New code'}
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>
            {paired ? 'OK' : 'Close'}
          </button>
        </div>
        <DiagChip role="camera" />
      </div>
    </div>
  );
}
