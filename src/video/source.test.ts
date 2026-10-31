import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { makeConfig } from '../engine/test-utils';
import { loadCurrent, saveMatch } from '../match/persist';
import { MatchStore } from '../match/store';
import { segmentZero, tRecFor } from '../recording/bundle';
import { matchBundle } from '../ui/exportLog';
import { describeFile, fileMs, fpsFromSteps, importedSegment, mimeOf, sameFile, videoClock, type VideoSource } from './source';

const T0 = 1_793_000_000_000;
const FILE = { name: 'แข่งแบด-semi-1080p.mp4', size: 441_330_926, type: 'video/mp4', lastModified: 1_793_429_700_981 };
const scoreboard = { id: 'sb-test', ua: 'test' };

/** A store scoring a video: its clock reads the "video" position `ms` with the source's offset (as VideoBoard does). */
function videoMatch(reasons: 'off' | 'endOfGame' = 'endOfGame') {
  const video = { ...describeFile(FILE), durationMs: 1_790_560, width: 1920, height: 1080, fps: 30 };
  let wall = T0;
  const store = new MatchStore(async () => {}, () => 'sb-test', () => wall);
  store.start({ ...makeConfig({ doubles: true }), reasons }, video);
  const clip = { ms: 0 };
  store.setClock(() => videoClock(T0, clip.ms, store.getSnapshot().match!.video!.tapOffsetMs));
  /** The video stands at `ms`, the wall clock somewhere else entirely (paused, seeked, tapped late). */
  const at = (ms: number) => {
    clip.ms = ms;
    wall += 7_777;
  };
  return { store, at };
}

describe('the log on the video clock (D17, R-VID-3)', () => {
  it('maps a video time to the log clock and back, minus the tap offset, never before the file starts', () => {
    expect(videoClock(T0, 98_621.4, 0)).toBe(T0 + 98_621);
    expect(videoClock(T0, 400_000, 300)).toBe(T0 + 399_700);
    expect(videoClock(T0, 120, 300)).toBe(T0); // a tap in the first `offset` ms lands on the first frame
    expect(fileMs(T0, videoClock(T0, 12_345, 0))).toBe(12_345);
  });

  it('stamps every event with the video time, whatever the wall clock does', () => {
    const { store, at } = videoMatch();
    expect(store.getSnapshot().match!.events[0].at).toBe(T0);
    at(300_200);
    const p1 = store.emit({ type: 'point', team: 'A' })!;
    at(150_000); // sought back and scored: the log keeps scoring order, the time is where the video was
    const p2 = store.emit({ type: 'point', team: 'B' })!;
    expect(p1.event.at - T0).toBe(300_200);
    expect(p2.event.at - T0).toBe(150_000);
    expect(p2.event.seq).toBe(3);
  });

  it('applies the offset set at the time of each tap; earlier taps keep theirs', () => {
    const { store, at } = videoMatch();
    at(10_000);
    store.emit({ type: 'point', team: 'A' });
    store.setVideo({ tapOffsetMs: 300 });
    at(20_000);
    store.emit({ type: 'point', team: 'A' });
    expect(store.getSnapshot().match!.events.slice(1).map((e) => e.at - T0)).toEqual([10_000, 19_700]);
  });

  it('a store without a clock stamps the wall clock again', () => {
    let wall = 5_000;
    const s = new MatchStore(async () => {}, () => 'sb', () => (wall += 1));
    s.start(makeConfig());
    s.setClock(() => 42);
    expect(s.emit({ type: 'point', team: 'A' })!.event.at).toBe(42);
    s.setClock(null);
    expect(s.emit({ type: 'point', team: 'A' })!.event.at).toBe(5_002); // the start read 5 001; the clocked tap read no wall clock
  });
});

describe('the file as the recording (D17, technical-design.md §8)', () => {
  it('describes a picked file, its media type from the name when the browser gives none', () => {
    expect(describeFile(FILE)).toMatchObject({ name: FILE.name, size: FILE.size, type: 'video/mp4', durationMs: null, fps: null, tapOffsetMs: 0, positionMs: 0 });
    expect(mimeOf('clip.MOV', '')).toBe('video/quicktime');
    expect(mimeOf('clip.webm', '')).toBe('video/webm');
    expect(mimeOf('clip', '')).toBe('application/octet-stream');
    expect(mimeOf('clip.mp4', 'video/x-custom')).toBe('video/x-custom');
  });

  it('the re-picked file must have the same name and size', () => {
    const v = describeFile(FILE);
    expect(sameFile(v, FILE)).toBe(true);
    expect(sameFile(v, { ...FILE, size: FILE.size - 1 })).toBe(false);
    expect(sameFile(v, { ...FILE, name: 'IMG_0001.MOV' })).toBe(false);
  });

  it('is one segment whose t = 0 is the match start, its duration long, nothing burned in', () => {
    const v: VideoSource = { ...describeFile(FILE), durationMs: 1_790_560, width: 1920, height: 1080, fps: 30 };
    const seg = importedSegment(v, T0);
    expect(seg).toMatchObject({
      index: 1,
      file: FILE.name,
      mimeType: 'video/mp4',
      width: 1920,
      height: 1080,
      fps: 30,
      startedAt: T0,
      firstFrameAt: T0,
      startLatencyMs: 0,
      endedAt: T0 + 1_790_560,
      bytes: FILE.size,
      endReason: null,
    });
    expect(seg.overlay).toMatchObject({ boxes: [], mirrored: false, logo: null, theme: 'none' });
    expect(segmentZero(seg)).toBe(T0);
    expect(tRecFor(T0 + 98_621, 0, [seg])).toEqual({ segment: 1, ms: 98_621 });
    expect(tRecFor(T0 + 1_790_560, 0, [seg])).toEqual({ segment: 1, ms: 1_790_560 });
  });

  it('unknown size and frame rate stay 0 rather than missing', () => {
    const seg = importedSegment(describeFile(FILE), T0);
    expect([seg.width, seg.height, seg.fps]).toEqual([0, 0, 0]);
  });

  it('works out the frame rate from frame steps, to the nearest standard rate', () => {
    const steps = (s: number, n = 40) => Array.from({ length: n }, (_, i) => s + (i % 3 === 2 ? 0.000001 : 0));
    expect(fpsFromSteps(steps(1 / 30))).toBe(30); // Chrome on the Suphanburi clip: 0.033333 / 0.033334
    expect(fpsFromSteps(steps(1001 / 30000))).toBe(29.97);
    expect(fpsFromSteps(steps(1 / 25))).toBe(25);
    expect(fpsFromSteps(steps(1 / 60))).toBe(60);
    expect(fpsFromSteps(steps(1 / 27.5))).toBe(27.5);
    expect(fpsFromSteps([...steps(1 / 30, 30), 0.0667, 0.0667, 1.2, 0])).toBe(30); // a dropped frame or a seek
    expect(fpsFromSteps(steps(1 / 30, 5))).toBeNull();
  });
});

describe('match.json of a video match (D17, R-VID-6)', () => {
  it('goes through the recording path: tRec and replay windows on the file, marked imported, version 1', () => {
    const { store, at } = videoMatch();
    at(300_200);
    store.emit({ type: 'point', team: 'A' });
    const p1 = store.getSnapshot().match!.events[1].id;
    store.emit({ type: 'tag', point: p1, how: 'winner', hit: { team: 'A', idx: 0 } });
    store.emit({ type: 'replay', point: p1 });
    store.setVideo({ tapOffsetMs: 300 });
    at(400_000);
    store.emit({ type: 'point', team: 'B' });
    const m = store.getSnapshot().match!;
    const b = matchBundle(m, scoreboard, 'test-app', T0 + 1);

    expect(b).toMatchObject({ format: 'badminton-scoreboard/match', version: 1, matchId: m.matchId, devices: { scoreboard } });
    expect(b.devices.camera).toBeUndefined();
    expect(b.clock).toEqual({ offsetMs: 0, samples: 0, medianRttMs: 0 });
    expect(b.recording).toMatchObject({ source: 'imported', tapOffsetMs: 300 });
    expect(b.recording!.segments).toHaveLength(1);
    expect(b.recording!.segments[0]).toMatchObject({ index: 1, file: FILE.name, startedAt: T0, firstFrameAt: T0, endedAt: T0 + 1_790_560, bytes: FILE.size });
    expect(b.events.map((e) => [e.type, e.tRec])).toEqual([
      ['match.start', { segment: 1, ms: 0 }],
      ['point', { segment: 1, ms: 300_200 }],
      ['tag', { segment: 1, ms: 300_200 }],
      ['replay', { segment: 1, ms: 300_200 }],
      ['point', { segment: 1, ms: 399_700 }],
    ]);
    expect(b.events.every((e) => e.leftOnCamera === e.after.leftTeam)).toBe(true);
    // D16 window: the 5 s ending 1 s before the tap, on the file.
    expect(b.replays).toEqual([expect.objectContaining({ point: p1, n: 1, rec: { segment: 1, fromMs: 294_200, toMs: 299_200 } })]);
    expect(b.stats?.match).toBeDefined();
    expect(b.result.games).toEqual({ A: 0, B: 0 });
  });

  it('a live match still exports the scoreboard-only bundle: no recording, no times on a video', () => {
    let t = T0;
    const s = new MatchStore(async () => {}, () => 'sb', () => (t += 1000));
    s.start(makeConfig());
    s.emit({ type: 'point', team: 'A' });
    const b = matchBundle(s.getSnapshot().match!, scoreboard, 'test-app', t);
    expect(b.recording).toBeUndefined();
    expect(b.clock).toBeUndefined();
    expect(b.events.every((e) => e.tRec === null)).toBe(true);
  });
});

describe('a video match in IndexedDB (D17, R-VID-5)', () => {
  it('keeps the file record, offset and position with the log; a fresh store resumes all of it', async () => {
    let wall = T0;
    const a = new MatchStore(saveMatch, () => 'sb-1', () => wall);
    a.start(makeConfig({ doubles: true }), describeFile(FILE));
    a.setClock(() => T0 + 61_000);
    a.emit({ type: 'point', team: 'A' });
    a.setVideo({ durationMs: 1_790_560, width: 1920, height: 1080, fps: 30, tapOffsetMs: 200, positionMs: 61_500 });
    wall += 1;
    await a.flushed();

    const stored = await loadCurrent();
    expect(stored?.video).toMatchObject({ name: FILE.name, size: FILE.size, durationMs: 1_790_560, fps: 30, tapOffsetMs: 200, positionMs: 61_500 });
    expect(stored?.events.map((e) => e.at - T0)).toEqual([0, 61_000]);
    const b = new MatchStore(saveMatch, () => 'sb-1');
    b.load(stored!);
    expect(b.getSnapshot().match?.video).toEqual(stored?.video);
    expect(b.getSnapshot().state).toEqual(a.getSnapshot().state);
  });

  it('a no-op change writes nothing; a live match has no video record to change', async () => {
    let saves = 0;
    const s = new MatchStore(async () => void saves++, () => 'sb-1');
    s.start(makeConfig(), describeFile(FILE));
    await s.flushed();
    const before = saves;
    s.setVideo({ positionMs: 0, tapOffsetMs: 0 });
    await s.flushed();
    expect(saves).toBe(before);
    s.setVideo({ positionMs: 3000 });
    await s.flushed();
    expect(saves).toBe(before + 1);

    const live = new MatchStore(async () => {}, () => 'sb-1');
    live.start(makeConfig());
    live.setVideo({ positionMs: 3000 });
    expect(live.getSnapshot().match?.video).toBeUndefined();
  });
});
