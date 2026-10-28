// C2 pairing (ux-design.md): the camera phone lists the scoreboards linked to it (up to two, D14) and, while
// a slot is free, shows a QR code and the six-digit room code for it. After the first scoreboard links, the
// code for the second one appears; the panel closes by itself once both are linked. The code renews by itself
// before the helper forgets it.
import { useEffect, useRef, useState } from 'react';
import { pairUrl, qrSvg } from '../../pairing/qr';
import type { SlotsSnapshot } from '../../pairing/slots';
import { DiagChip } from '../DiagSheet';
import { mismatchText, pairErrorText, SLOW_CONNECT_MS, slowConnectText } from '../pairText';
import { useNow } from '../useNow';
import { boardName } from './format';
import { LinkChip } from './parts';

export function PairPanel({
  slots,
  onNewCode,
  onUnpair,
  onClose,
}: {
  slots: SlotsSnapshot;
  onNewCode: () => void;
  onUnpair: (i: number) => void;
  onClose: () => void;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [answeredAt, setAnsweredAt] = useState<number | null>(null);
  const linked = slots.slots.map((s, i) => ({ s, i })).filter(({ s }) => s.everOpened && s.state !== 'unpaired');
  // The slot this screen is about: the one showing a code, else one connecting or failing.
  const l = slots.slots.find((s) => s.room) ?? slots.slots.find((s) => !s.everOpened && (s.busy || s.error || s.mismatch || s.state === 'connecting'));
  const code = l?.room?.code ?? null;
  const full = linked.length === slots.slots.length;
  const now = useNow(1000, !full);

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
    if (l && !code && l.state === 'connecting' && !l.busy && !l.error) setAnsweredAt((t) => t ?? Date.now());
    else setAnsweredAt(null);
  }, [code, l?.state, l?.busy, l?.error]);

  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!full) return;
    const id = setTimeout(() => close.current(), 1500);
    return () => clearTimeout(id);
  }, [full]);

  const left = l?.room ? Math.max(0, Math.round((l.room.expiresAt - now) / 1000)) : 0;
  const next = linked.length ? 'another scoreboard' : 'the scoreboard';
  const status = full
    ? `${linked.length} scoreboards linked ✓`
    : !l
      ? linked.length
        ? 'Paired with the scoreboard ✓'
        : null
      : l.mismatch
        ? mismatchText(l.mismatch)
        : l.error
          ? pairErrorText(l.error)
          : l.busy
            ? 'Preparing a code…'
            : code
              ? `Waiting for ${next}… (code valid ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')})`
              : answeredAt != null && now - answeredAt > SLOW_CONNECT_MS
                ? slowConnectText(l.net, l.relay)
                : 'Connecting…';

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center gap-5 bg-black/90 p-4" role="dialog" aria-label="Pair with the scoreboard">
      {code && (
        <div className="size-[min(200px,70vh)] shrink-0 overflow-hidden rounded-lg bg-white p-1" data-testid="pair-qr">
          {svg && <div className="size-full [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />}
        </div>
      )}
      <div className="flex max-w-md min-w-0 flex-col gap-2 overflow-y-auto">
        <b className="text-lg">{linked.length && !full ? 'Pair another scoreboard' : 'Pair with the scoreboard'}</b>
        {linked.map(({ s, i }) => (
          <div key={i} className="flex items-center gap-2 text-sm" data-testid={`board-${i + 1}`}>
            <span className="min-w-0 flex-1 truncate">
              Scoreboard {i + 1}: <b>{boardName(s.remote)}</b>
            </span>
            <LinkChip link={s.state} demo={false} />
            <button className="btn btn-ghost min-h-9 px-2 py-1 text-sm" onClick={() => onUnpair(i)}>
              Unpair
            </button>
          </div>
        ))}
        {code && (
          <div className="text-5xl font-bold tracking-[0.25em] tabular-nums" data-testid="pair-code">
            {code}
          </div>
        )}
        {code && (
          <p className="text-sm text-mut">
            On {linked.length ? 'the other scoreboard phone' : 'the scoreboard phone'}: Pair camera, then scan this code or type the digits.
            {linked.length > 0 && ' Two scoreboards score the same match; one is enough.'}
          </p>
        )}
        {status && (
          <p className={l?.error || l?.mismatch ? 'text-amber' : !l ? 'font-semibold text-ok' : 'text-fg'} role="status" data-testid="pair-status">
            {status}
          </p>
        )}
        <div className="flex gap-2">
          {!full && (
            <button className="btn btn-ghost" onClick={onNewCode} disabled={l?.busy}>
              {l?.error || l?.mismatch ? 'Try again' : 'New code'}
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>
            {linked.length ? 'Done' : 'Close'}
          </button>
        </div>
        <DiagChip role="camera" />
      </div>
    </div>
  );
}
