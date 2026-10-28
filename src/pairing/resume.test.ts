// The page comes back (screen on): the link is probed or given up at once, and a scoreboard offers a fresh
// connection itself instead of waiting for missed pongs and the camera's ICE restart (technical-design.md
// §4.5). Also unpairing: the goodbye leaves before the connection closes, and the helper's `ended` reaches a
// phone whose goodbye was lost.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encode } from '../protocol/messages';
import { HelperError, type Desc, type HelperClient, type PollReply, type Session } from './helper';
import { PeerLink } from './link';
import {
  CAMERA_FAST_FOR_MS,
  POLL_ANSWER_MS,
  POLL_DOWN_MS,
  POLL_FAST_MS,
  POLL_SLOW_MS,
  PROBE_MS,
  cameraPollEvery,
  resumeAction,
  resumeReply,
} from './reconnect';

const SDP = 'v=0\r\na=candidate:1 1 udp 2113937151 192.168.1.20 5000 typ host\r\n';

class FakeDc extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  sent: string[] = [];
  /** The other phone answers pings while true. */
  alive = true;
  send(data: string) {
    this.sent.push(data);
    const m = JSON.parse(data);
    if (m.t !== 'ping' || !this.alive) return;
    const pong = encode({ t: 'pong', id: m.id, t0: m.t0, t1: Date.now(), t2: Date.now() });
    queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('message'), { data: pong })));
  }
}

class FakePc extends EventTarget {
  static all: FakePc[] = [];
  iceGatheringState = 'complete';
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remote: RTCSessionDescriptionInit[] = [];
  dc: FakeDc | null = null;
  closedAt: number | null = null;
  constructor() {
    super();
    FakePc.all.push(this);
  }
  createDataChannel() {
    return (this.dc = new FakeDc());
  }
  async createOffer() {
    this.signalingState = 'have-local-offer';
    return { type: 'offer' as const, sdp: SDP };
  }
  async createAnswer() {
    return { type: 'answer' as const, sdp: SDP };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    this.remote.push(d);
    if (d.type === 'answer') this.signalingState = 'stable';
  }
  close() {
    this.connectionState = 'closed';
    this.closedAt = Date.now();
  }
}

/** A mailbox like the helper's: one offer and one answer, `poll` as in api/signal.ts. */
function fakeHelper() {
  const calls: string[] = [];
  const box: { offer: Desc | null; answer: Desc | null; ended: boolean } = { offer: null, answer: null, ended: false };
  const check = () => {
    if (box.ended) throw new HelperError('ended', 410);
  };
  const helper = {
    poll: async (_s: Session, gen: number, side: string): Promise<PollReply> => {
      calls.push(`poll ${side} ${gen}`);
      check();
      const o = box.offer;
      if (o && (o.by ?? 'camera') !== side && o.gen > gen) return { offer: o };
      if (o && (o.by ?? 'camera') === side && o.gen === gen && box.answer?.gen === gen) return { answer: box.answer };
      return null;
    },
    postOffer: async (_s: Session, d: Desc) => {
      calls.push(`offer ${d.by} ${d.gen} ${d.fresh ? 'fresh' : 'restart'}`);
      check();
      if (box.offer && d.gen <= box.offer.gen) throw new HelperError('stale', 409, 'stale', box.offer.gen);
      box.offer = d;
    },
    postAnswer: async (_s: Session, d: Desc) => {
      calls.push(`answer ${d.gen}`);
      check();
      box.answer = d;
    },
    end: async () => {
      calls.push('end');
      box.ended = true;
    },
    getIce: async () => ({ relay: 'not-configured' as const }),
  } as unknown as HelperClient;
  return { helper, calls, box };
}

const links: PeerLink[] = [];
afterEach(() => {
  for (const l of links.splice(0)) l.unpair();
  FakePc.all = [];
  vi.useRealTimers();
});

/** A scoreboard paired and open on a connection the camera offered (gen 1). */
async function openScoreboard() {
  vi.useFakeTimers({ now: 1_000_000 });
  const h = fakeHelper();
  h.box.offer = { gen: 1, sdp: SDP, fresh: true, by: 'camera' };
  const logged: string[] = [];
  const link = new PeerLink({
    role: 'scoreboard',
    helper: h.helper,
    hello: () => ({ deviceId: 'sb', app: 'test@1' }),
    createPc: () => new FakePc() as unknown as RTCPeerConnection,
    saved: { load: () => ({ session: 's'.repeat(32), secret: 'x'.repeat(32), gen: 0, at: Date.now() }), save: () => {} },
    log: (k, t) => logged.push(`${k} ${t}`),
  });
  links.push(link);
  link.rejoin();
  await vi.advanceTimersByTimeAsync(300); // poll, answer gen 1
  const pc = FakePc.all[0];
  const dc = new FakeDc();
  pc.dc = dc;
  pc.connectionState = 'connected';
  pc.iceConnectionState = 'connected';
  pc.dispatchEvent(Object.assign(new Event('datachannel'), { channel: dc }));
  dc.dispatchEvent(new Event('open'));
  dc.dispatchEvent(Object.assign(new Event('message'), { data: encode({ t: 'hello', role: 'camera', deviceId: 'cam', app: 'test@1' }) }));
  expect(link.isOpen()).toBe(true);
  h.calls.length = 0;
  return { ...h, link, pc, dc, logged };
}

describe('resume decisions', () => {
  it('probe a connection that still says it is up; give up at once on one that says otherwise', () => {
    const up = { channelOpen: true, connectionState: 'connected', iceConnectionState: 'connected' } as const;
    expect(resumeAction(up)).toBe('probe');
    expect(resumeAction({ ...up, channelOpen: false })).toBe('recover');
    for (const c of ['failed', 'closed', 'disconnected', 'none'] as const) expect(resumeAction({ ...up, connectionState: c })).toBe('recover');
    for (const c of ['failed', 'disconnected'] as const) expect(resumeAction({ ...up, iceConnectionState: c })).toBe('recover');
  });

  it('a scoreboard back from a locked screen answers a fresh offer, but replaces a restart with its own fresh offer', () => {
    expect(resumeReply({ fresh: true })).toBe('answer');
    expect(resumeReply({ fresh: false })).toBe('offer');
    expect(resumeReply(null)).toBe('offer');
  });

  it('the camera polls every second for two minutes while a link is down, then 2 s, then 5 s', () => {
    const down = { since: 0, cause: 'pongs' as const };
    expect(cameraPollEvery(1000, down, false)).toBe(POLL_DOWN_MS);
    expect(cameraPollEvery(CAMERA_FAST_FOR_MS + 1, down, false)).toBe(POLL_FAST_MS);
    expect(cameraPollEvery(11 * 60_000, down, false)).toBe(POLL_SLOW_MS);
    expect(cameraPollEvery(1000, down, true)).toBe(POLL_SLOW_MS);
  });
});

describe('a scoreboard whose screen comes back on', () => {
  it('a connection iOS suspended: no wait for pongs; its own fresh offer over the camera’s restart, answered within a second', async () => {
    const s = await openScoreboard();
    s.box.offer = { gen: 2, sdp: SDP, fresh: false, by: 'camera' }; // the camera's ICE restart, waiting since the drop
    s.pc.connectionState = 'failed';
    s.link.resume('visible');
    await vi.advanceTimersByTimeAsync(10);
    expect(s.calls.slice(0, 2)).toEqual(['poll scoreboard 1', 'offer scoreboard 3 fresh']);
    expect(s.pc.closedAt).not.toBeNull(); // the old connection is given up
    const mine = FakePc.all[1];
    expect(mine.dc).not.toBeNull(); // this phone offers, so it creates the channel
    // The camera answers; the scoreboard looks for it every 500 ms.
    s.box.answer = { gen: 3, sdp: SDP, fresh: true };
    await vi.advanceTimersByTimeAsync(POLL_ANSWER_MS + 300);
    expect(mine.remote.map((d) => d.type)).toEqual(['answer']);
    expect(s.logged.some((l) => l.includes('resume (visible): the link is gone (connection failed'))).toBe(true);
  });

  it('a fresh offer from the camera already waiting is answered at once', async () => {
    const s = await openScoreboard();
    s.box.offer = { gen: 2, sdp: SDP, fresh: true, by: 'camera' };
    s.dc.readyState = 'closed';
    s.link.resume('pageshow');
    await vi.advanceTimersByTimeAsync(10);
    expect(s.calls).toEqual(['poll scoreboard 1', 'answer 2']);
  });

  it('a link that survived answers the probe: nothing is rebuilt', async () => {
    const s = await openScoreboard();
    s.link.resume('visible');
    await vi.advanceTimersByTimeAsync(PROBE_MS + 500);
    expect(s.link.isOpen()).toBe(true);
    expect(FakePc.all).toHaveLength(1);
    expect(s.logged.some((l) => l.startsWith('link resume: the link is alive'))).toBe(true);
  });

  it('no pong within the probe’s second: recovery starts then, not after three missed pongs', async () => {
    const s = await openScoreboard();
    s.dc.alive = false;
    s.link.resume('visible');
    await vi.advanceTimersByTimeAsync(PROBE_MS + 300);
    expect(s.logged.some((l) => l.includes(`no pong within ${PROBE_MS} ms`))).toBe(true);
    expect(s.calls).toContain('offer scoreboard 2 fresh');
  });
});

describe('unpairing', () => {
  it('the goodbye leaves before the connection closes, and the helper marks the session ended', async () => {
    const s = await openScoreboard();
    s.dc.bufferedAmount = 500; // the goodbye is still queued
    s.link.unpair();
    expect(s.link.getSnapshot().state).toBe('unpaired');
    expect(JSON.parse(s.dc.sent.at(-1)!)).toMatchObject({ t: 'bye', reason: 'unpaired' });
    expect(s.calls).toContain('end');
    await vi.advanceTimersByTimeAsync(200);
    expect(s.pc.closedAt).toBeNull(); // still draining
    s.dc.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(200);
    expect(s.pc.closedAt).not.toBeNull();
  });

  it('a goodbye that never arrived: the helper’s "ended" unpairs this phone at its next look', async () => {
    const s = await openScoreboard();
    s.box.ended = true; // the camera unpaired; its bye was lost
    s.dc.readyState = 'closed';
    s.dc.dispatchEvent(new Event('close'));
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS);
    expect(s.link.getSnapshot().state).toBe('unpaired');
    expect(s.link.paired).toBe(false);
    expect(s.logged).toContain('link the other phone ended the pairing (helper)');
  });

  it('the other phone’s goodbye unpairs this one at once', async () => {
    const s = await openScoreboard();
    s.dc.dispatchEvent(Object.assign(new Event('message'), { data: encode({ t: 'bye', reason: 'unpaired' }) }));
    expect(s.link.getSnapshot().state).toBe('unpaired');
  });
});

describe('the camera while a link is down', () => {
  it('picks up a returning scoreboard’s own offer within a second and answers it on a new connection', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fakeHelper();
    const cam = new PeerLink({
      role: 'camera',
      helper: h.helper,
      hello: () => ({ deviceId: 'cam', app: 'test@1' }),
      createPc: () => new FakePc() as unknown as RTCPeerConnection,
      saved: { load: () => ({ session: 's'.repeat(32), secret: 'x'.repeat(32), gen: 2, at: Date.now() }), save: () => {} },
    });
    links.push(cam);
    h.box.offer = { gen: 2, sdp: SDP, fresh: false, by: 'camera' };
    // Down on missed pongs: the camera waits 10 s before its own restart, but looks at the helper meanwhile.
    (cam as any).session = { session: 's'.repeat(32), secret: 'x'.repeat(32) };
    (cam as any).gen = 2;
    (cam as any).down = { since: Date.now(), cause: 'pongs' };
    (cam as any).snap = { ...(cam as any).snap, everOpened: true };
    (cam as any).startTimer();
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.calls.filter((c) => c.startsWith('poll'))).toEqual(['poll camera 2', 'poll camera 2']);
    h.box.offer = { gen: 3, sdp: SDP, fresh: true, by: 'scoreboard' };
    await vi.advanceTimersByTimeAsync(POLL_DOWN_MS + 300);
    expect(h.calls).toContain('answer 3');
    expect(FakePc.all.at(-1)!.dc).toBeNull(); // the scoreboard offered: its channel arrives, none created here
  });
});
