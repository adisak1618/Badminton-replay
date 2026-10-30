// A drop only one phone saw (2026-10-30): each phone judges the link by its own pongs, so a stall near the
// limit, or the camera's page away for a few seconds, takes one phone down while the other stays open. The open
// phone does not answer a hello with one and the camera offers only when it is down itself, so the down phone
// counts the link open again on its next pong (link.ts). Before, the scoreboard stayed on "link lost" for minutes
// while each tap reached the camera only with the next ping round. Two PeerLinks over one fake channel pair and
// the helper's mailbox.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Desc, HelperClient, PollReply, Session } from './helper';
import { PeerLink } from './link';
import { DOWN_AFTER_MS } from './reconnect';

const SDP = 'v=0\r\na=candidate:1 1 udp 2113937151 192.168.1.20 5000 typ host\r\n';
const ONE_WAY_MS = 20;

class End extends EventTarget {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  other: End | null = null;
  /** What this phone sends is lost. */
  mute = false;
  /** What reaches this phone is not heard. */
  deaf = false;
  send(data: string) {
    const o = this.other;
    if (this.mute || !o) return;
    setTimeout(() => !o.deaf && o.dispatchEvent(Object.assign(new Event('message'), { data })), ONE_WAY_MS);
  }
  close() {
    this.readyState = 'closed';
  }
}

class FakePc extends EventTarget {
  static all: FakePc[] = [];
  iceGatheringState = 'complete';
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  dc: End | null = null;
  constructor(readonly role: string) {
    super();
    FakePc.all.push(this);
  }
  createDataChannel() {
    return (this.dc = new End());
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
    if (d.type === 'answer') this.signalingState = 'stable';
  }
  getConfiguration() {
    return {};
  }
  close() {
    this.connectionState = 'closed';
  }
}

function fakeHelper() {
  const calls: string[] = [];
  const box: { offer: Desc | null; answer: Desc | null } = { offer: null, answer: null };
  const helper = {
    poll: async (_s: Session, gen: number, side: string): Promise<PollReply> => {
      calls.push(`poll ${side} ${gen}`);
      const o = box.offer;
      if (o && (o.by ?? 'camera') !== side && o.gen > gen) return { offer: o };
      if (o && (o.by ?? 'camera') === side && o.gen === gen && box.answer?.gen === gen) return { answer: box.answer };
      return null;
    },
    postOffer: async (_s: Session, d: Desc) => {
      calls.push(`offer ${d.by} ${d.gen} ${d.fresh ? 'fresh' : 'restart'}`);
      box.offer = d;
    },
    postAnswer: async (_s: Session, d: Desc) => {
      calls.push(`answer ${d.gen}`);
      box.answer = d;
    },
    end: async () => {},
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

/** Both phones paired and open on the camera's first offer, as after a reload of each with a saved pairing. */
async function pairBoth() {
  vi.useFakeTimers({ now: 1_000_000 });
  const h = fakeHelper();
  const session = { session: 's'.repeat(32), secret: 'x'.repeat(32) };
  const logs: Record<string, string[]> = { camera: [], scoreboard: [] };
  const mk = (role: 'camera' | 'scoreboard') =>
    new PeerLink({
      role,
      helper: h.helper,
      hello: () => ({ deviceId: role, app: 'test@1' }),
      createPc: () => new FakePc(role) as unknown as RTCPeerConnection,
      saved: { load: () => ({ ...session, gen: 0, at: Date.now() }), save: () => {} },
      log: (k, t) => logs[role].push(`${Date.now() - 1_000_000} ${k} ${t}`),
    });
  const cam = mk('camera');
  const sb = mk('scoreboard');
  links.push(cam, sb);
  cam.rejoin();
  sb.rejoin();
  // camera polls, offers gen 1; the scoreboard answers; the camera applies the answer
  await vi.advanceTimersByTimeAsync(4000);
  expect(h.calls).toContain('offer camera 1 fresh');
  expect(h.calls).toContain('answer 1');
  const camPc = FakePc.all.find((p) => p.role === 'camera')!;
  const sbPc = FakePc.all.find((p) => p.role === 'scoreboard')!;
  const a = camPc.dc!;
  const b = new End();
  a.other = b;
  b.other = a;
  for (const pc of [camPc, sbPc]) {
    pc.connectionState = 'connected';
    pc.iceConnectionState = 'connected';
  }
  sbPc.dispatchEvent(Object.assign(new Event('datachannel'), { channel: b }));
  a.dispatchEvent(new Event('open'));
  b.dispatchEvent(new Event('open'));
  await vi.advanceTimersByTimeAsync(3000);
  expect(cam.isOpen()).toBe(true);
  expect(sb.isOpen()).toBe(true);
  h.calls.length = 0;
  return { cam, sb, a, b, h, logs };
}

const state = (l: PeerLink) => l.getSnapshot().state;

describe('a drop only one phone saw', () => {
  it('a stall both phones see heals by itself once pongs flow again', async () => {
    const s = await pairBoth();
    s.a.mute = s.b.mute = true;
    await vi.advanceTimersByTimeAsync(DOWN_AFTER_MS + 1500);
    expect([state(s.cam), state(s.sb)]).toEqual(['reconnecting', 'reconnecting']);
    s.a.mute = s.b.mute = false;
    await vi.advanceTimersByTimeAsync(4000);
    expect([state(s.cam), state(s.sb)]).toEqual(['paired', 'paired']);
  });

  it('the camera page away 8 s with its connection alive (an app switch): the scoreboard is linked again at its next ping', async () => {
    const s = await pairBoth();
    (s.cam as any).stopTimer(); // the page is suspended: no ticks, nothing sent or heard
    s.a.mute = s.a.deaf = true;
    await vi.advanceTimersByTimeAsync(8000);
    expect([state(s.cam), state(s.sb)]).toEqual(['paired', 'reconnecting']); // only the scoreboard missed its pongs
    s.a.mute = s.a.deaf = false;
    (s.cam as any).startTimer();
    s.cam.resume('visible'); // the camera's probe is answered: alive, nothing to rebuild
    await vi.advanceTimersByTimeAsync(2500);
    expect([state(s.cam), state(s.sb)]).toEqual(['paired', 'paired']);
    expect(s.logs.scoreboard.some((l) => l.endsWith('link open again: pongs are back'))).toBe(true);
    expect(s.h.calls.filter((c) => c.startsWith('offer'))).toEqual([]);
  });

  it('the scoreboard page’s timers held 8 s while it still answers pings: linked again with the first pong', async () => {
    const s = await pairBoth();
    (s.sb as any).stopTimer();
    await vi.advanceTimersByTimeAsync(8000);
    (s.sb as any).startTimer(); // first tick: a ping, and the last pong is 8 s old: down
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.logs.scoreboard.some((l) => l.endsWith('link down: pongs'))).toBe(true);
    expect([state(s.cam), state(s.sb)]).toEqual(['paired', 'paired']);
    expect(s.h.calls.filter((c) => c.startsWith('offer'))).toEqual([]);
  });

  it('the camera alone down: linked again with the first pong, not after an ICE restart and a fresh connection', async () => {
    const s = await pairBoth();
    (s.cam as any).stopTimer();
    await vi.advanceTimersByTimeAsync(8000);
    (s.cam as any).startTimer();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.logs.camera.some((l) => l.endsWith('link down: pongs'))).toBe(true);
    expect([state(s.cam), state(s.sb)]).toEqual(['paired', 'paired']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.h.calls.filter((c) => c.startsWith('offer'))).toEqual([]);
  });
});
