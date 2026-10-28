// The ICE servers a phone uses (STUN plus one TURN URL per transport, none without credentials), the path the
// link ended up on, the reasons the relay could not carry it, and the link fetching and renewing credentials:
// the camera's code carries relay candidates, new connections and ICE restarts get new credentials when the
// old ones run out, and a relayed link restarts ICE before they expire.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore, createHandler, type TurnServer } from '../../api/signal';
import { slowConnectText, SLOW_CONNECT_TEXT, SLOW_RELAY_TEXT } from '../ui/pairText';
import { encode } from '../protocol/messages';
import { HelperClient, type Desc, type IceReply, type Session } from './helper';
import {
  ICE_REFRESH_BEFORE_MS,
  STUN_URLS,
  assembleIceServers,
  describeIceServers,
  pathOf,
  pickTurnUrls,
  relayAddresses,
  relayLine,
  relayReason,
  selectedPath,
} from './ice';
import { PeerLink } from './link';
import { netCheck } from './net';

const CF_URLS = [
  'turn:turn.cloudflare.com:3478?transport=udp',
  'turn:turn.cloudflare.com:53?transport=udp',
  'turn:turn.cloudflare.com:3478?transport=tcp',
  'turn:turn.cloudflare.com:80?transport=tcp',
  'turns:turn.cloudflare.com:5349?transport=tcp',
  'turns:turn.cloudflare.com:443?transport=tcp',
];
const TURN: TurnServer[] = [{ urls: CF_URLS, username: 'user-1', credential: 'cred-1' }];

describe('ICE server assembly', () => {
  it('no TURN credentials: no servers at all, the local-network-only link as before', () => {
    expect(assembleIceServers(null)).toEqual([]);
    expect(assembleIceServers([])).toEqual([]);
    expect(assembleIceServers([{ urls: ['stun:stun.cloudflare.com:3478'], username: 'u', credential: 'c' }])).toEqual([]);
  });

  it('STUN (Cloudflare and a fallback), then TURN over UDP, TCP and TLS on 443, never port 53', () => {
    expect(pickTurnUrls(CF_URLS)).toEqual([
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turn:turn.cloudflare.com:3478?transport=tcp',
      'turns:turn.cloudflare.com:443?transport=tcp',
    ]);
    expect(STUN_URLS).toEqual(['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302']);
    expect(assembleIceServers(TURN)).toEqual([
      { urls: STUN_URLS },
      { urls: pickTurnUrls(CF_URLS), username: 'user-1', credential: 'cred-1' },
    ]);
  });

  it('takes what there is: other ports, default ports, a coturn on the Mac, a TCP-only list', () => {
    expect(pickTurnUrls(['turn:127.0.0.1?transport=udp', 'turns:relay.example:5349'])).toEqual(['turn:127.0.0.1?transport=udp', 'turns:relay.example:5349']);
    expect(pickTurnUrls(['turn:[2001:db8::1]:3478'])).toEqual(['turn:[2001:db8::1]:3478']);
    expect(pickTurnUrls(['turn:t.example:80?transport=tcp', 'turn:t.example:53?transport=udp'])).toEqual(['turn:t.example:80?transport=tcp']);
    expect(pickTurnUrls(['stun:t.example:3478', 'https://t.example'])).toEqual([]);
  });

  it('the diagnostics name the servers but never the username or the credential', () => {
    const line = describeIceServers(assembleIceServers(TURN));
    expect(line).toContain('stun:stun.cloudflare.com:3478');
    expect(line).toContain('turns:turn.cloudflare.com:443?transport=tcp');
    expect(line).not.toMatch(/user-1|cred-1/);
    expect(describeIceServers([])).toBe('none (local network only)');
    const ready = relayLine({ state: 'ready', expiresAt: Date.UTC(2026, 9, 28, 14, 3, 12) }, assembleIceServers(TURN));
    expect(ready.startsWith('ready until 14:03:12 UTC · stun:')).toBe(true);
    expect(ready).not.toMatch(/user-1|cred-1/);
    expect(relayLine({ state: 'not-configured' }).split(' · ')[0]).toBe('not configured');
    expect(relayLine({ state: 'failed', detail: 'helper: relay-failed: auth' }).split(' · ')[0]).toBe('failed (helper: relay-failed: auth)');
  });
});

describe('the path the link is on', () => {
  it('relay when either end is a relay candidate, else direct', () => {
    expect(pathOf({ candidateType: 'host', protocol: 'udp' }, { candidateType: 'host' })).toEqual({ type: 'direct', detail: 'this phone host/udp ↔ other phone host' });
    expect(pathOf({ candidateType: 'srflx', protocol: 'udp' }, { candidateType: 'srflx' }).type).toBe('direct');
    expect(pathOf({ candidateType: 'relay', relayProtocol: 'tls', protocol: 'udp' }, { candidateType: 'host' })).toEqual({
      type: 'relay',
      detail: 'this phone relay/tls ↔ other phone host',
    });
    expect(pathOf({ candidateType: 'host' }, { candidateType: 'relay' }).type).toBe('relay');
  });

  it('a peer-reflexive address that is one of the other phone’s relay candidates is the relay', () => {
    const sdp = 'v=0\r\na=candidate:1 1 udp 2113937151 10.1.2.3 50000 typ host\r\na=candidate:2 1 udp 16777215 203.0.113.9 61000 typ relay raddr 0.0.0.0 rport 0\r\n';
    expect(relayAddresses(sdp)).toEqual(['203.0.113.9 61000']);
    expect(pathOf({ candidateType: 'host' }, { candidateType: 'prflx', address: '203.0.113.9', port: 61000 }, relayAddresses(sdp)).type).toBe('relay');
    expect(pathOf({ candidateType: 'host' }, { candidateType: 'prflx', address: '198.51.100.1', port: 1 }, relayAddresses(sdp)).type).toBe('direct');
  });

  it('reads the selected pair from getStats, through the transport or a nominated pair', async () => {
    const stats = (list: object[]) => ({ getStats: async () => new Map(list.map((s: any) => [s.id, s])) }) as unknown as RTCPeerConnection;
    const l = { id: 'L', type: 'local-candidate', candidateType: 'relay', relayProtocol: 'udp' };
    const r = { id: 'R', type: 'remote-candidate', candidateType: 'srflx' };
    const p = { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', nominated: true, state: 'succeeded' };
    expect(await selectedPath(stats([l, r, p, { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }]))).toEqual({
      type: 'relay',
      detail: 'this phone relay/udp ↔ other phone srflx',
    });
    expect((await selectedPath(stats([l, r, p])))?.type).toBe('relay');
    expect(await selectedPath(stats([l, r, { ...p, state: 'in-progress' }]))).toBeNull();
    expect(await selectedPath({} as RTCPeerConnection)).toBeNull();
  });
});

describe('why the relay did not carry the link', () => {
  const A = 'v=0\r\na=candidate:1 1 udp 2113937151 10.195.144.160 50000 typ host\r\n';
  const B = 'v=0\r\na=candidate:1 1 udp 2113937151 10.131.171.124 50000 typ host\r\n';
  const relayed = (sdp: string) => `${sdp}a=candidate:2 1 udp 16777215 203.0.113.9 61000 typ relay raddr 0.0.0.0 rport 0\r\n`;

  it('a reason for every relay state, and for relay candidates that never connected', () => {
    expect(relayReason({ state: 'not-configured' }, netCheck(B, A))).toBe('the internet relay is not set up');
    expect(relayReason({ state: 'failed', detail: 'offline' }, netCheck(B, A))).toBe('the internet relay could not be used (offline)');
    expect(relayReason({ state: 'unknown' }, netCheck(B, A))).toBe('the internet relay was not tried');
    expect(relayReason({ state: 'ready' }, netCheck(B, relayed(A)))).toBe('this phone could not reach the relay server');
    expect(relayReason({ state: 'ready' }, netCheck(relayed(B), A))).toBe('the other phone could not use the relay');
    expect(relayReason({ state: 'ready' }, netCheck(relayed(B), relayed(A)))).toBe('the relay did not connect');
  });

  it('the different-networks line carries the reason; with a working relay the plain line does not demand one Wi-Fi', () => {
    const text = slowConnectText(netCheck(B, A), { state: 'not-configured' });
    expect(text).toContain('different networks (this phone 10.131.171.124, the other 10.195.144.160), probably mobile data, and the internet relay is not set up.');
    expect(slowConnectText(netCheck(relayed(B), relayed(A)), { state: 'ready' })).toContain('and the relay did not connect.');
    expect(slowConnectText(null, { state: 'ready' })).toBe(SLOW_RELAY_TEXT);
    expect(slowConnectText(null, { state: 'not-configured' })).toBe(SLOW_CONNECT_TEXT);
  });
});

// ---- the link fetching and renewing credentials ----

const HOST = 'v=0\r\na=candidate:1 1 udp 2113937151 192.168.1.20 5000 typ host\r\n';
const WITH_RELAY = `${HOST}a=candidate:2 1 udp 16777215 203.0.113.9 61000 typ relay raddr 0.0.0.0 rport 0\r\n`;

/** The other phone behind it answers every ping, so the link stays up as long as the test runs. */
class FakeDc extends EventTarget {
  readyState = 'open';
  send(data: string) {
    const m = JSON.parse(data);
    if (m.t !== 'ping') return;
    const pong = encode({ t: 'pong', id: m.id, t0: m.t0, t1: Date.now(), t2: Date.now() });
    queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('message'), { data: pong })));
  }
}

/** Records the configuration it was made with and changed to; offers with relay candidates when it has TURN. */
class FakePc extends EventTarget {
  static all: FakePc[] = [];
  iceGatheringState = 'complete';
  connectionState = 'new';
  signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  configs: RTCConfiguration[];
  constructor(config: RTCConfiguration) {
    super();
    this.configs = [config];
    FakePc.all.push(this);
  }
  private sdp() {
    return this.configs.at(-1)!.iceServers?.length ? WITH_RELAY : HOST;
  }
  getConfiguration() {
    return this.configs.at(-1)!;
  }
  setConfiguration(c: RTCConfiguration) {
    this.configs.push(c);
  }
  createDataChannel() {
    return new FakeDc();
  }
  async createOffer() {
    return { type: 'offer' as const, sdp: this.sdp() };
  }
  async createAnswer() {
    return { type: 'answer' as const, sdp: this.sdp() };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d;
  }
  async setRemoteDescription() {}
  close() {
    this.connectionState = 'closed';
  }
}

const links: PeerLink[] = [];
afterEach(() => {
  for (const l of links.splice(0)) l.unpair();
  FakePc.all = [];
  vi.useRealTimers();
});

const turnOf = (c: RTCConfiguration) => (c.iceServers ?? []).find((s) => s.username)?.username ?? null;

describe('the link and its relay credentials', () => {
  it('the camera’s code carries relay candidates: a second offer with TURN replaces the local-network one', async () => {
    const store = new MemoryStore();
    const minted: string[] = [];
    const handler = createHandler(() => store, {
      turn: () => ({ keyId: 'k', token: 't', api: 'https://cf.test' }),
      fetch: async () => {
        minted.push('x');
        return new Response(JSON.stringify({ iceServers: [{ urls: CF_URLS, username: `user-${minted.length}`, credential: 'c' }] }), { status: 201 });
      },
    });
    const helper = new HelperClient('/api/signal', async (url, init) => handler(new Request(`https://app.test${url}`, init)));
    const logged: string[] = [];
    const cam = new PeerLink({
      role: 'camera',
      helper,
      hello: () => ({ deviceId: 'cam', app: 'test@1' }),
      createPc: (c) => new FakePc(c) as unknown as RTCPeerConnection,
      saved: { load: () => null, save: () => {} },
      log: (k, t) => logged.push(`${k} ${t}`),
    });
    links.push(cam);
    await cam.pair();
    const snap = cam.getSnapshot();
    expect(snap.room?.code).toMatch(/^\d{6}$/);
    expect(snap.relay.state).toBe('ready');
    expect(FakePc.all.map((p) => turnOf(p.configs[0]))).toEqual([null, 'user-1']);
    const claimed = await helper.claimRoom(snap.room!.code);
    expect(claimed.offer).toMatchObject({ gen: 2, fresh: true, sdp: WITH_RELAY });
    expect(logged.some((l) => l.startsWith('relay ready until ') && l.includes('turns:turn.cloudflare.com:443?transport=tcp') && !l.includes('user-1'))).toBe(true);
  });

  it('without a TURN key the code is shown with the first offer, as before, and the log says not configured', async () => {
    const store = new MemoryStore();
    const handler = createHandler(() => store);
    const helper = new HelperClient('/api/signal', async (url, init) => handler(new Request(`https://app.test${url}`, init)));
    const logged: string[] = [];
    const cam = new PeerLink({
      role: 'camera',
      helper,
      hello: () => ({ deviceId: 'cam', app: 'test@1' }),
      createPc: (c) => new FakePc(c) as unknown as RTCPeerConnection,
      saved: { load: () => null, save: () => {} },
      log: (k, t) => logged.push(`${k} ${t}`),
    });
    links.push(cam);
    await cam.pair();
    expect(FakePc.all).toHaveLength(1);
    expect(FakePc.all[0].configs[0]).toEqual({ iceServers: [] });
    expect(cam.getSnapshot().relay).toEqual({ state: 'not-configured' });
    expect((await helper.claimRoom(cam.getSnapshot().room!.code)).offer.gen).toBe(1);
    expect(logged).toContain('relay not configured · no TURN key on the helper, local network only');
  });

  it('the scoreboard renews expired credentials for a new connection and for an ICE restart', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    let n = 0;
    let offer: Desc | null = { gen: 1, sdp: WITH_RELAY, fresh: true };
    const helper = {
      getIce: async (): Promise<IceReply> => ({ relay: 'ok', iceServers: [{ urls: CF_URLS, username: `user-${++n}`, credential: 'c' }], ttl: 3600 }),
      getOffer: async (_s: Session, gen: number) => (offer && offer.gen > gen ? offer : null),
      postAnswer: async () => {},
    } as unknown as HelperClient;
    const sb = new PeerLink({
      role: 'scoreboard',
      helper,
      hello: () => ({ deviceId: 'sb', app: 'test@1' }),
      createPc: (c) => new FakePc(c) as unknown as RTCPeerConnection,
      saved: { load: () => ({ session: 's'.repeat(32), secret: 'x'.repeat(32), gen: 0, at: Date.now() }), save: () => {} },
    });
    links.push(sb);
    sb.rejoin();
    await vi.advanceTimersByTimeAsync(300);
    expect(FakePc.all.map((p) => turnOf(p.configs[0]))).toEqual(['user-1']);
    const dc = new FakeDc();
    FakePc.all[0].dispatchEvent(Object.assign(new Event('datachannel'), { channel: dc }));
    dc.dispatchEvent(new Event('open'));
    dc.dispatchEvent(Object.assign(new Event('message'), { data: encode({ t: 'hello', role: 'camera', deviceId: 'cam', app: 'test@1' }) }));
    expect(sb.isOpen()).toBe(true);

    // 45 minutes on, the camera restarts ICE: the scoreboard's credentials have under 20 minutes left.
    await vi.advanceTimersByTimeAsync(45 * 60_000);
    offer = { gen: 2, sdp: WITH_RELAY, fresh: false };
    await vi.advanceTimersByTimeAsync(16_000);
    expect(FakePc.all).toHaveLength(1);
    expect(FakePc.all[0].configs.map(turnOf)).toEqual(['user-1', 'user-2']);

    // A new connection with credentials still fresh reuses them.
    offer = { gen: 3, sdp: WITH_RELAY, fresh: true };
    await vi.advanceTimersByTimeAsync(16_000);
    expect(FakePc.all.map((p) => turnOf(p.configs[0]))).toEqual(['user-1', 'user-2']);
    expect(n).toBe(2);
  });

  it('the camera restarts ICE on a relayed link before its credentials expire', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    let n = 0;
    const offers: Desc[] = [];
    const helper = {
      getIce: async (): Promise<IceReply> => ({ relay: 'ok', iceServers: [{ urls: CF_URLS, username: `user-${++n}`, credential: 'c' }], ttl: 3600 }),
      postOffer: async (_s: Session, d: Desc) => void offers.push(d),
      getAnswer: async () => null,
    } as unknown as HelperClient;
    const logged: string[] = [];
    const cam = new PeerLink({
      role: 'camera',
      helper,
      hello: () => ({ deviceId: 'cam', app: 'test@1' }),
      createPc: (c) => {
        const pc = new FakePc(c);
        // The selected pair: this phone's relay candidate.
        (pc as any).getStats = async () =>
          new Map<string, object>([
            ['L', { id: 'L', type: 'local-candidate', candidateType: 'relay', relayProtocol: 'udp' }],
            ['R', { id: 'R', type: 'remote-candidate', candidateType: 'host' }],
            ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R' }],
            ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }],
          ]);
        return pc as unknown as RTCPeerConnection;
      },
      saved: { load: () => ({ session: 's'.repeat(32), secret: 'x'.repeat(32), gen: 1, at: Date.now() }), save: () => {} },
      log: (k, t) => logged.push(`${k} ${t}`),
    });
    links.push(cam);
    cam.rejoin();
    await vi.advanceTimersByTimeAsync(300); // a fresh offer, gen 2
    expect(offers.map((o) => [o.gen, o.fresh])).toEqual([[2, true]]);
    (cam as any).attempt.answeredAt = Date.now(); // the answer arrived
    const dc = (cam as any).dc as FakeDc;
    dc.dispatchEvent(new Event('open'));
    dc.dispatchEvent(Object.assign(new Event('message'), { data: encode({ t: 'hello', role: 'scoreboard', deviceId: 'sb', app: 'test@1' }) }));
    await vi.advanceTimersByTimeAsync(300);
    expect(cam.getSnapshot().path).toBe('relay');
    expect(logged).toContain('path relay: this phone relay/udp ↔ other phone host');

    await vi.advanceTimersByTimeAsync(3600_000 - ICE_REFRESH_BEFORE_MS - 60_000);
    expect(offers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(offers.map((o) => [o.gen, o.fresh])).toEqual([
      [2, true],
      [3, false],
    ]);
    expect(FakePc.all).toHaveLength(1);
    expect(FakePc.all[0].configs.map(turnOf)).toEqual(['user-1', 'user-2']);
    expect(logged).toContain('relay credentials expire soon · ICE restart with new ones');
  });
});
