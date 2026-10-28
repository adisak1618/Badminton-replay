// A scoreboard whose link drops looks for the camera's new offer at once, not at its idle 15 s poll. In the
// e2e a camera reload took 16 s to rejoin instead of 2.6 s whenever the bye landed early in that interval.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encode } from '../protocol/messages';
import type { Desc, HelperClient, Session } from './helper';
import { PeerLink } from './link';
import { POLL_IDLE_MS } from './reconnect';

const SDP = 'v=0\r\na=candidate:1 1 udp 2113937151 192.168.1.20 5000 typ host\r\n';

class FakeDc extends EventTarget {
  readyState = 'open';
  send() {}
}

class FakePc extends EventTarget {
  iceGatheringState = 'complete';
  connectionState = 'new';
  signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  async setRemoteDescription() {}
  async createAnswer() {
    return { type: 'answer' as const, sdp: SDP };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d;
  }
  close() {
    this.connectionState = 'closed';
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('scoreboard polling', () => {
  it('a link that goes down polls the helper within one tick, not after the idle interval', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const polls: number[] = [];
    const pcs: FakePc[] = [];
    let offer: Desc | null = { gen: 1, sdp: SDP, fresh: true };
    const helper = {
      getOffer: async (_s: Session, gen: number) => {
        polls.push(Date.now());
        return offer && offer.gen > gen ? offer : null;
      },
      postAnswer: async () => {},
    } as unknown as HelperClient;
    const link = new PeerLink({
      role: 'scoreboard',
      helper,
      hello: () => ({ deviceId: 'sb', app: 'test@1' }),
      createPc: () => {
        const pc = new FakePc();
        pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
      saved: { load: () => ({ session: 's'.repeat(32), secret: 'x'.repeat(32), gen: 0, at: Date.now() }), save: () => {} },
    });
    expect(link.rejoin()).toBe(true);
    await vi.advanceTimersByTimeAsync(300); // first tick: poll, answer gen 1
    expect(pcs).toHaveLength(1);
    const dc = new FakeDc();
    const ev = Object.assign(new Event('datachannel'), { channel: dc });
    pcs[0].dispatchEvent(ev);
    dc.dispatchEvent(new Event('open'));
    const msg = (body: Parameters<typeof encode>[0]) => dc.dispatchEvent(Object.assign(new Event('message'), { data: encode(body) }));
    msg({ t: 'hello', role: 'camera', deviceId: 'cam', app: 'test@1' });
    expect(link.isOpen()).toBe(true);
    offer = null;
    await vi.advanceTimersByTimeAsync(1000); // the poll after the answer, then the idle interval starts
    const before = polls.length;
    msg({ t: 'bye', reason: 'leaving' }); // the camera reloads
    await vi.advanceTimersByTimeAsync(500);
    expect(polls.length).toBe(before + 1);
    expect(polls.at(-1)! - polls[before - 1]).toBeLessThan(POLL_IDLE_MS);
    link.unpair();
  });
});
