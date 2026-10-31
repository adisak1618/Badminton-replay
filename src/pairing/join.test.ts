// The scoreboard's PeerLink.join against the real helper handler: a room code is one-shot, so the code this
// pairing was claimed with is never claimed again. On iPhone the S2 viewfinder still sees the camera's QR after
// the code came from the launch link or was typed; its second claim failed with "code not found" and ended the
// pairing the first claim had made.
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore, createHandler } from '../../api/signal';
import { HelperClient } from './helper';
import { PeerLink } from './link';

const SDP = (tag: string) => `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=${tag}\r\na=candidate:1 1 udp 1 abc.local 5000 typ host\r\n`;

/** Just enough of an RTCPeerConnection for the scoreboard to answer an offer. */
class FakePc extends EventTarget {
  iceGatheringState = 'complete';
  connectionState = 'new';
  signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  async setRemoteDescription() {}
  async createAnswer() {
    return { type: 'answer' as const, sdp: SDP('answer') };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d;
  }
  close() {
    this.connectionState = 'closed';
  }
}

const links: PeerLink[] = [];

function setup() {
  const store = new MemoryStore();
  const handler = createHandler(() => store);
  const claims: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const m = /\/rooms\/(\d+)/.exec(url);
    if (m) claims.push(m[1]);
    return handler(new Request(`https://app.test${url}`, init));
  };
  const helper = new HelperClient('/api/signal', fetchImpl);
  const link = new PeerLink({
    role: 'scoreboard',
    helper,
    hello: () => ({ deviceId: 'sb', app: 'test@1' }),
    createPc: () => new FakePc() as unknown as RTCPeerConnection,
    saved: { load: () => null, save: () => {} },
  });
  links.push(link);
  return { helper, link, claims };
}

afterEach(() => {
  for (const l of links.splice(0)) l.unpair();
});

describe('scoreboard join', () => {
  it('the code it already claimed is not claimed again: one claim, the pairing stays', async () => {
    const { helper, link, claims } = setup();
    const room = await helper.createRoom(SDP('offer'));
    await link.join(room.code);
    expect(link.paired).toBe(true);
    await link.join(room.code); // the viewfinder reads the same QR
    expect(claims).toEqual([room.code]);
    expect(link.paired).toBe(true);
    expect(link.getSnapshot().error).toBeNull();
  });

  it('nor while that claim is still in flight', async () => {
    const { helper, link, claims } = setup();
    const room = await helper.createRoom(SDP('offer'));
    await Promise.all([link.join(room.code), link.join(room.code)]);
    expect(claims).toEqual([room.code]);
    expect(link.paired).toBe(true);
    expect(link.getSnapshot().error).toBeNull();
  });

  it('a code that failed can be tried again, and a new code starts a new pairing', async () => {
    const { helper, link, claims } = setup();
    await link.join('000000');
    expect(link.getSnapshot().error?.kind).toBe('no-room');
    await link.join('000000');
    expect(claims).toEqual(['000000', '000000']);
    const room = await helper.createRoom(SDP('offer'));
    await link.join(room.code);
    expect(link.paired).toBe(true);
    expect(link.getSnapshot().error).toBeNull();
  });

  it('a claim whose reply came after the page gave up (4 s): the page asks again with the same claim and pairs', async () => {
    // Real timers: the page's limit is AbortSignal.timeout. The helper takes 5 s to answer the first claim, and
    // completes it (the code is used) after the page has given up on it (2026-10-31 audit, BUG-5).
    const store = new MemoryStore();
    const handler = createHandler(() => store);
    let slow = 1;
    const claims: string[] = [];
    const helper = new HelperClient('/api/signal', async (url, init) => {
      if (/\/rooms\/\d+/.test(url)) claims.push(url);
      if (!slow || !/\/rooms\/\d+/.test(url)) return handler(new Request(`https://app.test${url}`, init));
      slow--;
      const { signal, ...rest } = init ?? {};
      const work = new Promise<void>((r) => setTimeout(r, 5000)).then(() => handler(new Request(`https://app.test${url}`, rest)));
      return new Promise<Response>((res, rej) => {
        signal?.addEventListener('abort', () => rej(signal.reason));
        work.then(res, rej);
      });
    });
    const room = await helper.createRoom(SDP('offer'));
    const link = new PeerLink({
      role: 'scoreboard',
      helper,
      hello: () => ({ deviceId: 'sb', app: 'test@1' }),
      createPc: () => new FakePc() as unknown as RTCPeerConnection,
      saved: { load: () => null, save: () => {} },
    });
    links.push(link);
    await link.join(room.code);
    // The retry went out at once with the same claim, before the helper had finished the first: one more try.
    if (!link.paired) {
      await new Promise((r) => setTimeout(r, 1500));
      await link.join(room.code);
    }
    expect(link.paired).toBe(true);
    expect(link.getSnapshot().error).toBeNull();
    expect(new Set(claims.map((u) => new URL(u, 'https://x').searchParams.get('claim'))).size).toBe(1);
  }, 20_000);
});
