// The Studio's rules (D16, ux-design.md C6): the default and adjusted windows, the limits, the point under the playhead.
import { describe, expect, it } from 'vitest';
import { append, configFromSetup, DEFAULT_SETUP, rallies, REPLAY_LIMITS, validReplay, type EventBody, type MatchEvent } from '../../engine';
import { withStudio, type MirrorLog } from '../../recording/meta';
import type { Segment } from '../../recording/session';
import { adjusted, fromTap, nextSpeed, pointAt, stepPoint, studioPoints } from './shots';

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

function log(points: number[], extra: (ids: string[]) => EventBody[] = () => []): MatchEvent[] {
  let ev: MatchEvent[] = [];
  const push = (b: EventBody, at: number) => (ev = append(ev, b, { at, by: 'sb', id: `e${ev.length + 1}` }));
  push({ type: 'match.start', config: cfg }, T0);
  points.forEach((ms, i) => push({ type: 'point', team: i % 2 ? 'B' : 'A' }, T0 + ms));
  const ids = ev.filter((e) => e.type === 'point').map((e) => e.id);
  extra(ids).forEach((b, i) => push(b, T0 + 900_000 + i));
  return ev;
}

describe('the Studio (D16, C6)', () => {
  it('each point has its tap on the recording; a marked one its window from the tap, the default 5 s ending 1 s before', () => {
    const ev = log([20_000, 50_000, 54_000], (ids) => [{ type: 'replay', point: ids[1] }, { type: 'replay', point: ids[2] }]);
    const ps = studioPoints(rallies(cfg, ev), 0, [seg(1, T0 + 10_000, T0 + 300_000)]);
    expect(ps.map((p) => p.rec)).toEqual([
      { segment: 1, ms: 10_000 },
      { segment: 1, ms: 40_000 },
      { segment: 1, ms: 44_000 },
    ]);
    expect(ps[0].shot).toBeNull();
    expect(ps[1].shot).toEqual({ start: -6000, end: -1000, speed: 0.5 });
    // The default window never reaches back past the previous rally's tap + 1 s.
    expect(ps[2].shot).toEqual({ start: -3000, end: -1000, speed: 0.5 });
  });

  it('an adjusted window is a replay event with every field set, kept in the limits and at least 1 s long', () => {
    const shot = { start: -6000, end: -1000, speed: 0.5 as const };
    expect(adjusted('p', shot, { start: -7000 })).toEqual({ type: 'replay', point: 'p', start: -7000, end: -1000, speed: 0.5 });
    expect(adjusted('p', shot, { speed: 0.75 })).toMatchObject({ start: -6000, end: -1000, speed: 0.75 });
    // Moving the start past the end pushes the end; moving the end before the start pulls the start.
    expect(adjusted('p', shot, { start: -500 })).toMatchObject({ start: -500, end: 500 });
    expect(adjusted('p', shot, { end: -6500 })).toMatchObject({ start: -7500, end: -6500 });
    // The limits: 30 s before the tap, 5 s after.
    expect(adjusted('p', shot, { start: -45_000 })).toMatchObject({ start: REPLAY_LIMITS.earliest });
    expect(adjusted('p', shot, { start: 4800 })).toMatchObject({ start: 4000, end: 5000 });
    expect(adjusted('p', shot, { end: -29_800 })).toMatchObject({ start: -30_000, end: -29_000 });
    for (const c of [{ start: -45_000 }, { end: 9000 }, { start: 4800 }, { end: -29_800 }, { start: -1000 }]) expect(validReplay(adjusted('p', shot, c))).toBe(true);
  });

  it('the adjusted window is what the bundle and the render use (newest mark wins)', () => {
    const ev = log([20_000], (ids) => [{ type: 'replay', point: ids[0] }, adjusted(ids[0], { start: -6000, end: -1000, speed: 0.5 }, { start: -8000, speed: 1 })]);
    const [p] = studioPoints(rallies(cfg, ev), 0, [seg(1, T0, T0 + 60_000)]);
    expect(p.shot).toEqual({ start: -8000, end: -1000, speed: 1 });
  });

  it('the point just played is the latest tap at or before the playhead, in that segment', () => {
    const ev = log([20_000, 50_000, 200_000]);
    const ps = studioPoints(rallies(cfg, ev), 0, [seg(1, T0, T0 + 100_000), seg(2, T0 + 150_000, T0 + 300_000)]);
    expect(pointAt(ps, 1, 19_999)).toBeNull();
    expect(pointAt(ps, 1, 20_000)?.rally.n).toBe(1);
    expect(pointAt(ps, 1, 80_000)?.rally.n).toBe(2);
    expect(pointAt(ps, 2, 60_000)?.rally.n).toBe(3);
    expect(pointAt(ps, 2, 10_000)).toBeNull();
  });

  it('stepping through points, the speeds in turn, and how the ends read', () => {
    const ps = studioPoints(rallies(cfg, log([20_000, 50_000])), 0, [seg(1, T0, T0 + 100_000)]);
    expect(stepPoint(ps, null, 1)?.rally.n).toBe(1);
    expect(stepPoint(ps, null, -1)?.rally.n).toBe(2);
    expect(stepPoint(ps, ps[0].rally.id, 1)?.rally.n).toBe(2);
    expect(stepPoint(ps, ps[1].rally.id, 1)).toBeNull();
    expect([nextSpeed(0.5), nextSpeed(0.75), nextSpeed(1)]).toEqual([0.75, 1, 0.5]);
    expect([fromTap(-6000), fromTap(500), fromTap(0)]).toEqual(['−6.0 s', '+0.5 s', '±0.0 s']);
  });
});

describe("the Studio's own events (studio.json, beside the camera's copy of the log)", () => {
  it('come after the log, numbered on, and win over its older tags and marks; another match or none changes nothing', () => {
    const events = log([20_000, 50_000], (ids) => [{ type: 'replay', point: ids[0] }, { type: 'undo', target: 3 }]);
    const base: MirrorLog = { matchId: 'm', config: cfg, events, receivedAt: {} };
    const p1 = events[1].id;
    const studio = {
      matchId: 'm',
      events: [
        { type: 'replay.clear' as const, point: p1, id: 's1', at: T0 + 999_000, by: 'cam' },
        { type: 'tag' as const, point: p1, how: 'winner' as const, hit: { team: 'A' as const, idx: 0 }, id: 's2', at: T0 + 999_500, by: 'cam' },
      ],
    };
    const merged = withStudio(base, studio)!;
    expect(merged.events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1).concat([events.length + 1, events.length + 2]));
    expect(merged.events.slice(0, events.length)).toEqual(events);
    const [r1] = rallies(cfg, merged.events);
    expect(r1.replay).toBeNull();
    expect(r1.tag).toMatchObject({ how: 'winner', hit: { team: 'A', idx: 0 } });
    expect(withStudio(base, { ...studio, matchId: 'other' })).toBe(base);
    expect(withStudio(base, null)).toBe(base);
    expect(withStudio(null, studio)).toBeNull();
  });
});
