// The Studio's timeline as data (D16, design B, ux-design.md C6): each point of a recording segment as a block from the
// previous tap to its own (the log has taps, not serves), breaks over BREAK_MS hatched, each replay as a bar with its
// star, what a tap on the whole-match overview picks, the zoomed lane of one point, and what dragging a knob on it does.
// Pure, so the screen and the tests agree; times are ms on the segment's file.
import type { ReplayBody, ReplaySpeed } from '../../engine';
import { adjusted, type StudioPoint } from './shots';

/** More than this before a tap is not play: the interval, a break between games, a pause. */
export const BREAK_MS = 45_000;

export interface Span {
  from: number;
  to: number;
}

/** A span drawn `width` px wide. */
export interface Scale extends Span {
  width: number;
}

export const xAt = (s: Scale, t: number): number => ((t - s.from) / (s.to - s.from)) * s.width;
export const tAt = (s: Scale, x: number): number => s.from + (x / s.width) * (s.to - s.from);

export interface Block {
  p: StudioPoint;
  /** Play: from the previous tap, or BREAK_MS before this tap when the gap is longer. */
  from: number;
  to: number;
  /** The start of a break before `from` (hatched), or null. */
  breakFrom: number | null;
}

/** The points of `segment` in order, each as its block on the recording. */
export function blocks(points: readonly StudioPoint[], segment: number): Block[] {
  const out: Block[] = [];
  let prev = 0;
  for (const p of points) {
    if (p.rec?.segment !== segment) continue;
    const to = p.rec.ms;
    const from = Math.max(prev, to - BREAK_MS);
    out.push({ p, from, to, breakFrom: from > prev ? prev : null });
    prev = to;
  }
  return out;
}

export interface Bar {
  p: StudioPoint;
  from: number;
  to: number;
  speed: ReplaySpeed;
}

/** The replays of `segment`: each window on the recording (never before its start), from the point's tap and its shot. */
export function bars(points: readonly StudioPoint[], segment: number): Bar[] {
  const out: Bar[] = [];
  for (const p of points) {
    if (!p.shot || p.rec?.segment !== segment) continue;
    const from = Math.max(0, p.rec.ms + p.shot.start);
    out.push({ p, from, to: Math.max(from, p.rec.ms + p.shot.end), speed: p.shot.speed });
  }
  return out;
}

/** Where a replay's star sits: over the middle of its bar. */
export const starAt = (b: Bar): number => (b.from + b.to) / 2;

/**
 * What a tap at x on the overview picks: the replay whose star is nearest within `zone` px (two neighbouring stars:
 * the nearer), else the point whose block holds that moment (its break included), else nothing.
 */
export function overviewHit(bs: readonly Block[], rs: readonly Bar[], s: Scale, x: number, zone = 16): StudioPoint | null {
  let best = zone;
  let hit: StudioPoint | null = null;
  for (const b of rs) {
    const d = Math.abs(xAt(s, starAt(b)) - x);
    if (d <= best) (best = d), (hit = b.p);
  }
  if (hit) return hit;
  const t = tAt(s, x);
  return bs.find((b) => t > (b.breakFrom ?? b.from) && t <= b.to)?.p ?? null;
}

/** The zoomed lane of a point: from 6 s before its replay starts (22 s before its tap without one) to 7 s after its tap. */
export function focusSpan(p: StudioPoint, durMs: number): Span {
  const tap = p.rec?.ms ?? 0;
  const from = p.shot ? tap + p.shot.start - 6000 : tap - 22_000;
  return { from: Math.max(0, from), to: Math.min(Math.max(durMs, tap), tap + 7000) };
}

/** The lane's span zoomed by `f` around `t`: kept inside the recording and between `min` and `max` long. */
export function zoomSpan(sp: Span, f: number, t: number, durMs: number, min = 5000, max = 180_000): Span {
  const len = Math.max(min, Math.min(max, (sp.to - sp.from) * f, durMs));
  const k = (t - sp.from) / (sp.to - sp.from);
  const from = Math.max(0, Math.min(durMs - len, t - k * len));
  return { from, to: from + len };
}

/** The knob of `bar` under x: a `zone` px reach each side of the start and end (the nearer one when both reach). */
export function knobAt(s: Scale, bar: Bar, x: number, zone = 24): 'start' | 'end' | null {
  const ds = Math.abs(xAt(s, bar.from) - x);
  const de = Math.abs(xAt(s, bar.to) - x);
  if (ds > zone && de > zone) return null;
  return ds <= de ? 'start' : 'end';
}

/** A dragged edge moves in steps of this (the Studio shows tenths of a second). */
export const DRAG_STEP_MS = 100;

/** The replay event for dragging `edge` of the point's window to x on the lane (the app's limits apply). */
export function dragEdge(p: StudioPoint, edge: 'start' | 'end', s: Scale, x: number): ReplayBody | null {
  if (!p.shot || !p.rec) return null;
  return adjusted(p.rally.id, p.shot, { [edge]: Math.round((tAt(s, x) - p.rec.ms) / DRAG_STEP_MS) * DRAG_STEP_MS });
}
