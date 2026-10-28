import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { makeConfig } from '../engine/test-utils';
import { clearCurrent, loadCurrent, saveMatch } from './persist';
import { MatchStore } from './store';

describe('persistence and resume (R-SCORE-9)', () => {
  it('writes after every event and a fresh store resumes the same state', async () => {
    let t = 1000;
    const a = new MatchStore(saveMatch, () => 'dev-1', () => (t += 10));
    a.start(makeConfig({ doubles: true }));
    for (const team of ['A', 'A', 'B', 'A', 'B', 'B'] as const) a.emit({ type: 'point', team });
    a.undo();
    await a.flushed();

    const stored = await loadCurrent();
    expect(stored?.events).toHaveLength(8);
    const b = new MatchStore(saveMatch, () => 'dev-1');
    b.load(stored!);
    expect(b.getSnapshot().state).toEqual(a.getSnapshot().state);
    expect(b.getSnapshot().state?.score).toEqual({ A: 3, B: 2 });
  });

  it('keeps writes in order', async () => {
    const s = new MatchStore(saveMatch, () => 'dev-1');
    s.start(makeConfig());
    for (let i = 0; i < 30; i++) s.emit({ type: 'point', team: i % 2 ? 'A' : 'B' });
    await s.flushed();
    expect((await loadCurrent())?.events).toHaveLength(31);
  });

  it('clearCurrent forgets the live match', async () => {
    const s = new MatchStore(saveMatch, () => 'dev-1');
    s.start(makeConfig());
    await s.flushed();
    await clearCurrent();
    expect(await loadCurrent()).toBeNull();
  });

  it('events carry seq, id, time and device', () => {
    let t = 5000;
    const s = new MatchStore(async () => {}, () => 'sb-x', () => (t += 1));
    s.start(makeConfig());
    const c = s.emit({ type: 'point', team: 'A' })!;
    expect(c.event).toMatchObject({ seq: 2, at: 5002, by: 'sb-x', type: 'point', team: 'A' });
    expect(c.event.id).toMatch(/\w+/);
    expect(c.prev.score).toEqual({ A: 0, B: 0 });
    expect(c.next.score).toEqual({ A: 1, B: 0 });
  });
});
