// Inputs applied to the camera's log (D14): place and time, undo/redo targets, phase checks, the duplicate
// window, and a resend recognised by id.
import { describe, expect, it } from 'vitest';
import { DUPLICATE_WINDOW_MS, applyInput, type Input, type InputBody } from './input';
import { reduce } from './reducer';
import { makeConfig } from './test-utils';
import type { MatchEvent } from './types';

const config = makeConfig();
let n = 0;
const input = (by: string, body: InputBody, at: number): Input => ({ id: `i${++n}`, at, by, body });

function log() {
  let events: MatchEvent[] = [{ seq: 1, id: 'start', at: 1000, by: 'sb-1', type: 'match.start', config }];
  const add = (by: string, body: InputBody, at: number) => {
    const r = applyInput(config, events, input(by, body, at), at);
    events = r.events;
    return r.result;
  };
  return { add, events: () => events, state: () => reduce(config, events) };
}

describe('applying inputs on the camera', () => {
  it('gives each its place and time, never earlier than the event before', () => {
    const l = log();
    expect(l.add('sb-1', { type: 'point', team: 'A' }, 5000)).toBe('applied');
    expect(l.add('sb-2', { type: 'point', team: 'B' }, 4000)).toBe('applied'); // arrived late
    expect(l.events().map((e) => [e.seq, e.at, e.by])).toEqual([
      [1, 1000, 'sb-1'],
      [2, 5000, 'sb-1'],
      [3, 5000, 'sb-2'],
    ]);
  });

  it('undo and redo target the newest event, whichever scoreboard sent it', () => {
    const l = log();
    l.add('sb-1', { type: 'point', team: 'A' }, 5000);
    l.add('sb-2', { type: 'point', team: 'B' }, 9000);
    expect(l.add('sb-1', { type: 'undo' }, 10_000)).toBe('applied');
    expect(l.events().at(-1)).toMatchObject({ type: 'undo', target: 3, by: 'sb-1' });
    expect(l.state().score).toEqual({ A: 1, B: 0 });
    expect(l.add('sb-2', { type: 'redo' }, 11_000)).toBe('applied');
    expect(l.state().score).toEqual({ A: 1, B: 1 });
    expect(l.add('sb-2', { type: 'redo' }, 12_000)).toBe('ignored'); // nothing to redo
  });

  it('a point to the same side from the other scoreboard within the window is the same rally', () => {
    const l = log();
    l.add('sb-1', { type: 'point', team: 'A' }, 5000);
    expect(l.add('sb-2', { type: 'point', team: 'A' }, 5000 + DUPLICATE_WINDOW_MS)).toBe('duplicate');
    expect(l.add('sb-2', { type: 'point', team: 'A' }, 5000 - 700)).toBe('duplicate'); // tapped first, arrived second
    expect(l.add('sb-2', { type: 'point', team: 'B' }, 5200)).toBe('applied'); // the other side: a real point
    expect(l.add('sb-1', { type: 'point', team: 'A' }, 5900)).toBe('applied'); // the same scoreboard: never merged
    expect(l.add('sb-2', { type: 'point', team: 'A' }, 5900 + DUPLICATE_WINDOW_MS + 1)).toBe('applied');
    expect(l.state().score).toEqual({ A: 3, B: 1 });
  });

  it('a point that was undone does not swallow the next tap', () => {
    const l = log();
    l.add('sb-1', { type: 'point', team: 'A' }, 5000);
    l.add('sb-1', { type: 'undo' }, 5300);
    expect(l.add('sb-2', { type: 'point', team: 'A' }, 5600)).toBe('applied');
    expect(l.state().score).toEqual({ A: 1, B: 0 });
  });

  it('ignores what makes no sense in the phase: points between games, a second interval end, a stale game start', () => {
    const l = log();
    expect(l.add('sb-1', { type: 'interval.end' }, 2000)).toBe('ignored');
    for (let i = 0; i < 11; i++) l.add('sb-1', { type: 'point', team: 'A' }, 10_000 + i * 5000);
    expect(l.state().phase).toBe('interval');
    expect(l.add('sb-2', { type: 'interval.end' }, 70_000)).toBe('applied');
    expect(l.add('sb-1', { type: 'interval.end' }, 70_100)).toBe('ignored'); // both countdowns ended it
    for (let i = 0; i < 10; i++) l.add('sb-1', { type: 'point', team: 'A' }, 80_000 + i * 5000);
    expect(l.state().phase).toBe('gameOver');
    expect(l.add('sb-2', { type: 'point', team: 'B' }, 200_000)).toBe('ignored');
    expect(l.add('sb-2', { type: 'game.start', game: 3 }, 200_000)).toBe('ignored');
    expect(l.add('sb-2', { type: 'game.start', game: 2 }, 200_000)).toBe('applied');
    expect(l.add('sb-1', { type: 'game.start', game: 2 }, 200_100)).toBe('ignored'); // the other one was first
  });

  it('a resent input is recognised by its id and changes nothing', () => {
    const events: MatchEvent[] = [{ seq: 1, id: 'start', at: 1000, by: 'sb-1', type: 'match.start', config }];
    const i = input('sb-1', { type: 'point', team: 'A' }, 3000);
    const once = applyInput(config, events, i, 3000).events;
    const twice = applyInput(config, once, i, 3000);
    expect(twice).toEqual({ result: 'applied', events: once });
  });
});
