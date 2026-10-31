// Point replays (D16): marking and unmarking, undo and redo, the camera's input rule (also with point reasons off and
// after a game is over), and the window each mark shows.
import { describe, expect, it } from 'vitest';
import { applyInput } from './input';
import { append } from './log';
import { lastUndoable } from './reducer';
import { REPLAY_DEFAULT, REPLAY_GAP_MS, replayWindows, validReplay } from './replays';
import { rallies } from './tags';
import { Match, doublesConfig, makeConfig } from './test-utils';
import type { EventBody, MatchConfig, MatchEvent } from './types';

const off = (cfg: MatchConfig): MatchConfig => ({ ...cfg, reasons: 'off' });

/** A log with each event at a chosen time (ms), as a real match spreads its rallies out. */
function timed(cfg: MatchConfig, steps: Array<[number, EventBody]>): MatchEvent[] {
  let events: MatchEvent[] = [];
  events = append(events, { type: 'match.start', config: cfg }, { at: 0, by: 'sb', id: 'e1' });
  for (const [at, body] of steps) events = append(events, body, { at, by: 'sb', id: `e${events.length + 1}` });
  return events;
}

describe('replay marks', () => {
  it('a mark names its point; the newest one wins and a replay.clear takes it back', () => {
    const m = new Match(off(doublesConfig())).rallies('AB');
    m.push({ type: 'replay', point: 'e2' });
    expect(rallies(m.cfg, m.events).map((r) => r.replay?.type ?? null)).toEqual(['replay', null]);
    m.push({ type: 'replay', point: 'e2', speed: 0.75 });
    expect(rallies(m.cfg, m.events)[0].replay).toMatchObject({ speed: 0.75 });
    m.push({ type: 'replay.clear', point: 'e2' });
    expect(rallies(m.cfg, m.events)[0].replay).toBeNull();
  });

  it('an undone point takes its mark with it and a redo brings it back; Undo never takes back a mark', () => {
    const m = new Match(doublesConfig()).rallies('AB');
    m.push({ type: 'replay', point: 'e3' });
    expect(lastUndoable(m.events)?.id).toBe('e3'); // the point, not the mark
    m.undo();
    expect(rallies(m.cfg, m.events).map((r) => r.id)).toEqual(['e2']);
    m.redo();
    expect(rallies(m.cfg, m.events)[1].replay).toMatchObject({ type: 'replay', point: 'e3' });
  });

  it('a mark with a bad window is passed over', () => {
    const m = new Match(doublesConfig()).rallies('A');
    m.push({ type: 'replay', point: 'e2', start: -1000, end: -6000 });
    expect(rallies(m.cfg, m.events)[0].replay).toBeNull();
  });
});

describe("the camera's input rule for marks", () => {
  const input = (body: EventBody, id = 'x') => ({ id, at: 1, by: 'sb', body: body as never });

  it('applies to a live point whether or not the match asks why, in any phase', () => {
    for (const cfg of [off(doublesConfig()), { ...doublesConfig(), reasons: 'endOfGame' as const }]) {
      const m = new Match(cfg).game(21, 10, { start: false });
      expect(m.state.phase).toBe('gameOver');
      const last = rallies(cfg, m.events).pop()!;
      const a = applyInput(cfg, m.events, input({ type: 'replay', point: last.id }), 9e9);
      expect(a.result).toBe('applied');
      expect(rallies(cfg, a.events).pop()!.replay).toMatchObject({ point: last.id });
      expect(applyInput(cfg, a.events, input({ type: 'replay.clear', point: last.id }, 'y'), 9e9).result).toBe('applied');
    }
  });

  it('ignores an unknown or undone point and a window out of range', () => {
    const m = new Match(makeConfig()).rallies('AB').undo();
    expect(applyInput(m.cfg, m.events, input({ type: 'replay', point: 'nope' }), 9e9).result).toBe('ignored');
    expect(applyInput(m.cfg, m.events, input({ type: 'replay', point: 'e3' }), 9e9).result).toBe('ignored');
    expect(applyInput(m.cfg, m.events, input({ type: 'replay', point: 'e2', start: -40_000 }), 9e9).result).toBe('ignored');
    expect(applyInput(m.cfg, m.events, input({ type: 'replay', point: 'e2', speed: 2 as never }), 9e9).result).toBe('ignored');
    expect(applyInput(m.cfg, m.events, input({ type: 'replay', point: 'e2', start: -8000, end: -2000, speed: 1 }), 9e9).result).toBe('applied');
  });

  it('validReplay: in range, at least 1 s long, a known speed', () => {
    expect(validReplay({})).toBe(true);
    expect(validReplay({ start: -30_000, end: 5_000, speed: 0.5 })).toBe(true);
    expect(validReplay({ start: -1500 })).toBe(false); // ends at -1000: 0.5 s
    expect(validReplay({ end: 6000 })).toBe(false);
    expect(validReplay({ speed: 0.25 as never })).toBe(false);
    expect(validReplay({ start: Number.NaN })).toBe(false);
  });
});

describe('the replay window (D16: 5 s ending 1 s before the tap, half speed)', () => {
  it('the default window, on the log clock', () => {
    const cfg = doublesConfig();
    const ev = timed(cfg, [[30_000, { type: 'point', team: 'A' }], [60_000, { type: 'point', team: 'B' }], [61_000, { type: 'replay', point: 'e3' }]]);
    expect(replayWindows(rallies(cfg, ev))).toEqual([
      { point: 'e3', n: 2, game: 1, at: 60_000, from: 60_000 + REPLAY_DEFAULT.start, to: 60_000 + REPLAY_DEFAULT.end, speed: 0.5, adjusted: false },
    ]);
    expect(REPLAY_DEFAULT).toEqual({ start: -6000, end: -1000, speed: 0.5 });
  });

  it('a mark made later, from the rally list, shows the same moments as one made right after the point', () => {
    const cfg = doublesConfig();
    const now = timed(cfg, [[30_000, { type: 'point', team: 'A' }], [31_000, { type: 'replay', point: 'e2' }]]);
    const later = timed(cfg, [[30_000, { type: 'point', team: 'A' }], [3_600_000, { type: 'replay', point: 'e2' }]]);
    expect(replayWindows(rallies(cfg, later))).toEqual(replayWindows(rallies(cfg, now)));
  });

  it('never reaches into the rally before: it starts 1 s after that tap, and stays at least 1 s long', () => {
    const cfg = doublesConfig();
    const ev = timed(cfg, [
      [30_000, { type: 'point', team: 'A' }],
      [33_000, { type: 'point', team: 'B' }],
      [34_200, { type: 'point', team: 'A' }],
      [40_000, { type: 'replay', point: 'e3' }],
      [40_001, { type: 'replay', point: 'e4' }],
    ]);
    const [a, b] = replayWindows(rallies(cfg, ev));
    expect(a).toMatchObject({ from: 30_000 + REPLAY_GAP_MS, to: 32_000 });
    expect(b).toMatchObject({ from: 33_200 - 1000, to: 33_200 }); // the gap would leave nothing: 1 s, ending as asked
  });

  it('an adjusted shot shows exactly what was asked; the newest adjustment wins', () => {
    const cfg = doublesConfig();
    const ev = timed(cfg, [
      [30_000, { type: 'point', team: 'A' }],
      [33_000, { type: 'point', team: 'B' }],
      [40_000, { type: 'replay', point: 'e3', start: -9000, end: 0, speed: 0.75 }],
    ]);
    expect(replayWindows(rallies(cfg, ev))).toEqual([{ point: 'e3', n: 2, game: 1, at: 33_000, from: 24_000, to: 33_000, speed: 0.75, adjusted: true }]);
  });

  it('only marked rallies, in rally order', () => {
    const m = new Match(doublesConfig()).rallies('ABAB');
    m.push({ type: 'replay', point: 'e5' });
    m.push({ type: 'replay', point: 'e2' });
    expect(replayWindows(rallies(m.cfg, m.events)).map((w) => w.n)).toEqual([1, 4]);
  });
});
