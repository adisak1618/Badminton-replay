import { describe, expect, it } from 'vitest';
import { matchStats, reduce } from '../engine';
import { doublesConfig, makeConfig, Match } from '../engine/test-utils';
import { buildBundle, buildLogBundle, bundleName, exportFileName, segmentAt, tRecFor } from './bundle';
import { newMeta, repairMeta, type MirrorLog, type RecordingMeta } from './meta';
import type { Segment } from './session';

const seg = (index: number, startedAt: number, endedAt: number | null, mirrored = false): Segment => ({
  index,
  file: `video-${index}.mp4`,
  mimeType: 'video/mp4',
  width: 1920,
  height: 1080,
  fps: 30,
  startedAt,
  startLatencyMs: 0,
  endedAt,
  bytes: 1000,
  endReason: endedAt ? 'user' : null,
  overlay: { box: { x: 43, y: 43, w: 500, h: 132 }, boxes: [], corner: 'tl', size: 'medium', delayMs: 0, mirrored, theme: 'bwf-tv-v4', logo: null },
});

const camera = { id: 'cam-1', ua: 'test' };

function recorded(m: Match, segments: Segment[], offsetMs = 0): { meta: RecordingMeta; log: MirrorLog } {
  const meta: RecordingMeta = {
    ...newMeta('m1', 'm1', camera, 1_000_000),
    segments,
    clock: { offsetMs, samples: offsetMs ? 8 : 0, medianRttMs: offsetMs ? 6 : 0 },
    scoreboard: { id: 'test', ua: 'scoreboard-ua' },
  };
  return { meta, log: { matchId: 'm1', config: m.cfg, events: m.events, receivedAt: {} } };
}

describe('match.json (technical-design.md §8, R-EXP-1, R-BURN-1)', () => {
  it('replays to the final score and positions, with the state after every event', () => {
    const m = new Match(doublesConfig()).rallies('AB').game(21, 15).scoreTo(5, 3).undo().point('B');
    const { meta, log } = recorded(m, [seg(1, 1_000_000, null)]);
    const b = buildBundle({ meta, log, app: 'test', now: 5 });
    const final = reduce(m.cfg, m.events);
    expect(reduce(b.config!, b.events)).toEqual(final);
    expect(b.events[b.events.length - 1].after).toEqual(final);
    expect(b.result).toEqual({ winner: null, games: final.games, completed: final.completed });
    // `after` is the prefix replay: the undone point still shows in the state right after it was scored.
    const undo = b.events.findIndex((e) => e.type === 'undo');
    expect(b.events[undo - 1].after.score).not.toEqual(b.events[undo].after.score);
    expect(b.events.map((e) => e.seq)).toEqual(m.events.map((e) => e.seq));
    expect(b).toMatchObject({ format: 'badminton-scoreboard/match', version: 1, matchId: 'm1', app: 'test' });
    expect(b.devices).toEqual({ scoreboard: { id: 'test', ua: 'scoreboard-ua' }, camera });
  });

  it('a full best of 3 records the winner', () => {
    const m = new Match(makeConfig()).game(21, 10).game(15, 21).game(21, 19);
    const { meta, log } = recorded(m, [seg(1, 0, null)]);
    expect(buildBundle({ meta, log, app: 'x', now: 0 }).result).toEqual({
      winner: 'A',
      games: { A: 2, B: 1 },
      completed: [
        { A: 21, B: 10 },
        { A: 15, B: 21 },
        { A: 21, B: 19 },
      ],
    });
  });

  it('times events on the recording across two segments, null in the gap, with the clock offset', () => {
    // Events are 1 s apart from t = 1_001_000; segment 1 covers 1_000_500..1_003_500, segment 2 from 1_005_000.
    const m = new Match(makeConfig()).rallies('ABABAB');
    const segs = [seg(1, 1_000_500, 1_003_500), seg(2, 1_005_000, null)];
    const { meta, log } = recorded(m, segs);
    const t = buildBundle({ meta, log, app: 'x', now: 0 }).events.map((e) => e.tRec);
    expect(t).toEqual([
      { segment: 1, ms: 500 },
      { segment: 1, ms: 1500 },
      { segment: 1, ms: 2500 },
      null,
      { segment: 2, ms: 0 },
      { segment: 2, ms: 1000 },
      { segment: 2, ms: 2000 },
    ]);
    // Camera clock 250 ms ahead of the scoreboard: every time shifts by the offset.
    const ahead = recorded(m, segs, 250);
    expect(buildBundle({ ...ahead, app: 'x', now: 0 }).events[0].tRec).toEqual({ segment: 1, ms: 750 });
    expect(buildBundle({ ...ahead, app: 'x', now: 0 }).clock).toEqual({ offsetMs: 250, samples: 8, medianRttMs: 6 });
  });

  it('subtracts the start latency', () => {
    expect(tRecFor(2000, 0, [{ ...seg(1, 1000, null), startLatencyMs: 120 }])).toEqual({ segment: 1, ms: 880 });
    expect(segmentAt([seg(1, 1000, 2000)], 2500)).toBeNull();
  });

  it('leftOnCamera follows the ends and flips in a mirrored segment', () => {
    const m = new Match(makeConfig()).game(21, 0).point('A');
    const plain = buildBundle({ ...recorded(m, [seg(1, 0, null)]), app: 'x', now: 0 });
    expect(plain.events[1].leftOnCamera).toBe('A');
    expect(plain.events[plain.events.length - 1].leftOnCamera).toBe('B'); // ends changed for game 2
    const mirrored = buildBundle({ ...recorded(m, [seg(1, 0, null, true)]), app: 'x', now: 0 });
    expect(mirrored.events[1].leftOnCamera).toBe('B');
  });

  it('names exported files after the match so a bundle stays together', () => {
    const at = new Date(2026, 9, 28, 19, 12).getTime();
    expect(bundleName(at)).toBe('match-20261028-1912');
    expect(exportFileName(at, 'video-2.mp4')).toBe('match-20261028-1912-video-2.mp4');
    const m = new Match(makeConfig());
    const { meta, log } = recorded(m, [seg(1, 0, null)]);
    meta.createdAt = at;
    expect(buildBundle({ meta, log, app: 'x', now: 0 }).recording!.segments[0].file).toBe('match-20261028-1912-video-1.mp4');
  });

  it('carries every segment overlay corner and boxes, logo included, into match.json (round 2)', () => {
    const m = new Match(makeConfig());
    const s1 = seg(1, 0, 10);
    const s2 = {
      ...seg(2, 20, null),
      overlay: { ...s1.overlay, corner: 'br' as const, logo: { box: { x: 1552, y: 43, w: 325, h: 130 }, corner: 'tr' as const, size: 'medium' as const } },
    };
    const b = buildBundle({ ...recorded(m, [s1, s2]), app: 'x', now: 0 });
    expect(b.recording!.segments.map((x) => [x.overlay.corner, x.overlay.logo?.corner ?? null])).toEqual([
      ['tl', null],
      ['br', 'tr'],
    ]);
    expect(b.recording!.segments[1].overlay.logo!.box).toEqual({ x: 1552, y: 43, w: 325, h: 130 });
  });

  it('an unpaired recording exports its segments with no config and no events', () => {
    const meta = { ...newMeta('cam-1', null, camera, 7), segments: [seg(1, 7, 99)] };
    const b = buildBundle({ meta, log: null, app: 'x', now: 0 });
    expect(b).toMatchObject({ matchId: 'cam-1', config: null, events: [], result: { winner: null } });
    expect(b.recording!.segments).toHaveLength(1);
  });
});

describe('repairMeta after a crash (R-REC-2)', () => {
  it('closes an open segment from the file and lists a video the metadata lost', () => {
    const meta = { ...newMeta('m1', 'm1', camera, 1), segments: [seg(1, 1000, null)] };
    const files = [
      { name: 'video-1.mp4', size: 75_000_000, lastModified: 601_000 },
      { name: 'video-2.mp4', size: 5_000, lastModified: 700_000 },
      { name: 'recording.json', size: 10, lastModified: 1 },
    ];
    const r = repairMeta(meta, 'm1', files, camera);
    expect(r.segments.map((s) => [s.index, s.bytes, s.endedAt, s.endReason])).toEqual([
      [1, 75_000_000, 601_000, 'error'],
      [2, 5_000, 700_000, 'error'],
    ]);
    expect(meta.segments[0].endedAt).toBeNull(); // the input is not modified
  });

  it('rebuilds the record from the files alone when recording.json is missing', () => {
    const r = repairMeta(null, 'cam-5', [{ name: 'video-1.mp4', size: 9, lastModified: 50 }], camera);
    expect(r).toMatchObject({ id: 'cam-5', matchId: null, createdAt: 50 });
    expect(r.segments).toHaveLength(1);
  });
});

describe('point reasons in match.json (D15)', () => {
  it('stats derived from the tags travel next to the events, which keep the tags unchanged', () => {
    const m = new Match({ ...doublesConfig(), reasons: 'endOfGame' }).rallies('AB');
    m.push({ type: 'tag', point: 'e2', how: 'winner', hit: { team: 'A', idx: 1 }, assist: { team: 'A', idx: 0 }, shot: 'smash' });
    const { meta, log } = recorded(m, [seg(1, 1_000_000, null)]);
    const b = buildBundle({ meta, log, app: 'test', now: 5 });
    expect(b.stats).toEqual(matchStats(m.cfg, m.events));
    expect(b.stats!.match.players.A[1]).toMatchObject({ W: 1 });
    expect(b.events.find((e) => e.type === 'tag')).toMatchObject({ point: 'e2', shot: 'smash', tRec: { segment: 1 } });
    expect(JSON.parse(JSON.stringify(b)).stats.games[0].teams.A.winners).toBe(1);
  });

  it('a match that did not ask has no stats block (Off is exactly as before)', () => {
    const m = new Match({ ...makeConfig(), reasons: 'off' }).rallies('AB');
    const { meta, log } = recorded(m, [seg(1, 1_000_000, null)]);
    expect('stats' in buildBundle({ meta, log, app: 'test', now: 5 })).toBe(false);
  });

  it('the scoreboard’s own export: no recording, replays to the final score, stats included', () => {
    const m = new Match({ ...doublesConfig(), reasons: 'endOfGame' }).rallies('AABA');
    m.push({ type: 'tag', point: 'e4', how: 'unforced', hit: { team: 'A', idx: 0 } });
    const b = buildLogBundle({ matchId: 'm9', config: m.cfg, events: m.events, scoreboard: { id: 'sb-1', ua: 'ua' }, app: 'test', now: 7 });
    expect(b).toMatchObject({ format: 'badminton-scoreboard/match', version: 1, matchId: 'm9', devices: { scoreboard: { id: 'sb-1' } } });
    expect(b.recording).toBeUndefined();
    expect(b.clock).toBeUndefined();
    expect(b.events.every((e) => e.tRec === null)).toBe(true);
    expect(b.events[b.events.length - 1].after).toEqual(reduce(m.cfg, m.events));
    expect(b.result.games).toEqual(reduce(m.cfg, m.events).games);
    expect(b.stats!.match.teams.B).toMatchObject({ won: 1, oppUnforced: 1 });
  });
});

describe('replays and the first frame in match.json (D16)', () => {
  /** Rallies 30 s apart from the scoreboard's 1,000,000 ms, as a real match spreads them. */
  function spread(m: Match): Match {
    m.events = m.events.map((e, i) => ({ ...e, at: 1_000_000 + i * 30_000 }));
    return m;
  }

  it('times events from the first composited frame when the segment has one', () => {
    const s = { ...seg(1, 1000, null), firstFrameAt: 812 };
    expect(tRecFor(2000, 0, [s])).toEqual({ segment: 1, ms: 1188 });
    expect(tRecFor(2000, 0, [{ ...s, startLatencyMs: 120 }])).toEqual({ segment: 1, ms: 1188 }); // the measured frame wins
  });

  it('each marked point with its window on the log clock and on the recording', () => {
    const m = new Match(doublesConfig()).rallies('AB');
    m.push({ type: 'replay', point: 'e3' });
    spread(m); // e2 at 1,030,000, e3 at 1,060,000, the mark at 1,090,000
    const { meta, log } = recorded(m, [{ ...seg(1, 1_000_000, null), firstFrameAt: 999_800 }], 500);
    const b = buildBundle({ meta, log, app: 'test', now: 5 });
    expect(b.replays).toEqual([
      { point: 'e3', n: 2, game: 1, at: 1_060_000, from: 1_054_000, to: 1_059_000, speed: 0.5, adjusted: false, rec: { segment: 1, fromMs: 54_700, toMs: 59_700 } },
    ]);
    expect(b.events.find((e) => e.id === 'e3')!.tRec).toEqual({ segment: 1, ms: 60_700 });
  });

  it('a window that began before the recording starts at the segment start; none recording, no place on it', () => {
    const m = new Match(doublesConfig()).rallies('A');
    m.push({ type: 'replay', point: 'e2' });
    spread(m); // e2 at 1,030,000: window 1,024,000 to 1,029,000
    const late = buildBundle({ ...recorded(m, [seg(1, 1_026_000, null)]), app: 'test', now: 5 });
    expect(late.replays![0].rec).toEqual({ segment: 1, fromMs: 0, toMs: 3000 });
    const none = buildBundle({ ...recorded(m, [seg(1, 1_040_000, null)]), app: 'test', now: 5 });
    expect(none.replays![0].rec).toBeNull();
  });

  it('no mark, no replays block; the scoreboard’s own export lists marks with no place on a video', () => {
    const m = new Match(doublesConfig()).rallies('AB');
    expect('replays' in buildBundle({ ...recorded(m, [seg(1, 1_000_000, null)]), app: 'test', now: 5 })).toBe(false);
    m.push({ type: 'replay', point: 'e2', speed: 1 });
    const b = buildLogBundle({ matchId: 'm9', config: m.cfg, events: m.events, scoreboard: { id: 'sb-1', ua: 'ua' }, app: 'test', now: 7 });
    expect(b.replays).toEqual([expect.objectContaining({ point: 'e2', speed: 1, adjusted: true, rec: null })]);
  });
});
