import { describe, expect, it } from 'vitest';
import { reduce, type EventBody } from '../engine';
import { makeConfig } from '../engine/test-utils';
import { MatchStore } from '../match/store';
import { Timeline } from './timeline';
import { describeFile, videoClock } from './source';

const T0 = 1_793_000_000_000;
const ms = (s: number) => T0 + s * 1000;

/** A video match whose events are stamped at the given video seconds (no offset). */
function scored(steps: Array<[number, EventBody | 'undo' | 'redo']>, reasons: 'off' | 'endOfGame' = 'endOfGame') {
  const store = new MatchStore(async () => {}, () => 'sb', () => T0);
  store.start({ ...makeConfig({ doubles: true }), reasons }, describeFile({ name: 'm.mp4', size: 1, type: 'video/mp4', lastModified: 0 }));
  const clip = { s: 0 };
  store.setClock(() => videoClock(T0, clip.s * 1000, 0));
  for (const [s, b] of steps) {
    clip.s = s;
    if (b === 'undo') store.undo();
    else if (b === 'redo') store.redo();
    else store.emit(b);
  }
  const m = store.getSnapshot().match!;
  return { cfg: m.config, events: m.events, line: new Timeline(m.config, m.events) };
}

const pt = (team: 'A' | 'B'): EventBody => ({ type: 'point', team });
const score = (line: Timeline, s: number) => {
  const m = line.at(ms(s));
  return [m.state.score.A, m.state.score.B, m.past] as const;
};

describe('the score at a moment of the video (D17, R-VID-8)', () => {
  const { cfg, events, line } = scored([
    [10, pt('A')],
    [20, pt('B')],
    [30, pt('A')],
  ]);

  it('before the first point: the start, and the board is in the past', () => {
    expect(score(line, 0)).toEqual([0, 0, true]);
    expect(score(line, 9.999)).toEqual([0, 0, true]);
  });

  it('exactly at a point: that point counts', () => {
    expect(score(line, 10)).toEqual([1, 0, true]);
    expect(score(line, 20)).toEqual([1, 1, true]);
  });

  it('between points: the last one before', () => {
    expect(score(line, 15)).toEqual([1, 0, true]);
    expect(score(line, 29.999)).toEqual([1, 1, true]);
  });

  it('at and after the last point: the latest state, not past', () => {
    expect(score(line, 30)).toEqual([2, 1, false]);
    expect(score(line, 900)).toEqual([2, 1, false]);
    expect(line.at(ms(30)).state).toEqual(reduce(cfg, events));
    expect(line.latestAt).toBe(ms(30));
  });

  it('serve and positions follow the moment too', () => {
    const at15 = line.at(ms(15)).state;
    const after1 = reduce(cfg, events.slice(0, 2));
    expect(at15).toEqual(after1);
    expect(at15.server).toBe('A');
  });

  it('an undone point never shows, even at the moment it was tapped; a redone one does', () => {
    const undone = scored([
      [10, pt('A')],
      [20, pt('B')],
      [21, 'undo'],
    ]).line;
    expect(score(undone, 20)).toEqual([1, 0, false]); // the latest is the point at 10 s again
    expect(undone.latestAt).toBe(ms(10));
    const redone = scored([
      [10, pt('A')],
      [20, pt('B')],
      [21, 'undo'],
      [22, 'redo'],
    ]).line;
    expect(score(redone, 20)).toEqual([1, 1, false]);
    expect(score(redone, 19)).toEqual([1, 0, true]);
  });

  it('tags and replay marks change nothing and never make the board past', () => {
    const r = scored([[10, pt('A')]]);
    const point = r.events[1].id;
    const marked = scored([
      [10, pt('A')],
      [14, { type: 'tag', point, how: 'winner', hit: { team: 'A', idx: 0 } }],
      [15, { type: 'replay', point }],
    ]).line;
    expect(score(marked, 12)).toEqual([1, 0, false]);
    expect(marked.latestAt).toBe(ms(10));
  });

  it('follows ends, intervals and games: the state at each moment equals the log replayed that far', () => {
    const steps: Array<[number, EventBody | 'undo' | 'redo']> = [];
    let s = 5;
    for (let i = 0; i < 21; i++) steps.push([(s += 7), pt('A')]); // game 1 to A (interval at 11 on the way)
    steps.push([(s += 30), { type: 'game.start', game: 2 }]);
    for (let i = 0; i < 5; i++) steps.push([(s += 7), pt(i % 2 ? 'A' : 'B')]);
    steps.push([(s += 3), { type: 'sides.swap' }]);
    const r = scored(steps, 'off');
    for (let i = 1; i < r.events.length; i++) {
      const e = r.events[i];
      expect(r.line.at(e.at).state).toEqual(reduce(r.cfg, r.events.slice(0, i + 1)));
    }
    expect(r.line.at(ms(9999)).state).toEqual(reduce(r.cfg, r.events));
  });

  it('a log whose times go back (scored before this build) still gives the events up to that time', () => {
    const { cfg, events } = scored([
      [10, pt('A')],
      [30, pt('B')],
      [20, pt('A')], // sought back and tapped
    ]);
    const back = new Timeline(cfg, events);
    expect(score(back, 25)).toEqual([2, 0, true]); // A at 10 s and 20 s; B's point at 30 s not yet
    expect(score(back, 30)).toEqual([2, 1, false]);
  });

  it('a 30-minute match: a position costs a binary search, not a replay', () => {
    const steps: Array<[number, EventBody | 'undo' | 'redo']> = [];
    for (let i = 0; i < 600; i++) steps.push([10 + i * 3, i % 7 === 6 ? 'undo' : pt(i % 3 ? 'A' : 'B')]);
    const r = scored(steps, 'off');
    const t = performance.now();
    for (let i = 0; i < 2000; i++) r.line.at(ms((i * 0.9) % 1800));
    expect(performance.now() - t).toBeLessThan(50);
  });
});
