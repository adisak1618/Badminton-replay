// Point replays (D16): which points get a slow replay in the video made after the match, and the window each one
// shows. A replay is marked by an event that names the point, like a tag (engine/tags.ts folds the newest one into
// Rally.replay); the window is worked out here from the point's own tap, so a mark made late (from the rally list,
// after the match) shows the same moments as one made right after the point.
import type { Rally } from './tags';
import type { ReplayBody, ReplaySpeed } from './types';

export const REPLAY_SPEEDS: readonly ReplaySpeed[] = [0.5, 0.75, 1];

/** The captain's pick (D16, Q6): the 5 s that end 1 s before the score tap, at half speed. Ms from the tap. */
export const REPLAY_DEFAULT: { start: number; end: number; speed: ReplaySpeed } = { start: -6000, end: -1000, speed: 0.5 };

/** How far a shot may be moved, in ms from its tap: up to 30 s back and 5 s after, and at least 1 s long. */
export const REPLAY_LIMITS = { earliest: -30_000, latest: 5_000, shortest: 1_000 } as const;

/** A window whose start was not set never reaches into the rally before: it starts this long after that rally's tap. */
export const REPLAY_GAP_MS = 1000;

const inRange = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x) && x >= REPLAY_LIMITS.earliest && x <= REPLAY_LIMITS.latest;

/** A mark the window rule can use: every field present is in range, and the window is at least 1 s long. */
export function validReplay(b: Pick<ReplayBody, 'start' | 'end' | 'speed'>): boolean {
  if (b.start !== undefined && !inRange(b.start)) return false;
  if (b.end !== undefined && !inRange(b.end)) return false;
  if (b.speed !== undefined && !(REPLAY_SPEEDS as readonly unknown[]).includes(b.speed)) return false;
  return (b.end ?? REPLAY_DEFAULT.end) - (b.start ?? REPLAY_DEFAULT.start) >= REPLAY_LIMITS.shortest;
}

export interface ReplayWindow {
  point: string;
  n: number;
  game: number;
  /** The point's tap and the window, on the log's clock (ms). */
  at: number;
  from: number;
  to: number;
  speed: ReplaySpeed;
  /** The shot was adjusted (a field was set) rather than left to the default. */
  adjusted: boolean;
}

/** The window of every rally that has a replay, in rally order; `rs` is `rallies(cfg, events)`. */
export function replayWindows(rs: readonly Rally[]): ReplayWindow[] {
  const out: ReplayWindow[] = [];
  rs.forEach((r, i) => {
    const m = r.replay;
    if (!m) return;
    const to = r.at + (m.end ?? REPLAY_DEFAULT.end);
    let from = r.at + (m.start ?? REPLAY_DEFAULT.start);
    const prev = rs[i - 1];
    if (m.start === undefined && prev) from = Math.min(Math.max(from, prev.at + REPLAY_GAP_MS), to - REPLAY_LIMITS.shortest);
    const adjusted = m.start !== undefined || m.end !== undefined || m.speed !== undefined;
    out.push({ point: r.id, n: r.n, game: r.game, at: r.at, from, to, speed: m.speed ?? REPLAY_DEFAULT.speed, adjusted });
  });
  return out;
}
