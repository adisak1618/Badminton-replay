// A reconnect offer gathered while the camera's network was down carried no candidate at all (`sent offer gen 5
// new connection: none`), was posted all the same, and the next attempt came only 10 s after its useless answer:
// the link came back 16 s after the network (2026-10-31 audit, BUG-7). Such an offer is no longer posted, and the
// camera gathers again 2 s later. Two PeerLinks over the one-sided test's fake channel pair and helper mailbox.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Desc, HelperClient, PollReply, Session } from './helper';
import { PeerLink } from './link';
import { RESTART_AFTER_MS } from './reconnect';

/** What a gathering finds: candidates, or nothing while the network is down. */
const net = { gathers: '' };

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
    return { type: 'offer' as const, sdp: net.gathers };
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


describe('a reconnect offer gathered while the network is down', () => {
  it('is not posted; the camera gathers again 2 s later and posts the first offer that has candidates', async () => {
    net.gathers = SDP;
    const s = await pairBoth();
    s.a.mute = s.b.mute = true; // the network is gone
    net.gathers = 'v=0\r\n'; // and a gathering finds nothing
    await vi.advanceTimersByTimeAsync(RESTART_AFTER_MS + 6000);
    expect(s.h.calls.filter((c) => c.startsWith('offer camera'))).toEqual([]);
    expect(s.logs.camera.some((l) => / not posted: nothing in it the other phone could reach$/.test(l))).toBe(true);
    net.gathers = SDP; // the network is back
    const back = Date.now();
    for (let t = 0; t < 6000 && !s.h.calls.some((c) => c.startsWith('offer camera')); t += 100) await vi.advanceTimersByTimeAsync(100);
    expect(s.h.calls.some((c) => c.startsWith('offer camera'))).toBe(true);
    expect(Date.now() - back).toBeLessThanOrEqual(2000 + 2000 + 500); // the retry interval plus one gathering
  });
});
