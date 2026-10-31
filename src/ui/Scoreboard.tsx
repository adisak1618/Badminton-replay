// S3 scoreboard: two tap zones, top bar, Undo band, and the S3a-S3c overlays, S4 correction and S5 menu. With
// point reasons on (D15): the why-was-this-point-won popup after a tap that counted on this phone (S3d), the
// rally list to tag later (S3e), and the stats card at game over and match over. Always (D16): "☆ Replay" after each
// point, in the popup or on its own for a few seconds, and the rally list's stars. Scoring a saved video (D17): the
// player pane beside the board (`video`), a compact board, the match's times on the video's clock, the player pausing
// for the popup, and keyboard shortcuts.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  matchStats,
  other,
  rallies,
  reasonsOn,
  receiverIdx,
  servingCourt,
  summaryStatus,
  type Court,
  type EventBody,
  type MatchConfig,
  type MatchEvent,
  type MatchState,
  type PlayerRef,
  type Rally,
  type Team,
} from '../engine';
import { keepScreenOn, subscribeWake, wakeHint, wakeStatus } from '../device/wakeLock';
import { DUPLICATE_WINDOW_MS } from '../engine';
import { deviceId, type Prefs } from '../match/prefs';
import type { Change, MatchStore } from '../match/store';
import { announce } from '../speech/announce';
import { scoreCall } from '../speech/phrases';
import { audioUnlocked, unlockAudio } from '../speech/sound';
import { hasVoice, speak, speechAvailable } from '../speech/speech';
import { CorrectionSheet } from './CorrectionSheet';
import { FORMAT_LABEL, elapsed, playerName } from './format';
import { GESTURE, GestureRecognizer, type Zone } from './gestures';
import { CameraStatus, useCameraLink } from './CameraLink';
import { Menu } from './Menu';
import { GameOverOverlay, IntervalOverlay, MatchOverOverlay } from './overlays';
import { useNow } from './useNow';
import { exportLog } from './exportLog';
import { RallyList } from './reasons/RallyList';
import { StatsCard, type SummaryControl } from './reasons/StatsCard';
import { TagSheet } from './reasons/TagSheet';
import { ReplayPill } from './ReplayPill';
import { isVideoAction, keyAction, typingIn, type VideoAction } from '../video/keys';

const REDO_WINDOW_MS = 5000;
/** After a tap that counted, the popup rises once the flash and the new score have shown (D15). */
const TAG_OPEN_DELAY_MS = 350;
/** How long another scoreboard's point offers "Tap to tag" here (the popup opens on the phone that tapped). */
const TAG_CHIP_MS = 6000;
/** How long "already counted" stays up after a duplicate tap (D14). */
const DUPLICATE_CUE_MS = DUPLICATE_WINDOW_MS;
/** How long "☆ Replay" stays after a point when no popup is open (D16); the rally list's star works any time later. */
const REPLAY_PILL_MS = 8000;
const NO_RALLIES: Rally[] = [];
const SHUTTLE = '\u{1F3F8}';

/** D17: the board beside a saved video being scored (video/VideoBoard.tsx). */
export interface VideoMode {
  /** The player: beside the board in landscape, above it in portrait; the board's overlays never cover it. */
  pane: ReactNode;
  /** The log's clock on the video: the match's own times (interval countdown, elapsed play) run on it. */
  clock: () => number;
  /** The file is open: taps and score keys count only then. */
  ready: boolean;
  /** The why-was-this-point-won popup opened or closed (the player pauses for it). */
  onPopup: (open: boolean) => void;
  /** A key for the player: play, seek, speed, sound, the shortcut list. */
  onKey: (a: VideoAction) => void;
  /** The menu's rows for the video (they replace the camera rows). */
  menuRows: (row: string, close: () => void) => ReactNode;
}

interface Props {
  store: MatchStore;
  config: MatchConfig;
  events: MatchEvent[];
  state: MatchState;
  prefs: Prefs;
  setPrefs: (p: Prefs) => void;
  resumed: boolean;
  onContinue: () => void;
  onNewMatch: () => void;
  onUpdate: (() => void) | null;
  onPair: () => void;
  video?: VideoMode;
}

export function Scoreboard({ store, config, events, state: s, prefs, setPrefs, resumed, onContinue, onNewMatch, onUpdate, onPair, video }: Props) {
  const camera = useCameraLink();
  const wakeLine = wakeHint(useSyncExternalStore(subscribeWake, wakeStatus));
  const [sheet, setSheet] = useState<'none' | 'menu' | 'correct'>('none');
  const [flash, setFlash] = useState<{ zone: Zone; key: number } | null>(null);
  const [undoAt, setUndoAt] = useState(0);
  const recognizer = useRef(new GestureRecognizer());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const now = useNow(500);
  // The match's own clock: the wall clock live, the video's time on the log's clock when scoring a video (D17).
  const t = video ? video.clock() : now;

  // ---- point reasons (D15) ----
  const reasons = reasonsOn(config);
  // Every counted rally: replay marks (D16) work whether or not the match asks why; `rs` is the D15 view of them.
  const all = useMemo(() => rallies(config, events), [config, events]);
  const rs = reasons ? all : NO_RALLIES;
  const over = s.phase === 'gameOver' || s.phase === 'matchOver';
  const stats = useMemo(() => (reasons && over ? matchStats(config, events) : null), [reasons, over, config, events]);
  // The summary burned into the video (R-TAG-7): its close button shows while a camera is paired.
  const sum = useMemo(() => (reasons && over ? summaryStatus(config, events, s) : null), [reasons, over, config, events, s]);
  const summary: SummaryControl | null =
    sum && camera.l.state === 'paired' ? { waiting: !sum.resolved, closed: sum.closed, onClose: () => store.emit({ type: 'summary.close' }) } : null;
  const [tagging, setTagging] = useState<{ id: string; live: boolean; hit?: PlayerRef; step?: boolean } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [offer, setOffer] = useState<{ id: string; until: number } | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const me = useMemo(deviceId, []);
  const newest = rs[rs.length - 1];
  const seen = useRef(newest?.id ?? null);
  const tagRally = tagging ? (rs.find((r) => r.id === tagging.id) ?? null) : null;
  const untaggedCount = rs.filter((r) => !r.tag).length;
  // A point undone, or counted on the other scoreboard after all: its popup goes with it.
  useEffect(() => {
    if (tagging && !tagRally) setTagging(null);
  }, [tagging, tagRally]);
  // A point that counted on another scoreboard: the popup opened there; here it can be tagged too.
  useEffect(() => {
    if (!newest || newest.id === seen.current) return;
    seen.current = newest.id;
    // Only a point just made: joining mid-match or a resync does not offer an old one.
    if (newest.by !== me && !newest.tag && prefs.askReasons && Date.now() - newest.at < TAG_CHIP_MS)
      setOffer({ id: newest.id, until: Date.now() + TAG_CHIP_MS });
  }, [newest, me, prefs.askReasons]);
  const offered = offer && now < offer.until && !tagging ? rs.find((r) => r.id === offer.id && !r.tag) : undefined;
  // ---- replay marks (D16) ----
  const toggleReplay = (r: Rally) => store.emit(r.replay ? { type: 'replay.clear', point: r.id } : { type: 'replay', point: r.id });
  const [replayOffer, setReplayOffer] = useState<{ id: string; from: number; until: number } | null>(null);
  const latest = all[all.length - 1];
  const seenLatest = useRef(latest?.id ?? null);
  // A new point, on either scoreboard: "☆ Replay" is offered for a few seconds, inside the popup when one opens (it
  // waits out the popup's own delay so it does not flash first).
  useEffect(() => {
    if (!latest || latest.id === seenLatest.current) return;
    seenLatest.current = latest.id;
    const t = Date.now();
    setReplayOffer({ id: latest.id, from: t + TAG_OPEN_DELAY_MS + 50, until: t + REPLAY_PILL_MS });
  }, [latest]);
  const replayShown = replayOffer && now >= replayOffer.from && now < replayOffer.until && !tagging && !listOpen && sheet === 'none' && !resumed;
  const replayOffered = replayShown ? all.find((r) => r.id === replayOffer.id) : undefined;
  const nextUntagged = (after: number) => rs.find((r) => !r.tag && r.n > after) ?? rs.find((r) => !r.tag && r.n !== after);
  const closeTag = (reason: 'done' | 'later' | 'timeout' | 'outside') => {
    const t = tagging;
    setTagging(null);
    // Walking through the list: a tagged one moves on to the next untagged.
    if (t?.step && reason === 'done' && tagRally) {
      const n = nextUntagged(tagRally.n);
      if (n) setTagging({ id: n.id, live: false, step: true });
    }
  };

  const L = s.leftTeam;
  const R = other(L);
  const teamOf = (z: Zone): Team => (z === 'left' ? L : R);
  const matchStart = events[0]?.at ?? t;
  const live = s.phase === 'playing' || s.phase === 'interval';
  const redoVisible = undoAt > 0 && now - undoAt < REDO_WINDOW_MS && store.canRedo();

  const emit = (body: EventBody): Change | null => {
    const c = store.emit(body);
    announce(c, prefs);
    return c;
  };

  // Any touch on the board unlocks audio and the wake lock after a resume (both need a gesture on iOS).
  const wake = () => {
    if (!audioUnlocked()) unlockAudio();
    keepScreenOn(true);
  };

  useEffect(() => {
    keepScreenOn(true);
  }, []);

  // The mid-game interval closes by itself when its countdown ends (S3a).
  useEffect(() => {
    if (video || s.phase !== 'interval' || s.phaseSince == null) return;
    const since = s.phaseSince;
    const left = since + config.intervalMs.midGame - Date.now();
    const id = setTimeout(() => {
      const cur = store.getSnapshot().state;
      if (cur?.phase === 'interval' && cur.phaseSince === since) announce(store.emit({ type: 'interval.end' }), prefs);
    }, Math.max(0, left));
    return () => clearTimeout(id);
  }, [s.phase, s.phaseSince, config.intervalMs.midGame, store, prefs]);
  // Scoring a video, the countdown is the video's: it closes once the video has played on past it (D17).
  useEffect(() => {
    if (!video || s.phase !== 'interval' || s.phaseSince == null || t < s.phaseSince + config.intervalMs.midGame) return;
    announce(store.emit({ type: 'interval.end' }), prefs);
  }, [video ? t : 0, s.phase, s.phaseSince]);

  const undo = () => {
    clearTimeout(openTimer.current);
    const c = store.undo();
    if (c) setUndoAt(Date.now());
    announce(c, prefs);
  };
  const redo = () => {
    announce(store.redo(), prefs);
    setUndoAt(0);
  };

  // ---- touch handling on the zones (ux-design.md §3) ----
  const clearTimer = (id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  };
  const onDown = (zone: Zone) => (e: ReactPointerEvent<HTMLDivElement>) => {
    wake();
    const id = e.pointerId;
    recognizer.current.down(id, e.clientX, e.clientY, performance.now(), zone);
    try {
      e.currentTarget.setPointerCapture(id);
    } catch {
      // synthetic or already-released pointer
    }
    clearTimer(id);
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        if (recognizer.current.longPress(id, performance.now())) setSheet('correct');
      }, GESTURE.longPressMs),
    );
  };
  const onMove = (e: ReactPointerEvent) => recognizer.current.move(e.pointerId, e.clientX, e.clientY);
  const onUp = (e: ReactPointerEvent) => {
    clearTimer(e.pointerId);
    const g = recognizer.current.up(e.pointerId, e.clientX, e.clientY, performance.now());
    if (!g || resumed || (video && !video.ready)) return;
    if (g.kind === 'swipeDown') return undo();
    if (g.kind === 'point' && s.phase === 'playing') score(g.zone);
  };
  const score = (zone: Zone) => {
    setFlash({ zone, key: Date.now() });
    setUndoAt(0);
    const c = emit({ type: 'point', team: teamOf(zone) });
    // The popup opens on the phone whose tap counted (a duplicate returns no change).
    if (c?.event.type === 'point' && reasons && prefs.askReasons) {
      const id = c.event.id;
      clearTimeout(openTimer.current);
      openTimer.current = setTimeout(() => setTagging({ id, live: true }), TAG_OPEN_DELAY_MS);
    }
  };

  // ---- scoring a saved video (D17) ----
  const popupOpen = !!(tagging && tagRally);
  const onPopup = useRef(video?.onPopup);
  onPopup.current = video?.onPopup;
  useEffect(() => {
    onPopup.current?.(popupOpen);
  }, [popupOpen]);
  // Keys (R-VID-4): the player's always work; the score keys do what a tap would, never under a sheet or the list.
  const onKey = useRef<(e: KeyboardEvent) => void>(undefined);
  onKey.current = (e: KeyboardEvent) => {
    if (!video || typingIn(e.target)) return;
    const a = keyAction(e);
    if (!a) return;
    e.preventDefault();
    if (isVideoAction(a)) return video.onKey(a);
    if (sheet !== 'none' || listOpen || resumed || !video.ready) return;
    const last = all[all.length - 1];
    switch (a) {
      case 'left':
      case 'right':
        // A key scores during the interval too (the break on the video is often shorter than the countdown).
        if (!tagging && (s.phase === 'playing' || s.phase === 'interval')) score(a);
        return;
      case 'undo':
        setTagging(null);
        return undo();
      case 'redo':
        if (!tagging && store.canRedo()) redo();
        return;
      case 'replay':
        if (last) toggleReplay(last);
        return;
      case 'tag':
        if (reasons && last && !tagging) setTagging({ id: last.id, live: false });
        return;
      case 'ends':
        if (!tagging) emit({ type: 'sides.swap' });
        return;
    }
  };
  useEffect(() => {
    if (!video) return;
    const h = (e: KeyboardEvent) => onKey.current?.(e);
    addEventListener('keydown', h);
    return () => removeEventListener('keydown', h);
  }, [!!video]);
  const onCancel = (e: ReactPointerEvent) => {
    clearTimer(e.pointerId);
    recognizer.current.cancel(e.pointerId);
  };
  const zoneHandlers = (zone: Zone) => ({
    onPointerDown: onDown(zone),
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onCancel,
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  });

  const dismissInterval = () => {
    if (store.getSnapshot().state?.phase !== 'interval') return;
    wake();
    recognizer.current.holdOff(performance.now()); // the overlay swallows exactly one tap
    emit({ type: 'interval.end' });
  };

  const continueResumed = () => {
    wake();
    recognizer.current.holdOff(performance.now());
    onContinue();
    if (prefs.voice && live) speak(scoreCall(s, prefs.lang), prefs.lang);
  };

  const duplicate = camera.b.duplicateAt != null && now - camera.b.duplicateAt < DUPLICATE_CUE_MS;
  const gameInfo = `Game ${s.game} · ${config.teams.A.name} ${s.games.A}–${s.games.B} ${config.teams.B.name} · ${FORMAT_LABEL[config.format]}`;
  const speechWarning = prefs.voice && (!speechAvailable() || !hasVoice(prefs.lang));

  return (
    <main className="relative flex h-full flex-col bg-bg">
      {/* Portrait: the "rotate" screen replaces the board; the match state is kept (R-DISP-7). Not when scoring a
          video: the player stacks above the board instead (D17). */}
      {!video && (
        <div className="fixed inset-0 z-50 hidden flex-col items-center justify-center gap-3 bg-bg p-6 text-center portrait:flex">
          <div className="text-5xl">⟲</div>
          <div className="text-2xl font-semibold">Rotate your phone to landscape</div>
          <div className="text-mut">
            {config.teams[L].name} {s.score[L]} – {s.score[R]} {config.teams[R].name} · game {s.game}
          </div>
        </div>
      )}

      <header className="pad-safe-x flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line text-sm text-mut">
        <span className="flex min-w-0 items-center gap-3">
          <button className="btn btn-ghost min-h-10 px-3 text-xl leading-none" aria-label="Menu" onClick={() => setSheet('menu')}>
            ⋯
          </button>
          <b className="truncate text-fg">{gameInfo}</b>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {resumed && (
            <button className={`btn btn-pri min-h-10 rounded-full px-4 text-sm ${video ? 'hidden' : ''}`} onClick={continueResumed}>
              Match resumed · tap anywhere to continue
            </button>
          )}
          {speechWarning && <span className="text-amber">no {prefs.lang === 'th' ? 'Thai' : 'English'} voice</span>}
          {!prefs.voice && <span title="voice off">voice off</span>}
          {!prefs.sound && <span title="sound off">sound off</span>}
          {reasons && untaggedCount > 0 && (
            <button className="btn min-h-9 rounded-full border border-amber/50 bg-amber/10 px-3 py-1 text-sm text-amber" onClick={() => setListOpen(true)} data-testid="untagged-chip">
              🏷 {untaggedCount} untagged
            </button>
          )}
          {!video && <CameraStatus onPair={onPair} />}
          <span className="rounded-full bg-pan2 px-3 py-1 tabular-nums" title={video ? 'play time on the video since the match started' : undefined}>
            {elapsed(t - matchStart)}
          </span>
        </span>
      </header>

      <VideoSplit pane={video?.pane}>
        <div className={`pad-safe-bottom relative flex min-h-0 flex-1 ${video ? 'min-w-0' : ''}`}>
          {(['left', 'right'] as const).map((zone) => (
            <TeamZone
              key={`${zone}-${teamOf(zone)}`}
              zone={zone}
              team={teamOf(zone)}
              config={config}
              s={s}
              flashKey={flash?.zone === zone ? flash.key : null}
              handlers={zoneHandlers(zone)}
              compact={!!video}
            />
          ))}
          <div className="pointer-events-none absolute top-0 bottom-0 left-1/2 w-px bg-line" />

          {s.phase === 'playing' && !resumed && (
            // Floating Undo on the centre line. The 96 px disc around the 64 px button is a dead zone: touches on
            // or right around it belong to Undo and never reach a tap zone. Swipe-down stays the shortcut (D6).
            <div className="absolute top-1/2 left-1/2 z-10 flex size-24 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full">
              <button
                className="flex size-16 flex-col items-center justify-center rounded-full border border-line bg-btn text-fg shadow-[0_2px_12px_rgb(0_0_0/0.6)] active:brightness-125 disabled:opacity-40"
                aria-label={redoVisible ? 'Redo' : 'Undo'}
                onClick={redoVisible ? redo : undo}
                disabled={!redoVisible && !store.canUndo()}
              >
                <span className="text-2xl leading-none">{redoVisible ? '↷' : '↶'}</span>
                <span className="text-[11px] font-semibold">{redoVisible ? 'Redo' : 'Undo'}</span>
              </button>
            </div>
          )}
          {s.phase === 'interval' && (
            <IntervalOverlay
              config={config}
              s={s}
              now={t}
              onDismiss={dismissInterval}
              onUndo={undo}
              tagPoints={reasons ? { untagged: untaggedCount, onOpen: () => setListOpen(true) } : null}
            />
          )}
          {s.phase === 'gameOver' && (
            <GameOverOverlay
              config={config}
              s={s}
              now={t}
              onUndo={undo}
              onStart={(serverIdx, receiverIdx) => {
                wake();
                emit({ type: 'game.start', game: s.game + 1, serverIdx, receiverIdx });
              }}
              card={stats && <StatsCard config={config} stats={stats} game={s.game} onList={() => setListOpen(true)} summary={summary} />}
            />
          )}
          {s.phase === 'matchOver' && (
            <MatchOverOverlay
              config={config}
              s={s}
              start={matchStart}
              end={events[events.length - 1].at}
              onUndo={undo}
              onNewMatch={onNewMatch}
              onStopRec={
                camera.b.rec?.state === 'recording' && camera.l.state === 'paired' ? () => camera.board.command('rec.stop') : null
              }
              card={stats && <StatsCard config={config} stats={stats} game={0} onList={() => setListOpen(true)} summary={summary} />}
            />
          )}
          {resumed && (
            <button className="absolute inset-0 z-30 bg-bg/20" onClick={continueResumed} aria-label="Continue the match" />
          )}
          {(duplicate || offered || replayOffered) && (
            // Above the game-over and match-over cards (z-20): the point that ends a game is often the one to replay.
            <div className="pointer-events-none absolute top-3 left-1/2 z-[31] flex w-max max-w-[95%] -translate-x-1/2 flex-wrap items-center justify-center gap-2">
              {duplicate && (
                <div className="rounded-full bg-pan2 px-4 py-2 font-semibold text-amber shadow-[0_2px_12px_rgb(0_0_0/0.6)]" role="status" data-testid="duplicate-cue">
                  Already counted on the other scoreboard
                </div>
              )}
              {offered && (
                <button
                  className="btn pointer-events-auto rounded-full border border-amber/60 bg-pan2 px-4 font-semibold text-amber shadow-[0_2px_12px_rgb(0_0_0/0.6)]"
                  onClick={() => {
                    setOffer(null);
                    setTagging({ id: offered.id, live: true });
                  }}
                  data-testid="tag-offer"
                >
                  🏷 Tap to tag point {offered.n}
                </button>
              )}
              {replayOffered && (
                <span className="pointer-events-auto">
                  <ReplayPill on={!!replayOffered.replay} onToggle={() => toggleReplay(replayOffered)} label={`point ${replayOffered.n}`} testid="replay-pill" />
                </span>
              )}
            </div>
          )}
          {listOpen && (
            <RallyList
              config={config}
              rallies={all}
              leftTeam={L}
              reasons={reasons}
              onReplay={toggleReplay}
              onOpen={(r, hit) => setTagging({ id: r.id, live: false, hit })}
              onStep={() => {
                const n = nextUntagged(0);
                if (n) setTagging({ id: n.id, live: false, step: true });
              }}
              onClose={() => setListOpen(false)}
            />
          )}
          {tagging && tagRally && (
            <TagSheet
              key={tagging.id}
              config={config}
              rally={tagRally}
              leftTeam={L}
              live={tagging.live}
              closeAfterMs={prefs.tagCloseS * 1000}
              initialHit={tagging.hit}
              onTag={(t) => store.emit(t)}
              replay={tagging.live ? { on: !!tagRally.replay, onToggle: () => toggleReplay(tagRally) } : undefined}
              onClear={() => {
                store.emit({ type: 'tag.clear', point: tagRally.id });
                setTagging(null);
              }}
              onClose={closeTag}
              onUndo={
                tagging.live
                  ? () => {
                      setTagging(null);
                      undo();
                    }
                  : undefined
              }
              next={
                tagging.step
                  ? (() => {
                      const n = nextUntagged(tagRally.n);
                      return n ? () => setTagging({ id: n.id, live: false, step: true }) : null;
                    })()
                  : null
              }
            />
          )}
          {wakeLine && (
            <div className="pointer-events-none absolute bottom-1 left-1/2 z-20 w-max max-w-[90%] -translate-x-1/2 text-center text-xs text-amber" data-testid="wake-hint">
              {wakeLine}
            </div>
          )}
          {video && !video.ready && (
            // D17: nothing counts until the file is open again (the player says how).
            <div className="absolute inset-0 z-[29] flex items-center justify-center bg-bg/70 p-4 text-center text-lg font-semibold text-mut" data-testid="video-closed">
              Open the video first
            </div>
          )}
        </div>
      </VideoSplit>

      {sheet === 'menu' && (
        <Menu
          config={config}
          s={s}
          prefs={prefs}
          setPrefs={setPrefs}
          onClose={() => setSheet('none')}
          onCorrect={() => setSheet('correct')}
          onSwapEnds={() => {
            emit({ type: 'sides.swap' });
            setSheet('none');
          }}
          onEndMatch={() => {
            emit({ type: 'match.end', reason: 'abandoned' });
            setSheet('none');
          }}
          onNewMatch={onNewMatch}
          onUpdate={onUpdate}
          onPair={() => {
            setSheet('none');
            onPair();
          }}
          reasons={reasons}
          videoRows={video ? (row) => video.menuRows(row, () => setSheet('none')) : undefined}
          onRallyList={() => {
            setSheet('none');
            setListOpen(true);
          }}
          onExport={() => {
            const m = store.getSnapshot().match;
            if (m) void exportLog(m);
          }}
        />
      )}
      {sheet === 'correct' && (
        <CorrectionSheet
          config={config}
          s={s}
          onCancel={() => setSheet('none')}
          onEvent={(b) => emit(b)}
          onApply={(b) => {
            emit(b);
            setSheet('none');
          }}
        />
      )}
    </main>
  );
}

function TeamZone({
  zone,
  team,
  config,
  s,
  flashKey,
  handlers,
  compact = false,
}: {
  zone: Zone;
  team: Team;
  config: MatchConfig;
  s: MatchState;
  flashKey: number | null;
  handlers: Record<string, unknown>;
  /** D17: beside a video the board has a fraction of the screen; type and court boxes scale to the zone. */
  compact?: boolean;
}) {
  const color = config.teams[team].color;
  const serving = s.server === team;
  const flag = s.matchPoint === team ? 'MATCH POINT' : s.gamePoint === team ? 'GAME POINT' : '';
  return (
    <div
      {...handlers}
      data-zone={zone}
      data-team={team}
      className={`zone swap-in relative flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden ${zone === 'left' ? 'zone-left' : 'zone-right'} ${compact ? '[container-type:size]' : ''}`}
      style={{ background: `${color}14` }}
    >
      {flashKey !== null && <div key={flashKey} className="flash-layer pointer-events-none absolute inset-0" style={{ background: color }} />}
      <div className={`relative flex flex-col items-center ${compact ? 'w-full' : ''}`}>
        <div className={`max-w-full truncate px-2 leading-tight font-bold tracking-wide ${compact ? 'text-[min(22px,9cqw)]' : 'text-[30px]'}`} style={{ color }}>
          {config.teams[team].name}
          {serving && <span aria-label="serving"> {SHUTTLE}</span>}
        </div>
        <div key={s.score[team]} className={`digits pop ${compact ? 'digits-compact' : ''}`} style={{ color }} data-testid={`score-${team}`}>
          {s.score[team]}
        </div>
        <div className={`font-bold text-amber ${compact ? 'h-5 text-[13px] tracking-[1px]' : 'h-[26px] text-lg tracking-[2px]'}`}>{flag}</div>
        <Courts team={team} config={config} s={s} compact={compact} />
      </div>
      {compact && (
        // The key that scores for this side (R-VID-4), on computers only.
        <kbd className="absolute bottom-2 hidden rounded-md border border-line bg-pan px-2 py-0.5 font-mono text-[13px] text-mut [@media(hover:hover)_and_(pointer:fine)]:block" aria-hidden>
          {zone === 'left' ? 'A' : 'B'}
        </kbd>
      )}
    </div>
  );
}

/**
 * R-DISP-4: the team's two service courts side by side, left court on the left and right court on the right,
 * each with its player's name; the server's box carries the shuttle and the receiver's says "receives".
 */
function Courts({ team, config, s, compact = false }: { team: Team; config: MatchConfig; s: MatchState; compact?: boolean }) {
  const color = config.teams[team].color;
  const serving = s.server === team;
  const court = servingCourt(s);
  if (!s.doubles)
    return (
      <div
        className={`mt-1 rounded-lg border px-3 py-1.5 ${compact ? 'text-[min(18px,7cqw)]' : 'text-lg'} ${serving ? 'border-current font-semibold' : 'border-dashed border-line text-[#cbd2dc]'}`}
        style={serving ? { color } : undefined}
      >
        {serving ? `serves from ${court} ${SHUTTLE}` : `receives in ${court}`}
      </div>
    );
  const rcv = receiverIdx(s);
  const order: Court[] = ['left', 'right'];
  return (
    <div className={`mt-1 flex ${compact ? 'w-[94%] gap-1.5' : 'gap-2'}`} data-testid={`courts-${team}`}>
      {order.map((c) => {
        const idx = s.pos[team][c];
        const isServer = serving && s.serverIdx === idx;
        const isReceiver = !serving && rcv === idx;
        return (
          <div
            key={c}
            data-court={c}
            className={`flex min-w-0 flex-col rounded-lg border py-1 ${compact ? 'flex-1 px-1.5' : 'w-[164px] px-2.5'} ${
              isServer ? 'border-2 border-current' : isReceiver ? 'border-2 border-dashed border-[#8a94a6]' : 'border-line'
            }`}
            style={isServer ? { color } : undefined}
          >
            <span className={`flex h-[18px] items-center justify-between font-semibold tracking-wide text-mut uppercase ${compact ? 'text-[10px]' : 'text-[12px]'}`}>
              <span>{c}</span>
              {isServer && <span className="text-base normal-case">{SHUTTLE}</span>}
              {isReceiver && <span className="text-[#e6eaf0] normal-case">{compact ? 'recv' : 'receives'}</span>}
            </span>
            <span className={`truncate leading-tight font-semibold ${compact ? 'text-[min(18px,6cqw)]' : 'text-[22px]'} ${isServer ? 'text-fg' : isReceiver ? 'text-[#e6eaf0]' : 'text-mut'}`}>
              {playerName(config, team, idx)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * D17: the player beside the board in landscape (about 56 %), above it in portrait. Without a video the board is the
 * whole body, as before. The overlays, popup and rally list live in the board, so they never cover the player.
 */
function VideoSplit({ pane, children }: { pane: ReactNode; children: ReactNode }) {
  if (!pane) return <>{children}</>;
  return (
    <div className="flex min-h-0 flex-1 portrait:flex-col">
      <div className="pad-safe-bottom flex min-h-0 shrink-0 flex-col border-line landscape:w-[56%] landscape:border-r portrait:border-b" data-testid="video-pane">
        {pane}
      </div>
      {children}
    </div>
  );
}
