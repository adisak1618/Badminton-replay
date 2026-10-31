// S3v: scoring a saved video (D17, R-VID; ux-design.md S3v, S3v-r). The scoreboard (S3) with a player pane: the video,
// a seek bar with a tick per point, play/pause, ±5 s and ±1 s, speed and sound. The match's log runs on the video's
// clock (video/source.ts), so every tap lands where the video stood. The player pauses while the why-was-this-point-won
// popup is open (setting). After a reload the file has to be picked again (iOS keeps no handle to it); a different
// name or size is pointed out before it is used. Sought back before the latest change of the score, the board shows
// the match as it stood at that moment (video/timeline.ts, R-VID-8).
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { rallies, type MatchConfig, type MatchEvent, type MatchState } from '../engine';
import type { Prefs } from '../match/prefs';
import type { MatchStore } from '../match/store';
import { Scoreboard, type VideoMode } from '../ui/Scoreboard';
import { elapsed } from '../ui/format';
import { SEEK_S, SHORTCUTS, SPEED_OF, SPEEDS, type Speed, type VideoAction } from './keys';
import { TAP_OFFSET, fileMs, fpsFromSteps, sameFile, videoClock, type VideoSource } from './source';
import { Timeline } from './timeline';

/** While playing, the position is saved this often (and on every pause and seek). */
const SAVE_EVERY_MS = 3000;
/** Frame steps measured before the frame rate is worked out. */
const FPS_STEPS = 40;

interface Props {
  store: MatchStore;
  config: MatchConfig;
  events: MatchEvent[];
  state: MatchState;
  video: VideoSource;
  /** The picked file, or null after a reload until it is picked again. */
  file: File | null;
  onFile: (f: File) => void;
  prefs: Prefs;
  setPrefs: (p: Prefs) => void;
  resumed: boolean;
  onContinue: () => void;
  onNewMatch: () => void;
  onUpdate: (() => void) | null;
}

export function VideoBoard({ store, config, events, state, video: v, file, onFile, prefs, setPrefs, resumed, onContinue, onNewMatch, onUpdate }: Props) {
  const el = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [pos, setPos] = useState(v.positionMs / 1000);
  const [dur, setDur] = useState((v.durationMs ?? 0) / 1000);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState<Speed>(1);
  const [help, setHelp] = useState(false);
  /** A re-picked file whose name or size is not the saved one: used only once confirmed. */
  const [other, setOther] = useState<File | null>(null);
  const ready = !!file && loaded && !error;
  const t0 = events[0]?.at ?? 0;

  useEffect(() => {
    setLoaded(false);
    setError(false);
    if (!file) return setUrl(null);
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // ---- the log's clock is the video's (R-VID-3) ----
  const live = useRef({ t0, offset: v.tapOffsetMs, positionMs: v.positionMs, ready });
  live.current = { t0, offset: v.tapOffsetMs, positionMs: v.positionMs, ready };
  const clock = useCallback(() => {
    const L = live.current;
    const e = el.current;
    return videoClock(L.t0, L.ready && e ? e.currentTime * 1000 : L.positionMs, L.offset);
  }, []);
  useEffect(() => {
    store.setClock(clock);
    return () => store.setClock(null);
  }, [store, clock]);

  // A resumed match carries on once its file is open again: the re-pick was the tap that resumes it.
  useEffect(() => {
    if (ready && resumed) onContinue();
  }, [ready, resumed]);

  // ---- position, saved with the match (R-VID-5) ----
  const savedAt = useRef(0);
  const savePos = (force: boolean) => {
    const e = el.current;
    if (!e || !live.current.ready) return;
    const now = Date.now();
    if (!force && now - savedAt.current < SAVE_EVERY_MS) return;
    savedAt.current = now;
    store.setVideo({ positionMs: Math.round(e.currentTime * 1000) });
  };

  const onMeta = () => {
    const e = el.current;
    if (!e) return;
    const d = Number.isFinite(e.duration) ? e.duration : 0;
    setDur(d);
    store.setVideo({ durationMs: Math.round(d * 1000), width: e.videoWidth || null, height: e.videoHeight || null });
    // Back where the scorer was (a reload, or a file picked again).
    e.currentTime = Math.min(live.current.positionMs / 1000, d || Infinity);
    e.playbackRate = rate;
    e.muted = prefs.videoMuted;
    setPos(e.currentTime);
    setLoaded(true);
  };

  useEffect(() => {
    if (el.current) el.current.muted = prefs.videoMuted;
  }, [prefs.videoMuted]);
  useEffect(() => {
    if (el.current) el.current.playbackRate = rate;
  }, [rate]);

  // The frame rate for match.json: the steps between frames as they are shown, once per file (R-VID-6).
  const fpsKnown = v.fps != null;
  useEffect(() => {
    const e = el.current;
    if (!e || !ready || fpsKnown || typeof e.requestVideoFrameCallback !== 'function') return;
    const steps: number[] = [];
    let last: { t: number; n: number } | null = null;
    let id = 0;
    let stop = false;
    const cb: VideoFrameRequestCallback = (_now, md) => {
      if (stop) return;
      if (last && md.presentedFrames - last.n === 1) steps.push(md.mediaTime - last.t);
      last = { t: md.mediaTime, n: md.presentedFrames };
      const fps = steps.length >= FPS_STEPS ? fpsFromSteps(steps) : null;
      if (fps) return store.setVideo({ fps });
      id = e.requestVideoFrameCallback(cb);
    };
    id = e.requestVideoFrameCallback(cb);
    return () => {
      stop = true;
      e.cancelVideoFrameCallback?.(id);
    };
  }, [ready, fpsKnown, store]);

  // ---- the player ----
  const toggle = () => {
    const e = el.current;
    if (!e || !ready) return;
    if (e.paused) void e.play().catch(() => {});
    else e.pause();
  };
  const seekTo = (s: number) => {
    const e = el.current;
    if (!e || !ready) return;
    e.currentTime = Math.max(0, Math.min(s, dur || e.duration || 0));
    setPos(e.currentTime);
  };
  const seekBy = (d: number) => seekTo((el.current?.currentTime ?? 0) + d);
  const setMuted = (m: boolean) => setPrefs({ ...prefs, videoMuted: m });

  // R-VID-3: pause for the popup, play on after it if the video was playing.
  const pausedForPopup = useRef(false);
  const autoPause = useRef(prefs.videoAutoPause);
  autoPause.current = prefs.videoAutoPause;
  const onPopup = useCallback((open: boolean) => {
    const e = el.current;
    if (!e) return;
    if (open) {
      if (autoPause.current && !e.paused) {
        e.pause();
        pausedForPopup.current = true;
      }
    } else if (pausedForPopup.current) {
      pausedForPopup.current = false;
      void e.play().catch(() => {});
    }
  }, []);

  const onKey = (a: VideoAction) => {
    const step = SEEK_S[a];
    if (step !== undefined) return seekBy(step);
    if (a === 'play') return toggle();
    if (a === 'mute') return setMuted(!prefs.videoMuted);
    if (a === 'help') return setHelp((h) => !h);
    if (a === 'slow' || a === 'normal' || a === 'fast') setRate(SPEED_OF[a]);
  };

  // ---- picking the file again (S3v-r) ----
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (sameFile(v, f)) {
      setOther(null);
      onFile(f);
    } else setOther(f);
  };
  const useOther = () => {
    if (!other) return;
    store.setVideo({ name: other.name, size: other.size, type: other.type || v.type, lastModified: other.lastModified, fps: null });
    onFile(other);
    setOther(null);
  };

  // ---- the seek bar's ticks: a point at its place on the video, ★ when marked for a replay ----
  const rs = useMemo(() => rallies(config, events), [config, events]);
  const durMs = dur * 1000 || v.durationMs || 0;
  const ticks = durMs
    ? rs.map((r) => ({ id: r.id, x: Math.max(0, Math.min(100, (fileMs(t0, r.at) / durMs) * 100)), color: config.teams[r.team].color, star: !!r.replay }))
    : [];

  const btn = 'btn min-h-10 min-w-10 px-2 text-sm';
  const pane: ReactNode = (
    <>
      <div className="relative min-h-0 bg-black portrait:aspect-video landscape:flex-1" onClick={toggle} data-testid="video-stage">
        <video
          ref={el}
          className="absolute inset-0 h-full w-full object-contain"
          src={url ?? undefined}
          playsInline
          muted
          preload="auto"
          onLoadedMetadata={onMeta}
          onError={() => setError(true)}
          onTimeUpdate={(e) => {
            setPos(e.currentTarget.currentTime);
            savePos(false);
          }}
          onSeeked={(e) => {
            setPos(e.currentTarget.currentTime);
            savePos(true);
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => {
            setPlaying(false);
            savePos(true);
          }}
          onEnded={() => setPlaying(false)}
          data-testid="video"
        />
        {(!file || error || other) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg/90 p-3 text-center" onClick={(e) => e.stopPropagation()} data-testid="video-repick">
            {other ? (
              <>
                <b className="text-amber">This is not the file the match was scored on</b>
                <span className="text-sm text-mut">
                  saved: {v.name} · {mb(v.size)}
                  <br />
                  picked: {other.name} · {mb(other.size)}
                </span>
                <span className="flex gap-2">
                  <button className="btn btn-pri min-h-10 text-sm" onClick={useOther} data-testid="video-use-anyway">
                    Use it anyway
                  </button>
                  <FileButton className="btn min-h-10 text-sm" onPick={pick}>
                    Pick another
                  </FileButton>
                </span>
              </>
            ) : (
              <>
                <b>{error ? 'This browser cannot play this file' : 'Open the video again to carry on'}</b>
                <span className="text-sm break-all text-mut">
                  {v.name} · {mb(v.size)} · at {elapsed(v.positionMs)}
                </span>
                <FileButton className="btn btn-pri min-h-11 px-5" onPick={pick} testid="video-open">
                  Open video…
                </FileButton>
              </>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 px-2 pt-1 pb-1.5">
        <div className="flex items-center gap-2">
          <div className="relative h-7 min-w-0 flex-1">
            <input
              type="range"
              className="absolute inset-x-0 top-0 h-5 w-full accent-pri"
              min={0}
              max={dur || 0}
              step={0.1}
              value={Math.min(pos, dur || 0)}
              disabled={!ready}
              onChange={(e) => seekTo(Number(e.target.value))}
              aria-label="Position in the video"
              data-testid="video-seek"
            />
            <div className="pointer-events-none absolute inset-x-[7px] top-[19px] h-2">
              {ticks.map((k) => (
                <span key={k.id} className="absolute top-0 h-2 w-0.5 -translate-x-1/2" style={{ left: `${k.x}%`, background: k.color }} />
              ))}
              {ticks
                .filter((k) => k.star)
                .map((k) => (
                  <span key={`${k.id}-s`} className="absolute -top-2.5 -translate-x-1/2 text-[10px] leading-none text-amber" style={{ left: `${k.x}%` }}>
                    ★
                  </span>
                ))}
            </div>
          </div>
          <span className="shrink-0 text-xs text-mut tabular-nums" data-testid="video-time">
            {elapsed(pos * 1000)} / {elapsed(dur * 1000)}
          </span>
          <button className={`${btn} min-h-9`} onClick={() => setMuted(!prefs.videoMuted)} title="Sound (M)" aria-pressed={!prefs.videoMuted} aria-label={prefs.videoMuted ? 'Sound on' : 'Sound off'}>
            {prefs.videoMuted ? '🔇' : '🔊'}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <button className={`${btn} btn-pri`} onClick={toggle} disabled={!ready} title="Play / pause (Space)" aria-label={playing ? 'Pause' : 'Play'} data-testid="video-play">
            {playing ? '❚❚' : '▶'}
          </button>
          <button className={btn} onClick={() => seekBy(-5)} disabled={!ready} title="Back 5 s (←)">
            ◀5
          </button>
          <button className={btn} onClick={() => seekBy(-1)} disabled={!ready} title="Back 1 s (Shift+←)">
            ◀1
          </button>
          <button className={btn} onClick={() => seekBy(1)} disabled={!ready} title="Forward 1 s (Shift+→)">
            1▶
          </button>
          <button className={btn} onClick={() => seekBy(5)} disabled={!ready} title="Forward 5 s (→)">
            5▶
          </button>
          <span className="seg [&>button]:px-2.5" role="group" aria-label="Speed">
            {SPEEDS.map((sp, i) => (
              <button key={sp} aria-pressed={rate === sp} onClick={() => setRate(sp)} title={`Speed ${sp}× (${i + 1})`}>
                {sp}×
              </button>
            ))}
          </span>
          <button className={`${btn} btn-ghost hidden [@media(hover:hover)_and_(pointer:fine)]:inline-flex`} onClick={() => setHelp(true)} title="Keyboard shortcuts (?)">
            Keys ?
          </button>
        </div>
      </div>
      {help && <Shortcuts onClose={() => setHelp(false)} />}
    </>
  );

  const menuRows = (row: string, close: () => void): ReactNode => (
    <>
      <div className={`${row} flex items-center justify-between gap-2`} data-testid="menu-tap-offset">
        <span>
          Tap offset: <b>{v.tapOffsetMs} ms</b>
        </span>
        <span className="flex gap-1">
          <button className="btn min-h-10 min-w-10 px-2" aria-label="Less offset" disabled={v.tapOffsetMs <= 0} onClick={() => store.setVideo({ tapOffsetMs: Math.max(0, v.tapOffsetMs - TAP_OFFSET.step) })}>
            −
          </button>
          <button className="btn min-h-10 min-w-10 px-2" aria-label="More offset" disabled={v.tapOffsetMs >= TAP_OFFSET.max} onClick={() => store.setVideo({ tapOffsetMs: Math.min(TAP_OFFSET.max, v.tapOffsetMs + TAP_OFFSET.step) })}>
            +
          </button>
        </span>
      </div>
      <button className={row} aria-pressed={prefs.videoAutoPause} onClick={() => setPrefs({ ...prefs, videoAutoPause: !prefs.videoAutoPause })} data-testid="menu-auto-pause">
        Pause the video while the popup is open: <b>{prefs.videoAutoPause ? 'on' : 'off'}</b>
      </button>
      <FileButton
        className={row}
        onPick={(e) => {
          close();
          pick(e);
        }}
      >
        Open a different file…
      </FileButton>
      <button
        className={row}
        onClick={() => {
          close();
          setHelp(true);
        }}
      >
        Keyboard shortcuts
      </button>
    </>
  );

  // R-VID-8: the match at the video's position. The clock is read live (not the last timeupdate), so a point just
  // tapped is never taken for a later one; a position is a binary search in the memoized timeline.
  const timeline = useMemo(() => new Timeline(config, events), [config, events]);
  const moment = ready ? timeline.at(clock()) : null;
  const past = moment?.past ? { state: moment.state, label: elapsed(pos * 1000) } : null;
  // Just past the latest change (+1 ms against a seek that lands a hair early): its own tap counts again.
  const onLatest = () => seekTo((fileMs(t0, timeline.latestAt) + v.tapOffsetMs + 1) / 1000);

  const mode: VideoMode = { pane, clock, ready, onPopup, onKey, menuRows, past, onLatest };
  return (
    <Scoreboard
      store={store}
      config={config}
      events={events}
      state={state}
      prefs={prefs}
      setPrefs={setPrefs}
      resumed={resumed}
      onContinue={onContinue}
      onNewMatch={onNewMatch}
      onUpdate={onUpdate}
      onPair={() => {}}
      video={mode}
    />
  );
}

/** A button that opens the file picker (a label around a visually hidden input, so iOS sees the tap). */
export function FileButton({ className, onPick, children, testid }: { className: string; onPick: (e: ChangeEvent<HTMLInputElement>) => void; children: ReactNode; testid?: string }) {
  return (
    <label className={`${className} cursor-pointer`} data-testid={testid}>
      {children}
      <input type="file" accept="video/*" className="sr-only" onChange={onPick} />
    </label>
  );
}

const mb = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`);

function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-3" onClick={onClose} data-testid="video-shortcuts">
      <div className="sheet max-h-full w-[min(460px,100%)] overflow-y-auto p-4" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <b>Keyboard shortcuts</b>
          <button className="btn btn-ghost min-h-9 px-3 text-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {SHORTCUTS.map(([k, what]) => (
              <tr key={k} className="border-b border-line">
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <kbd className="rounded border border-line bg-pan2 px-1.5 py-0.5 font-mono text-[12px]">{k}</kbd>
                </td>
                <td className="py-1.5 text-mut">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-mut">The score keys count only when no popup, list or menu is open; the video keys always work.</p>
      </div>
    </div>
  );
}
