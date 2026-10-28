import { describe, expect, it } from 'vitest';
import { reduce } from '../engine';
import { makeConfig } from '../engine/test-utils';
import { MatchStore } from '../match/store';
import { LocalSource } from './local';
import { Mirror } from './mirror';
import { NoSource } from './none';
import type { RecCommand } from './source';

const device = { id: 'sb-test', ua: 'test' };

function setup() {
  let t = 10_000;
  const store = new MatchStore(async () => {}, () => 'sb-test', () => (t += 100));
  const source = new LocalSource(store, device);
  const mirror = new Mirror(() => t);
  return { store, source, mirror };
}

describe('same-phone source and the camera mirror', () => {
  it('mirrors a match started before connecting, then every new event', () => {
    const { store, source, mirror } = setup();
    store.start(makeConfig());
    store.emit({ type: 'point', team: 'A' });
    mirror.attach(source);
    expect(mirror.getSnapshot().events).toHaveLength(2);
    expect(mirror.getSnapshot().link).toBe('paired');
    store.emit({ type: 'point', team: 'B' });
    store.undo();
    const s = mirror.getSnapshot();
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(reduce(s.config!, s.events)).toEqual(store.getSnapshot().state);
  });

  it('a new match on the scoreboard is a full sync that replaces the mirror', () => {
    const { store, source, mirror } = setup();
    mirror.attach(source);
    store.start(makeConfig());
    store.emit({ type: 'point', team: 'A' });
    const first = mirror.getSnapshot().matchId;
    store.start(makeConfig({ points: 11 }));
    const s = mirror.getSnapshot();
    expect(s.matchId).not.toBe(first);
    expect(s.events).toHaveLength(1);
    expect(s.config?.pointsToWin).toBe(11);
  });

  it('dedupes by id and keeps the first receive time across a resync of the same match (R-PAIR-4)', () => {
    let now = 1;
    const mirror = new Mirror(() => now);
    const cfg = makeConfig();
    const e1 = { seq: 1, id: 'a', at: 100, by: 'x', type: 'match.start' as const, config: cfg };
    const e2 = { seq: 2, id: 'b', at: 200, by: 'x', type: 'point' as const, team: 'A' as const };
    const e3 = { seq: 3, id: 'c', at: 300, by: 'x', type: 'point' as const, team: 'B' as const };
    mirror.sync({ matchId: 'm', config: cfg, events: [e1] });
    now = 2;
    mirror.event(e2);
    mirror.event(e2);
    expect(mirror.getSnapshot().events).toHaveLength(2);
    now = 9;
    mirror.sync({ matchId: 'm', config: cfg, events: [e1, e2, e3, e3] });
    const s = mirror.getSnapshot();
    expect(s.events.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(s.receivedAt).toEqual({ a: 1, b: 2, c: 9 });
  });

  it('ignores events before any sync and sorts a late one into place', () => {
    const mirror = new Mirror(() => 0);
    const cfg = makeConfig();
    mirror.event({ seq: 2, id: 'b', at: 2, by: 'x', type: 'point', team: 'A' });
    expect(mirror.getSnapshot().events).toHaveLength(0);
    mirror.sync({ matchId: 'm', config: cfg, events: [{ seq: 1, id: 'a', at: 1, by: 'x', type: 'match.start', config: cfg }] });
    mirror.event({ seq: 3, id: 'c', at: 3, by: 'x', type: 'point', team: 'A' });
    mirror.event({ seq: 2, id: 'b', at: 2, by: 'x', type: 'point', team: 'B' });
    expect(mirror.getSnapshot().events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('carries remote REC commands in and reports and acks out', () => {
    const { source, mirror } = setup();
    const got: RecCommand[] = [];
    mirror.onCommand = (c) => {
      got.push(c);
      source.ack(c.id, true);
    };
    mirror.attach(source);
    let seen = 0;
    source.watch(() => seen++);
    const c = source.command('rec.start', 'cmd-1');
    expect(got).toEqual([c]);
    expect(source.lastAck).toEqual({ id: 'cmd-1', ok: true, error: undefined });
    source.report({ state: 'recording', segment: 1 });
    expect(source.lastReport.state).toBe('recording');
    expect(seen).toBe(2);
    expect(source.clock()).toEqual({ offsetMs: 0, samples: 0, medianRttMs: 0 });
  });

  it('not paired: no match, red chip, no clock', () => {
    const mirror = new Mirror();
    const none = new NoSource();
    mirror.attach(none);
    expect(mirror.getSnapshot()).toMatchObject({ matchId: null, config: null, link: 'unpaired' });
    expect(none.clock()).toBeNull();
  });
});
