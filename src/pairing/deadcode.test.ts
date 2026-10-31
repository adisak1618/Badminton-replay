// A code whose camera page is gone or in the background (2026-10-31 audit, BUG-4): the claim succeeded, the
// scoreboard waited for ever, and after 15 s it said the phones were on different networks and the relay did not
// connect, which was false. Now a page that goes away withdraws its code (pagehide, or at its next launch when it
// was killed), a scoreboard whose answer the camera never fetched says the camera is not answering and waits
// for it, and a camera back after its code's renewal time looks for a waiting answer before showing a new code.
// PeerLinks against the real helper handler, with connections that gather at once and never connect.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore, createHandler } from '../../api/signal';
import { pairErrorText, CAMERA_SILENT_TEXT } from '../ui/pairText';
import { HelperClient, type Session } from './helper';
import { PeerLink } from './link';
import { PAIR_GIVE_UP_MS, PEER_SILENT_MS } from './unreachable';

const SDP = 'v=0\r\na=candidate:1 1 udp 2113937151 10.195.183.85 50000 typ host\r\n';

class DeadPc extends EventTarget {
  iceGatheringState = 'complete';
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  createDataChannel() {
    return Object.assign(new EventTarget(), { readyState: 'connecting', bufferedAmount: 0, send() {}, close() {} });
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

function setup() {
  const store = new MemoryStore(() => Date.now());
  const handler = createHandler(() => store, { now: () => Date.now() });
  const calls: string[] = [];
  const helper = new HelperClient('/api/signal', async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url.replace(/[0-9a-f]{32}/, 'S')}`);
    return handler(new Request(`https://app.test${url}`, init));
  });
  return { helper, calls };
}

const links: PeerLink[] = [];
afterEach(() => {
  for (const l of links.splice(0)) l.unpair();
  vi.useRealTimers();
});

/** One camera page; `shown` is the localStorage of the phone, shared by its pages. */
function camera(helper: HelperClient, shown: { s: Session | null }, logs: string[] = []): PeerLink {
  const l = new PeerLink({
    role: 'camera',
    helper,
    hello: () => ({ deviceId: 'cam', app: 'test@1' }),
    createPc: () => new DeadPc() as unknown as RTCPeerConnection,
    saved: { load: () => null, save: () => {} },
    shown: { load: () => shown.s, save: (s) => (shown.s = s) },
    log: (k, t) => logs.push(`${k} ${t}`),
  });
  links.push(l);
  return l;
}

function scoreboard(helper: HelperClient, logs: string[] = []): PeerLink {
  const l = new PeerLink({
    role: 'scoreboard',
    helper,
    hello: () => ({ deviceId: 'sb', app: 'test@1' }),
    createPc: () => new DeadPc() as unknown as RTCPeerConnection,
    saved: { load: () => null, save: () => {} },
    log: (k, t) => logs.push(`${k} ${t}`),
  });
  links.push(l);
  return l;
}

const suspend = (l: PeerLink) => (l as unknown as { stopTimer(): void }).stopTimer();
const wake = (l: PeerLink) => {
  (l as unknown as { startTimer(): void }).startTimer();
  l.resume('visible');
};

describe('a code whose camera page is gone', () => {
  it('a camera page that goes away (pagehide) withdraws its code: typing it says so at once', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { helper } = setup();
    const cam = camera(helper, { s: null });
    await cam.pair();
    const code = cam.getSnapshot().room!.code;
    cam.leave();
    await vi.advanceTimersByTimeAsync(100);
    const sb = scoreboard(helper);
    await sb.join(code);
    expect(sb.getSnapshot().error?.kind).toBe('no-room');
  });

  it('a page killed with its code on show: the next launch withdraws it, and a scoreboard already waiting on it is told', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { helper } = setup();
    const phone = { s: null as Session | null };
    const old = camera(helper, phone);
    await old.pair();
    const code = old.getSnapshot().room!.code;
    suspend(old); // killed: no pagehide, no more ticks
    const sb = scoreboard(helper);
    await sb.join(code);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sb.getSnapshot().error).toBeNull(); // waiting on a page that is not there
    const relaunched = camera(helper, phone);
    expect(relaunched.rejoin()).toBe(false); // nothing to rejoin, but the left code is withdrawn
    await vi.advanceTimersByTimeAsync(3000); // the scoreboard's next look at the helper
    const err = sb.getSnapshot().error!;
    expect(err.kind).toBe('withdrawn');
    expect(pairErrorText(err, 'scoreboard')).toBe('The camera phone no longer offers this code (it showed a new one, or its pairing screen was closed). Type the code it shows now.');
    expect(phone.s).toBeNull();
  });

  it('a new code replaces the one on show and withdraws it', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { helper } = setup();
    const cam = camera(helper, { s: null });
    await cam.pair();
    const first = cam.getSnapshot().room!.code;
    await cam.pair();
    const sb = scoreboard(helper);
    await sb.join(first);
    expect(sb.getSnapshot().error?.kind).toBe('no-room');
  });
});

describe('a code whose camera page is in the background', () => {
  it('the scoreboard says the camera is not answering, never "different networks", and waits; it links up once the camera is back', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { helper } = setup();
    const sbLogs: string[] = [];
    const cam = camera(helper, { s: null });
    await cam.pair();
    const code = cam.getSnapshot().room!.code;
    suspend(cam); // the iPhone's screen locked, or the app switched away
    const sb = scoreboard(helper, sbLogs);
    await sb.join(code);
    await vi.advanceTimersByTimeAsync(PEER_SILENT_MS + 1000);
    expect(sb.getSnapshot().peerSilent).toBe(true);
    expect(CAMERA_SILENT_TEXT).toMatch(/^The camera phone is not answering/);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sb.getSnapshot().error).toBeNull(); // still waiting: the camera may come back
    expect(sb.paired).toBe(true);
    wake(cam);
    await vi.advanceTimersByTimeAsync(6000); // the camera fetches the answer; the scoreboard learns it at its next poll (every 5 s by now)
    expect(cam.getSnapshot().room).toBeNull(); // the answer was applied
    expect(sb.getSnapshot().peerSilent).toBe(false);
    expect(sbLogs.some((l) => l.includes('the camera answers again (it fetched the answer)'))).toBe(true);
    // From here the usual clock runs: these connections never connect, so both give up, from the camera's return.
    await vi.advanceTimersByTimeAsync(PAIR_GIVE_UP_MS + 3000);
    expect(sb.getSnapshot().error?.kind).toBe('unreachable');
  });

  it('a camera back after its code’s renewal time takes the waiting answer instead of showing a new code', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { helper, calls } = setup();
    const cam = camera(helper, { s: null });
    await cam.pair();
    const code = cam.getSnapshot().room!.code;
    suspend(cam);
    const sb = scoreboard(helper);
    await sb.join(code);
    await vi.advanceTimersByTimeAsync(10 * 60_000); // past ROOM_TTL_S - 20 s
    wake(cam);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.filter((c) => c.startsWith('POST /api/signal/rooms'))).toHaveLength(1); // no new code
    expect(cam.getSnapshot().room).toBeNull();
    expect(cam.paired).toBe(true);
    expect(sb.getSnapshot().error).toBeNull();
  });
});
