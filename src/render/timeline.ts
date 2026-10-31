// The video made after the match (D16), as data: for each recorded segment, where every marked point's replay goes in
// and how the output timeline maps to the recording. Pure, so the renderer, the Studio and the tests agree.
//
// A replay is inserted 2 s after its point's score tap (the new score is on the panel by then). The card spins in over
// the live picture, the live picture pauses where the replay dissolves in and resumes there after it, so no live moment
// is lost and the clip grows by each replay's pause. Under the replay the real sound that followed the point plays on.
import { replayMarks, replayPause, type Motion, type ReplayPlan } from '../overlay';
import { segmentZero, type MatchBundle } from '../recording/bundle';
import type { Segment } from '../recording/session';

/** The replay starts this long after the point's tap. */
export const INSERT_AFTER_TAP_MS = 2000;
/** Rendering is cut into parts of this much output, each its own file, so an interruption loses one part at most. */
export const PART_MS = 120_000;

export interface LivePiece {
  kind: 'live';
  out: number; // output ms where it starts
  src: number; // recording ms where it starts
  len: number;
}

export interface ReplayPiece {
  kind: 'replay';
  out: number;
  len: number;
  point: string;
  plan: ReplayPlan; // `at` on the output timeline, `from`/`to` on the recording
  /** The recording ms the live picture pauses on; under the replay the sound from here on plays. */
  pauseAt: number;
}

export type Piece = LivePiece | ReplayPiece;

export interface SegmentTimeline {
  segment: number;
  sourceMs: number;
  outMs: number;
  pieces: Piece[];
  /** Every replay's plan, for the graphics that run over live frames (the card turning in and out). */
  plans: ReplayPlan[];
}

/** A segment burned the overlay in while recording; an imported video file (D17) or an unpaired recording did not. */
export function burnedIn(b: Pick<MatchBundle, 'recording'>, seg: Segment): boolean {
  if ((b.recording as { source?: string } | undefined)?.source === 'imported') return false;
  return seg.overlay.boxes.length > 0 || seg.overlay.box.w > 0;
}

/** Camera wall clock of recording ms `ms` in this segment: what OverlayClock was given as `now` live. */
export const cameraTime = (seg: Segment, ms: number): number => segmentZero(seg) + ms;

/**
 * The output timeline of one segment `sourceMs` long, with the bundle's marked replays (D16) that fall in it.
 * `motion` sets the transition (the segment's own set by default); `replays: false` keeps the clip's length.
 */
export function segmentTimeline(b: MatchBundle, segment: number, sourceMs: number, o: { replays: boolean; motion?: Motion }): SegmentTimeline {
  const seg = b.recording?.segments.find((s) => s.index === segment);
  const motion: Motion = o.motion ?? seg?.overlay.motion ?? 'full';
  const tapOf = new Map(b.events.filter((e) => e.type === 'point' && e.tRec?.segment === segment).map((e) => [e.id, e.tRec!.ms]));
  const marks = o.replays
    ? (b.replays ?? [])
        .filter((r) => r.rec?.segment === segment && tapOf.has(r.point))
        .map((r) => ({ r, ins: Math.min(Math.max(0, tapOf.get(r.point)! + INSERT_AFTER_TAP_MS), sourceMs - 1) }))
        .sort((a, b2) => a.ins - b2.ins)
    : [];
  const pieces: Piece[] = [];
  const plans: ReplayPlan[] = [];
  let src = 0;
  let out = 0;
  for (const { r, ins } of marks) {
    if (ins < src) continue; // a second replay inside the first one's entry: never (taps are seconds apart)
    // The card starts over the live picture at the insert point; the picture pauses where the replay dissolves in.
    const at = out + (ins - src);
    const entry = replayMarks({ at, from: r.rec!.fromMs, to: r.rec!.toMs, speed: r.speed, motion }).start - at;
    const pauseAt = Math.min(sourceMs, ins + entry);
    if (pauseAt > src) pieces.push({ kind: 'live', out, src, len: pauseAt - src });
    out += pauseAt - src;
    src = pauseAt;
    const plan: ReplayPlan = { at: out - (pauseAt - ins), from: r.rec!.fromMs, to: r.rec!.toMs, speed: r.speed, motion };
    const len = replayPause(plan);
    pieces.push({ kind: 'replay', out, len, point: r.point, plan, pauseAt });
    plans.push(plan);
    out += len;
  }
  if (sourceMs > src) pieces.push({ kind: 'live', out, src, len: sourceMs - src });
  out += Math.max(0, sourceMs - src);
  return { segment, sourceMs, outMs: out, pieces, plans };
}

/** The pieces of `t` overlapping output ms [from, to), each cut to that range. */
export function piecesIn(t: SegmentTimeline, from: number, to: number): Piece[] {
  const out: Piece[] = [];
  for (const p of t.pieces) {
    const a = Math.max(from, p.out);
    const z = Math.min(to, p.out + p.len);
    if (z <= a) continue;
    out.push(p.kind === 'live' ? { ...p, out: a, src: p.src + (a - p.out), len: z - a } : { ...p, out: a, len: z - a });
  }
  return out;
}

/** The parts the output is rendered in: [from, to) output ms, PART_MS long, the last one shorter. */
export function parts(t: SegmentTimeline, partMs = PART_MS): Array<{ index: number; from: number; to: number }> {
  const n = Math.max(1, Math.ceil(t.outMs / partMs));
  return Array.from({ length: n }, (_, i) => ({ index: i, from: i * partMs, to: Math.min(t.outMs, (i + 1) * partMs) }));
}

/** Where output ms `t` is on the recording, for the live picture (a replay piece shows the paused frame). */
export function liveSourceAt(tl: SegmentTimeline, t: number): number {
  for (const p of tl.pieces) {
    if (t < p.out || t >= p.out + p.len) continue;
    return p.kind === 'live' ? p.src + (t - p.out) : p.pauseAt;
  }
  return tl.sourceMs;
}
