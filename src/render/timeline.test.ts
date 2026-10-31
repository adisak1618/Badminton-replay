// The video made after the match (D16): where replays go in, how long the clip grows, the parts, the late tags.
import { describe, expect, it } from 'vitest';
import { append, configFromSetup, DEFAULT_SETUP, type EventBody, type MatchEvent } from '../engine';
import { REPLAY_TIMES, replayFrame, replayMarks, replayPause } from '../overlay';
import { buildBundle, type MatchBundle } from '../recording/bundle';
import { newMeta } from '../recording/meta';
import type { Segment } from '../recording/session';
import { RETRO_TAG_MS, retroTags } from './retro';
import { INSERT_AFTER_TAP_MS, PART_MS, burnedIn, liveSourceAt, parts, piecesIn, segmentTimeline } from './timeline';

const cfg = configFromSetup({ ...DEFAULT_SETUP, reasons: 'endOfGame' });
const T0 = 1_000_000;

const seg = (o: Partial<Segment> = {}): Segment => ({
  index: 1,
  file: 'video-1.mp4',
  mimeType: 'video/mp4',
  width: 1920,
  height: 1080,
  fps: 30,
  startedAt: T0,
  firstFrameAt: T0,
  startLatencyMs: 0,
  endedAt: T0 + 600_000,
  bytes: 1,
  endReason: 'user',
  overlay: { box: { x: 43, y: 43, w: 400, h: 100 }, boxes: [{ at: T0, box: { x: 43, y: 43, w: 400, h: 100 } }], corner: 'tl', size: 'medium', delayMs: 0, mirrored: false, theme: 'bwf-championship-v1', motion: 'full', logo: null },
  ...o,
});

/** Points at the given ms of the recording; `marks` of them (by index) get a replay. */
function bundle(points: number[], marks: number[], s: Segment = seg()): MatchBundle {
  let ev: MatchEvent[] = [];
  const push = (b: EventBody, at: number) => (ev = append(ev, b, { at, by: 'sb', id: `e${ev.length + 1}` }));
  push({ type: 'match.start', config: cfg }, T0);
  points.forEach((ms, i) => push({ type: 'point', team: i % 2 ? 'B' : 'A' }, T0 + ms));
  const ids = ev.filter((e) => e.type === 'point').map((e) => e.id);
  for (const i of marks) push({ type: 'replay', point: ids[i] }, T0 + 590_000 + i);
  return buildBundle({ meta: { ...newMeta('m', 'm', { id: 'c', ua: '' }, T0), segments: [s] }, log: { matchId: 'm', config: cfg, events: ev, receivedAt: {} }, app: 't', now: T0 });
}

describe('the output timeline (D16: replays inserted, the live picture paused under them)', () => {
  it('a replay goes in 2 s after its point; the clip grows by its pause and no live moment is lost', () => {
    const b = bundle([20_000, 50_000], [1]);
    const t = segmentTimeline(b, 1, 120_000, { replays: true });
    const [live1, rp, live2] = t.pieces;
    const plan = rp.kind === 'replay' ? rp.plan : null!;
    const m = replayMarks(plan);
    expect(plan.at).toBe(50_000 + INSERT_AFTER_TAP_MS);
    expect({ from: plan.from, to: plan.to, speed: plan.speed }).toEqual({ from: 44_000, to: 49_000, speed: 0.5 });
    expect(live1).toEqual({ kind: 'live', out: 0, src: 0, len: m.start - 0 });
    expect(rp).toMatchObject({ kind: 'replay', out: m.start, len: m.back - m.start, pauseAt: m.start });
    expect(live2).toEqual({ kind: 'live', out: m.back, src: m.start, len: 120_000 - m.start });
    expect(t.outMs).toBe(120_000 + replayPause(plan));
    // 5 s at half speed is 10 s of replay (the dissolve in is its start) plus the 0.25 s dissolve back to live; the card's
    // spin-in runs over the live picture and its spin-out over the resumed one.
    expect(replayPause(plan)).toBe(10_000 + REPLAY_TIMES.full.mix);
  });

  it('every live moment of the recording appears once, in order', () => {
    const b = bundle([10_000, 40_000, 70_000], [0, 2]);
    const t = segmentTimeline(b, 1, 100_000, { replays: true });
    const live = t.pieces.filter((p) => p.kind === 'live');
    let next = 0;
    for (const p of live) {
      expect(p.src).toBe(next);
      next = p.src + p.len;
    }
    expect(next).toBe(100_000);
    expect(t.pieces.filter((p) => p.kind === 'replay')).toHaveLength(2);
  });

  it('without replays the clip keeps its length; a segment with no mark has none', () => {
    const b = bundle([10_000], [0]);
    expect(segmentTimeline(b, 1, 60_000, { replays: false })).toMatchObject({ outMs: 60_000, pieces: [{ kind: 'live', out: 0, src: 0, len: 60_000 }] });
    expect(segmentTimeline(b, 2, 60_000, { replays: true }).pieces).toHaveLength(1);
  });

  it('the light set dissolves (no card) and pauses right at the insert point; the none set cuts', () => {
    const b = bundle([20_000], [0]);
    const light = segmentTimeline(b, 1, 60_000, { replays: true, motion: 'light' });
    expect(light.pieces[1]).toMatchObject({ kind: 'replay', pauseAt: 22_000 });
    const none = segmentTimeline(b, 1, 60_000, { replays: true, motion: 'none' });
    expect(none.outMs).toBe(60_000 + 10_000);
  });

  it('parts cut the output in PART_MS pieces; piecesIn cuts the pieces to a part', () => {
    const b = bundle([100_000], [0]);
    const t = segmentTimeline(b, 1, 300_000, { replays: true });
    const ps = parts(t);
    expect(ps.map((p) => p.from)).toEqual([0, PART_MS, 2 * PART_MS]);
    expect(ps[2].to).toBe(t.outMs);
    const inPart = piecesIn(t, PART_MS, 2 * PART_MS);
    expect(inPart.reduce((a, p) => a + p.len, 0)).toBe(PART_MS);
    expect(inPart[0]).toMatchObject({ out: PART_MS });
  });

  it('liveSourceAt: the recording ms of the live picture, the paused frame during a replay', () => {
    const b = bundle([20_000], [0]);
    const t = segmentTimeline(b, 1, 60_000, { replays: true });
    const rp = t.pieces[1];
    expect(liveSourceAt(t, 1000)).toBe(1000);
    if (rp.kind !== 'replay') throw new Error('no replay');
    expect(liveSourceAt(t, rp.out + 3000)).toBe(rp.pauseAt);
    expect(liveSourceAt(t, rp.out + rp.len + 1000)).toBe(rp.pauseAt + 1000);
  });

  it('an imported file (D17) or an unpaired recording burned nothing in; a recording did', () => {
    const b = bundle([10_000], []);
    expect(burnedIn(b, seg())).toBe(true);
    expect(burnedIn({ recording: { segments: [], source: 'imported' } as never }, seg())).toBe(false);
    expect(burnedIn(b, seg({ overlay: { ...seg().overlay, box: { x: 0, y: 0, w: 0, h: 0 }, boxes: [] } }))).toBe(false);
  });
});

describe('replay graphics timing (overlay/replay.ts)', () => {
  const plan = { at: 10_000, from: 0, to: 5000, speed: 0.5, motion: 'full' as const };
  it('the card turns in, holds while the picture dissolves, turns out; the picture shows the window at half speed', () => {
    const m = replayMarks(plan);
    expect(replayFrame(plan, 9_999).on).toBe(false);
    expect(replayFrame(plan, 10_090).card).toBeGreaterThan(0);
    expect(replayFrame(plan, 10_500)).toMatchObject({ card: 1, mix: 0 });
    expect(replayFrame(plan, m.cut)).toMatchObject({ mix: 1 });
    expect(replayFrame(plan, m.start + 4000).src).toBeCloseTo(2000, 0);
    expect(replayFrame(plan, m.end - 1).src).toBeGreaterThan(4999);
    expect(replayFrame(plan, m.back).mix).toBe(0);
    expect(replayFrame(plan, m.done).on).toBe(false);
  });

  it('the same plan and time give the same frame (a render is repeatable)', () => {
    for (const t of [10_000, 10_333, 15_000, 21_000]) expect(replayFrame(plan, t)).toEqual(replayFrame({ ...plan }, t));
  });
});

describe('late tags count from their point (retro.ts)', () => {
  it('a tag typed after the match moves to its point + 3 s; one typed in time stays; the newest still wins', () => {
    let ev: MatchEvent[] = [];
    const push = (b: EventBody, at: number) => (ev = append(ev, b, { at, by: 'sb', id: `e${ev.length + 1}` }));
    push({ type: 'match.start', config: cfg }, 0);
    push({ type: 'point', team: 'A' }, 10_000);
    push({ type: 'point', team: 'B' }, 30_000);
    push({ type: 'tag', point: 'e2', how: 'winner', hit: { team: 'A', idx: 0 } }, 11_000);
    push({ type: 'tag', point: 'e3', how: 'winner', hit: { team: 'B', idx: 0 } }, 900_000);
    push({ type: 'tag', point: 'e3', how: 'unforced', hit: { team: 'A', idx: 0 } }, 900_500);
    const r = retroTags(ev);
    expect(r.find((e) => e.id === 'e4')!.at).toBe(11_000);
    const late = r.filter((e) => e.type === 'tag' && e.point === 'e3');
    expect(late.map((e) => e.at)).toEqual([30_000 + RETRO_TAG_MS, 30_000 + RETRO_TAG_MS]);
    expect(late.map((e) => e.id)).toEqual(['e5', 'e6']);
    expect(r.map((e) => e.at)).toEqual([...r.map((e) => e.at)].sort((a, b) => a - b));
  });
});
