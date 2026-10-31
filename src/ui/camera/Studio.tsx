// C4 → "Studio" (D16, ux-design.md C6): the recording with its rally list, after the match. Any point can be given a
// replay (or have it taken off), each replay's start, end and speed adjusted against the picture and previewed, and
// points tagged while watching; "Make video" opens the replays video (RenderSheet) with the changes. Every change is
// an ordinary tag or replay event, saved at once in studio.json beside the camera's copy of the log (meta.ts).
import { useEffect, useMemo, useRef, useState } from 'react';
import { APP_BUILD } from '../../build';
import { randomId, rallies, reasonsOn, REPLAY_SPEEDS, type EventBody, type PlayerRef, type ReplaySpeed } from '../../engine';
import { buildBundle } from '../../recording/bundle';
import { MATCHES_DIR, STUDIO_FILE, withStudio, type StudioLog } from '../../recording/meta';
import type { StoredRecording } from '../../recording/storage';
import { WriterClient } from '../../recording/writerClient';
import { tagText } from '../reasons/labels';
import { TagSheet } from '../reasons/TagSheet';
import { ReplayStar } from '../ReplayPill';
import { thisDevice } from './live';
import { RenderSheet } from './RenderSheet';
import { STEP_MS, adjusted, fromTap, nextSpeed, pointAt, stepPoint, studioPoints, type Shot, type StudioPoint } from './shots';

const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
/** Where a point is shown from when it has no replay window: a few seconds before its tap. */
const LEAD_MS = 6000;

const KEYS: Array<[string, string]> = [
  ['Space', 'play'],
  ['← →', '2 s'],
  ['↑ ↓', 'point'],
  ['R', '★'],
  ['T', 'tag'],
  ['[ ]', 'start'],
  [', .', 'end'],
  ['I O', 'start/end here'],
  ['1 2 3', 'speed'],
  ['P', 'preview'],
];

export function Studio({ rec, title, onClose }: { rec: StoredRecording; title: string; onClose: () => void }) {
  const { meta } = rec;
  const base = rec.studio?.base ?? rec.log!;
  const [edits, setEdits] = useState<StudioLog>(() => rec.studio?.log ?? { matchId: base.matchId, events: [] });
  const log = useMemo(() => withStudio(base, edits)!, [base, edits]);
  const cfg = log.config;
  const reasons = reasonsOn(cfg);
  const offset = meta.clock?.offsetMs ?? 0;
  const points = useMemo(() => studioPoints(rallies(cfg, log.events), offset, meta.segments), [cfg, log, offset, meta.segments]);
  const bundle = useMemo(() => buildBundle({ meta, log, app: APP_BUILD, now: Date.now() }), [meta, log]);
  const marked = points.filter((p) => p.shot).length;

  const [segment, setSegment] = useState(meta.segments[0]?.index ?? 1);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [tagging, setTagging] = useState<{ id: string; hit?: PlayerRef } | null>(null);
  const [rendering, setRendering] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const previewEnd = useRef<number | null>(null);

  // The segment's file as a URL, made and revoked in one effect (a cleanup run twice must not revoke the live one).
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const s = meta.segments.find((x) => x.index === segment);
    const f = s && rec.files.get(s.file);
    if (!f) return setUrl(null);
    const u = URL.createObjectURL(f);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [meta.segments, rec.files, segment]);

  // Saving: one short-lived worker for the screen (the only OPFS write path on iOS before Safari 26), writes in order.
  const writer = useRef<{ w: Worker; c: WriterClient } | null>(null);
  useEffect(() => () => writer.current?.w.terminate(), []);
  const save = (next: StudioLog) => {
    if (!writer.current) {
      const w = new Worker(new URL('../../recording/opfs.worker.ts', import.meta.url), { type: 'module' });
      writer.current = { w, c: new WriterClient(w) };
    }
    void writer.current.c.put([MATCHES_DIR, meta.id], STUDIO_FILE, JSON.stringify(next)).then((r) => {
      if (!r.ok) setNote(`Could not save the change (${r.error}). It is kept while the Studio is open.`);
    });
  };
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const emit = (body: EventBody) => {
    const stamp = { at: Date.now() - offset, by: thisDevice().id, id: randomId() };
    const next = { ...editsRef.current, events: [...editsRef.current.events, { ...body, ...stamp }] };
    editsRef.current = next;
    setEdits(next);
    save(next);
  };
  // The playhead: smooth while playing, and a preview stops at its window's end.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = video.current;
      if (v) {
        const ms = v.currentTime * 1000;
        setT(ms);
        if (previewEnd.current != null && ms >= previewEnd.current) {
          previewEnd.current = null;
          v.pause();
          v.playbackRate = 1;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const seek = (seg: number, ms: number) => {
    const v = video.current;
    if (seg !== segment) {
      pendingSeek.current = ms;
      setSegment(seg);
      return;
    }
    if (v) {
      v.currentTime = Math.max(0, ms) / 1000;
      setT(Math.max(0, ms));
    }
  };
  const play = (v: HTMLVideoElement) =>
    void v.play().catch((err: DOMException) => {
      if (err.name !== 'AbortError') setNote(`The video would not play (${err.name}). Tap ▶ to try again.`);
    });
  const playPause = () => {
    const v = video.current;
    if (!v) return;
    previewEnd.current = null;
    v.playbackRate = 1;
    if (v.paused) play(v);
    else v.pause();
  };

  const current = pointAt(points, segment, t + 1);
  const target: StudioPoint | null = (sel ? points.find((p) => p.rally.id === sel) : null) ?? current;
  const replayOf = (p: StudioPoint) => bundle.replays?.find((r) => r.point === p.rally.id) ?? null;

  const show = (p: StudioPoint, select = true) => {
    if (select) setSel(p.rally.id);
    const w = replayOf(p)?.rec;
    if (w) seek(w.segment, w.fromMs);
    else if (p.rec) seek(p.rec.segment, p.rec.ms - LEAD_MS);
  };
  const toggle = (p: StudioPoint) => emit(p.shot ? { type: 'replay.clear', point: p.rally.id } : { type: 'replay', point: p.rally.id });
  const change = (p: StudioPoint, c: Partial<Shot>) => {
    if (p.shot) emit(adjusted(p.rally.id, p.shot, c));
  };
  /** The playhead as ms from the point's tap: a window end set "here". */
  const here = (p: StudioPoint): number | null => (p.rec && p.rec.segment === segment ? Math.round(t - p.rec.ms) : null);
  const preview = (p: StudioPoint) => {
    const w = replayOf(p);
    const v = video.current;
    if (!w?.rec || !v || !p.shot) return;
    seek(w.rec.segment, w.rec.fromMs);
    previewEnd.current = w.rec.toMs;
    v.playbackRate = p.shot.speed;
    play(v);
  };

  // Keyboard (the board's Q12 "keys"), when no sheet is open.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (tagging || rendering || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select')) return;
    const p = target;
    const k = e.key;
    const act: Record<string, () => void> = {
      ' ': playPause,
      ArrowLeft: () => seek(segment, t - (e.shiftKey ? 10_000 : 2000)),
      ArrowRight: () => seek(segment, t + (e.shiftKey ? 10_000 : 2000)),
      ArrowUp: () => {
        const n = stepPoint(points, target?.rally.id ?? null, -1);
        if (n) show(n);
      },
      ArrowDown: () => {
        const n = stepPoint(points, target?.rally.id ?? null, 1);
        if (n) show(n);
      },
      Escape: () => setSel(null),
      ...(p
        ? {
            r: () => toggle(p),
            ...(reasons ? { t: () => setTagging({ id: p.rally.id }) } : {}),
            '[': () => change(p, { start: p.shot!.start - STEP_MS }),
            ']': () => change(p, { start: p.shot!.start + STEP_MS }),
            ',': () => change(p, { end: p.shot!.end - STEP_MS }),
            '.': () => change(p, { end: p.shot!.end + STEP_MS }),
            i: () => here(p) != null && change(p, { start: here(p)! }),
            o: () => here(p) != null && change(p, { end: here(p)! }),
            '1': () => change(p, { speed: 0.5 }),
            '2': () => change(p, { speed: 0.75 }),
            '3': () => change(p, { speed: 1 }),
            s: () => p.shot && change(p, { speed: nextSpeed(p.shot.speed) }),
            p: () => preview(p),
          }
        : {}),
    };
    const f = act[k.length === 1 ? k.toLowerCase() : k];
    if (!f) return;
    if (!p?.shot && ['[', ']', ',', '.', 'i', 'o', '1', '2', '3', 's', 'p'].includes(k.toLowerCase())) return;
    e.preventDefault();
    f();
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const tagRally = tagging ? (rallies(cfg, log.events).find((r) => r.id === tagging.id) ?? null) : null;
  const leftTeam = bundle.events.find((e) => e.id === tagRally?.id)?.after.leftTeam ?? cfg.leftTeamAtStart;
  let game = 0;

  return (
    <main className="pad-safe-x relative flex h-full flex-col gap-2 py-2" data-testid="studio">
      <header className="flex min-h-11 shrink-0 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <button className="btn btn-ghost min-h-10 px-3" onClick={onClose} aria-label="Back">
            ‹
          </button>
          <h1 className="truncate text-lg font-bold">Studio · {title}</h1>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-sm text-mut" data-testid="studio-marked">
            ★ {marked} replay{marked === 1 ? '' : 's'}
          </span>
          <button className="btn btn-pri min-h-10 px-4" onClick={() => setRendering(true)} data-testid="studio-render">
            Make video
          </button>
        </span>
      </header>
      {note && (
        <div className="shrink-0 rounded-lg border border-line bg-pan px-3 py-1.5 text-sm text-amber" role="status">
          {note}
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-2">
        <section className="flex min-w-0 flex-[3] flex-col gap-1.5">
          <video
            ref={video}
            src={url ?? undefined}
            className="min-h-0 w-full flex-1 rounded-lg bg-black object-contain"
            playsInline
            preload="auto"
            onClick={playPause}
            onPlay={() => setPlaying(true)}
            onPause={() => {
              setPlaying(false);
              setT((video.current?.currentTime ?? 0) * 1000);
            }}
            onSeeked={() => setT((video.current?.currentTime ?? 0) * 1000)}
            onLoadedMetadata={() => {
              setDur((video.current?.duration ?? 0) * 1000);
              if (pendingSeek.current != null && video.current) {
                video.current.currentTime = pendingSeek.current / 1000;
                setT(pendingSeek.current);
                pendingSeek.current = null;
              }
            }}
            data-testid="studio-video"
          />
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <button className="btn min-h-8 px-2.5" onClick={() => seek(segment, t - 2000)} aria-label="Back 2 seconds">
              −2 s
            </button>
            <button className="btn btn-pri min-h-8 w-12 px-0" onClick={playPause} aria-label={playing ? 'Pause' : 'Play'} data-testid="studio-play">
              {playing ? '❚❚' : '▶'}
            </button>
            <button className="btn min-h-8 px-2.5" onClick={() => seek(segment, t + 2000)} aria-label="On 2 seconds">
              +2 s
            </button>
            <input
              type="range"
              className="min-w-24 flex-1"
              min={0}
              max={Math.max(1, Math.round(dur))}
              step={100}
              value={Math.round(t)}
              onChange={(e) => seek(segment, Number(e.target.value))}
              aria-label="Position"
            />
            <span className="w-24 text-right text-sm text-mut tabular-nums">
              {mmss(t)} / {mmss(dur)}
            </span>
            {meta.segments.length > 1 &&
              meta.segments.map((s) => (
                <button key={s.index} className={`btn min-h-8 px-2 text-sm ${s.index === segment ? 'btn-pri' : ''}`} onClick={() => seek(s.index, 0)}>
                  Part {s.index}
                </button>
              ))}
          </div>
          {target ? (
            <ShotEditor
              p={target}
              selected={!!sel}
              reasons={reasons}
              tag={target.rally.tag ? tagText(cfg, target.rally.tag) : null}
              here={here(target)}
              onToggle={() => toggle(target)}
              onChange={(c) => change(target, c)}
              onReset={() => emit({ type: 'replay', point: target.rally.id })}
              onPreview={() => preview(target)}
              onTag={() => setTagging({ id: target.rally.id })}
              onFollow={() => setSel(null)}
            />
          ) : (
            <p className="shrink-0 text-sm text-mut">Play the video or pick a point on the right.</p>
          )}
        </section>
        <section className="flex min-w-0 flex-[2] flex-col gap-1 overflow-y-auto [touch-action:pan-y]" aria-label="Points" data-testid="studio-points">
          {points.length === 0 && <p className="py-4 text-center text-mut">No points in this match.</p>}
          {points.map((p) => {
            const r = p.rally;
            const head = r.game !== game;
            game = r.game;
            const on = target?.rally.id === r.id;
            return (
              <div key={r.id} className="contents">
                {head && <div className="pt-1 text-[12px] font-semibold text-mut uppercase">Game {r.game}</div>}
                <div
                  className={`flex min-h-10 cursor-pointer items-center gap-1.5 rounded-lg border px-1.5 text-[14px] ${on ? 'border-pri bg-pri/15' : 'border-line bg-[#0f141b]'}`}
                  onClick={() => show(p)}
                  data-testid={`studio-point-${r.n}`}
                >
                  <ReplayStar on={!!p.shot} onToggle={() => toggle(p)} n={r.n} />
                  <span className="w-8 shrink-0 font-mono text-[12px] text-mut">#{r.n}</span>
                  <span className="w-11 shrink-0 font-bold tabular-nums">
                    {r.after.A}–{r.after.B}
                  </span>
                  <span className="w-14 shrink-0 truncate font-semibold" style={{ color: cfg.teams[r.team].color }}>
                    {cfg.teams[r.team].name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-mut">{reasons ? (r.tag ? tagText(cfg, r.tag) : 'untagged') : ''}</span>
                  <span className="shrink-0 text-[12px] text-mut tabular-nums">{p.rec ? mmss(p.rec.ms) : '–'}</span>
                </div>
              </div>
            );
          })}
        </section>
      </div>
      <p className="hidden shrink-0 text-[12px] text-mut [@media(min-height:520px)]:block">
        {KEYS.map(([k, what]) => (
          <span key={k} className="mr-3 whitespace-nowrap">
            <kbd className="rounded border border-line px-1 font-mono">{k}</kbd> {what}
          </span>
        ))}
      </p>
      {tagging && tagRally && (
        <TagSheet
          key={tagging.id}
          config={cfg}
          rally={tagRally}
          leftTeam={leftTeam}
          live={false}
          closeAfterMs={0}
          initialHit={tagging.hit}
          onTag={(b) => emit(b)}
          onClear={() => {
            emit({ type: 'tag.clear', point: tagRally.id });
            setTagging(null);
          }}
          onClose={() => setTagging(null)}
        />
      )}
      {rendering && <RenderSheet rec={{ ...rec, log }} bundle={bundle} title={title} onClose={() => setRendering(false)} />}
    </main>
  );
}

/** The point the Studio works on: its replay (★, start, end, speed, preview) and its tag, in two rows. */
function ShotEditor({
  p,
  selected,
  reasons,
  tag,
  here,
  onToggle,
  onChange,
  onReset,
  onPreview,
  onTag,
  onFollow,
}: {
  p: StudioPoint;
  selected: boolean;
  reasons: boolean;
  tag: string | null;
  here: number | null;
  onToggle: () => void;
  onChange: (c: Partial<Shot>) => void;
  onReset: () => void;
  onPreview: () => void;
  onTag: () => void;
  onFollow: () => void;
}) {
  const r = p.rally;
  const s = p.shot;
  const end = (label: string, v: number, k: 'start' | 'end') => (
    <span className="flex items-center gap-0.5">
      <span className="mr-0.5 text-[12px] text-mut">{label}</span>
      <button className="btn min-h-8 w-8 px-0" onClick={() => onChange({ [k]: v - 1000 })} aria-label={`${label} 1 s earlier`} data-testid={`studio-${k}-minus`}>
        −
      </button>
      <span className="w-12 text-center text-[13px] font-semibold tabular-nums" data-testid={`studio-${k}`}>
        {fromTap(v)}
      </span>
      <button className="btn min-h-8 w-8 px-0" onClick={() => onChange({ [k]: v + 1000 })} aria-label={`${label} 1 s later`} data-testid={`studio-${k}-plus`}>
        +
      </button>
      {here != null && (
        <button className="btn btn-ghost min-h-8 px-1.5 text-[12px]" onClick={() => onChange({ [k]: here })} aria-label={`${label} at the playhead`}>
          here
        </button>
      )}
    </span>
  );
  return (
    <div className="flex shrink-0 flex-col gap-1 rounded-lg border border-line bg-pan px-1.5 py-1" data-testid="studio-editor">
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          className={`btn min-h-8 shrink-0 px-2 text-sm ${s ? 'text-amber' : ''}`}
          onClick={onToggle}
          aria-pressed={!!s}
          aria-label={s ? `Point ${r.n} has a replay: take it off` : `Give point ${r.n} a replay`}
          data-testid="studio-star"
        >
          {s ? '★ Replay' : '☆ Replay'}
        </button>
        <b className="shrink-0 text-[14px]">
          #{r.n} · {r.after.A}–{r.after.B}
        </b>
        {selected ? (
          <button className="btn btn-ghost min-h-8 shrink-0 px-1.5 text-[12px]" onClick={onFollow}>
            follow video
          </button>
        ) : (
          <span className="shrink-0 text-[12px] text-mut">just played</span>
        )}
        <span className="min-w-0 flex-1" />
        {reasons && (
          <button className="btn min-h-8 min-w-0 truncate px-2 text-[13px]" onClick={onTag} data-testid="studio-tag">
            {tag ? `🏷 ${tag}` : '🏷 Tag'}
          </button>
        )}
      </div>
      {s && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {end('Start', s.start, 'start')}
          {end('End', s.end, 'end')}
          <span className="flex items-center gap-0.5">
            {REPLAY_SPEEDS.map((v: ReplaySpeed) => (
              <button key={v} className={`btn min-h-8 px-2 text-[13px] ${s.speed === v ? 'btn-pri' : ''}`} onClick={() => onChange({ speed: v })} aria-pressed={s.speed === v} data-testid={`studio-speed-${v}`}>
                ×{v}
              </button>
            ))}
          </span>
          <button className="btn min-h-8 px-2 text-[13px]" onClick={onPreview} data-testid="studio-preview">
            ▶ Preview
          </button>
          <button className="btn btn-ghost min-h-8 px-1.5 text-[12px]" onClick={onReset} title="Back to the default window: the 5 s ending 1 s before the tap, ×0.5">
            Reset
          </button>
          <span className="text-[12px] text-mut tabular-nums">
            {((s.end - s.start) / 1000).toFixed(1)} s → {((s.end - s.start) / 1000 / s.speed + 0.25).toFixed(1)} s
          </span>
        </div>
      )}
    </div>
  );
}
