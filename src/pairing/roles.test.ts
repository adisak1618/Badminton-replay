// The two role layers talking through an in-memory link: the scoreboard's ScoreboardLink and the camera's
// PeerSource feeding the camera Mirror. Sync on open, live events, dedupe, a drop with points scored
// meanwhile (R-PAIR-4), remote REC with acks and retries (R-PAIR-6), rec reports, and the clock direction.
import { describe, expect, it } from 'vitest';
import { reduce } from '../engine';
import { makeConfig } from '../engine/test-utils';
import { Mirror } from '../link/mirror';
import { PeerSource } from '../link/peer';
import type { ClockEstimate, LinkState, RecCommand } from '../link/source';
import { MatchStore } from '../match/store';
import { encode, parse, type Msg } from '../protocol/messages';
import type { LinkPort } from './port';
import { CMD_GIVE_UP_MS, CMD_RETRY_MS, ScoreboardLink } from './scoreboard';

class FakePort implements LinkPort {
  peer: FakePort | null = null;
  open = false;
  state: LinkState = 'connecting';
  clockValue: ClockEstimate | null = null;
  sent: Msg[] = [];
  private listeners = new Set<() => void>();
  onMessage: (m: Msg) => void = () => {};
  onOpen: () => void = () => {};

  send(body: Parameters<typeof encode>[0]): boolean {
    return this.sendRaw(encode(body));
  }
  sendRaw(data: string): boolean {
    if (!this.open || !this.peer) return false;
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
    return { state: this.state, remote: { deviceId: 'sb-1', app: 'test@1', ua: 'ua' } };
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

function pair() {
  let t = 50_000;
  const now = () => t;
  const sbPort = new FakePort();
  const camPort = new FakePort();
  sbPort.peer = camPort;
  camPort.peer = sbPort;
  const store = new MatchStore(async () => {}, () => 'sb-1', () => (t += 10));
  const board = new ScoreboardLink(sbPort, store, now);
  const source = new PeerSource(camPort);
  const mirror = new Mirror(now);
  // The controller's idempotent command handling (recording/controller.ts), reduced to what the link sees.
  const handled = new Map<string, boolean>();
  const started: string[] = [];
  mirror.onCommand = (c: RecCommand) => {
    if (!handled.has(c.id)) {
      handled.set(c.id, true);
      started.push(c.action);
    }
    source.ack(c.id, true);
  };
  mirror.attach(source);
  const connect = () => {
    sbPort.setState('paired', true);
    camPort.setState('paired', true);
    camPort.onOpen();
    sbPort.onOpen();
  };
  const drop = () => {
    sbPort.setState('reconnecting', false);
    camPort.setState('reconnecting', false);
  };
  return { store, board, source, mirror, sbPort, camPort, connect, drop, started, advance: (ms: number) => (t += ms) };
}

const same = (p: ReturnType<typeof pair>) => {
  const m = p.mirror.getSnapshot();
  return reduce(m.config!, m.events);
};

describe('scoreboard and camera over the link', () => {
  it('a match started before pairing arrives whole on open, then event by event', () => {
    const p = pair();
    p.store.start(makeConfig());
    p.store.emit({ type: 'point', team: 'A' });
    expect(p.mirror.getSnapshot().config).toBeNull();
    p.connect();
    expect(p.mirror.getSnapshot().link).toBe('paired');
    expect(p.mirror.getSnapshot().events).toHaveLength(2);
    p.store.emit({ type: 'point', team: 'B' });
    p.store.undo();
    expect(p.sbPort.sent.map((m) => m.t)).toEqual(['sync', 'event', 'event']);
    expect(same(p)).toEqual(p.store.getSnapshot().state);
  });

  it('a drop: points scored meanwhile arrive by the resync, none lost or doubled (R-PAIR-4)', () => {
    const p = pair();
    p.connect();
    p.store.start(makeConfig());
    p.store.emit({ type: 'point', team: 'A' });
    p.drop();
    expect(p.mirror.getSnapshot().link).toBe('reconnecting');
    for (let i = 0; i < 5; i++) p.store.emit({ type: 'point', team: i % 2 ? 'A' : 'B' });
    expect(p.mirror.getSnapshot().events).toHaveLength(2); // frozen while down
    p.connect();
    const m = p.mirror.getSnapshot();
    expect(m.events).toHaveLength(7);
    expect(new Set(m.events.map((e) => e.id)).size).toBe(7);
    expect(same(p)).toEqual(p.store.getSnapshot().state);
    // The events the camera already had keep their first receive time.
    const first = p.store.getSnapshot().match!.events[1].id;
    expect(m.receivedAt[first]).toBeLessThan(m.receivedAt[p.store.getSnapshot().match!.events[6].id]);
  });

  it('a resent event is ignored by id', () => {
    const p = pair();
    p.connect();
    p.store.start(makeConfig());
    p.store.emit({ type: 'point', team: 'A' });
    const ev = p.store.getSnapshot().match!.events[1];
    p.sbPort.send({ t: 'event', event: ev });
    expect(p.mirror.getSnapshot().events).toHaveLength(2);
  });

  it('a new match on the scoreboard replaces the camera mirror', () => {
    const p = pair();
    p.connect();
    p.store.start(makeConfig());
    p.store.emit({ type: 'point', team: 'A' });
    p.store.start(makeConfig({ points: 11 }));
    expect(p.mirror.getSnapshot().config?.pointsToWin).toBe(11);
    expect(p.mirror.getSnapshot().events).toHaveLength(1);
  });

  it('remote REC: cmd -> camera -> ack; a retry after a blip never starts twice (D11)', () => {
    const p = pair();
    p.connect();
    const c = p.board.command('rec.start');
    expect(p.started).toEqual(['rec.start']);
    expect(p.board.getSnapshot().cmd).toMatchObject({ id: c.id, ack: { ok: true } });

    // Stop sent while the link is down: queued, then sent once on reopen with the same id.
    p.drop();
    const stop = p.board.command('rec.stop');
    expect(p.board.getSnapshot().cmd?.ack).toBeNull();
    p.connect();
    expect(p.started).toEqual(['rec.start', 'rec.stop']);
    expect(p.board.getSnapshot().cmd).toMatchObject({ id: stop.id, ack: { ok: true } });

    // A command the camera never answers is resent with the same id, then given up on.
    p.camPort.onMessage = () => {};
    const lone = p.board.command('rec.start');
    p.advance(CMD_RETRY_MS);
    p.board.tick();
    const cmds = p.sbPort.sent.filter((m) => m.t === 'cmd' && m.id === lone.id);
    expect(cmds).toHaveLength(2);
    p.advance(CMD_GIVE_UP_MS);
    p.board.tick();
    expect(p.board.getSnapshot().cmd?.ack).toEqual({ ok: false, error: 'The camera phone did not answer.' });
  });

  it('rec reports reach the scoreboard, and the last one is repeated on every reopen', () => {
    const p = pair();
    p.connect();
    p.source.report({ state: 'recording', segment: 1, startedAt: 1, elapsedMs: 5000 });
    expect(p.board.getSnapshot().rec).toMatchObject({ state: 'recording', elapsedMs: 5000 });
    p.drop();
    p.board.clear();
    p.connect();
    expect(p.board.getSnapshot().rec).toMatchObject({ state: 'recording', segment: 1 });
  });

  it('the camera reports camera clock minus scoreboard clock: the negation of its own ping samples', () => {
    const p = pair();
    expect(p.source.clock()).toBeNull();
    p.camPort.clockValue = { offsetMs: 420, samples: 5, medianRttMs: 6 };
    expect(p.source.clock()).toEqual({ offsetMs: -420, samples: 5, medianRttMs: 6 });
    expect(p.source.peer()).toEqual({ id: 'sb-1', ua: 'ua', app: 'test@1' });
  });

  it('scoring never waits on the link (R-PAIR-3)', () => {
    const p = pair();
    p.store.start(makeConfig());
    for (let i = 0; i < 21; i++) p.store.emit({ type: 'point', team: 'A' });
    expect(p.store.getSnapshot().state?.games.A).toBe(1);
    expect(p.sbPort.sent).toHaveLength(0);
  });
});
