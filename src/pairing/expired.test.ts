// The helper forgetting a session (its TTL passed, or a memory-store helper restarted) must not tear down a link
// that is open and working: it did, on both phones within 2 s, and the camera dropped the match it held (2026-10-31
// audit, BUG-3). The link only needs the helper again when it goes down. Two PeerLinks over one fake channel pair
// and a fake helper that can forget the session.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HelperError, type Desc, type HelperClient, type PollReply, type Session } from './helper';
import { PeerLink } from './link';
import { DOWN_AFTER_MS } from './reconnect';

const SDP = 'v=0\r\na=candidate:1 1 udp 2113937151 192.168.1.20 5000 typ host\r\n';

class End extends EventTarget {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  other: End | null = null;
  mute = false;
  send(data: string) {
    const o = this.other;
    if (this.mute || !o) return;
    setTimeout(() => o.dispatchEvent(Object.assign(new Event('message'), { data })), 20);
  }
  close() {
    this.readyState = 'closed';
  }
}

class FakePc extends EventTarget {
  iceGatheringState = 'complete';
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  dc: End | null = null;
  closed = false;
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
    this.closed = true;
    this.connectionState = 'closed';
  }
}

const links: PeerLink[] = [];
afterEach(() => {
  for (const l of links.splice(0)) l.unpair();
  vi.useRealTimers();
});

async function openPair() {
  vi.useFakeTimers({ now: 1_800_000_000_000 });
  const h = { forgot: false, polls: 0 };
  const box: { offer: Desc | null; answer: Desc | null } = { offer: null, answer: null };
  const gone = () => {
    if (h.forgot) throw new HelperError('no-session', 404);
  };
  const helper = {
    poll: async (_s: Session, gen: number, side: string): Promise<PollReply> => {
      h.polls++;
      gone();
      const o = box.offer;
      if (o && (o.by ?? 'camera') !== side && o.gen > gen) return { offer: o };
      if (o && (o.by ?? 'camera') === side && o.gen === gen && box.answer?.gen === gen) return { answer: box.answer };
      return null;
    },
    postOffer: async (_s: Session, d: Desc) => {
      gone();
      box.offer = d;
    },
    postAnswer: async (_s: Session, d: Desc) => {
      gone();
      box.answer = d;
    },
    end: async () => {},
    getIce: async () => ({ relay: 'not-configured' as const }),
  } as unknown as HelperClient;
  const pcs: FakePc[] = [];
  const session = { session: 's'.repeat(32), secret: 'x'.repeat(32) };
  const logs: string[] = [];
  const mk = (role: 'camera' | 'scoreboard') => {
    const l = new PeerLink({
      role,
      helper,
      hello: () => ({ deviceId: role, app: 'test@1' }),
      createPc: () => {
        const p = new FakePc();
        pcs.push(p);
        return p as unknown as RTCPeerConnection;
      },
      saved: { load: () => ({ ...session, gen: 0, at: Date.now() }), save: () => {} },
      log: (k, t) => logs.push(`${role} ${k} ${t}`),
    });
    links.push(l);
    return l;
  };
  const cam = mk('camera');
  const sb = mk('scoreboard');
  cam.rejoin();
  sb.rejoin();
  await vi.advanceTimersByTimeAsync(4000);
  const [camPc, sbPc] = pcs;
  const a = camPc.dc!;
  const b = new End();
  a.other = b;
  b.other = a;
  for (const p of [camPc, sbPc]) Object.assign(p, { connectionState: 'connected', iceConnectionState: 'connected' });
  sbPc.dispatchEvent(Object.assign(new Event('datachannel'), { channel: b }));
  a.dispatchEvent(new Event('open'));
  b.dispatchEvent(new Event('open'));
  await vi.advanceTimersByTimeAsync(3000);
  expect([cam.isOpen(), sb.isOpen()]).toEqual([true, true]);
  return { cam, sb, h, a, b, pcs, logs };
}

describe('the helper forgets a session', () => {
  it('an open link stays open and keeps carrying messages; the scoreboard stops its idle polls', async () => {
    const { cam, sb, h, pcs, logs } = await openPair();
    h.forgot = true;
    await vi.advanceTimersByTimeAsync(20_000); // the scoreboard polls every 15 s while open: one 404
    expect([cam.isOpen(), sb.isOpen()]).toEqual([true, true]);
    expect([cam.getSnapshot().state, sb.getSnapshot().state]).toEqual(['paired', 'paired']);
    expect(sb.getSnapshot().error).toBeNull();
    expect(pcs.some((p) => p.closed)).toBe(false);
    expect(logs).toContain('scoreboard error the helper no longer knows this pairing; the open link is kept');
    const polls = h.polls;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.polls).toBe(polls);
    expect([cam.isOpen(), sb.isOpen()]).toEqual([true, true]);
    let got = '';
    cam.onMessage = (m) => (got = m.t);
    sb.send({ t: 'resync' });
    await vi.advanceTimersByTimeAsync(100);
    expect(got).toBe('resync');
  });

  it('a link that then goes down and needs the helper ends with "expired", as before', async () => {
    const { sb, h, a, b } = await openPair();
    h.forgot = true;
    await vi.advanceTimersByTimeAsync(20_000);
    a.mute = b.mute = true; // the path dies: the phones need the helper to reconnect
    await vi.advanceTimersByTimeAsync(DOWN_AFTER_MS + 5000);
    expect(sb.paired).toBe(false);
    expect(sb.getSnapshot().error).toEqual({ kind: 'expired' });
  });
});
