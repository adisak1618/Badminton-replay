// Guards, clock offset maths and sync chunking (technical-design.md §4.4, §4.5, §12).
import { describe, expect, it } from 'vitest';
import { append, randomId, type MatchEvent } from '../engine';
import { makeConfig } from '../engine/test-utils';
import { ClockSampler, sample } from './clock';
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, encode, isMatchEvent, parse } from './messages';
import { SyncAssembler, stateParts, syncParts } from './sync';

const config = makeConfig();

describe('message guards', () => {
  it('accept every example and shape from §4.4', () => {
    const examples = [
      '{"v":3,"t":"input","matchId":"m-1","input":{"id":"k3f9","at":1793100000123,"by":"sb-7c2","body":{"type":"point","team":"A"}}}',
      '{"v":3,"t":"event","matchId":"m-1","event":{"seq":17,"id":"k3f9","at":1793100000101,"by":"sb-7c2","type":"point","team":"A"}}',
      '{"v":3,"t":"result","id":"k3f9","result":"duplicate"}',
      '{"v":3,"t":"rec","state":"recording","segment":1,"startedAt":1793099000456,"elapsedMs":754000,"bytes":565000000,"minutesLeft":26}',
      encode({ t: 'input', matchId: 'm', input: { id: 'u', at: 1, by: 'sb', body: { type: 'undo' } } }),
      encode({ t: 'input', matchId: 'm', input: { id: 's', at: 1, by: 'sb', body: { type: 'match.start', config } } }),
      encode({ t: 'state', matchId: null }),
      encode({ t: 'state', matchId: 'm', config, events: [], part: [0, 2] }),
      encode({ t: 'resync' }),
      encode({ t: 'peers', count: 2 }),
      encode({ t: 'hello', role: 'scoreboard', deviceId: 'sb-1', app: 'x@1', matchId: 'm-1', lastSeq: 3 }),
      encode({ t: 'hello', role: 'camera', deviceId: 'cam-1', app: 'x@1', ua: 'iPhone' }),
      encode({ t: 'ping', id: 1, t0: 10 }),
      encode({ t: 'pong', id: 1, t0: 10, t1: 20, t2: 21 }),
      encode({ t: 'sync', matchId: 'm', config, events: [], part: [0, 2] }),
      encode({ t: 'cmd', id: 'c1', action: 'rec.start' }),
      encode({ t: 'ack', id: 'c1', ok: false, error: 'no camera' }),
      encode({ t: 'bye' }),
      encode({ t: 'bye', reason: 'leaving' }),
      encode({ t: 'input', matchId: 'm', input: { id: 't', at: 1, by: 'sb', body: { type: 'tag', point: 'p', how: 'winner', hit: { team: 'A', idx: 1 }, assist: { team: 'A', idx: 0 }, shot: 'kill' } } }),
      encode({ t: 'input', matchId: 'm', input: { id: 'c', at: 1, by: 'sb', body: { type: 'tag.clear', point: 'p' } } }),
    ];
    for (const raw of examples) expect(parse(raw).kind, raw).toBe('msg');
  });

  it('every engine event type round-trips through the event guard', () => {
    let events: MatchEvent[] = [];
    const add = (b: Parameters<typeof append>[1]) => (events = append(events, b, { at: 1, by: 'sb', id: randomId() }));
    add({ type: 'match.start', config });
    add({ type: 'point', team: 'A' });
    add({ type: 'undo', target: 2 });
    add({ type: 'redo', target: 3 });
    add({ type: 'correct', score: { A: 3, B: 2 }, server: 'B', serverIdx: 0 });
    add({ type: 'sides.swap' });
    add({ type: 'courts.swap', team: 'B' });
    add({ type: 'server.set', team: 'A', idx: 1 });
    add({ type: 'interval.end' });
    add({ type: 'game.start', game: 2, serverIdx: 0, receiverIdx: 1 });
    add({ type: 'match.end', reason: 'abandoned' });
    add({ type: 'tag', point: 'p', how: 'forced', hit: { team: 'B', idx: 0 }, forcedBy: { team: 'A', idx: 1 }, assist: { team: 'A', idx: 0 }, shot: 'smash' });
    add({ type: 'tag', point: 'p', how: 'winner', hit: { team: 'A', idx: 0 } });
    add({ type: 'tag.clear', point: 'p' });
    for (const e of events) expect(isMatchEvent(JSON.parse(JSON.stringify(e))), e.type).toBe(true);
  });

  it('reject malformed messages and ignore unknown types', () => {
    const bad = [
      'not json',
      '[1,2]',
      '{"v":3,"t":"event","matchId":"m","event":{"seq":"1","id":"x","at":1,"by":"s","type":"point","team":"A"}}',
      '{"v":3,"t":"event","matchId":"m","event":{"seq":1,"id":"x","at":1,"by":"s","type":"point","team":"C"}}',
      '{"v":3,"t":"event","matchId":"m","event":{"seq":1,"id":"x","at":1,"by":"s","type":"tag","point":"p","how":"lucky","hit":{"team":"A","idx":0}}}',
      '{"v":3,"t":"event","matchId":"m","event":{"seq":1,"id":"x","at":1,"by":"s","type":"tag","point":"p","how":"winner","hit":{"team":"C","idx":0}}}',
      '{"v":3,"t":"event","matchId":"m","event":{"seq":1,"id":"x","at":1,"by":"s","type":"tag","point":"p","how":"winner","hit":{"team":"A","idx":0},"shot":"lob"}}',
      '{"v":3,"t":"event","matchId":"m","event":{"seq":1,"id":"x","at":1,"by":"s","type":7}}',
      '{"v":3,"t":"event","event":{"seq":1,"id":"x","at":1,"by":"s","type":"point","team":"A"}}',
      '{"v":3,"t":"input","matchId":"m","input":{"id":"x","at":1,"by":"s","body":{"type":"undo","target":3}}}',
      '{"v":3,"t":"input","matchId":"m","input":{"id":"x","at":1,"body":{"type":"point","team":"A"}}}',
      '{"v":3,"t":"result","id":"x","result":"maybe"}',
      '{"v":3,"t":"state","matchId":null,"events":[]}',
      '{"v":3,"t":"peers","count":-1}',
      '{"v":3,"t":"ping","id":1}',
      '{"v":3,"t":"rec","state":"dancing"}',
      '{"v":3,"t":"cmd","id":"c","action":"rec.pause"}',
      '{"v":3,"t":"sync","matchId":"m","config":{},"events":[]}',
      '{"v":3,"t":"sync","matchId":"m","config":' + JSON.stringify(config) + ',"events":[],"part":[2,2]}',
      '{"v":3,"t":"hello","role":"referee","deviceId":"d","app":"a"}',
      '{"v":3,"t":"newfangled","x":1}',
    ];
    for (const raw of bad) expect(parse(raw).kind, raw).toBe('ignore');
  });

  it('from v3 an event or input of a type this build does not know is kept, not refused (D15)', () => {
    const later = { seq: 3, id: 'x', at: 1, by: 's', type: 'replay.marker', label: 'nice rally' };
    expect(isMatchEvent(later)).toBe(true);
    const state = encode({ t: 'state', matchId: 'm', config, events: [{ seq: 1, id: 'a', at: 1, by: 's', type: 'match.start', config }, later as unknown as MatchEvent] });
    expect(parse(state).kind).toBe('msg');
    const input = '{"v":3,"t":"input","matchId":"m","input":{"id":"x","at":1,"by":"s","body":{"type":"replay.marker"}}}';
    expect(parse(input).kind).toBe('msg');
  });

  it('another protocol version is reported, not parsed (R-PAIR-7)', () => {
    expect(parse('{"v":4,"t":"hello","role":"camera","deviceId":"d","app":"next@4"}')).toEqual({ kind: 'version', v: 4, app: 'next@4' });
    // A phone still on protocol 2 (before D15) would drop every state carrying a tag: it is told to update.
    expect(parse('{"v":2,"t":"hello","role":"scoreboard","deviceId":"d","app":"old@2"}')).toEqual({ kind: 'version', v: 2, app: 'old@2' });
    // A phone still on protocol 1 (before D14) is told to update, not half understood.
    expect(parse('{"v":1,"t":"hello","role":"scoreboard","deviceId":"d","app":"old@1"}')).toEqual({ kind: 'version', v: 1, app: 'old@1' });
    expect(parse('{"t":"hello"}')).toMatchObject({ kind: 'version', v: undefined });
    expect(JSON.parse(encode({ t: 'bye' })).v).toBe(PROTOCOL_VERSION);
  });
});

describe('clock offset (§4.5)', () => {
  it('one round trip: offset and rtt from the four stamps', () => {
    // The camera is 500 ms ahead; 4 ms each way, 1 ms on the camera.
    expect(sample(1000, 1504, 1505, 1009)).toEqual({ offset: 500, rtt: 8 });
  });

  it('median of the last 8 samples with rtt < 50 ms, under jitter and outliers', () => {
    const c = new ClockSampler();
    expect(c.estimate()).toBeNull();
    const trueOffset = -1234;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let t = 10_000;
    for (let i = 0; i < 40; i++) {
      const up = 1 + rnd() * 10;
      const down = i % 5 === 0 ? 120 : 1 + rnd() * 10; // every 5th has a slow return leg: rtt > 50 ms, dropped
      const t0 = t;
      const t1 = t0 + up + trueOffset;
      const t2 = t1 + 1;
      const t3 = t2 - trueOffset + down;
      c.add(t0, t1, t2, t3);
      t += 2000;
    }
    const e = c.estimate()!;
    expect(Math.abs(e.offsetMs - trueOffset)).toBeLessThanOrEqual(5); // asymmetric legs of up to 9 ms -> < 5 ms error
    expect(e.samples).toBe(32);
    expect(e.medianRttMs).toBeLessThan(50);
  });

  it('drops samples with rtt >= 50 ms or a negative rtt', () => {
    const c = new ClockSampler();
    expect(c.add(0, 100, 100, 60)).toBe(false);
    expect(c.add(0, 100, 100, -5)).toBe(false);
    expect(c.estimate()).toBeNull();
    expect(c.add(0, 100, 101, 11)).toBe(true);
    expect(c.estimate()).toEqual({ offsetMs: 95, samples: 1, medianRttMs: 10 });
  });
});

describe('sync chunking', () => {
  const longLog = () => {
    let events: MatchEvent[] = append([], { type: 'match.start', config }, { at: 1, by: 'sb-1', id: randomId() });
    for (let i = 0; i < 600; i++)
      events = append(events, i % 7 === 6 ? { type: 'undo', target: events.length } : { type: 'point', team: i % 3 ? 'A' : 'B' }, {
        at: 1000 + i * 9000,
        by: 'sb-1',
        id: randomId(),
      });
    return { matchId: 'm-1', config, events };
  };

  it('a short log is one message', () => {
    const log = { matchId: 'm', config, events: longLog().events.slice(0, 20) };
    const parts = syncParts(log);
    expect(parts).toHaveLength(1);
    expect(JSON.parse(parts[0]).part).toBeUndefined();
  });

  it('a 3-game log splits into parts under 16 kB that reassemble exactly', () => {
    const log = longLog();
    const parts = syncParts(log);
    expect(parts.length).toBeGreaterThan(2);
    const enc = new TextEncoder();
    for (const p of parts) expect(enc.encode(p).length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    const a = new SyncAssembler();
    const out = parts.map((p) => {
      const r = parse(p);
      if (r.kind !== 'msg' || r.msg.t !== 'sync') throw new Error('not a sync');
      return a.add(r.msg);
    });
    expect(out.slice(0, -1).every((x) => x === undefined)).toBe(true);
    expect(out[out.length - 1]).toEqual(log);
  });

  it('the camera\'s state is chunked the same way, and "no match" is one small message', () => {
    const log = longLog();
    const parts = stateParts(log);
    expect(parts.length).toBeGreaterThan(2);
    const enc = new TextEncoder();
    for (const p of parts) expect(enc.encode(p).length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    const a = new SyncAssembler();
    let last: unknown;
    for (const p of parts) {
      const r = parse(p);
      if (r.kind !== 'msg' || r.msg.t !== 'state') throw new Error('not a state');
      last = a.add(r.msg);
    }
    expect(last).toEqual(log);
    const none = stateParts(null);
    expect(none).toHaveLength(1);
    const r = parse(none[0]);
    if (r.kind !== 'msg' || r.msg.t !== 'state') throw new Error('not a state');
    expect(a.add(r.msg)).toBeNull();
  });

  it('a gap drops the partial log; a new part 0 starts over', () => {
    const log = longLog();
    const msgs = syncParts(log).map((p) => JSON.parse(p));
    const a = new SyncAssembler();
    expect(a.add(msgs[0])).toBeUndefined();
    expect(a.add(msgs[2])).toBeUndefined(); // part 1 missing
    expect(a.add(msgs[msgs.length - 1])).toBeUndefined();
    let last = null;
    for (const m of msgs) last = a.add(m);
    expect(last).toEqual(log);
  });
});
