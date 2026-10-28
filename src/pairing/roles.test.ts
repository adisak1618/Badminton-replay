// The camera's MatchHub and up to two scoreboards' ScoreboardLinks over in-memory links (D14): the camera holds
// the match, each scoreboard sends inputs and shows what the camera sends. Joining with and without a match on
// either side, both scoring, undo across scoreboards, the same rally tapped twice, a drop with points scored
// meanwhile (R-PAIR-4), a late joiner, unpairing, remote REC with acks and retries (R-PAIR-6), rec reports,
// and the clock.
import { describe, expect, it } from 'vitest';
import { DUPLICATE_WINDOW_MS, reduce } from '../engine';
import { makeConfig } from '../engine/test-utils';
import { MatchHub, type HubStore } from '../link/hub';
import { Mirror } from '../link/mirror';
import type { ClockEstimate, LinkState, MatchLog, RecCommand } from '../link/source';
import { MatchStore } from '../match/store';
import { encode, parse, type Msg } from '../protocol/messages';
import type { LinkPort } from './port';
import { CMD_GIVE_UP_MS, CMD_RETRY_MS, RESYNC_AFTER_MS, ScoreboardLink } from './scoreboard';

class FakePort implements LinkPort {
  peer: FakePort | null = null;
  open = false;
  state: LinkState = 'unpaired';
  clockValue: ClockEstimate | null = null;
  sent: Msg[] = [];
  private listeners = new Set<() => void>();
  onMessage: (m: Msg) => void = () => {};
  onOpen: () => void = () => {};

  constructor(private readonly remoteId: string) {}

  send(body: Parameters<typeof encode>[0]): boolean {
    return this.sendRaw(encode(body));
  }
  sendRaw(data: string): boolean {
    if (!this.open || !this.peer) return false;
    if (data.length > 16_000) throw new Error('message over 16 kB');
    const p = parse(data);
    if (p.kind !== 'msg') throw new Error(`bad frame ${data}`);
    this.sent.push(p.msg);
    this.peer.onMessage(p.msg);
    return true;
  }
  isOpen() {
    return this.open;
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  getSnapshot() {
    return { state: this.state, remote: this.state === 'unpaired' ? null : { deviceId: this.remoteId, app: 'test@1', ua: 'ua' } };
  }
  clockEstimate() {
    return this.clockValue;
  }
  setState(s: LinkState, open: boolean) {
    this.state = s;
    this.open = open;
    for (const fn of this.listeners) fn();
  }
}

const memoryHub = (): HubStore & { log: MatchLog | null } => ({
  log: null,
  load() {
    return this.log;
  },
  save(l) {
    this.log = l;
  },
});

function setup(boards = 2) {
  let t = 50_000;
  const now = () => t;
  const camPorts: FakePort[] = [];
  const sides = Array.from({ length: boards }, (_, i) => {
    const id = `sb-${i + 1}`;
    const sbPort = new FakePort('cam');
    const camPort = new FakePort(id);
    sbPort.peer = camPort;
    camPort.peer = sbPort;
    camPorts.push(camPort);
    const store = new MatchStore(async () => {}, () => id, now);
    const board = new ScoreboardLink(sbPort, store, now);
    const connect = () => {
      sbPort.setState('paired', true);
      camPort.setState('paired', true);
      sbPort.onOpen(); // the camera's hello arrives first, then its state (§4.4)
      camPort.onOpen();
    };
    const drop = () => {
      sbPort.setState('reconnecting', false);
      camPort.setState('reconnecting', false);
    };
    const unpair = () => {
      sbPort.setState('unpaired', false);
      camPort.setState('unpaired', false);
    };
    const shown = () => store.getSnapshot().state;
    return { id, store, board, sbPort, camPort, connect, drop, unpair, shown };
  });
  const hubStore = memoryHub();
  const hub = new MatchHub(camPorts, hubStore);
  const mirror = new Mirror(now);
  // The controller's idempotent command handling (recording/controller.ts), reduced to what the link sees.
  const handled = new Map<string, boolean>();
  const started: string[] = [];
  mirror.onCommand = (c: RecCommand) => {
    if (!handled.has(c.id)) {
      handled.set(c.id, true);
      started.push(c.action);
    }
    hub.ack(c.id, true);
  };
  mirror.attach(hub);
  const camera = () => {
    const m = mirror.getSnapshot();
    return reduce(m.config!, m.events);
  };
  return { sides, hub, hubStore, mirror, camera, started, advance: (ms: number) => (t += ms), now };
}

describe('one camera, two scoreboards (D14)', () => {
  it('a match started before pairing is adopted by a camera that has none; the second scoreboard takes it', () => {
    const p = setup();
    const [a, b] = p.sides;
    a.store.start(makeConfig());
    a.store.emit({ type: 'point', team: 'A' });
    b.store.start(makeConfig({ points: 11 })); // B had its own match: it gives way to the camera's
    a.connect();
    expect(p.hub.current()?.matchId).toBe(a.store.getSnapshot().match!.matchId);
    expect(p.mirror.getSnapshot().events).toHaveLength(2);
    b.connect();
    expect(b.store.getSnapshot().match!.matchId).toBe(a.store.getSnapshot().match!.matchId);
    expect(b.shown()).toEqual(a.shown());
    expect(b.board.getSnapshot()).toMatchObject({ synced: true, others: 1 });
    expect(a.board.getSnapshot().others).toBe(1);
  });

  it('a camera that holds a match gives it to a joining scoreboard, whose own match is dropped', () => {
    const p = setup();
    const [a, b] = p.sides;
    a.store.start(makeConfig());
    a.connect();
    a.store.emit({ type: 'point', team: 'B' });
    b.store.start(makeConfig({ points: 15 }));
    for (let i = 0; i < 4; i++) b.store.emit({ type: 'point', team: 'A' });
    b.connect(); // mid-match, a late joiner
    expect(b.shown()).toEqual(p.camera());
    expect(b.store.getSnapshot().match!.config.pointsToWin).toBe(21);
    expect(b.store.getSnapshot().origin).toBe('remote');
  });

  it('both score; every phone shows the camera’s log; undo undoes the newest event whoever sent it', () => {
    const p = setup();
    const [a, b] = p.sides;
    a.store.start(makeConfig());
    a.connect();
    b.connect();
    a.store.emit({ type: 'point', team: 'A' });
    p.advance(5000);
    b.store.emit({ type: 'point', team: 'B' });
    p.advance(5000);
    a.store.emit({ type: 'point', team: 'A' });
    for (const s of [a, b]) expect(s.shown()!.score).toEqual({ A: 2, B: 1 });
    expect(p.camera().score).toEqual({ A: 2, B: 1 });
    b.store.undo(); // B undoes A's last point
    for (const s of [a, b]) expect(s.shown()!.score).toEqual({ A: 1, B: 1 });
    expect(p.camera().score).toEqual({ A: 1, B: 1 });
    a.store.redo();
    expect(b.shown()!.score).toEqual({ A: 2, B: 1 });
    const events = p.hub.current()!.events;
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.map((e) => e.by)).toEqual(['sb-1', 'sb-1', 'sb-2', 'sb-1', 'sb-2', 'sb-1']);
    expect(a.store.pending()).toHaveLength(0);
    expect(b.store.pending()).toHaveLength(0);
  });

  it('the same rally tapped on both scoreboards within the window counts once, with the cue on the second', () => {
    const p = setup();
    const [a, b] = p.sides;
    a.store.start(makeConfig());
    a.connect();
    b.connect();
    a.store.emit({ type: 'point', team: 'A' });
    p.advance(DUPLICATE_WINDOW_MS - 300);
    const c = b.store.emit({ type: 'point', team: 'A' });
    expect(c).toBeNull(); // not counted, not announced
    expect(b.board.getSnapshot().duplicateAt).toBe(p.now());
    for (const s of [a, b]) expect(s.shown()!.score).toEqual({ A: 1, B: 0 });
    expect(p.camera().score).toEqual({ A: 1, B: 0 });
    expect(a.board.getSnapshot().duplicateAt).toBeNull();
    // After the window it is a new rally; the other side within the window is a different point.
    p.advance(DUPLICATE_WINDOW_MS + 1);
    b.store.emit({ type: 'point', team: 'A' });
    p.advance(200);
    a.store.emit({ type: 'point', team: 'B' });
    expect(p.camera().score).toEqual({ A: 2, B: 1 });
    // The same scoreboard tapping twice is not merged (undo is there for that).
    p.advance(5000);
    a.store.emit({ type: 'point', team: 'B' });
    p.advance(900);
    a.store.emit({ type: 'point', team: 'B' });
    expect(p.camera().score).toEqual({ A: 2, B: 3 });
  });

  it('the camera decides a tap its scoreboard did not see as a duplicate: the cue, and the score corrected', () => {
    const p = setup();
    const [a, b] = p.sides;
    a.store.start(makeConfig());
    a.connect();
    b.connect();
    b.drop(); // B misses A's point
    a.store.emit({ type: 'point', team: 'A' });
    p.advance(800);
    b.store.emit({ type: 'point', team: 'A' }); // shown on B at once
    expect(b.shown()!.score).toEqual({ A: 1, B: 0 });
    b.connect(); // B's pending tap reaches the camera, 800 ms after A's
    expect(b.board.getSnapshot().duplicateAt).not.toBeNull();
    expect(b.shown()!.score).toEqual({ A: 1, B: 0 });
    expect(p.camera().score).toEqual({ A: 1, B: 0 });
  });

  it('a drop: points scored meanwhile reach the camera when the link is back, none lost or doubled (R-PAIR-4)', () => {
    const p = setup(1);
    const [a] = p.sides;
    a.store.start(makeConfig());
    a.connect();
    a.store.emit({ type: 'point', team: 'A' });
    a.drop();
    expect(p.mirror.getSnapshot().link).toBe('reconnecting');
    for (let i = 0; i < 5; i++) {
      p.advance(4000);
      a.store.emit({ type: 'point', team: i % 2 ? 'A' : 'B' });
    }
    expect(a.shown()!.score).toEqual({ A: 3, B: 3 }); // scoring never waits (R-PAIR-3)
    expect(p.mirror.getSnapshot().events).toHaveLength(2); // frozen while down
    a.connect();
    expect(p.mirror.getSnapshot().events).toHaveLength(7);
    expect(p.camera()).toEqual(a.shown());
    expect(a.store.pending()).toHaveLength(0);
    a.connect(); // a second open sends nothing again
    expect(p.mirror.getSnapshot().events).toHaveLength(7);
  });

  it('a new match from either scoreboard replaces the camera’s on every phone', () => {
    const p = setup();
    const [a, b] = p.sides;
    a.store.start(makeConfig());
    a.connect();
    b.connect();
    a.store.emit({ type: 'point', team: 'A' });
    b.store.start(makeConfig({ points: 11 }));
    expect(p.hub.current()!.config.pointsToWin).toBe(11);
    expect(a.store.getSnapshot().match!.matchId).toBe(b.store.getSnapshot().match!.matchId);
    expect(a.store.getSnapshot().origin).toBe('remote');
    expect(p.mirror.getSnapshot().events).toHaveLength(1);
  });

  it('inputs that make no sense now are ignored and not shown (both scoreboards end the interval)', () => {
    const p = setup();
    const [a, b] = p.sides;
    a.store.start(makeConfig());
    a.connect();
    b.connect();
    for (let i = 0; i < 11; i++) {
      p.advance(5000);
      a.store.emit({ type: 'point', team: 'A' });
    }
    expect(p.camera().phase).toBe('interval');
    a.store.emit({ type: 'interval.end' });
    expect(b.store.emit({ type: 'interval.end' })).toBeNull();
    expect(p.hub.current()!.events.filter((e) => e.type === 'interval.end')).toHaveLength(1);
  });

  it('unpaired, each scoreboard keeps the match as its own and forgets the camera; the camera forgets it once none is left', () => {
    const p = setup();
    const [a, b] = p.sides;
    a.store.start(makeConfig());
    a.connect();
    b.connect();
    a.store.emit({ type: 'point', team: 'A' });
    p.hub.report({ state: 'recording', segment: 1, startedAt: 1, elapsedMs: 10 });
    expect(b.board.getSnapshot().rec?.state).toBe('recording');
    b.unpair();
    expect(b.board.getSnapshot()).toEqual({ rec: null, cmd: null, synced: false, syncedAt: null, others: 0, duplicateAt: null });
    expect(b.store.paired).toBe(false);
    b.store.emit({ type: 'point', team: 'B' }); // its own log again (R-PAIR-3)
    expect(b.shown()!.score).toEqual({ A: 1, B: 1 });
    expect(p.camera().score).toEqual({ A: 1, B: 0 });
    expect(p.hub.current()).not.toBeNull(); // A is still paired
    a.unpair();
    expect(p.hub.current()).toBeNull();
    expect(p.hubStore.log).toBeNull();
  });

  it('the camera keeps its match across a reload (its store)', () => {
    const p = setup(1);
    p.sides[0].store.start(makeConfig());
    p.sides[0].connect();
    const again = new MatchHub([new FakePort('x')], p.hubStore);
    expect(again.current()?.matchId).toBe(p.hub.current()!.matchId);
  });

  it('a gap in the camera’s events asks for the whole state again', () => {
    const p = setup(1);
    const [a] = p.sides;
    a.store.start(makeConfig());
    a.connect();
    const ev = { seq: 9, id: 'zz', at: 1, by: 'x', type: 'point' as const, team: 'A' as const };
    a.sbPort.onMessage({ v: 2, t: 'event', matchId: a.store.getSnapshot().match!.matchId, event: ev });
    expect(a.sbPort.sent.at(-1)?.t).toBe('resync');
    expect(a.shown()).toEqual(p.camera());
  });
});

describe('a reopen the camera did not answer with its match', () => {
  it('the scoreboard asks for it after 1.5 s and shows it', () => {
    const p = setup(1);
    const [a] = p.sides;
    a.store.start(makeConfig());
    a.connect();
    a.sbPort.onOpen(); // the scoreboard saw the link reopen; the camera did not
    expect(a.board.getSnapshot().synced).toBe(false);
    a.board.tick();
    expect(a.sbPort.sent.at(-1)?.t).not.toBe('resync');
    p.advance(RESYNC_AFTER_MS);
    a.board.tick();
    expect(a.board.getSnapshot().synced).toBe(true);
    expect(a.sbPort.sent.some((m) => m.t === 'resync')).toBe(true);
  });
});

describe('remote REC and the camera’s reports', () => {
  it('cmd -> camera -> ack to the scoreboard that asked; a retry after a blip never starts twice (D11)', () => {
    const p = setup();
    const [a, b] = p.sides;
    a.connect();
    b.connect();
    a.drop();
    const c = a.board.command('rec.start');
    expect(c.ack).toBeNull();
    a.connect(); // resent on open
    expect(p.started).toEqual(['rec.start']);
    expect(a.board.getSnapshot().cmd?.ack).toEqual({ ok: true });
    expect(b.board.getSnapshot().cmd).toBeNull();
    p.advance(CMD_RETRY_MS);
    a.board.tick();
    expect(p.started).toEqual(['rec.start']);
  });

  it('gives up after 30 s without an ack', () => {
    const p = setup(1);
    p.sides[0].board.command('rec.stop');
    p.advance(CMD_GIVE_UP_MS);
    p.sides[0].board.tick();
    expect(p.sides[0].board.getSnapshot().cmd?.ack).toEqual({ ok: false, error: 'The camera phone did not answer.' });
  });

  it('rec reports reach every scoreboard, and the last one is repeated on every open', () => {
    const p = setup();
    const [a, b] = p.sides;
    a.connect();
    p.hub.report({ state: 'recording', segment: 1, startedAt: 1, elapsedMs: 5 });
    b.connect();
    expect(a.board.getSnapshot().rec?.state).toBe('recording');
    expect(b.board.getSnapshot().rec?.state).toBe('recording');
  });

  it('events are on the camera’s clock: a scoreboard’s tap time minus its measured offset; the hub reports offset 0', () => {
    const p = setup(1);
    const [a] = p.sides;
    a.store.start(makeConfig());
    a.camPort.clockValue = { offsetMs: 400, samples: 8, medianRttMs: 6 }; // scoreboard clock 400 ms ahead
    a.sbPort.clockValue = { offsetMs: -400, samples: 8, medianRttMs: 6 };
    a.connect();
    p.advance(5000);
    a.store.emit({ type: 'point', team: 'A' });
    const e = p.hub.current()!.events.at(-1)!;
    expect(e.at).toBe(p.now() - 400);
    expect(p.hub.clock()).toEqual({ offsetMs: 0, samples: 8, medianRttMs: 6 });
  });
});
