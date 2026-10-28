// C1 camera setup and C3 recording (ux-design.md), plus their E1 states. Both show the composited canvas
// itself as the preview, so what the user sees is what is recorded (R-REC-4).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { other, reduce } from '../../engine';
import type { LocalSource } from '../../link/local';
import { saveLogo } from '../../match/persist';
import type { Corner, LogoSize } from '../../overlay';
import { DIM_AFTER_MS, LOW_MINUTES, OVERLAY_DELAYS_MS, QUALITIES, type Quality } from '../../recording/config';
import type { CameraController } from '../../recording/controller';
import { LOGO_TYPES, prepareLogo } from '../../recording/logo';
import { current, isActive, segmentMs } from '../../recording/session';
import { elapsed } from '../format';
import { useNow } from '../useNow';
import { DemoPanel } from './DemoPanel';
import { bytes } from './format';
import { CameraMenu, HoldButton, LinkChip } from './parts';

interface Props {
  ctrl: CameraController;
  demo: LocalSource | null;
  paired: boolean;
  onToggleDemo: () => void;
  onPair: () => void;
  onUnpair: () => void;
  /** C2, shown over the preview while open. */
  c2: ReactNode;
  /** Why the last pairing ended (version mismatch, expired), shown in C1. */
  pairNote: string | null | false;
  onRecordings: () => void;
  onLeave: () => void;
  onUpdate: (() => void) | null;
}

const CORNER_OPTIONS: Array<[Corner, string]> = [
  ['tl', '↖'],
  ['tr', '↗'],
  ['bl', '↙'],
  ['br', '↘'],
];

const SIZE_OPTIONS: Array<[LogoSize, string]> = [
  ['small', 'S'],
  ['medium', 'M'],
  ['large', 'L'],
];

function Seg<T extends string | number | boolean>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
}) {
  return (
    <>
      <span className="lab self-center">{label}</span>
      <span className="seg w-full [&>button]:min-h-9 [&>button]:px-1">
        {options.map(([v, text]) => (
          <button key={String(v)} className="flex-1" aria-pressed={value === v} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </span>
    </>
  );
}

export function CameraScreen({ ctrl, demo, paired, onToggleDemo, onPair, onUnpair, c2, pairNote, onRecordings, onLeave, onUpdate }: Props) {
  const snap = useSyncExternalStore(ctrl.subscribe, ctrl.getSnapshot);
  const mirror = useSyncExternalStore(ctrl.mirror.subscribe, ctrl.mirror.getSnapshot);
  const [menu, setMenu] = useState(false);
  const [dimmed, setDimmed] = useState(false);
  const lastTouch = useRef(Date.now());
  const previewRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const { session, settings } = snap;
  const active = isActive(session.phase);
  const c3 = active || session.phase === 'interrupted' || session.phase === 'full';
  const now = useNow(1000, c3);
  const seg = current(session);
  const minutes = ctrl.minutesLeft();
  const low = minutes != null && minutes < LOW_MINUTES;

  // The canvas belongs to the controller and outlives this screen; mount it into the preview box.
  useLayoutEffect(() => {
    previewRef.current?.appendChild(ctrl.compositor.canvas);
  }, [ctrl]);

  useEffect(() => {
    if (snap.camera === 'off' && session.phase === 'idle') void ctrl.startCamera();
    // Only on entering the screen; later stops are the user's or the system's.
  }, [ctrl]);

  // C3: dim after 30 s without a touch; the canvas keeps being drawn and recorded (A7).
  useEffect(() => {
    if (!active) {
      setDimmed(false);
      return;
    }
    lastTouch.current = Date.now();
    const id = setInterval(() => {
      if (Date.now() - lastTouch.current >= DIM_AFTER_MS) setDimmed(true);
    }, 1000);
    return () => clearInterval(id);
  }, [active]);

  // Round 2: an optional logo, downscaled and kept on this device; it is drawn into the frames like the score.
  const addLogo = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setLogoError(null);
    try {
      const { logo, png } = await prepareLogo(file);
      if (ctrl.setLogo(logo)) await saveLogo(png);
    } catch (err) {
      setLogoError((err as Error).message || 'This image could not be used.');
    }
  };
  const removeLogo = async () => {
    if (ctrl.setLogo(null)) await saveLogo(null).catch(() => {});
  };

  const live = useMemo(() => (mirror.config ? reduce(mirror.config, mirror.events) : null), [mirror.config, mirror.events]);
  const lastScore =
    live && mirror.config
      ? `${mirror.config.teams[live.leftTeam].name} ${live.score[live.leftTeam]} – ${live.score[other(live.leftTeam)]} ${mirror.config.teams[other(live.leftTeam)].name}`
      : null;

  const storageLine = (q: Quality) => {
    const m = minutes;
    const persisted = snap.storage.persisted === true ? 'persisted ✓' : snap.storage.persisted === false ? 'not persisted: export promptly' : '';
    return (
      <span className={low ? 'font-semibold text-amber' : 'text-mut'} data-testid="storage-line">
        Storage: {m == null ? 'unknown' : `${m} min left at ${q}`}
        {persisted && <span className={snap.storage.persisted ? 'text-mut' : 'text-amber'}> · {persisted}</span>}
      </span>
    );
  };

  const lastSeg = session.segments[session.segments.length - 1];
  const header = c3 ? (
    <>
      <span className="flex min-w-0 items-center gap-2">
        {active ? (
          <span className="flex items-center gap-2 rounded-full bg-red/25 px-3 py-1 font-bold text-red" data-testid="rec-chip">
            <span className="rec-dot">●</span> REC {seg ? elapsed(segmentMs(seg, now)) : ''}
            {seg && seg.index > 1 && <span className="font-normal">· seg {seg.index}</span>}
          </span>
        ) : (
          <span className="rounded-full bg-pan2 px-3 py-1 font-bold">stopped</span>
        )}
        <span className={low ? 'text-amber' : 'text-mut'}>{minutes != null ? `${minutes} min left` : ''}</span>
        <span className="text-mut tabular-nums">{snap.fps} fps</span>
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <LinkChip link={mirror.link} demo={!!demo} />
        {lastScore && <b className="truncate" data-testid="last-score">{lastScore}</b>}
      </span>
    </>
  ) : (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <button className="btn btn-ghost min-h-10 px-3" onClick={onLeave} aria-label="Back">
          ‹
        </button>
        <b className="text-fg">Camera</b>
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <LinkChip link={mirror.link} demo={!!demo} />
        {lastScore && (
          <span className="truncate" data-testid="last-score">
            {lastScore}
          </span>
        )}
      </span>
    </>
  );

  return (
    <main
      className="relative flex h-full flex-col bg-bg"
      onPointerDownCapture={() => {
        lastTouch.current = Date.now();
      }}
    >
      <div className="fixed inset-0 z-50 hidden flex-col items-center justify-center gap-3 bg-bg p-6 text-center portrait:flex">
        <div className="text-5xl">⟲</div>
        <div className="text-2xl font-semibold">Rotate your phone to landscape</div>
        <div className="text-mut">{active ? 'Still recording.' : 'The camera records in the orientation it starts in.'}</div>
      </div>

      <header className="pad-safe-x flex h-12 shrink-0 items-center justify-between gap-3 text-sm">
        {header}
        <button className="btn btn-ghost min-h-10 px-3 text-xl leading-none" aria-label="Menu" onClick={() => setMenu(true)}>
          ⋯
        </button>
      </header>

      <div className="pad-safe-x pad-safe-bottom flex min-h-0 flex-1 gap-3 pb-2">
        <div className="relative min-w-0 flex-1 overflow-hidden rounded-xl border border-line bg-black" data-testid="preview">
          <div ref={previewRef} className="absolute inset-0" />
          {demo && <DemoPanel source={demo} />}
          {c2}
          {!c3 && snap.camera !== 'live' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center">
              {snap.camera === 'starting' && <span className="text-mut">Starting the camera…</span>}
              {(snap.camera === 'denied' || snap.camera === 'error') && <span className="max-w-md text-amber">{snap.cameraError}</span>}
              {snap.camera !== 'starting' && (
                <button className="btn btn-pri" onClick={() => void ctrl.startCamera()}>
                  {snap.camera === 'off' ? 'Start camera' : 'Retry'}
                </button>
              )}
            </div>
          )}
          {(session.phase === 'interrupted' || session.phase === 'full') && lastSeg && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/80 p-4 text-center" role="alert">
              <div className="max-w-lg text-lg font-semibold">
                {session.message ?? 'Recording stopped.'} Segment {lastSeg.index} saved ({elapsed(segmentMs(lastSeg, now))}).
              </div>
              <div className="flex gap-3">
                {session.phase === 'interrupted' && (
                  <button className="btn btn-pri px-6" onClick={() => void ctrl.resume()} data-testid="resume">
                    Resume (segment {lastSeg.index + 1})
                  </button>
                )}
                <button className="btn btn-ghost" onClick={() => ctrl.dismiss()}>
                  {session.phase === 'full' ? 'OK' : 'Done'}
                </button>
              </div>
              {session.phase === 'full' && <div className="text-mut">Export and delete old recordings to free space.</div>}
            </div>
          )}
        </div>

        {c3 ? (
          <aside className="flex w-[112px] shrink-0 flex-col items-center justify-between gap-2 py-1">
            <button className="btn btn-ghost w-full text-sm" onClick={() => setDimmed(true)} disabled={!active}>
              Dim screen
            </button>
            <span className="text-center text-xs text-mut">{bytes(snap.bytes)}</span>
            <HoldButton label="Hold to stop recording" onHold={() => ctrl.stopRec('user')} disabled={session.phase !== 'recording'} />
          </aside>
        ) : (
          <aside className="flex w-[240px] shrink-0 flex-col gap-1.5 pb-1">
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
              <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1.5">
                <Seg
                  label="Quality"
                  value={settings.quality}
                  options={(Object.keys(QUALITIES) as Quality[]).map((q) => [q, q])}
                  onChange={(quality) => ctrl.setSettings({ quality })}
                />
                <Seg label="Audio" value={settings.audio} options={[[true, 'On'], [false, 'Off']]} onChange={(audio) => ctrl.setSettings({ audio })} />
                <Seg
                  label="Mirror overlay"
                  value={settings.mirrored}
                  options={[[false, 'Off'], [true, 'On']]}
                  onChange={(mirrored) => ctrl.setSettings({ mirrored })}
                />
                <Seg
                  label="Overlay delay"
                  value={settings.delayMs}
                  options={OVERLAY_DELAYS_MS.map((d) => [d, `${d / 1000} s`] as [number, string])}
                  onChange={(delayMs) => ctrl.setSettings({ delayMs })}
                />
                <Seg label="Score at" value={settings.scoreCorner} options={CORNER_OPTIONS} onChange={(scoreCorner) => ctrl.setSettings({ scoreCorner })} />
                <Seg label="Score size" value={settings.scoreSize} options={SIZE_OPTIONS} onChange={(scoreSize) => ctrl.setSettings({ scoreSize })} />
                <span className="lab self-center">Logo</span>
                <span className="flex gap-1.5">
                  <button className="btn min-h-9 flex-1 px-2 py-1 text-sm" onClick={() => fileRef.current?.click()} data-testid="logo-add">
                    {snap.logo ? 'Change…' : 'Add logo…'}
                  </button>
                  {snap.logo && (
                    <button className="btn btn-ghost min-h-9 px-2 py-1 text-sm" onClick={() => void removeLogo()} data-testid="logo-remove">
                      Remove
                    </button>
                  )}
                </span>
                {snap.logo && (
                  <>
                    <Seg label="Logo at" value={settings.logoCorner} options={CORNER_OPTIONS} onChange={(logoCorner) => ctrl.setSettings({ logoCorner })} />
                    <Seg label="Logo size" value={settings.logoSize} options={SIZE_OPTIONS} onChange={(logoSize) => ctrl.setSettings({ logoSize })} />
                  </>
                )}
              </div>
              <input ref={fileRef} type="file" accept={LOGO_TYPES} className="hidden" onChange={(e) => void addLogo(e.currentTarget)} data-testid="logo-file" />
              {logoError && <div className="text-xs text-amber">{logoError}</div>}
              <div className="text-xs leading-snug">{storageLine(settings.quality)}</div>
              {snap.opfs === 'unavailable' && (
                <div className="text-xs font-semibold text-amber">Recording needs normal browsing mode (not Private Browsing).</div>
              )}
              {session.phase === 'failed' && (
                <div className="text-xs text-amber" role="alert">
                  {session.message}{' '}
                  <button className="underline" onClick={() => ctrl.dismiss()}>
                    OK
                  </button>
                </div>
              )}
              {pairNote && (
                <div className="text-xs font-semibold text-amber" data-testid="pair-note">
                  {pairNote}
                </div>
              )}
              {mirror.link === 'unpaired' && !demo && (
                <div className="flex items-center gap-2 text-xs text-mut">
                  <span className="flex-1">Not paired: records without the score.</span>
                  <button className="btn min-h-9 px-2 py-1 text-sm" onClick={onPair} data-testid="cam-pair">
                    Pair…
                  </button>
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center justify-between gap-2">
              <button className="btn btn-ghost text-sm" onClick={onRecordings}>
                Recordings
              </button>
              <button
                className="size-[88px] shrink-0 rounded-full border-[6px] border-[#444] bg-white disabled:opacity-40"
                aria-label="Start recording"
                data-testid="rec-button"
                disabled={snap.camera !== 'live' || snap.opfs !== 'ok'}
                onClick={() => void ctrl.startRec()}
              >
                <span className="mx-auto block size-9 rounded-full bg-red" />
              </button>
            </div>
          </aside>
        )}
      </div>

      {dimmed && active && (
        // Not real brightness (a web page cannot set it): an 80 % black layer; any touch wakes it.
        <button className="fixed inset-0 z-[45] bg-black/80" aria-label="Wake the screen" onClick={() => setDimmed(false)} data-testid="dim-layer" />
      )}
      {menu && (
        <CameraMenu
          demo={!!demo}
          paired={paired}
          recording={active}
          onPair={() => {
            setMenu(false);
            onPair();
          }}
          onUnpair={() => {
            setMenu(false);
            onUnpair();
          }}
          onDemo={() => {
            onToggleDemo();
            setMenu(false);
          }}
          onRecordings={() => {
            setMenu(false);
            onRecordings();
          }}
          onLeave={onLeave}
          onUpdate={onUpdate}
          onClose={() => setMenu(false)}
        />
      )}
    </main>
  );
}
