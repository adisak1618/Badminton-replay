// A first pairing that cannot open says why within PAIR_GIVE_UP_MS of its first answer and stops, and a phone
// speaking another protocol is refused before any connection. Production, 2026-10-30: the scoreboard (an old
// build with no relay, or one whose relay credentials failed) answered with mDNS candidates only, the camera
// offered a new connection every 12 s for ever, and both screens advised one Wi-Fi. Two PeerLinks against the
// real helper handler, with connections that gather at once and never connect.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore, createHandler, type TurnConfig } from '../../api/signal';
import { PROTOCOL_VERSION } from '../protocol/messages';
import { mismatchText, pairErrorText, unreachableText } from '../ui/pairText';
import { HelperClient } from './helper';
import { PeerLink } from './link';
import { netCheck } from './net';
import { PAIR_GIVE_UP_MS, unreachable } from './unreachable';

const RELAY_OFFER = [
  'v=0',
  'a=candidate:1 1 udp 2113937151 10.195.183.85 50000 typ host',
  'a=candidate:2 1 udp 41885439 104.30.1.1 61000 typ relay raddr 10.195.183.85 rport 50000',
  '',
].join('\r\n');
const RELAY_ANSWER = RELAY_OFFER.replace('10.195.183.85', '10.131.171.124').replace('104.30.1.1', '104.30.1.2');
const MDNS_ANSWER = ['v=0', 'a=candidate:1 1 udp 2113937151 3f0c9a3e-1c2d-4c1e-9d10-7d0b8f3a0c11.local 54000 typ host', ''].join('\r\n');

/** An RTCPeerConnection that gathers at once and never connects. */
class DeadPc extends EventTarget {
  iceGatheringState = 'complete';
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  constructor(readonly sdp: string) {
    super();
  }
  createDataChannel() {
    return Object.assign(new EventTarget(), { readyState: 'connecting', bufferedAmount: 0, send() {}, close() {} });
  }
  async createOffer() {
    this.signalingState = 'have-local-offer';
    return { type: 'offer' as const, sdp: this.sdp };
  }
  async createAnswer() {
    return { type: 'answer' as const, sdp: this.sdp };
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
  setConfiguration() {}
  close() {
    this.connectionState = 'closed';
  }
}

const TURN: TurnConfig = { keyId: 'k', token: 't', api: 'https://turn.test/v1/turn/keys' };
const turnApi = async () => new Response(JSON.stringify({ iceServers: [{ urls: ['turn:turn.test:3478?transport=udp'], username: 'u', credential: 'c' }] }), { status: 201 });

/** The helper; `iceFails` makes one phone's credential fetch answer 503, `rewrite` changes what one phone posts. */
function setup(o: { iceFails?: 'scoreboard'; rewrite?: { who: string; fn: (body: string) => string } } = {}) {
  const store = new MemoryStore(() => Date.now());
  const handler = createHandler(() => store, { now: () => Date.now(), turn: () => TURN, fetch: turnApi });
  const posted: Array<{ who: string; url: string; body: Record<string, unknown> }> = [];
  const client = (who: string) =>
    new HelperClient('/api/signal', async (url, init) => {
      if (o.iceFails === who && /\/ice$/.test(url)) return new Response(JSON.stringify({ error: 'store' }), { status: 503 });
      let body = typeof init?.body === 'string' ? init.body : undefined;
      if (body && o.rewrite?.who === who) body = o.rewrite.fn(body);
      if (body) posted.push({ who, url, body: JSON.parse(body) });
      return handler(new Request(`https://app.test${url}`, { ...init, body }));
    });
  return { store, client, posted };
}

const links: PeerLink[] = [];
afterEach(() => {
  for (const l of links.splice(0)) l.unpair();
  vi.useRealTimers();
});

function link(role: 'camera' | 'scoreboard', helper: HelperClient, sdp: string, logs: string[] = [], app = 'badminton-scoreboard@test'): PeerLink {
  const l = new PeerLink({
    role,
    helper,
    hello: () => ({ deviceId: role, app }),
    createPc: () => new DeadPc(sdp) as unknown as RTCPeerConnection,
    saved: { load: () => null, save: () => {} },
    log: (k, x) => logs.push(`${k} ${x}`),
  });
  links.push(l);
  return l;
}

describe('a first pairing that cannot open says why and stops', () => {
  it('a scoreboard without relay (its credentials failed): both phones give up within about 20 s of Pair, each with its own reason', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { client, posted } = setup({ iceFails: 'scoreboard' });
    const camLogs: string[] = [];
    const cam = link('camera', client('camera'), RELAY_OFFER, camLogs);
    await cam.pair();
    const sb = link('scoreboard', client('scoreboard'), MDNS_ANSWER);
    const start = Date.now();
    await sb.join(cam.getSnapshot().room!.code);
    let failedAt = 0;
    for (let t = 0; t < 30_000 && !failedAt; t += 250) {
      await vi.advanceTimersByTimeAsync(250);
      if (cam.getSnapshot().error && sb.getSnapshot().error) failedAt = Date.now();
    }
    expect(failedAt - start).toBeGreaterThan(PAIR_GIVE_UP_MS - 1000);
    expect(failedAt - start).toBeLessThanOrEqual(PAIR_GIVE_UP_MS + 4000);
    const camErr = cam.getSnapshot().error!;
    const sbErr = sb.getSnapshot().error!;
    expect(camErr).toMatchObject({ kind: 'unreachable', why: { reason: 'no-relay-there', detail: 'helper: store', peerOld: false } });
    expect(sbErr).toMatchObject({ kind: 'unreachable', why: { reason: 'no-relay-here', detail: 'helper: store' } });
    expect(pairErrorText(camErr, 'camera')).toBe(
      'Could not connect: the scoreboard phone could not use the internet relay (helper: store). Check its internet connection, then pair again.',
    );
    expect(pairErrorText(sbErr, 'scoreboard')).toBe('Could not connect: this phone could not use the internet relay (helper: store). Check this phone\'s internet connection, then pair again.');
    // Nothing more is offered, and the session is ended so neither phone keeps trying.
    const offers = () => posted.filter((p) => p.url.endsWith('/offer')).length;
    const before = offers();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(offers()).toBe(before);
    expect(posted.some((p) => p.url.endsWith('/end') && p.body.reason === 'unreachable')).toBe(true);
    expect(cam.paired || sb.paired).toBe(false);
    expect(camLogs.some((l) => /^error could not connect \d+ s after the first answer: no-relay-there/.test(l))).toBe(true);
  });

  it('a scoreboard on a build from before 2026-10-31 says nothing about itself: the camera says it probably runs an older version', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    // What an old build posts: no app, no protocol, no relay state (and, before the relay existed, no relay candidate).
    const { client } = setup({ rewrite: { who: 'scoreboard', fn: (b) => JSON.stringify({ ...JSON.parse(b), app: undefined, v: undefined, relay: undefined }) } });
    const cam = link('camera', client('camera'), RELAY_OFFER);
    await cam.pair();
    const sb = link('scoreboard', client('scoreboard'), MDNS_ANSWER);
    await sb.join(cam.getSnapshot().room!.code);
    await vi.advanceTimersByTimeAsync(PAIR_GIVE_UP_MS + 4000);
    const err = cam.getSnapshot().error!;
    expect(err).toMatchObject({ kind: 'unreachable', why: { reason: 'no-relay-there', peerOld: true } });
    expect(pairErrorText(err, 'camera')).toContain('the scoreboard phone cannot use the internet relay; it probably runs an older version of the app.');
  });

  it('a credential fetch that fails once is tried again at once: the answer carries the relay', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    let fail = 1;
    const store = new MemoryStore(() => Date.now());
    const handler = createHandler(() => store, { now: () => Date.now(), turn: () => TURN, fetch: turnApi });
    const answers: Array<Record<string, unknown>> = [];
    const sbHelper = new HelperClient('/api/signal', async (url, init) => {
      if (/\/ice$/.test(url) && fail-- > 0) return new Response(JSON.stringify({ error: 'store' }), { status: 503 });
      if (/\/answer$/.test(url) && typeof init?.body === 'string') answers.push(JSON.parse(init.body));
      return handler(new Request(`https://app.test${url}`, init));
    });
    const camHelper = new HelperClient('/api/signal', async (url, init) => handler(new Request(`https://app.test${url}`, init)));
    const cam = link('camera', camHelper, RELAY_OFFER);
    await cam.pair();
    const sb = link('scoreboard', sbHelper, RELAY_ANSWER);
    await sb.join(cam.getSnapshot().room!.code);
    expect(answers[0]).toMatchObject({ relay: 'ready' });
    expect(sb.getSnapshot().relay.state).toBe('ready');
  });

  it('a pairing that opens later than the first attempt still opens: nothing gives up before PAIR_GIVE_UP_MS', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { client } = setup();
    const cam = link('camera', client('camera'), RELAY_OFFER);
    await cam.pair();
    const sb = link('scoreboard', client('scoreboard'), RELAY_ANSWER);
    await sb.join(cam.getSnapshot().room!.code);
    await vi.advanceTimersByTimeAsync(PAIR_GIVE_UP_MS - 3000);
    expect([cam.getSnapshot().error, sb.getSnapshot().error]).toEqual([null, null]);
    expect(cam.getSnapshot().state).toBe('connecting');
  });
});

describe('another protocol is refused before any connection (R-PAIR-7)', () => {
  it('a scoreboard claiming a newer camera’s code: told at once to update, posts no answer; the camera is told the other phone is older', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const newer = PROTOCOL_VERSION + 1;
    const { client, posted } = setup({ rewrite: { who: 'camera', fn: (b) => b.replace(`"v":${PROTOCOL_VERSION}`, `"v":${newer}`) } });
    const cam = link('camera', client('camera'), RELAY_OFFER, [], 'badminton-scoreboard@next');
    await cam.pair();
    const sb = link('scoreboard', client('scoreboard'), RELAY_ANSWER);
    await sb.join(cam.getSnapshot().room!.code);
    expect(sb.getSnapshot().mismatch).toEqual({ theirs: 'badminton-scoreboard@next', newer: 'other' });
    expect(posted.some((p) => p.who === 'scoreboard' && p.url.endsWith('/answer'))).toBe(false);
    expect(mismatchText(sb.getSnapshot().mismatch!)).toBe('This phone runs an older version of the app. Update it (Update now, or close the app fully and open it again), then pair again.');
    await vi.advanceTimersByTimeAsync(3000); // the camera's next look at the helper
    expect(cam.getSnapshot().mismatch).toEqual({ theirs: 'badminton-scoreboard@test', newer: 'this' });
    expect(mismatchText(cam.getSnapshot().mismatch!)).not.toMatch(/reload/);
  });

  it('a camera whose scoreboard answers in an older protocol refuses the answer and tells it', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const older = PROTOCOL_VERSION - 1;
    const { client } = setup({ rewrite: { who: 'scoreboard', fn: (b) => b.replace(`"v":${PROTOCOL_VERSION}`, `"v":${older}`) } });
    const cam = link('camera', client('camera'), RELAY_OFFER);
    await cam.pair();
    const sb = link('scoreboard', client('scoreboard'), RELAY_ANSWER, [], 'badminton-scoreboard@old');
    await sb.join(cam.getSnapshot().room!.code);
    await vi.advanceTimersByTimeAsync(3000);
    expect(cam.getSnapshot().mismatch).toEqual({ theirs: 'badminton-scoreboard@old', newer: 'this' });
    await vi.advanceTimersByTimeAsync(3000);
    // Told through the helper (this test's scoreboard only posts the older number, so which is newer is moot here).
    expect(sb.getSnapshot().mismatch).toMatchObject({ theirs: 'badminton-scoreboard@test' });
  });

  it('a description that says nothing about its protocol (an older build) is not refused: the hello decides, as before', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { client } = setup({ rewrite: { who: 'camera', fn: (b) => JSON.stringify({ ...JSON.parse(b), app: undefined, v: undefined }) } });
    const cam = link('camera', client('camera'), RELAY_OFFER);
    await cam.pair();
    const sb = link('scoreboard', client('scoreboard'), RELAY_ANSWER);
    await sb.join(cam.getSnapshot().room!.code);
    expect(sb.getSnapshot().mismatch).toBeNull();
    expect(sb.paired).toBe(true);
  });
});

describe('why a pairing could not open', () => {
  const host = (ip: string) => `v=0\r\na=candidate:1 1 udp 2113937151 ${ip} 50000 typ host\r\n`;
  const relayed = (sdp: string) => `${sdp}a=candidate:2 1 udp 16777215 203.0.113.9 61000 typ relay raddr 0.0.0.0 rport 0\r\n`;
  const A = host('10.195.144.160');
  const B = host('10.131.171.124');

  it('a reason for each case, from this phone’s side', () => {
    expect(unreachable({ state: 'not-configured' }, netCheck(B, A), null).reason).toBe('no-relay');
    expect(unreachable({ state: 'failed', detail: 'offline' }, netCheck(B, relayed(A)), null)).toMatchObject({ reason: 'no-relay-here', detail: 'offline' });
    expect(unreachable({ state: 'ready' }, netCheck(B, relayed(A)), null)).toMatchObject({ reason: 'no-relay-here', detail: 'the relay server did not answer' });
    expect(unreachable({ state: 'ready' }, netCheck(relayed(B), A), { app: 'x', relay: 'failed: rate-limited' })).toMatchObject({ reason: 'no-relay-there', detail: 'rate-limited', peerOld: false });
    expect(unreachable({ state: 'ready' }, netCheck(relayed(B), A), null)).toMatchObject({ reason: 'no-relay-there', peerOld: true });
    expect(unreachable({ state: 'ready' }, netCheck(relayed(B), relayed(A)), { app: 'x' }).reason).toBe('relay-blocked');
    expect(unreachable({ state: 'ready' }, netCheck(host('192.168.1.20'), host('192.168.1.30')), { app: 'x' }).reason).toBe('same-network');
  });

  it('no line advises one Wi-Fi when the relay is the problem, and every line names what to do', () => {
    const u = unreachable({ state: 'ready' }, netCheck(relayed(B), A), null);
    expect(unreachableText(u, 'camera')).toBe(
      'Could not connect: the phones are on different networks (this phone 10.131.171.124, the other 10.195.144.160), probably mobile data, and the scoreboard phone cannot use the internet relay; it probably runs an older version of the app. On the scoreboard phone, close the app fully and open it again (tap Update now if it shows), then pair again.',
    );
    for (const reason of ['no-relay-here', 'no-relay-there'] as const)
      expect(unreachableText({ reason, peerOld: false, verdict: 'unknown', mine: [], theirs: [], detail: 'x' }, 'scoreboard')).not.toMatch(/Wi-Fi/);
  });
});
