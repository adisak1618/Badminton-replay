// C4 → "Studio" (D16, ux-design.md C6, design B "watch, then focus"), after the match, landscape only. Watching: the
// recording fills the screen with the whole match laid over its bottom edge (each point a block tinted by its winner,
// breaks hatched, every replay a bright bar with a star). Focus on a point (its star, "Edit this point", the points
// list): the video docks at the top and a zoomed lane of that point goes underneath, with big knobs on the replay's
// two ends; the start's controls sit on the left, the end's on the right. Every change is an ordinary tag or replay
// event, saved at once in studio.json beside the camera's copy of the log (meta.ts); "Make video" opens RenderSheet.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CanvasHTMLAttributes, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from 'react';
import { APP_BUILD } from '../../build';
import { randomId, rallies, reasonsOn, REPLAY_SPEEDS, type EventBody, type MatchConfig, type PlayerRef, type ReplayBody, type ReplaySpeed } from '../../engine';
import { buildBundle } from '../../recording/bundle';
import { MATCHES_DIR, STUDIO_FILE, withStudio, type StudioLog } from '../../recording/meta';
import type { StoredRecording } from '../../recording/storage';
import { WriterClient } from '../../recording/writerClient';
import { tagText } from '../reasons/labels';
import { TagSheet } from '../reasons/TagSheet';
import { thisDevice } from './live';
import { RenderSheet } from './RenderSheet';
import { STEP_MS, adjusted, fromTap, nextSpeed, pointAt, stepPoint, studioPoints, type Shot, type StudioPoint } from './shots';
import { bars, blocks, dragEdge, focusSpan, knobAt, overviewHit, starAt, tAt, xAt, zoomSpan, type Bar, type Block, type Scale, type Span } from './timeline';

const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
/** Where a point without a replay is shown from: a few seconds before its tap. */
const LEAD_MS = 6000;
/** Watching, the controls hide this long into playback; a tap on the video brings them back. */
const HIDE_MS = 2500;
const REPLAY = '#ffd21f';

const KEYS: Array<[string, string]> = [
  ['Space', 'play'],
  ['← →', '2 s'],
  ['↑ ↓', 'point'],
  ['Enter', 'edit'],
  ['R', '★'],
  ['T', 'tag'],
  ['[ ]', 'start'],
  [', .', 'end'],
  ['I O', 'here'],
  ['1 2 3', 'speed'],
  ['P', 'preview'],
  ['+ − 0', 'zoom'],
  ['L', 'list'],
  ['Esc', 'back'],
];

type Box = { x: number; y: number; w: number; h: number };
interface Layout {
  video: Box;
  gutter: number;
  side: number;
  lane: Box | null;
  over: Box | null;
}

/** Watching: the 16:9 picture as large as the screen allows. Focus: the picture on top, sides for the controls, the lane and the overview below. */
function layoutFor(W: number, H: number, focus: boolean): Layout {
  if (!focus) {
    let vh = H;
    let vw = (vh * 16) / 9;
    if (vw > W) (vw = W), (vh = (W * 9) / 16);
    return { video: { x: (W - vw) / 2, y: (H - vh) / 2, w: vw, h: vh }, gutter: (W - vw) / 2, side: 0, lane: null, over: null };
  }
  const phone = H < 500;
  const ovH = 30;
  const vh0 = H - (phone ? 64 : 96) - ovH - 16;
  const vw = Math.min((vh0 * 16) / 9, W - 2 * (phone ? 160 : 180));
  const vh = (vw * 9) / 16;
  return {
    video: { x: (W - vw) / 2, y: 4, w: vw, h: vh },
    gutter: 0,
    side: (W - vw) / 2 - 4,
    lane: { x: 6, y: vh + 8, w: W - 12, h: H - vh - ovH - 20 },
    over: { x: 6, y: H - ovH - 6, w: W - 12, h: ovH },
  };
}

function useWindowSize(): { W: number; H: number } {
  const [s, setS] = useState({ W: innerWidth, H: innerHeight });
  useEffect(() => {
    const on = () => setS({ W: innerWidth, H: innerHeight });
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);
  return s;
}

/** A canvas drawn on every render at the device's pixel ratio, in CSS pixels. */
function Canvas({
  box,
  draw,
  className,
  testid,
  span,
  ...on
}: {
  box: Box;
  draw: (g: CanvasRenderingContext2D, w: number, h: number) => void;
  className?: string;
  testid: string;
  /** The ms it spans, for tests and tools that point at a time on it. */
  span: Span;
} & Pick<
  CanvasHTMLAttributes<HTMLCanvasElement>,
  'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onWheel'
>) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const d = devicePixelRatio || 1;
    const w = Math.round(box.w * d);
    const h = Math.round(box.h * d);
    if (c.width !== w || c.height !== h) (c.width = w), (c.height = h);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, box.w, box.h);
    draw(g, box.w, box.h);
  });
  return (
    <canvas
      ref={ref}
      className={className}
      style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, touchAction: 'none' }}
      data-testid={testid}
      data-span={`${Math.round(span.from)},${Math.round(span.to)}`}
      {...on}
    />
  );
}

function hatch(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.strokeStyle = 'rgba(255,255,255,.12)';
  for (let i = x - h; i < x + w; i += 6) {
    g.beginPath();
    g.moveTo(i, y + h);
    g.lineTo(i + h, y);
    g.stroke();
  }
  g.restore();
}

function star(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    g.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
  }
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

/** The whole segment: a band of point blocks (breaks hatched), a bright bar per replay with its star above, the playhead. */
function drawOverview(g: CanvasRenderingContext2D, h: number, cfg: MatchConfig, bs: Block[], rs: Bar[], s: Scale, t: number, sel: string | null, bracket: Span | null) {
  const band = [h - 10, h - 2];
  for (const b of bs) {
    if (b.breakFrom != null) hatch(g, xAt(s, b.breakFrom), band[0], xAt(s, b.from) - xAt(s, b.breakFrom), band[1] - band[0]);
    g.globalAlpha = b.p.rally.id === sel ? 1 : 0.6;
    g.fillStyle = cfg.teams[b.p.rally.team].color;
    g.fillRect(xAt(s, b.from), band[0], Math.max(1, xAt(s, b.to) - xAt(s, b.from) - 0.5), band[1] - band[0]);
  }
  g.globalAlpha = 1;
  for (const r of rs) {
    const on = r.p.rally.id === sel;
    const x0 = xAt(s, r.from);
    const x1 = Math.max(x0 + 4, xAt(s, r.to));
    g.fillStyle = on ? '#fff' : REPLAY;
    g.fillRect(x0, band[0] - 7, x1 - x0, 4);
    star(g, xAt(s, starAt(r)), band[0] - 17, on ? 8 : 6.5, on ? '#fff' : REPLAY);
  }
  if (bracket) {
    g.strokeStyle = '#2f7cf6';
    g.lineWidth = 2;
    g.strokeRect(xAt(s, bracket.from), 1, Math.max(4, xAt(s, bracket.to) - xAt(s, bracket.from)), h - 2);
    g.lineWidth = 1;
  }
  g.fillStyle = '#e5484d';
  g.fillRect(xAt(s, t) - 1, 0, 2, h);
}

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
  const [focus, setFocus] = useState<string | null>(null);
  const [lane, setLane] = useState<Span>({ from: 0, to: 30_000 });
  const [draft, setDraft] = useState<{ edge: 'start' | 'end'; body: ReplayBody } | null>(null);
  const [sheet, setSheet] = useState(false);
  const [filter, setFilter] = useState<'all' | 'star' | 'untagged'>('all');
  const [shown, setShown] = useState(true);
  const [tagging, setTagging] = useState<{ id: string; hit?: PlayerRef } | null>(null);
  const [rendering, setRendering] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const previewEnd = useRef<number | null>(null);
  const hideTimer = useRef(0);
  const { W, H } = useWindowSize();
  const L = layoutFor(W, H, focus != null);

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

  // Watching: the controls hide a while into playback.
  const poke = () => {
    setShown(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setShown(false), HIDE_MS);
  };
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  const seek = (seg: number, ms: number) => {
    const v = video.current;
    if (seg !== segment) {
      pendingSeek.current = ms;
      setSegment(seg);
      return;
    }
    const at = Math.max(0, Math.min(dur || Infinity, ms));
    if (v) v.currentTime = at / 1000;
    setT(at);
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

  const focused = focus ? (points.find((p) => p.rally.id === focus) ?? null) : null;
  const current = pointAt(points, segment, t + 1);
  /** What the keys and buttons act on: the point in focus, else the one just played. */
  const target: StudioPoint | null = focused ?? current;
  // A knob being dragged shows its new window before it is saved (once, on release).
  const shotOf = (p: StudioPoint): Shot | null =>
    draft && p.rally.id === draft.body.point ? { start: draft.body.start!, end: draft.body.end!, speed: draft.body.speed ?? 0.5 } : p.shot;
  const shown$ = (p: StudioPoint): StudioPoint => (draft && p.rally.id === draft.body.point ? { ...p, shot: shotOf(p) } : p);
  const view = points.map(shown$);
  const segBlocks = blocks(view, segment);
  const segBars = bars(view, segment);
  const whole: Scale = { from: 0, to: Math.max(dur, 1), width: 1 };

  const windowStart = (p: StudioPoint): number | null => (p.rec && p.shot ? Math.max(0, p.rec.ms + p.shot.start) : null);
  /** Focus on a point: its lane, the video at its replay's start (or a few seconds before its tap), paused. */
  const enter = (p: StudioPoint) => {
    setFocus(p.rally.id);
    setSheet(false);
    video.current?.pause();
    if (!p.rec) return;
    setLane(focusSpan(p, dur || p.rec.ms + 10_000));
    seek(p.rec.segment, windowStart(p) ?? p.rec.ms - LEAD_MS);
  };
  const leave = () => {
    setFocus(null);
    poke();
  };
  const toggle = (p: StudioPoint) => emit(p.shot ? { type: 'replay.clear', point: p.rally.id } : { type: 'replay', point: p.rally.id });
  const change = (p: StudioPoint, c: Partial<Shot>) => {
    if (!p.shot) return;
    const body = adjusted(p.rally.id, p.shot, c);
    emit(body);
    const k = c.start !== undefined ? 'start' : c.end !== undefined ? 'end' : null;
    if (k && p.rec) seek(p.rec.segment, Math.max(0, p.rec.ms + body[k]!));
  };
  /** The playhead as ms from the point's tap: a window end set "here". */
  const here = (p: StudioPoint): number | null => (p.rec && p.rec.segment === segment ? Math.round(t - p.rec.ms) : null);
  const preview = (p: StudioPoint) => {
    const w = bundle.replays?.find((r) => r.point === p.rally.id)?.rec;
    const v = video.current;
    if (!w || !v || !p.shot) return;
    seek(w.segment, w.fromMs);
    previewEnd.current = w.toMs;
    v.playbackRate = p.shot.speed;
    play(v);
  };
  const step = (by: 1 | -1) => {
    const n = stepPoint(points, target?.rally.id ?? null, by);
    if (!n) return;
    if (focused) enter(n);
    else if (n.rec) seek(n.rec.segment, windowStart(n) ?? n.rec.ms - LEAD_MS);
  };
  const zoom = (f: number) => setLane((sp) => zoomSpan(sp, f, t, dur));

  // Keyboard: PR 17's keys, plus Enter (focus), + − 0 Z (the lane), L (the list), Esc (back).
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (tagging || rendering || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select')) return;
    const p = target;
    const k = e.key;
    const act: Record<string, () => void> = {
      ' ': () => (playPause(), poke()),
      ArrowLeft: () => seek(segment, t - (e.shiftKey ? 10_000 : 2000)),
      ArrowRight: () => seek(segment, t + (e.shiftKey ? 10_000 : 2000)),
      ArrowUp: () => step(-1),
      ArrowDown: () => step(1),
      Escape: () => (sheet ? setSheet(false) : focused ? leave() : undefined),
      l: () => setSheet((s) => !s),
      ...(focused ? { '+': () => zoom(0.5), '=': () => zoom(0.5), '-': () => zoom(2), '0': () => enter(focused), z: () => enter(focused) } : {}),
      ...(p
        ? {
            Enter: () => enter(p),
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

  // ---- the overview (both modes) ----
  const ov = useRef<{ x0: number; moved: boolean } | null>(null);
  const ovScale = (w: number): Scale => ({ ...whole, width: w });
  const ovX = (e: RPointerEvent<HTMLCanvasElement>) => e.clientX - e.currentTarget.getBoundingClientRect().left;
  const overviewHandlers = {
    onPointerDown: (e: RPointerEvent<HTMLCanvasElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      ov.current = { x0: ovX(e), moved: false };
      poke();
    },
    onPointerMove: (e: RPointerEvent<HTMLCanvasElement>) => {
      if (!ov.current) return;
      const x = ovX(e);
      if (Math.abs(x - ov.current.x0) > 6) ov.current.moved = true;
      if (!ov.current.moved) return;
      const ms = tAt(ovScale(e.currentTarget.getBoundingClientRect().width), x);
      seek(segment, ms);
      if (focused) setLane((sp) => ({ from: Math.max(0, ms - (sp.to - sp.from) / 2), to: Math.max(0, ms - (sp.to - sp.from) / 2) + (sp.to - sp.from) }));
      poke();
    },
    onPointerUp: (e: RPointerEvent<HTMLCanvasElement>) => {
      const o = ov.current;
      ov.current = null;
      if (!o || o.moved) return;
      const s = ovScale(e.currentTarget.getBoundingClientRect().width);
      // A star opens that point; elsewhere the video goes there (and in focus, so does the focus).
      const hit = overviewHit(segBlocks, segBars, s, o.x0);
      const bar = hit && segBars.find((b) => b.p.rally.id === hit.rally.id);
      const onStar = !!bar && Math.abs(xAt(s, starAt(bar)) - o.x0) <= 16;
      if (hit && (onStar || focused)) return enter(points.find((p) => p.rally.id === hit.rally.id)!);
      seek(segment, tAt(s, o.x0));
    },
  };

  // ---- the lane (focus) ----
  const ln = useRef<{ kind: 'tap' | 'scrub' | 'start' | 'end' | 'pinch'; x0: number; d?: number; sp?: Span; mid?: number } | null>(null);
  const ptrs = useRef(new Map<number, number>());
  const laneScale = (w: number): Scale => ({ ...lane, width: w });
  const laneHandlers = {
    onPointerDown: (e: RPointerEvent<HTMLCanvasElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      const r = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - r.left;
      ptrs.current.set(e.pointerId, x);
      if (ptrs.current.size === 2) {
        const [a, b] = [...ptrs.current.values()];
        ln.current = { kind: 'pinch', x0: x, d: Math.abs(a - b), sp: lane, mid: tAt(laneScale(r.width), (a + b) / 2) };
        setDraft(null);
        return;
      }
      const bar = focused && segBars.find((b) => b.p.rally.id === focused.rally.id);
      const knob = bar ? knobAt(laneScale(r.width), bar, x) : null;
      ln.current = { kind: knob ?? 'tap', x0: x };
    },
    onPointerMove: (e: RPointerEvent<HTMLCanvasElement>) => {
      const g = ln.current;
      if (!g) return;
      const r = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (ptrs.current.has(e.pointerId)) ptrs.current.set(e.pointerId, x);
      if (g.kind === 'pinch' && ptrs.current.size === 2) {
        const [a, b] = [...ptrs.current.values()];
        return setLane(zoomSpan(g.sp!, g.d! / Math.max(10, Math.abs(a - b)), g.mid!, dur));
      }
      if (g.kind === 'tap' && Math.abs(x - g.x0) > 6) g.kind = 'scrub';
      if (g.kind === 'scrub') return seek(segment, tAt(laneScale(r.width), x));
      if ((g.kind === 'start' || g.kind === 'end') && focused?.rec) {
        const body = dragEdge(focused, g.kind, laneScale(r.width), x);
        if (!body) return;
        setDraft({ edge: g.kind, body });
        seek(focused.rec.segment, Math.max(0, focused.rec.ms + body[g.kind]!));
      }
    },
    onPointerUp: (e: RPointerEvent<HTMLCanvasElement>) => {
      ptrs.current.delete(e.pointerId);
      const g = ln.current;
      if (ptrs.current.size) return;
      ln.current = null;
      if (draft) {
        emit(draft.body);
        setDraft(null);
        return;
      }
      if (g?.kind !== 'tap') return;
      const s = laneScale(e.currentTarget.getBoundingClientRect().width);
      const ms = tAt(s, g.x0);
      const hit = segBlocks.find((b) => ms > (b.breakFrom ?? b.from) && ms <= b.to)?.p;
      if (hit && hit.rally.id !== focused?.rally.id) enter(points.find((p) => p.rally.id === hit.rally.id)!);
      else seek(segment, ms);
    },
    onPointerCancel: (e: RPointerEvent<HTMLCanvasElement>) => {
      ptrs.current.delete(e.pointerId);
      ln.current = null;
      setDraft(null);
    },
    onWheel: (e: RWheelEvent<HTMLCanvasElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) return setLane(zoomSpan(lane, Math.exp(e.deltaY * 0.01), tAt(laneScale(r.width), e.clientX - r.left), dur));
      const d = ((e.deltaX || e.deltaY) / r.width) * (lane.to - lane.from);
      setLane(zoomSpan({ from: lane.from + d, to: lane.to + d }, 1, lane.from + d, dur));
    },
  };
  // The lane follows playback that runs off its edge.
  useEffect(() => {
    if (!focused || !playing || (t >= lane.from && t <= lane.to)) return;
    const len = lane.to - lane.from;
    setLane({ from: Math.max(0, t - len * 0.2), to: Math.max(0, t - len * 0.2) + len });
  }, [t, playing, focused, lane]);

  const drawLane = (g: CanvasRenderingContext2D, w: number, h: number) => {
    const s = laneScale(w);
    const zero = focused?.rec?.ms ?? 0;
    const pxPerMs = w / (lane.to - lane.from);
    const stepMs = [1, 2, 5, 10, 30, 60].map((x) => x * 1000).find((x) => x * pxPerMs >= 48) ?? 60_000;
    g.font = '10px ui-monospace, Menlo, monospace';
    for (let ms = zero + Math.ceil((lane.from - zero) / stepMs) * stepMs; ms <= lane.to; ms += stepMs) {
      const x = xAt(s, ms);
      g.fillStyle = '#3a4554';
      g.fillRect(x, 0, 1, 6);
      g.fillStyle = '#8a96a6';
      g.fillText(fromTap(ms - zero).replace(' s', ''), x + 2, 10);
    }
    const y0 = 14;
    const y1 = h - 4;
    for (const b of segBlocks) {
      if (b.to < lane.from || (b.breakFrom ?? b.from) > lane.to) continue;
      if (b.breakFrom != null) hatch(g, xAt(s, b.breakFrom), y0, xAt(s, b.from) - xAt(s, b.breakFrom), y1 - y0);
      const on = b.p.rally.id === focused?.rally.id;
      g.globalAlpha = on ? 0.3 : 0.12;
      g.fillStyle = cfg.teams[b.p.rally.team].color;
      g.fillRect(xAt(s, b.from), y0, xAt(s, b.to) - xAt(s, b.from) - 1, y1 - y0);
      g.globalAlpha = 1;
      g.fillStyle = '#e8edf3';
      g.fillRect(xAt(s, b.to) - 1, y0, 2, y1 - y0);
      g.font = '600 11px -apple-system, system-ui';
      g.fillStyle = on ? '#e8edf3' : '#8a96a6';
      g.fillText(`#${b.p.rally.n} ${b.p.rally.after.A}–${b.p.rally.after.B}`, Math.max(xAt(s, b.from) + 4, 4), y1 - 5);
      g.fillText('tap', xAt(s, b.to) + 3, y0 + 11);
    }
    const bar = focused && segBars.find((b) => b.p.rally.id === focused.rally.id);
    if (bar) {
      const x0 = xAt(s, bar.from);
      const x1 = xAt(s, bar.to);
      const cy = (y0 + y1) / 2 - 4;
      g.fillStyle = REPLAY;
      g.fillRect(x0, cy - 10, x1 - x0, 20);
      g.fillStyle = '#111';
      g.font = '700 11px -apple-system, system-ui';
      const sh = shotOf(focused)!;
      g.fillText(`★ ${((sh.end - sh.start) / 1000).toFixed(1)} s ×${sh.speed} → ${((sh.end - sh.start) / 1000 / sh.speed + 0.25).toFixed(1)} s`, x0 + 18, cy + 4);
      for (const [x, k] of [
        [x0, 'start'],
        [x1, 'end'],
      ] as const) {
        g.fillStyle = '#fff';
        g.strokeStyle = REPLAY;
        g.lineWidth = 3;
        g.beginPath();
        g.arc(x, cy, 14, 0, 7);
        g.fill();
        g.stroke();
        g.lineWidth = 1;
        g.fillStyle = '#333';
        g.fillRect(x - 3.5, cy - 6, 1.5, 12);
        g.fillRect(x + 2, cy - 6, 1.5, 12);
        if (draft?.edge === k) {
          const text = `${k === 'start' ? 'Start' : 'End'} ${fromTap(sh[k])}`;
          g.font = '600 12px -apple-system, system-ui';
          const tw = g.measureText(text).width + 12;
          const tx = Math.max(2, Math.min(w - tw - 2, x - tw / 2));
          g.fillStyle = '#000';
          g.fillRect(tx, 0, tw, 16);
          g.fillStyle = '#fff';
          g.fillText(text, tx + 6, 12);
        }
      }
    }
    g.fillStyle = '#e5484d';
    g.fillRect(xAt(s, t) - 1, 0, 2, h);
  };

  const tagRally = tagging ? (rallies(cfg, log.events).find((r) => r.id === tagging.id) ?? null) : null;
  const leftTeam = bundle.events.find((e) => e.id === tagRally?.id)?.after.leftTeam ?? cfg.leftTeamAtStart;
  const btn = 'btn min-h-11 px-3';
  const roomy = L.gutter >= 64;
  /** Watching: the controls fade out a while into playback (they stay while paused). */
  const chrome = { opacity: shown || !playing ? 1 : 0, pointerEvents: shown || !playing ? ('auto' as const) : ('none' as const) };
  const fp = focused ? shown$(focused) : null;
  const fs = fp?.shot ?? null;
  const rows = points.filter((p) => filter === 'all' || (filter === 'star' ? p.shot : !p.rally.tag));
  let game = 0;

  return (
    <main className="relative h-full overflow-hidden bg-black" data-testid="studio" data-mode={focused ? 'focus' : 'watch'}>
      {/* Portrait: the rotate screen (R-DISP-7); the Studio is landscape only (the captain, 2026-10-31). */}
      <div className="fixed inset-0 z-50 hidden flex-col items-center justify-center gap-3 bg-bg p-6 text-center portrait:flex">
        <div className="text-5xl">⟲</div>
        <div className="text-2xl font-semibold">Rotate your phone to landscape</div>
        <div className="text-mut">Studio · {title}</div>
      </div>

      <video
        ref={video}
        src={url ?? undefined}
        className="absolute bg-black object-contain"
        style={{ left: L.video.x, top: L.video.y, width: L.video.w, height: L.video.h }}
        playsInline
        preload="auto"
        onClick={() => {
          if (focused) return playPause();
          if (!shown && playing) return poke();
          playPause();
          poke();
        }}
        onPlay={() => {
          setPlaying(true);
          if (!focused) poke();
        }}
        onPause={() => {
          setPlaying(false);
          setShown(true);
          setT((video.current?.currentTime ?? 0) * 1000);
        }}
        onSeeked={() => setT((video.current?.currentTime ?? 0) * 1000)}
        onLoadedMetadata={() => {
          setDur((video.current?.duration ?? 0) * 1000);
          if (pendingSeek.current != null && video.current) {
            video.current.currentTime = pendingSeek.current / 1000;
            setT(pendingSeek.current);
            pendingSeek.current = null;
          } else if (video.current && video.current.currentTime === 0) video.current.currentTime = 0.04; // a frame to show, not black
        }}
        data-testid="studio-video"
      />

      {!focused && (
        <>
          {/* The corners: in the black side bars when there is room, else small pills on the picture. */}
          <div className="absolute flex flex-col gap-2 transition-opacity duration-200" style={{ left: roomy ? 8 : L.video.x + 8, top: 8, ...chrome }}>
            <button className={`${btn} w-11 px-0 ${roomy ? '' : 'bg-black/60'}`} onClick={onClose} aria-label="Back">
              ‹
            </button>
            <button className={`${btn} ${roomy ? 'w-11 px-0' : 'bg-black/60'}`} onClick={() => setSheet(true)} aria-label="Points" data-testid="studio-list-open">
              ☰{roomy ? '' : ' Points'}
            </button>
          </div>
          <div className="absolute flex flex-col items-end gap-2 transition-opacity duration-200" style={{ right: roomy ? 8 : W - L.video.x - L.video.w + 8, top: 8, ...chrome }}>
            <span className="rounded bg-black/60 px-1.5 py-0.5 text-sm text-amber" data-testid="studio-marked">
              ★ {marked}
            </span>
            <button
              className={`btn btn-pri min-h-11 ${roomy ? 'w-[58px] px-0 text-[12px] leading-tight' : 'px-3'}`}
              onClick={() => setRendering(true)}
              data-testid="studio-render"
            >
              {roomy ? (
                <>
                  Make
                  <br />
                  video
                </>
              ) : (
                'Make video'
              )}
            </button>
          </div>
          <div
            className="absolute flex flex-col gap-1 px-2.5 pt-5 pb-1.5 transition-opacity duration-200"
            style={{
              left: L.video.x,
              width: L.video.w,
              top: L.video.y + L.video.h - 118,
              height: 118,
              background: 'linear-gradient(transparent, rgba(0,0,0,.8) 40%)',
              ...chrome,
            }}
          >
            <div className="flex items-center gap-2 text-sm">
              <button className={`${btn} btn-pri w-12 px-0`} onClick={() => (playPause(), poke())} aria-label={playing ? 'Pause' : 'Play'} data-testid="studio-play">
                {playing ? '❚❚' : '▶'}
              </button>
              <span className="font-mono text-[13px] tabular-nums">
                {mmss(t)} / {mmss(dur)}
              </span>
              {current && (
                <span className="min-w-0 flex-1 truncate">
                  #{current.rally.n} · {current.rally.after.A}–{current.rally.after.B}{' '}
                  <span className="text-mut">{current.rally.tag ? tagText(cfg, current.rally.tag) : ''}</span>
                </span>
              )}
              {!current && <span className="flex-1" />}
              {meta.segments.length > 1 &&
                meta.segments.map((s) => (
                  <button key={s.index} className={`${btn} px-2 text-sm ${s.index === segment ? 'btn-pri' : ''}`} onClick={() => seek(s.index, 0)}>
                    Part {s.index}
                  </button>
                ))}
              <button className={btn} onClick={() => target && enter(target)} disabled={!target} data-testid="studio-edit">
                ✎ Edit this point
              </button>
            </div>
            <Canvas
              box={{ x: 0, y: 0, w: L.video.w - 20, h: 40 }}
              className="!relative"
              draw={(g, w, h) => drawOverview(g, h, cfg, segBlocks, segBars, { ...whole, width: w }, t, current?.rally.id ?? null, null)}
              span={whole}
              testid="studio-overview"
              {...overviewHandlers}
            />
          </div>
        </>
      )}

      {focused && fp && (
        <>
          <div className="absolute flex flex-col gap-1 p-1.5" style={{ left: 0, top: 0, width: L.side, height: L.video.h + 4 }}>
            <div className="flex gap-1.5">
              <button className={`${btn} flex-1 px-1`} onClick={leave} data-testid="studio-watch">
                ‹ Watch
              </button>
              <button className={`${btn} w-11 px-0`} onClick={() => setSheet(true)} aria-label="Points" data-testid="studio-list-open">
                ☰
              </button>
            </div>
            <div className="truncate text-[14px]">
              <b>
                #{fp.rally.n} · {fp.rally.after.A}–{fp.rally.after.B}
              </b>{' '}
              <span style={{ color: cfg.teams[fp.rally.team].color }}>{cfg.teams[fp.rally.team].name}</span>
            </div>
            {fs ? (
              <>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[11px] text-mut">START</span>
                  <b className="font-mono text-[20px] tabular-nums" data-testid="studio-start">
                    {fromTap(fs.start)}
                  </b>
                </div>
                <div className="flex gap-1">
                  <button className={`${btn} min-w-0 flex-1 px-0 text-sm whitespace-nowrap`} onClick={() => change(fp, { start: fs.start - STEP_MS })} aria-label="Start 1 s earlier" data-testid="studio-start-minus">
                    −1 s
                  </button>
                  <button className={`${btn} min-w-0 flex-1 px-0 text-sm whitespace-nowrap`} onClick={() => change(fp, { start: fs.start + STEP_MS })} aria-label="Start 1 s later" data-testid="studio-start-plus">
                    +1 s
                  </button>
                  <button
                    className={`${btn} btn-ghost min-w-0 flex-1 px-0 text-sm`}
                    onClick={() => here(fp) != null && change(fp, { start: here(fp)! })}
                    disabled={here(fp) == null}
                    aria-label="Start at the playhead"
                  >
                    here
                  </button>
                </div>
              </>
            ) : (
              <p className="text-sm text-mut">No replay on this point.</p>
            )}
            <p className="mt-auto hidden text-[11px] leading-5 text-mut [@media(min-height:640px)]:block">
              {KEYS.map(([k, what]) => (
                <span key={k} className="mr-2 inline-block whitespace-nowrap">
                  <kbd className="rounded border border-line px-1 font-mono">{k}</kbd> {what}
                </span>
              ))}
            </p>
            <div className="flex gap-1.5 [@media(max-height:639px)]:mt-auto">
              <button className={`${btn} flex-1 px-0`} onClick={() => step(-1)} aria-label="Previous point">
                ◀ #{Math.max(1, fp.rally.n - 1)}
              </button>
              <button className={`${btn} flex-1 px-0`} onClick={() => step(1)} aria-label="Next point">
                #{Math.min(points.length, fp.rally.n + 1)} ▶
              </button>
            </div>
          </div>
          <div className="absolute flex flex-col gap-1 p-1.5" style={{ right: 0, top: 0, width: L.side, height: L.video.h + 4 }}>
            <div className="flex gap-1.5">
              {reasons && (
                <button className={`${btn} w-11 px-0`} onClick={() => setTagging({ id: fp.rally.id })} aria-label="Tag" title={fp.rally.tag ? tagText(cfg, fp.rally.tag) : 'Tag'} data-testid="studio-tag">
                  🏷
                </button>
              )}
              <button className={`${btn} flex-1 px-1 ${fs ? 'text-amber' : ''}`} onClick={() => toggle(fp)} aria-pressed={!!fs} data-testid="studio-star">
                {fs ? '★ Replay' : '☆ Replay'}
              </button>
            </div>
            {fs ? (
              <>
                <div className="flex items-baseline justify-end gap-1.5">
                  <span className="text-[11px] text-mut">END</span>
                  <b className="font-mono text-[20px] tabular-nums" data-testid="studio-end">
                    {fromTap(fs.end)}
                  </b>
                </div>
                <div className="flex gap-1">
                  <button className={`${btn} min-w-0 flex-1 px-0 text-sm whitespace-nowrap`} onClick={() => change(fp, { end: fs.end - STEP_MS })} aria-label="End 1 s earlier" data-testid="studio-end-minus">
                    −1 s
                  </button>
                  <button className={`${btn} min-w-0 flex-1 px-0 text-sm whitespace-nowrap`} onClick={() => change(fp, { end: fs.end + STEP_MS })} aria-label="End 1 s later" data-testid="studio-end-plus">
                    +1 s
                  </button>
                  <button
                    className={`${btn} btn-ghost min-w-0 flex-1 px-0 text-sm`}
                    onClick={() => here(fp) != null && change(fp, { end: here(fp)! })}
                    disabled={here(fp) == null}
                    aria-label="End at the playhead"
                  >
                    here
                  </button>
                </div>
                <div className="flex min-w-0">
                  {REPLAY_SPEEDS.map((v: ReplaySpeed) => (
                    <button
                      key={v}
                      className={`${btn} min-w-0 flex-1 rounded-none px-0 text-sm first:rounded-l-lg last:rounded-r-lg ${fs.speed === v ? 'btn-pri' : ''}`}
                      onClick={() => change(fp, { speed: v })}
                      aria-pressed={fs.speed === v}
                      data-testid={`studio-speed-${v}`}
                    >
                      ×{v}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1.5">
                  <button className={`${btn} min-w-0 flex-1 px-1 text-sm whitespace-nowrap`} onClick={() => preview(fp)} data-testid="studio-preview">
                    ▶ Preview
                  </button>
                  <button className={`${btn} btn-ghost px-1.5 text-sm`} onClick={() => emit({ type: 'replay', point: fp.rally.id })} title="Back to the default window: the 5 s ending 1 s before the tap, ×0.5">
                    Reset
                  </button>
                </div>
              </>
            ) : (
              <p className="text-right text-sm text-mut">{fp.rally.tag ? tagText(cfg, fp.rally.tag) : reasons ? 'untagged' : ''}</p>
            )}
          </div>
          <Canvas box={L.lane!} className="rounded-md border border-line bg-[#0d1218]" draw={drawLane} span={lane} testid="studio-lane" {...laneHandlers} />
          <Canvas
            box={L.over!}
            draw={(g, w, h) => drawOverview(g, h, cfg, segBlocks, segBars, { ...whole, width: w }, t, focused.rally.id, lane)}
            span={whole}
            testid="studio-overview"
            {...overviewHandlers}
          />
        </>
      )}

      {note && (
        <div className="absolute top-2 left-1/2 z-30 max-w-[90%] -translate-x-1/2 rounded-lg border border-line bg-pan px-3 py-1.5 text-sm text-amber" role="status">
          {note}
        </div>
      )}

      {sheet && (
        <div className="absolute inset-0 z-30 bg-black/50" onClick={() => setSheet(false)}>
          <div
            className="sheet absolute right-0 bottom-0 left-0 flex h-[78%] flex-col rounded-t-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Points"
            data-testid="studio-sheet"
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-line p-2">
              <b className="mr-auto">Points</b>
              {(
                [
                  ['all', `All ${points.length}`],
                  ['star', `★ ${marked}`],
                  ...(reasons ? [['untagged', `Untagged ${points.filter((p) => !p.rally.tag).length}`]] : []),
                ] as Array<[typeof filter, string]>
              ).map(([f, label]) => (
                <button key={f} className={`${btn} ${filter === f ? 'btn-pri' : ''}`} onClick={() => setFilter(f)} data-testid={`studio-filter-${f}`}>
                  {label}
                </button>
              ))}
              <button className={btn} onClick={() => setSheet(false)}>
                Close
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2 [touch-action:pan-y]">
              {rows.length === 0 && <p className="py-4 text-center text-mut">Nothing here.</p>}
              {rows.map((p) => {
                const r = p.rally;
                const head = r.game !== game;
                game = r.game;
                return (
                  <div key={r.id} className="contents">
                    {head && <div className="pt-1 text-[12px] font-semibold text-mut uppercase">Game {r.game}</div>}
                    <div
                      className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-1 text-[15px] ${r.id === target?.rally.id ? 'border-pri bg-pri/15' : 'border-line bg-[#0f141b]'}`}
                      onClick={() => enter(p)}
                      data-testid={`studio-point-${r.n}`}
                    >
                      <button
                        className={`btn btn-ghost min-h-11 w-11 shrink-0 px-0 text-[20px] ${p.shot ? 'text-amber' : 'text-mut'}`}
                        aria-pressed={!!p.shot}
                        aria-label={p.shot ? `Point ${r.n} has a replay: take it off` : `Give point ${r.n} a replay`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(p);
                        }}
                        data-testid={`studio-point-${r.n}-star`}
                      >
                        {p.shot ? '★' : '☆'}
                      </button>
                      <span className="w-9 shrink-0 font-mono text-[13px] text-mut">#{r.n}</span>
                      <b className="w-12 shrink-0 tabular-nums">
                        {r.after.A}–{r.after.B}
                      </b>
                      <span className="w-20 shrink-0 truncate font-semibold" style={{ color: cfg.teams[r.team].color }}>
                        {cfg.teams[r.team].name}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-mut">{reasons ? (r.tag ? tagText(cfg, r.tag) : 'untagged') : ''}</span>
                      {p.shot && <span className="text-sm text-mut">×{p.shot.speed}</span>}
                      <span className="shrink-0 pr-2 font-mono text-[13px] text-mut">{p.rec ? mmss(p.rec.ms) : '–'}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

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
