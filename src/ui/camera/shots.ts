// The Studio (D16, ux-design.md C6) as data: each counted rally with where its tap is in the recording and, when it has
// a replay, the window as ms from that tap; a changed window as the replay event to append; the point the playhead has
// just passed. Pure, so the screen and the tests agree.
import { REPLAY_LIMITS, REPLAY_SPEEDS, replayWindows, type Rally, type ReplayBody, type ReplaySpeed } from '../../engine';
import { tRecFor } from '../../recording/bundle';
import type { Segment } from '../../recording/session';

/** A replay window as the Studio edits it: ms from the point's tap (negative = before it), and the speed. */
export interface Shot {
  start: number;
  end: number;
  speed: ReplaySpeed;
}

export interface StudioPoint {
  rally: Rally;
  /** The tap on the recording: segment and ms from its t = 0; null when nothing was recording. */
  rec: { segment: number; ms: number } | null;
  /** The replay window in force (the default one until adjusted), or null when the point has no replay. */
  shot: Shot | null;
}

/** Every counted rally with its place on the recording and its replay window, in rally order. */
export function studioPoints(rs: readonly Rally[], offsetMs: number, segments: readonly Segment[]): StudioPoint[] {
  const ws = new Map(replayWindows(rs).map((w) => [w.point, w]));
  return rs.map((rally) => {
    const w = ws.get(rally.id);
    return { rally, rec: tRecFor(rally.at, offsetMs, segments), shot: w ? { start: w.from - w.at, end: w.to - w.at, speed: w.speed } : null };
  });
}

/** One step of the start and end buttons and keys (the board's Q12: start ±1 s, end ±1 s). */
export const STEP_MS = 1000;

const clamp = (x: number) => Math.min(REPLAY_LIMITS.latest, Math.max(REPLAY_LIMITS.earliest, Math.round(x)));

/**
 * The replay event for `point` after a change to its window: both ends kept within the limits (30 s before the tap to
 * 5 s after) and the window at least 1 s long, the end that was not moved giving way. Every field is set, so the
 * window no longer follows the default rule.
 */
export function adjusted(point: string, shot: Shot, change: Partial<Shot>): ReplayBody {
  let start = clamp(change.start ?? shot.start);
  let end = clamp(change.end ?? shot.end);
  if (end - start < REPLAY_LIMITS.shortest) {
    if (change.start !== undefined && change.end === undefined) {
      end = Math.min(REPLAY_LIMITS.latest, start + REPLAY_LIMITS.shortest);
      start = end - REPLAY_LIMITS.shortest;
    } else {
      start = Math.max(REPLAY_LIMITS.earliest, end - REPLAY_LIMITS.shortest);
      end = start + REPLAY_LIMITS.shortest;
    }
  }
  return { type: 'replay', point, start, end, speed: change.speed ?? shot.speed };
}

/** The next speed of the three (×0.5 → ×0.75 → ×1 → ×0.5). */
export const nextSpeed = (s: ReplaySpeed): ReplaySpeed => REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(s) + 1) % REPLAY_SPEEDS.length];

/** The point whose tap is the latest at or before recording ms `ms` of `segment`: the one just played. */
export function pointAt(points: readonly StudioPoint[], segment: number, ms: number): StudioPoint | null {
  let best: StudioPoint | null = null;
  for (const p of points) if (p.rec?.segment === segment && p.rec.ms <= ms && (!best || p.rec.ms >= best.rec!.ms)) best = p;
  return best;
}

/** The point `by` places from `id` in rally order (the first or last one when nothing is selected), or null. */
export function stepPoint(points: readonly StudioPoint[], id: string | null, by: 1 | -1): StudioPoint | null {
  if (!points.length) return null;
  const i = points.findIndex((p) => p.rally.id === id);
  if (i < 0) return by > 0 ? points[0] : points[points.length - 1];
  return points[i + by] ?? null;
}

/** Ms as signed seconds from the tap, the way the Studio shows a window's ends: "−6.0 s", "+0.5 s". */
export const fromTap = (ms: number): string => `${ms < 0 ? '−' : ms > 0 ? '+' : '±'}${(Math.abs(ms) / 1000).toFixed(1)} s`;
