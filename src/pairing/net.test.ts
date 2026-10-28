// The network check and ICE gathering, on the descriptions the phones really sent on 2026-10-28 (read back from
// the helper): two iPhones on mobile data never connected and the screens only said "connecting"; restart
// offers and answers went out with no candidate at all.
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore, createHandler } from '../../api/signal';
import { slowConnectText, SLOW_CONNECT_TEXT } from '../ui/pairText';
import { HelperClient } from './helper';
import { gathered, hasCandidates, PeerLink } from './link';
import { candidatesOf, describeCandidates, netCheck, netVerdict } from './net';

const sdp = (...candidates: string[]) =>
  ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', ...candidates, ''].join('\r\n');
const webkit = (ip: string) => `a=candidate:3863767257 1 udp 2113937151 ${ip} 63383 typ host generation 0 network-cost 999`;
const CAMERA = sdp(webkit('10.195.144.160')); // iPhone, iOS 26.6.1, all day
const SCOREBOARD = sdp(webkit('10.131.171.124')); // iPhone, iOS 27.2, 13:03-13:16 UTC
const MAC = sdp(
  'a=candidate:1215717930 1 udp 2122260223 172.20.10.12 62669 typ host generation 0 network-id 1 network-cost 10',
  'a=candidate:1117122153 1 udp 2122129151 100.100.209.126 58528 typ host generation 0 network-id 2 network-cost 50',
  'a=candidate:1886431412 1 udp 2122199807 fd7a:115c:a1e0::ad34:d17f 61240 typ host generation 0 network-id 3 network-cost 50',
  'a=candidate:3067918014 1 tcp 1518280447 172.20.10.12 9 typ host tcptype active generation 0 network-id 1 network-cost 10',
);
const MDNS = sdp('a=candidate:2348311497 1 udp 2113937151 dc91c8f8-38b1-4c1f-a3c2-eee850042104.local 49774 typ host generation 0 network-cost 999');
const RESTART_SENT = sdp(); // offer-169c3e gen 2, offer-b39230 gen 2, answer-b39230 gen 2

describe('candidates of a description', () => {
  it('reads plain addresses once each, and counts mDNS names', () => {
    expect(candidatesOf(MAC).ips).toEqual(['172.20.10.12', '100.100.209.126', 'fd7a:115c:a1e0::ad34:d17f']);
    expect(candidatesOf(MDNS)).toEqual({ ips: [], mdns: 1, srflx: 0, relay: 0 });
    expect(describeCandidates(candidatesOf(CAMERA))).toBe('10.195.144.160');
    expect(describeCandidates(candidatesOf(MDNS))).toBe('1 mDNS');
    expect(describeCandidates(candidatesOf(RESTART_SENT))).toBe('none');
  });
});

describe('network check', () => {
  it('the two iPhones of 2026-10-28 were on different networks', () => {
    expect(netCheck(SCOREBOARD, CAMERA)).toEqual({ mine: ['10.131.171.124'], theirs: ['10.195.144.160'], verdict: 'different' });
    expect(netVerdict(['10.160.74.63'], ['10.195.144.160'])).toBe('different'); // the same phones, 12:33 UTC
  });

  it('a phone on the other one’s Personal Hotspot can connect: the host shows its carrier address', () => {
    expect(netCheck(MAC, CAMERA)?.verdict).toBe('hotspot');
  });

  it('one Wi-Fi network: same', () => {
    expect(netVerdict(['192.168.1.109', '192.168.1.112'], ['192.168.1.23'])).toBe('same');
    expect(netVerdict(['172.20.10.2'], ['172.20.10.3'])).toBe('same');
  });

  it('mDNS only, or nothing yet: unknown, never "different"', () => {
    expect(netCheck(MDNS, CAMERA)?.verdict).toBe('unknown');
    expect(netCheck(RESTART_SENT, CAMERA)?.verdict).toBe('unknown');
    expect(netCheck(null, CAMERA)).toBeNull();
  });

  it('the slow-connect text names both addresses when the networks differ', () => {
    const text = slowConnectText(netCheck(SCOREBOARD, CAMERA));
    expect(text).toContain('different networks (this phone 10.131.171.124, the other 10.195.144.160)');
    expect(text).toContain('Personal Hotspot');
    expect(slowConnectText(netCheck(MAC, CAMERA))).toBe(SLOW_CONNECT_TEXT);
    expect(slowConnectText(null)).toBe(SLOW_CONNECT_TEXT);
  });
});

/** An RTCPeerConnection after setLocalDescription of an ICE restart: still `complete` from the last round. */
class RestartingPc extends EventTarget {
  iceGatheringState: RTCIceGatheringState = 'complete';
  localDescription = { type: 'offer', sdp: RESTART_SENT };
  /** The new round: gathering, then complete with a candidate. */
  finishRound(after: number) {
    setTimeout(() => {
      this.iceGatheringState = 'gathering';
      this.dispatchEvent(new Event('icegatheringstatechange'));
    }, after / 2);
    setTimeout(() => {
      this.localDescription = { type: 'offer', sdp: CAMERA };
      this.iceGatheringState = 'complete';
      this.dispatchEvent(new Event('icegatheringstatechange'));
    }, after);
  }
}

describe('gathering', () => {
  it('waits for the candidates of an ICE restart instead of sending its description empty', async () => {
    const pc = new RestartingPc();
    pc.finishRound(30);
    await gathered(pc as unknown as RTCPeerConnection, 1000);
    expect(hasCandidates(pc.localDescription.sdp)).toBe(true);
  });

  it('a first gathering already complete with candidates returns at once', async () => {
    const pc = new RestartingPc();
    pc.localDescription = { type: 'offer', sdp: CAMERA };
    const start = Date.now();
    await gathered(pc as unknown as RTCPeerConnection, 1000);
    expect(Date.now() - start).toBeLessThan(20);
  });

  it('a round that never yields a candidate still ends after the maximum', async () => {
    const pc = new RestartingPc();
    const start = Date.now();
    await gathered(pc as unknown as RTCPeerConnection, 60);
    expect(Date.now() - start).toBeGreaterThanOrEqual(55);
    expect(hasCandidates(pc.localDescription.sdp)).toBe(false);
  });
});

/** Answers with the scoreboard iPhone's address. */
class ScoreboardPc extends EventTarget {
  iceGatheringState = 'complete';
  connectionState = 'new';
  signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  async setRemoteDescription() {}
  async createAnswer() {
    return { type: 'answer' as const, sdp: SCOREBOARD };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d;
  }
  close() {
    this.connectionState = 'closed';
  }
}

const links: PeerLink[] = [];
afterEach(() => {
  for (const l of links.splice(0)) l.unpair();
});

describe('the scoreboard checks the network as soon as it has answered', () => {
  it('different networks are in the snapshot and in the log', async () => {
    const store = new MemoryStore();
    const handler = createHandler(() => store);
    const helper = new HelperClient('/api/signal', async (url, init) => handler(new Request(`https://app.test${url}`, init)));
    const logged: string[] = [];
    const link = new PeerLink({
      role: 'scoreboard',
      helper,
      hello: () => ({ deviceId: 'sb', app: 'test@1' }),
      createPc: () => new ScoreboardPc() as unknown as RTCPeerConnection,
      saved: { load: () => null, save: () => {} },
      log: (k, t) => logged.push(`${k} ${t}`),
    });
    links.push(link);
    const room = await helper.createRoom(CAMERA);
    await link.join(room.code);
    expect(link.getSnapshot().net).toEqual({ mine: ['10.131.171.124'], theirs: ['10.195.144.160'], verdict: 'different' });
    expect(logged).toContain('sdp got offer gen 1 new connection: 10.195.144.160');
    expect(logged.some((l) => l.startsWith('sdp sent answer gen 1 new connection: 10.131.171.124 (gathered in'))).toBe(true);
    expect(logged).toContain('net different (this phone 10.131.171.124, other 10.195.144.160)');
    link.unpair();
    expect(link.getSnapshot().net).toBeNull();
  });
});
