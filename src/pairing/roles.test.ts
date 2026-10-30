// The camera's MatchHub and up to two scoreboards' ScoreboardLinks over in-memory links (D14): the camera holds
// the match, each scoreboard sends inputs and shows what the camera sends. Joining with and without a match on
// either side, both scoring, undo across scoreboards, the same rally tapped twice, a drop with points scored
// meanwhile (R-PAIR-4), a late joiner, unpairing, remote REC with acks and retries (R-PAIR-6), rec reports,
// and the clock.
import { describe, expect, it } from 'vitest';
import { DUPLICATE_WINDOW_MS, matchStats, rallies, reduce } from '../engine';
import { doublesConfig, makeConfig } from '../engine/test-utils';
import { MatchHub, type HubStore } from '../link/hub';
import { Mirror } from '../link/mirror';
import type { ClockEstimate, LinkState, MatchLog, RecCommand } from '../link/source';
import { MatchStore } from '../match/store';
import { encode, parse, type Msg } from '../protocol/messages';
import { SyncAssembler, stateParts } from '../protocol/sync';
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

  it('an input the camera applied while a drop cut its reply leaves the pending list at the reopen, instead of being resent forever', () => {
    const p = setup(1);
    const [a] = p.sides;
    a.store.start(makeConfig());
    a.connect();
    a.camPort.open = false; // the drop begins: the scoreboard's input still arrives, the camera's event and result do not
    a.store.emit({ type: 'point', team: 'A' });
    expect(p.camera().score).toEqual({ A: 1, B: 0 });
    expect(a.store.pending()).toHaveLength(1);
    a.drop();
    a.connect();
    expect(a.shown()).toEqual(p.camera());
    expect(a.store.pending()).toHaveLength(0);
    const sent = a.sbPort.sent.length;
    a.connect(); // a later reopen resends nothing
    expect(a.sbPort.sent.slice(sent).filter((m) => m.t === 'input')).toEqual([]);
  });

  it('a new match started on a scoreboard while the link is down replaces the camera’s at the reopen, with its points', () => {
    const p = setup(1);
    const [a] = p.sides;
    a.store.start(makeConfig());
    a.connect();
    a.store.emit({ type: 'point', team: 'A' });
    a.drop();
    p.advance(60_000);
    a.store.start(makeConfig({ points: 11 })); // the next match, while the camera cannot hear this phone
    a.store.emit({ type: 'point', team: 'B' });
    a.store.emit({ type: 'point', team: 'B' });
    a.connect();
    expect(p.hub.current()!.matchId).toBe(a.store.getSnapshot().match!.matchId);
    expect(p.hub.current()!.config.pointsToWin).toBe(11);
    expect(a.shown()!.score).toEqual({ A: 0, B: 2 });
    expect(p.camera()).toEqual(a.shown());
    expect(a.store.pending()).toHaveLength(0);
  });

  it('a match started on a scoreboard while it was down gives way to a newer one the camera took meanwhile', () => {
    const p = setup();
    const [a, b] = p.sides;
    a.store.start(makeConfig());
    a.connect();
    b.connect();
    a.drop();
    p.advance(10_000);
    a.store.start(makeConfig({ points: 11 })); // unheard
    p.advance(10_000);
    b.store.start(makeConfig({ points: 15 })); // linked: the camera's match from now
    a.connect();
    expect(p.hub.current()!.config.pointsToWin).toBe(15);
    expect(a.store.getSnapshot().match!.matchId).toBe(b.store.getSnapshot().match!.matchId);
    expect(a.store.pending()).toHaveLength(0);
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
    a.sbPort.onMessage({ v: 3, t: 'event', matchId: a.store.getSnapshot().match!.matchId, event: ev });
    expect(a.sbPort.sent.at(-1)?.t).toBe('resync');
    expect(a.shown()).toEqual(p.camera());
  });
});

describe('point reasons through the camera (D15)', () => {
  const reasons = () => ({ ...doublesConfig(), reasons: 'endOfGame' as const });
  const lastPoint = (s: MatchStore) => [...s.getSnapshot().match!.events].reverse().find((e) => e.type === 'point')!;
  const tagOf = (s: MatchStore, id: string) => rallies(s.getSnapshot().match!.config, s.getSnapshot().match!.events).find((r) => r.id === id)?.tag ?? null;

  it('a tag from either scoreboard is an input the camera applies and broadcasts; the camera’s order decides', () => {
    const p = setup();
    const [a, b] = p.sides;
    a.store.start(reasons());
    a.connect();
    b.connect();
    a.store.emit({ type: 'point', team: 'A' });
    const id = lastPoint(a.store).id;
    expect(lastPoint(b.store).id).toBe(id); // the point id is the same on every phone
    a.store.emit({ type: 'tag', point: id, how: 'winner', hit: { team: 'A', idx: 1 }, shot: 'smash' });
    p.advance(1000);
    b.store.emit({ type: 'tag', point: id, how: 'forced', hit: { team: 'B', idx: 0 }, forcedBy: { team: 'A', idx: 1 } });
    for (const s of [a, b]) expect(tagOf(s.store, id)).toMatchObject({ how: 'forced', hit: { team: 'B', idx: 0 } });
    const cam = p.hub.current()!;
    expect(rallies(cam.config, cam.events)[0].tag).toMatchObject({ how: 'forced' });
    expect(cam.events.filter((e) => e.type === 'tag').map((e) => e.by)).toEqual(['sb-1', 'sb-2']);
    // Undo still takes back the point, whoever tagged it; redo brings the tag back with it.
    b.store.undo();
    expect(a.shown()!.score).toEqual({ A: 0, B: 0 });
    expect(tagOf(a.store, id)).toBeNull();
    a.store.redo();
    expect(tagOf(b.store, id)).toMatchObject({ how: 'forced' });
    expect(a.store.pending()).toHaveLength(0);
    expect(b.store.pending()).toHaveLength(0);
  });

  it('tag later from the other scoreboard; both show the same game stats', () => {
    const p = setup();
    const [a, b] = p.sides;
    a.store.start({ ...reasons(), pointsToWin: 11, cap: 20 });
    a.connect();
    b.connect();
    for (let i = 0; i < 11; i++) {
      p.advance(4000);
      a.store.emit({ type: 'point', team: i === 3 ? 'B' : 'A' });
      if (a.shown()!.phase === 'interval') a.store.emit({ type: 'interval.end' });
    }
    expect(a.shown()!.phase).toBe('playing'); // 10-1
    a.store.emit({ type: 'point', team: 'A' });
    expect(b.shown()!.phase).toBe('gameOver');
    const rs = rallies(b.store.getSnapshot().match!.config, b.store.getSnapshot().match!.events);
    b.store.emit({ type: 'tag', point: rs[3].id, how: 'unforced', hit: { team: 'A', idx: 0 } }); // B tags an early point later
    b.store.emit({ type: 'tag', point: rs[11].id, how: 'winner', hit: { team: 'A', idx: 1 }, assist: { team: 'A', idx: 0 }, shot: 'kill' });
    const st = (s: MatchStore) => matchStats(s.getSnapshot().match!.config, s.getSnapshot().match!.events).games[0];
    expect(st(a.store)).toEqual(st(b.store));
    expect(st(a.store).players.A[1].W).toBe(1);
    expect(st(a.store).players.A[0]).toMatchObject({ A: 1, UE: 1 });
    expect(st(a.store).teams.A).toMatchObject({ won: 11, winners: 1, untagged: 10 });
  });

  it('a match full of tags still reaches a late joiner in parts under 16 kB', () => {
    const p = setup();
    const [a, b] = p.sides;
    a.store.start(reasons());
    a.connect();
    for (let i = 0; i < 40; i++) {
      p.advance(4000);
      a.store.emit({ type: 'point', team: i % 3 ? 'A' : 'B' });
      if (a.shown()!.phase === 'interval') a.store.emit({ type: 'interval.end' });
      if (a.shown()!.phase === 'gameOver') a.store.emit({ type: 'game.start', game: a.shown()!.game + 1 });
      const pt = lastPoint(a.store);
      for (const shot of ['smash', 'kill', 'drop'] as const) {
        const team = pt.type === 'point' ? pt.team : 'A';
        a.store.emit({ type: 'tag', point: pt.id, how: 'winner', hit: { team, idx: 0 }, assist: { team, idx: 1 }, shot });
      }
    }
    const cam = p.hub.current()!;
    const parts = stateParts(cam, 4000);
    expect(parts.length).toBeGreaterThan(1);
    const asm = new SyncAssembler();
    let whole;
    for (const raw of parts) {
      const m = parse(raw);
      if (m.kind === 'msg' && m.msg.t === 'state') whole = asm.add(m.msg);
    }
    expect(whole).toEqual(cam);
    b.connect();
    expect(matchStats(b.store.getSnapshot().match!.config, b.store.getSnapshot().match!.events)).toEqual(matchStats(cam.config, cam.events));
  });

  it('Off: tags sent to the camera are ignored and nothing is recorded', () => {
    const p = setup();
    const [a, b] = p.sides;
    a.store.start({ ...doublesConfig(), reasons: 'off' });
    a.connect();
    b.connect();
    a.store.emit({ type: 'point', team: 'A' });
    const id = lastPoint(a.store).id;
    expect(b.store.emit({ type: 'tag', point: id, how: 'winner', hit: { team: 'A', idx: 0 } })).toBeNull();
    expect(p.hub.current()!.events.some((e) => e.type === 'tag')).toBe(false);
    expect(b.store.pending()).toHaveLength(0);
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
