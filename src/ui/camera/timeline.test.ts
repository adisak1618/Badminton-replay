// The Studio's timeline (D16, design B, ux-design.md C6): blocks and breaks, replay bars and stars, what a tap on the
// overview picks, the zoomed lane, and dragging a knob to a time.
import { describe, expect, it } from 'vitest';
import { append, configFromSetup, DEFAULT_SETUP, rallies, REPLAY_LIMITS, type EventBody, type MatchEvent } from '../../engine';
import type { Segment } from '../../recording/session';
import { studioPoints } from './shots';
import { BREAK_MS, bars, blocks, dragEdge, focusSpan, knobAt, overviewHit, starAt, tAt, xAt, zoomSpan, type Scale } from './timeline';

const cfg = configFromSetup({ ...DEFAULT_SETUP, reasons: 'endOfGame' });
const T0 = 1_000_000;
const seg = (index: number, startedAt: number, endedAt: number): Segment => ({
  index,
  file: `video-${index}.mp4`,
  mimeType: 'video/mp4',
  width: 1920,
  height: 1080,
  fps: 30,
  startedAt,
  firstFrameAt: startedAt,
  startLatencyMs: 0,
  endedAt,
  bytes: 1,
  endReason: 'user',
  overlay: { box: { x: 0, y: 0, w: 0, h: 0 }, boxes: [], corner: 'tl', size: 'medium', delayMs: 0, mirrored: false, theme: '', motion: 'full', logo: null },
});

/** Points at the given ms of a recording that starts with the match; `marks` get a replay (with an optional window). */
function points(taps: number[], marks: Array<[number, Omit<Extract<EventBody, { type: 'replay' }>, 'type' | 'point'>?]> = [], segs = [seg(1, T0, T0 + 1_800_000)]) {
  let ev: MatchEvent[] = [];
  const push = (b: EventBody, at: number) => (ev = append(ev, b, { at, by: 'sb', id: `e${ev.length + 1}` }));
  push({ type: 'match.start', config: cfg }, T0);
  taps.forEach((ms, i) => push({ type: 'point', team: i % 2 ? 'B' : 'A' }, T0 + ms));
  const ids = ev.filter((e) => e.type === 'point').map((e) => e.id);
  marks.forEach(([i, w], k) => push({ type: 'replay', point: ids[i], ...(w ?? {}) }, T0 + 1_700_000 + k));
  return studioPoints(rallies(cfg, ev), 0, segs);
}

const scale = (from: number, to: number, width: number): Scale => ({ from, to, width });

describe('blocks: each point from the previous tap to its own (D16, C6)', () => {
  it('runs tap to tap; a gap over 45 s before a tap is a break (the interval, a game break), the first from the start', () => {
    const bs = blocks(points([30_000, 55_000, 180_000, 200_000]), 1);
    expect(bs.map((b) => [b.from, b.to, b.breakFrom])).toEqual([
      [0, 30_000, null],
      [30_000, 55_000, null],
      [180_000 - BREAK_MS, 180_000, 55_000],
      [180_000, 200_000, null],
    ]);
    // A first point more than 45 s in starts with a break too.
    expect(blocks(points([70_000]), 1)[0]).toMatchObject({ from: 25_000, breakFrom: 0 });
  });

  it('keeps to its segment: points of another segment, or with no place on a recording, are not drawn', () => {
    const ps = points([20_000, 200_000, 260_000], [], [seg(1, T0, T0 + 100_000), seg(2, T0 + 150_000, T0 + 400_000)]);
    expect(blocks(ps, 1).map((b) => b.p.rally.n)).toEqual([1]);
    // Segment 2 starts at 150 s: its first point's tap is at 50 s on that file.
    expect(blocks(ps, 2).map((b) => [b.p.rally.n, b.from, b.to, b.breakFrom])).toEqual([
      [2, 5_000, 50_000, 0],
      [3, 65_000, 110_000, 50_000],
    ]);
  });
});

describe('replay bars and stars', () => {
  it('a bar spans the window on the recording, never before its start; the star sits over its middle', () => {
    const ps = points([20_000, 50_000, 4_000 + 60_000], [[1], [2, { start: -9000, end: -500, speed: 0.75 }]]);
    const rs = bars(ps, 1);
    expect(rs.map((b) => [b.p.rally.n, b.from, b.to, b.speed])).toEqual([
      [2, 44_000, 49_000, 0.5],
      [3, 55_000, 63_500, 0.75],
    ]);
    expect(starAt(rs[0])).toBe(46_500);
    // A window that starts before the recording did is cut at 0.
    expect(bars(points([3_000], [[0]]), 1)[0]).toMatchObject({ from: 0, to: 2_000 });
  });
});

describe('a tap on the overview', () => {
  const ps = points([20_000, 50_000, 54_000, 120_000, 300_000], [[1], [2], [4]]);
  const bs = blocks(ps, 1);
  const rs = bars(ps, 1);
  const s = scale(0, 360_000, 720); // 2 px a second

  it('picks the replay whose star is nearest within 16 px, the nearer of two neighbours', () => {
    expect(overviewHit(bs, rs, s, xAt(s, starAt(rs[2])) + 12)?.rally.n).toBe(5);
    // #2 and #3 replay 4 s apart (8 px): the tap goes to the nearer star.
    expect(overviewHit(bs, rs, s, xAt(s, starAt(rs[0])) - 2)?.rally.n).toBe(2);
    expect(overviewHit(bs, rs, s, xAt(s, starAt(rs[1])) + 1)?.rally.n).toBe(3);
  });

  it('else the point whose block (break included) holds that moment; past the last point, nothing', () => {
    expect(overviewHit(bs, rs, s, xAt(s, 10_000))?.rally.n).toBe(1);
    expect(overviewHit(bs, rs, s, xAt(s, 200_000))?.rally.n).toBe(5); // in the break before #5
    expect(overviewHit(bs, rs, s, xAt(s, 340_000))).toBeNull();
  });
});

describe('the zoomed lane of one point', () => {
  it('shows 6 s before the replay starts to 7 s after the tap (22 s before the tap without a replay), inside the recording', () => {
    const ps = points([20_000, 90_000, 200_000], [[1]]);
    expect(focusSpan(ps[1], 300_000)).toEqual({ from: 90_000 - 6000 - 6000, to: 97_000 });
    expect(focusSpan(ps[2], 300_000)).toEqual({ from: 178_000, to: 207_000 });
    expect(focusSpan(points([10_000])[0], 300_000).from).toBe(0);
    expect(focusSpan(ps[2], 203_000).to).toBe(203_000);
  });

  it('zooms around a moment, between 5 s and 3 min, never past the recording', () => {
    expect(zoomSpan({ from: 80_000, to: 100_000 }, 0.5, 90_000, 300_000)).toEqual({ from: 85_000, to: 95_000 });
    expect(zoomSpan({ from: 80_000, to: 100_000 }, 0.01, 90_000, 300_000)).toEqual({ from: 87_500, to: 92_500 });
    expect(zoomSpan({ from: 0, to: 20_000 }, 4, 1000, 300_000)).toEqual({ from: 0, to: 80_000 });
    expect(zoomSpan({ from: 280_000, to: 300_000 }, 100, 290_000, 300_000)).toEqual({ from: 120_000, to: 300_000 });
  });

  it('maps x to time and back', () => {
    const s = scale(84_000, 97_000, 832);
    expect(tAt(s, xAt(s, 90_000))).toBeCloseTo(90_000, 6);
    expect(xAt(s, 84_000)).toBe(0);
    expect(xAt(s, 97_000)).toBe(832);
  });
});

describe('dragging a knob', () => {
  const [p] = points([60_000], [[0]]); // window 54 s to 59 s
  const s = scale(48_000, 67_000, 760); // 40 px a second
  const bar = bars([p], 1)[0];

  it('a knob answers within 24 px of its edge, the nearer one when both reach', () => {
    expect(knobAt(s, bar, xAt(s, 54_000) - 20)).toBe('start');
    expect(knobAt(s, bar, xAt(s, 59_000) + 23)).toBe('end');
    expect(knobAt(s, bar, xAt(s, 56_500))).toBeNull();
    const short = { ...bar, from: 54_000, to: 54_800 }; // 32 px wide: both reach
    expect(knobAt(s, short, xAt(s, 54_100))).toBe('start');
    expect(knobAt(s, short, xAt(s, 54_700))).toBe('end');
  });

  it('dragging an edge to x sets that end at x on the recording, from the tap, in tenths of a second', () => {
    expect(dragEdge(p, 'start', s, xAt(s, 51_230))).toEqual({ type: 'replay', point: p.rally.id, start: -8800, end: -1000, speed: 0.5 });
    expect(dragEdge(p, 'end', s, xAt(s, 60_480))).toMatchObject({ start: -6000, end: 500 });
  });

  it('keeps the app limits: at least 1 s long, 30 s before to 5 s after the tap, the other end giving way', () => {
    expect(dragEdge(p, 'start', s, xAt(s, 59_500))).toMatchObject({ start: -500, end: 500 });
    expect(dragEdge(p, 'end', s, xAt(s, 66_900))).toMatchObject({ end: REPLAY_LIMITS.latest });
    expect(dragEdge(p, 'start', scale(0, 60_000, 600), 0)).toMatchObject({ start: REPLAY_LIMITS.earliest });
    expect(dragEdge(points([60_000])[0], 'start', s, 100)).toBeNull();
  });
});
