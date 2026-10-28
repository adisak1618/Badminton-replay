// S2 pairing (ux-design.md): scan the camera phone's QR or type its six digits. The viewfinder stays open
// while typing too: on iPhone the camera permission is what lets the browser offer local-network candidates
// (technical-design.md §4.3).
import { useEffect, useRef, useState } from 'react';
import { registerCapture } from '../pairing/capture';
import { codeFromText, grabFrame, qrReader } from '../pairing/qr';
import { useCameraLink } from './CameraLink';
import { DiagChip } from './DiagSheet';
import { useNow } from './useNow';
import { SLOW_CONNECT_MS, mismatchText, pairErrorText, slowConnectText } from './pairText';

type Cam = 'starting' | 'live' | 'denied' | 'off';
const SCAN_EVERY_MS = 300;

export function PairScreen({ initialCode, onClose }: { initialCode: string | null; onClose: () => void }) {
  const { link, l, b } = useCameraLink();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cam, setCam] = useState<Cam>('starting');
  const [code, setCode] = useState(initialCode ?? '');
  const [joinedAt, setJoinedAt] = useState<number | null>(null);
  const autoStarted = useRef(false);
  /**
   * The last code joined, however it came (launch link, typed, scanned): the scanner never joins it again. The
   * viewfinder usually still sees the camera's QR after a typed or linked code, and a room code is one-shot, so
   * a second claim fails ("code not found"). After a failure the user retries with Pair.
   */
  const tried = useRef<string | null>(null);
  const paired = l.state === 'paired';
  const now = useNow(1000, joinedAt != null && !paired);

  const join = (c: string) => {
    if (l.busy) return;
    tried.current = c;
    setCode(c);
    setJoinedAt(Date.now());
    void link.join(c);
  };

  // The viewfinder, open until the link is up (or the screen closes).
  useEffect(() => {
    if (paired) return setCam('off');
    let stream: MediaStream | null = null;
    let stopped = false;
    const unregister = registerCapture(() => !!stream?.getVideoTracks().some((t) => t.readyState === 'live'));
    if (!navigator.mediaDevices?.getUserMedia) {
      setCam('denied');
      return unregister;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        const v = videoRef.current;
        if (v) {
          v.srcObject = s;
          void v.play().catch(() => {});
        }
        setCam('live');
      })
      .catch(() => !stopped && setCam('denied'));
    return () => {
      stopped = true;
      unregister();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [paired]);

  // A code from the launch URL starts as soon as the viewfinder has settled.
  useEffect(() => {
    if (initialCode && !autoStarted.current && cam !== 'starting') {
      autoStarted.current = true;
      join(initialCode);
    }
  }, [cam, initialCode]);

  // Scan for the QR while the viewfinder is live and nothing is in progress.
  useEffect(() => {
    if (cam !== 'live' || paired || l.busy) return;
    let live = true;
    const canvas = document.createElement('canvas');
    let timer: ReturnType<typeof setTimeout>;
    const step = async () => {
      try {
        const read = await qrReader();
        const img = videoRef.current && grabFrame(videoRef.current, canvas);
        const text = img ? await read(img) : null;
        const c = text && codeFromText(text);
        if (live && c && c !== tried.current) return join(c);
      } catch {
        // decoder failed to load: typing still works
      }
      if (live) timer = setTimeout(step, SCAN_EVERY_MS);
    };
    timer = setTimeout(step, SCAN_EVERY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [cam, paired, l.busy]);

  const slow = !paired && l.state === 'connecting' && !l.busy && joinedAt != null && now - joinedAt > SLOW_CONNECT_MS;
  const status = l.mismatch
    ? mismatchText(l.mismatch)
    : l.error
      ? pairErrorText(l.error)
      : paired
        ? null
        : l.busy
          ? 'Connecting…'
          : l.state === 'connecting' && joinedAt != null
            ? slow
              ? slowConnectText(l.net)
              : 'Connecting to the camera phone…'
            : l.state === 'reconnecting' || l.state === 'lost' || l.state === 'offline'
              ? 'Paired before: reconnecting to the camera phone by itself.'
              : null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-bg" role="dialog" aria-label="Pair with the camera">
      <header className="pad-safe-x flex h-14 shrink-0 items-center justify-between gap-3">
        <b className="text-lg">Pair with the camera</b>
        <button className="btn btn-ghost" onClick={onClose}>
          {paired ? 'Done' : 'Close'}
        </button>
      </header>
      <div className="pad-safe-x pad-safe-bottom flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-3 landscape:flex-row">
        <div className="relative aspect-[4/3] max-h-full min-h-40 shrink-0 overflow-hidden rounded-xl border border-line bg-black landscape:h-full landscape:aspect-[4/3]">
          <video ref={videoRef} className="absolute inset-0 size-full object-cover" playsInline muted autoPlay />
          {cam !== 'live' && (
            <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-mut">
              {cam === 'starting'
                ? 'Opening the camera…'
                : cam === 'denied'
                  ? 'Camera not available. Type the code instead; allow camera access in Settings › Apps › Safari › Camera if pairing fails.'
                  : paired
                    ? 'Paired ✓'
                    : ''}
            </div>
          )}
          {cam === 'live' && <div className="pointer-events-none absolute inset-[18%] rounded-xl border-2 border-white/70" />}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {!paired && (
            <>
              <p className="text-mut">Point at the QR code on the camera phone, or type its six digits.</p>
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (/^\d{6}$/.test(code)) join(code);
                }}
              >
                <input
                  className="field w-44 text-center text-2xl font-semibold tracking-[0.35em] tabular-nums"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                  aria-label="Pairing code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  data-testid="pair-code"
                />
                <button className="btn btn-pri px-5" disabled={!/^\d{6}$/.test(code) || l.busy} data-testid="pair-submit">
                  Pair
                </button>
              </form>
            </>
          )}
          {status && (
            <p className={l.error || l.mismatch ? 'text-amber' : 'text-fg'} role="status" data-testid="pair-status">
              {status}
            </p>
          )}
          {paired && (
            <div className="flex flex-col gap-2" data-testid="pair-done">
              <p className="text-xl font-semibold text-ok">Paired, camera ready</p>
              <p className="text-mut">
                link: paired · REC: {b.rec?.state ?? 'idle'}
                {l.otherBuild && ` · the camera runs another build (${l.otherBuild}); update both when convenient`}
              </p>
              <button className="btn btn-pri self-start px-8" onClick={onClose}>
                OK
              </button>
            </div>
          )}
          {(l.error || l.mismatch) && (
            <p className="text-sm text-mut">Scoring works without the camera; you can pair later from the menu.</p>
          )}
          <DiagChip role="scoreboard" />
        </div>
      </div>
    </div>
  );
}
