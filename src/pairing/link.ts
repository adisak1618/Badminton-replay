// One phone's end of the paired link: an RTCPeerConnection with one ordered data channel, over the local
// network when the phones share one and through a TURN relay when they do not (ice.ts; D13), its descriptors
// and the relay credentials carried by the helper (D2), liveness pings both ways, the clock samples, the
// version check (R-PAIR-7) and automatic reconnect (R-PAIR-8). The camera offers, the scoreboard
// answers (technical-design.md §4.3). What the messages mean is the role's business (scoreboard.ts, peer.ts);
// this class only delivers them.
import { ClockSampler } from '../protocol/clock';
import { PROTOCOL_VERSION, encode, parse, type Msg, type Role } from '../protocol/messages';
import type { ClockEstimate, LinkState } from '../link/source';
import type { DiagKind } from './diag';
import { HelperError, type Desc, type HelperClient, type HelperErrorKind, type Session } from './helper';
import {
  GATHER_LAN_MS,
  GATHER_RELAY_MS,
  GATHER_SETTLE_MS,
  ICE_REFRESH_BEFORE_MS,
  RELAY_UNKNOWN,
  assembleIceServers,
  relayAddresses,
  relayLine,
  relayReason,
  selectedPath,
  type PathType,
  type RelayStatus,
} from './ice';
import { candidatesOf, describeCandidates, netCheck, type NetCheck } from './net';
import {
  PING_EVERY_MS,
  POLL_FAST_MS,
  chipState,
  nextAttempt,
  pollEvery,
  pongsMissed,
  type Attempt,
  type Down,
  type DownCause,
} from './reconnect';
import { loadPairing, savePairing, type SavedPairing } from './saved';

const TICK_MS = 250;
/** Not open this long after the answer: the pairing screens say why (pairText.ts) and the log records it. */
export const SLOW_CONNECT_MS = 15_000;
/** How often an open link reads which candidate pair carries it (it can change after an ICE restart). */
const PATH_EVERY_MS = 10_000;
/** After a failed credential fetch, and after "not configured", ask the helper again only this much later. */
const ICE_RETRY_FAILED_MS = 30_000;
const ICE_RETRY_UNCONFIGURED_MS = 10 * 60_000;
/** Renew the camera's code shortly before the helper forgets the room. */
const ROOM_RENEW_BEFORE_MS = 20_000;

export type PairErrorKind = HelperErrorKind | 'expired' | 'no-candidates' | 'failed';

export interface PairError {
  kind: PairErrorKind;
  detail?: string;
}

export interface Mismatch {
  /** The other phone's build id, when it said. */
  theirs: string | null;
  /** Which phone runs the newer protocol, when it can be told. */
  newer: 'this' | 'other' | null;
}

export interface LinkSnapshot {
  state: LinkState;
  /** Camera while pairing: the code to show and type. */
  room: { code: string; expiresAt: number } | null;
  /** True while a pairing step is running (gathering, talking to the helper). */
  busy: boolean;
  error: PairError | null;
  remote: { deviceId: string; app: string; ua?: string } | null;
  /** Another protocol version: the link stops (R-PAIR-7). */
  mismatch: Mismatch | null;
  /** Same protocol, another build: works, but worth updating. */
  otherBuild: string | null;
  /** The link has been open at least once in this pairing. */
  everOpened: boolean;
  /** Where this phone and the other one are, from the last descriptions each side sent (net.ts). */
  net: NetCheck | null;
  /** Whether this phone has TURN credentials (ice.ts). */
  relay: RelayStatus;
  /** Which candidate pair carries the open link: direct, relay, or none while it is not open. */
  path: PathType;
}

export type HelloFields = { deviceId: string; app: string; ua?: string; matchId?: string; lastSeq?: number };
type Body = Parameters<typeof encode>[0];

export interface PeerLinkDeps {
  role: Role;
  helper: HelperClient;
  hello: () => HelloFields;
  createPc?: (config: RTCConfiguration) => RTCPeerConnection;
  now?: () => number;
  /**
   * Before every ICE gathering: make sure this page holds capture permission, without which WebKit offers no
   * host candidates (§4.3). Returns a release, called once the link is open.
   */
  ensureCapture?: (why: 'pair' | 'reconnect') => Promise<(() => void) | void>;
  /** Persisted pairing; defaults to localStorage. */
  saved?: { load(): SavedPairing | null; save(p: SavedPairing | null): void };
  /** The pairing diagnostics log (diag.ts). */
  log?: (kind: DiagKind, text: string) => void;
}

const INITIAL: LinkSnapshot = {
  state: 'unpaired',
  room: null,
  busy: false,
  error: null,
  remote: null,
  mismatch: null,
  otherBuild: null,
  everOpened: false,
  net: null,
  relay: RELAY_UNKNOWN,
  path: 'none',
};

export function hasCandidates(sdp: string): boolean {
  return /^a=candidate:/m.test(sdp);
}

/**
 * Resolve when ICE gathering is complete, or after `max` ms with whatever was gathered (no trickle ICE). With
 * STUN/TURN servers the caller passes GATHER_RELAY_MS, and `settle`: once this round has a relay candidate,
 * resolve when no other candidate came for that long, instead of waiting for every server (a blocked
 * transport would hold the round up until `max`). A relay candidate on UDP is enough; without one the round
 * waits on for TCP or TLS.
 * Right after the description of an ICE restart the state still says `complete` from the last round while the
 * description has no candidate yet, so complete also needs a candidate: restart offers and answers went out
 * empty before (production, 2026-10-28) and the restart could not work.
 */
export function gathered(pc: RTCPeerConnection, max = GATHER_LAN_MS, settle?: number): Promise<void> {
  return new Promise((resolve) => {
    const ready = () => pc.iceGatheringState === 'complete' && hasCandidates(pc.localDescription?.sdp ?? '');
    if (ready()) return resolve();
    let relayed = false;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      clearTimeout(quiet);
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('icecandidate', candidate);
      resolve();
    };
    const check = () => ready() && done();
    const candidate = (e: Event) => {
      const c = (e as RTCPeerConnectionIceEvent).candidate;
      if (!c || settle == null) return;
      relayed ||= c.type === 'relay' || / typ relay /.test(c.candidate);
      if (!relayed) return;
      clearTimeout(quiet);
      quiet = setTimeout(done, settle);
    };
    const timer = setTimeout(done, max);
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', candidate);
  });
}

export class PeerLink {
  readonly role: Role;
  private readonly helper: HelperClient;
  private readonly helloFields: () => HelloFields;
  private readonly createPc: (config: RTCConfiguration) => RTCPeerConnection;
  private readonly now: () => number;
  private readonly ensureCapture: NonNullable<PeerLinkDeps['ensureCapture']>;
  private readonly saved: NonNullable<PeerLinkDeps['saved']>;
  private readonly log: NonNullable<PeerLinkDeps['log']>;

  private snap: LinkSnapshot = INITIAL;
  private listeners = new Set<() => void>();
  private session: Session | null = null;
  /** Scoreboard: the room code the current pairing was claimed with. */
  private joined: string | null = null;
  /** The last description this phone sent and the last one it received, for the network check. */
  private localSdp: string | null = null;
  private remoteSdp: string | null = null;
  private gen = 0;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private open = false;
  private down: Down | null = null;
  private attempt: Attempt | null = null;
  private offline = false;
  private busy = false;
  private retryAt = 0;
  private nextPollAt = 0;
  private lastPingAt = 0;
  private lastPongAt = 0;
  private pingId = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private releaseCapture: (() => void) | null = null;
  /** The ICE servers for this session (TURN credentials until expiresAt), and when to ask the helper again. */
  private ice: { servers: RTCIceServer[]; expiresAt: number } | null = null;
  private iceRetryAt = 0;
  /** The servers the current connection was configured with. */
  private pcServers: RTCIceServer[] = [];
  private lastPathAt = 0;
  private lastPathLine = '';
  /** The first answer since the link was last open, and whether its slow connect was logged (once). */
  private stuckSince: number | null = null;
  private slowLogged = false;
  /** Bumped by unpair/pair so work started for an older pairing drops its result. */
  private epoch = 0;
  readonly clock = new ClockSampler();

  /** A message for the role (event, sync, rec, cmd, ack). */
  onMessage: (m: Msg) => void = () => {};
  /** The link is (again) open: the remote hello has arrived. */
  onOpen: () => void = () => {};

  constructor(deps: PeerLinkDeps) {
    this.role = deps.role;
    this.helper = deps.helper;
    this.helloFields = deps.hello;
    this.createPc = deps.createPc ?? ((config) => new RTCPeerConnection(config));
    this.now = deps.now ?? Date.now;
    this.ensureCapture = deps.ensureCapture ?? (async () => {});
    this.saved = deps.saved ?? { load: () => loadPairing(deps.role), save: (p) => savePairing(deps.role, p) };
    this.log = deps.log ?? (() => {});
  }

  // ---- store plumbing for React ----
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): LinkSnapshot => this.snap;
  private set(patch: Partial<LinkSnapshot>): void {
    const next = { ...this.snap, ...patch };
    next.state = this.chip(next);
    if (Object.keys(next).every((k) => next[k as keyof LinkSnapshot] === this.snap[k as keyof LinkSnapshot])) return;
    this.snap = next;
    for (const fn of this.listeners) fn();
  }

  private chip(s: LinkSnapshot): LinkState {
    if (!this.session && !s.room) return this.busy ? 'connecting' : 'unpaired';
    if (this.open) return 'paired';
    if (!s.everOpened && !this.offline) return 'connecting';
    return chipState(this.now(), this.down ?? { since: this.now(), cause: 'closed' }, this.offline);
  }

  get paired(): boolean {
    return !!this.session;
  }

  isOpen(): boolean {
    return this.open && this.dc?.readyState === 'open';
  }

  /** The other phone's clock minus this one's, from this phone's own pings. */
  clockEstimate(): ClockEstimate | null {
    return this.clock.estimate();
  }

  send(body: Body): boolean {
    return this.sendRaw(encode(body));
  }

  /** Send an already encoded message (the parts of a `sync`). */
  sendRaw(data: string): boolean {
    const dc = this.dc;
    if (!dc || dc.readyState !== 'open') return false;
    try {
      dc.send(data);
      return true;
    } catch {
      return false;
    }
  }

  // ---- starting and ending a pairing ----

  /** Camera: open a room and show its code (C2). */
  async pair(): Promise<void> {
    if (this.role !== 'camera') throw new Error('only the camera opens a room');
    const epoch = this.reset();
    this.setBusy(true);
    this.set({ error: null, mismatch: null, room: null, net: null });
    try {
      this.holdCapture(await this.ensureCapture('pair'));
      const sdp = await this.makeOffer('fresh', 1);
      if (!hasCandidates(sdp)) throw new PairFailure('no-candidates');
      const r = await this.helper.createRoom(sdp);
      if (epoch !== this.epoch) return;
      this.session = { session: r.session, secret: r.secret };
      this.gen = 1;
      // The room needs a session before TURN credentials can be had; with them, a new offer carrying relay
      // candidates replaces the local-network one before the code is shown (the claim gets the latest offer).
      if ((await this.iceServers()).length) {
        if (epoch !== this.epoch) return;
        const relayed = await this.makeOffer('fresh', 2);
        await this.helper.postOffer(this.session, { gen: 2, sdp: relayed, fresh: true });
        if (epoch !== this.epoch) return;
        this.gen = 2;
      }
      this.persist();
      this.down = { since: this.now(), cause: 'closed' };
      this.attempt = { kind: 'fresh', gen: this.gen, startedAt: this.now(), answeredAt: null };
      this.nextPollAt = this.now() + POLL_FAST_MS;
      this.offline = false;
      this.set({ room: { code: r.code, expiresAt: this.now() + r.expiresIn * 1000 }, everOpened: false });
      this.log('link', `showing code ${r.code}`);
      this.startTimer();
    } catch (err) {
      if (epoch === this.epoch) this.fail(err);
    } finally {
      if (epoch === this.epoch) this.setBusy(false);
    }
  }

  /** Scoreboard: take the camera's room by its code and answer (S2). */
  async join(code: string): Promise<void> {
    if (this.role !== 'scoreboard') throw new Error('only the scoreboard joins a room');
    // A room code is one-shot: claiming it again can only fail, and starting over would end the pairing it made.
    if (code === this.joined && (this.busy || this.session)) return;
    const epoch = this.reset();
    this.joined = code;
    this.setBusy(true);
    this.set({ error: null, mismatch: null, net: null });
    this.log('link', `joining with code ${code}`);
    try {
      this.holdCapture(await this.ensureCapture('pair'));
      const r = await this.helper.claimRoom(code);
      if (epoch !== this.epoch) return;
      this.session = { session: r.session, secret: r.secret };
      this.gen = 0;
      this.down = { since: this.now(), cause: 'closed' };
      this.set({ everOpened: false });
      await this.answer(r.offer, true);
      this.startTimer();
    } catch (err) {
      if (epoch === this.epoch) {
        this.session = null;
        this.fail(err);
      }
    } finally {
      if (epoch === this.epoch) this.setBusy(false);
    }
  }

  /** Pick up the saved pairing after a reload, with no user action; false when there is none. */
  rejoin(): boolean {
    const p = this.saved.load();
    if (!p || this.session) return false;
    this.session = { session: p.session, secret: p.secret };
    this.gen = p.gen;
    this.down = { since: this.now(), cause: 'closed' };
    this.set({ everOpened: true, error: null });
    this.log('link', `rejoining the saved pairing (session ${p.session.slice(0, 6)}…, gen ${p.gen})`);
    this.startTimer();
    return true;
  }

  /** Forget the pairing on both phones. */
  unpair(): void {
    this.send({ t: 'bye', reason: 'unpaired' });
    this.reset();
    this.saved.save(null);
    this.set({ ...INITIAL });
  }

  /** The page is going away: tell the other phone so it reconnects at once instead of waiting for pongs. */
  leave(): void {
    this.send({ t: 'bye', reason: 'leaving' });
  }

  // ---- internals ----

  private reset(): number {
    this.stopTimer();
    this.closePc();
    this.session = null;
    this.gen = 0;
    this.open = false;
    this.down = null;
    this.attempt = null;
    this.offline = false;
    this.busy = false;
    this.retryAt = 0;
    this.localSdp = null;
    this.remoteSdp = null;
    this.ice = null;
    this.iceRetryAt = 0;
    this.stuckSince = null;
    this.slowLogged = false;
    this.releaseHeldCapture();
    this.set({ relay: RELAY_UNKNOWN, path: 'none' });
    return ++this.epoch;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.set({ busy });
  }

  private fail(err: unknown): void {
    const error: PairError =
      err instanceof PairFailure
        ? { kind: err.kind }
        : err instanceof HelperError
          ? { kind: err.kind, detail: err.message }
          : { kind: 'failed', detail: (err as Error)?.message ?? String(err) };
    if (err instanceof HelperError && err.kind === 'offline') this.offline = true;
    this.log('error', `${error.kind}${error.detail && error.detail !== error.kind ? ` (${error.detail})` : ''}`);
    this.closePc();
    this.releaseHeldCapture();
    this.set({ error, room: null });
  }

  private persist(): void {
    if (this.session) this.saved.save({ ...this.session, gen: this.gen, at: this.now() });
  }

  private holdCapture(release: (() => void) | void): void {
    this.releaseHeldCapture();
    if (release) this.releaseCapture = release;
  }

  private releaseHeldCapture(): void {
    const r = this.releaseCapture;
    this.releaseCapture = null;
    r?.();
  }

  private startTimer(): void {
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private closePc(): void {
    if (this.open && this.session) this.down = { since: this.now(), cause: 'closed' };
    const pc = this.pc;
    this.pc = null;
    this.dc = null;
    this.open = false;
    if (this.snap.path !== 'none') this.set({ path: 'none' });
    try {
      pc?.close();
    } catch {
      // already closed
    }
  }

  private newPc(servers: RTCIceServer[]): RTCPeerConnection {
    this.closePc();
    const pc = this.createPc({ iceServers: servers });
    this.pc = pc;
    this.pcServers = servers;
    pc.addEventListener('iceconnectionstatechange', () => {
      if (this.pc !== pc) return;
      this.log('ice', `ice ${pc.iceConnectionState}`);
      if (this.open && (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')) void this.checkPath();
    });
    pc.addEventListener('icegatheringstatechange', () => this.pc === pc && this.log('sdp', `gathering ${pc.iceGatheringState}`));
    pc.addEventListener('connectionstatechange', () => {
      if (this.pc !== pc) return;
      this.log('ice', `connection ${pc.connectionState}`);
      if (pc.connectionState === 'failed') this.goDown('ice-failed');
      else if (pc.connectionState === 'closed') this.goDown('closed');
    });
    if (this.role === 'camera') this.attachDc(pc, pc.createDataChannel('match', { ordered: true }));
    else pc.addEventListener('datachannel', (e) => this.pc === pc && this.attachDc(pc, e.channel));
    return pc;
  }

  private attachDc(pc: RTCPeerConnection, dc: RTCDataChannel): void {
    this.dc = dc;
    const mine = () => this.pc === pc && this.dc === dc;
    dc.addEventListener('open', () => {
      if (!mine()) return;
      this.log('link', 'channel open');
      this.lastPongAt = this.now();
      this.sendHello();
      this.ping();
    });
    dc.addEventListener('close', () => {
      if (!mine()) return;
      this.log('link', 'channel closed');
      this.goDown('closed');
    });
    dc.addEventListener('message', (e) => mine() && this.receive(e.data));
  }

  /** Camera: a local offer on a new connection ('fresh') or an ICE restart of the current one. */
  private async makeOffer(kind: 'fresh' | 'restart', gen: number): Promise<string> {
    const fresh = kind === 'fresh' || !this.pc;
    const servers = await this.iceServers();
    const pc = fresh ? this.newPc(servers) : this.pc!;
    if (!fresh) this.configure(pc, servers, true);
    await pc.setLocalDescription(await pc.createOffer(fresh ? undefined : { iceRestart: true }));
    const start = this.now();
    await gathered(pc, servers.length ? GATHER_RELAY_MS : GATHER_LAN_MS, servers.length ? GATHER_SETTLE_MS : undefined);
    const sdp = pc.localDescription!.sdp;
    this.local(`offer gen ${gen} ${fresh ? 'new connection' : 'ICE restart'}`, sdp, this.now() - start);
    return sdp;
  }

  /**
   * The ICE servers for the next gathering: the cached ones while their credentials have long enough left,
   * else new ones from the helper. The scoreboard renews with twice the margin, so when the camera restarts ICE
   * for new credentials (tickCamera) the scoreboard's answer carries new ones too. Without a session (the
   * camera's very first offer), a TURN key on the helper or working credentials: none, the local network only.
   */
  private async iceServers(): Promise<RTCIceServer[]> {
    const now = this.now();
    const margin = this.role === 'camera' ? ICE_REFRESH_BEFORE_MS : 2 * ICE_REFRESH_BEFORE_MS;
    const cached = this.ice && now < this.ice.expiresAt ? this.ice.servers : [];
    if (this.ice && now < this.ice.expiresAt - margin) return this.ice.servers;
    if (!this.session || now < this.iceRetryAt) return cached;
    const epoch = this.epoch;
    let relay: RelayStatus;
    try {
      const r = await this.helper.getIce(this.session);
      if (epoch !== this.epoch) return [];
      if (r?.relay === 'ok') {
        const servers = assembleIceServers(r.iceServers);
        if (!servers.length) throw new Error('no usable TURN server in the reply');
        this.ice = { servers, expiresAt: this.now() + r.ttl * 1000 };
        relay = { state: 'ready', expiresAt: this.ice.expiresAt };
      } else if (r?.relay === 'not-configured') {
        this.iceRetryAt = this.now() + ICE_RETRY_UNCONFIGURED_MS;
        relay = { state: 'not-configured' };
      } else throw new Error('unexpected reply');
    } catch (err) {
      if (epoch !== this.epoch) return [];
      this.iceRetryAt = this.now() + ICE_RETRY_FAILED_MS;
      const detail = err instanceof HelperError ? (err.message === err.kind ? err.kind : `${err.kind}: ${err.message}`) : ((err as Error)?.message ?? String(err));
      relay = { state: 'failed', detail };
    }
    const servers = relay.state === 'ready' ? this.ice!.servers : cached;
    this.log('relay', relayLine(relay, servers));
    // Credentials still valid from before outlive a failed renewal: keep saying ready until they expire.
    if (relay.state === 'ready' || !cached.length) this.set({ relay });
    return servers;
  }

  /** An ICE restart gathers with the connection's configuration: give it new credentials first. */
  private configure(pc: RTCPeerConnection, servers: RTCIceServer[], strict: boolean): void {
    if (servers === this.pcServers || typeof pc.setConfiguration !== 'function') return;
    try {
      pc.setConfiguration({ ...pc.getConfiguration(), iceServers: servers });
      this.pcServers = servers;
    } catch (err) {
      this.log('error', `could not change the ICE servers for the restart (${(err as Error)?.message ?? err})`);
      if (strict) throw err; // the camera falls back to a fresh connection (runAttempt)
    }
  }

  /** Which candidate pair carries the open link, logged when it changes. */
  private async checkPath(): Promise<void> {
    const pc = this.pc;
    if (!pc || !this.open) return;
    this.lastPathAt = this.now();
    const p = await selectedPath(pc, relayAddresses(this.remoteSdp)).catch(() => null);
    if (!p || this.pc !== pc || !this.open) return;
    const line = `${p.type}: ${p.detail}`;
    if (line !== this.lastPathLine) this.log('path', line);
    this.lastPathLine = line;
    this.set({ path: p.type });
  }

  private local(what: string, sdp: string, ms: number): void {
    this.localSdp = sdp;
    this.log('sdp', `sent ${what}: ${describeCandidates(candidatesOf(sdp))} (gathered in ${ms} ms)`);
    this.checkNet();
  }

  private remote(what: string, sdp: string): void {
    this.remoteSdp = sdp;
    this.log('sdp', `got ${what}: ${describeCandidates(candidatesOf(sdp))}`);
    this.checkNet();
  }

  private checkNet(): void {
    const net = netCheck(this.localSdp, this.remoteSdp);
    const prev = this.snap.net;
    const key = (n: NetCheck | null) => (n ? `${n.verdict} ${n.mine} ${n.theirs}` : '');
    if (key(net) === key(prev)) return;
    if (net) this.log('net', `${net.verdict} (this phone ${net.mine.join(', ') || 'no address'}, other ${net.theirs.join(', ') || 'no address'})`);
    this.set({ net });
  }

  /** Scoreboard: answer an offer, in place for an ICE restart when the channel is still usable. */
  private async answer(offer: Desc, first = false): Promise<void> {
    const reuse =
      !first &&
      !offer.fresh &&
      !!this.pc &&
      this.pc.connectionState !== 'closed' &&
      this.pc.signalingState === 'stable' &&
      this.dc?.readyState === 'open';
    if (!first && !this.open) this.holdCapture(await this.ensureCapture('reconnect'));
    const servers = await this.iceServers();
    const pc = reuse ? this.pc! : this.newPc(servers);
    if (reuse) this.configure(pc, servers, false);
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    this.remote(`offer gen ${offer.gen} ${offer.fresh ? 'new connection' : 'ICE restart'}`, offer.sdp);
    await pc.setLocalDescription(await pc.createAnswer());
    const start = this.now();
    const relay = this.pcServers.length > 0;
    await gathered(pc, relay ? GATHER_RELAY_MS : GATHER_LAN_MS, relay ? GATHER_SETTLE_MS : undefined);
    const sdp = pc.localDescription!.sdp;
    this.local(`answer gen ${offer.gen} ${reuse ? 'ICE restart' : 'new connection'}`, sdp, this.now() - start);
    if (first && !hasCandidates(sdp)) throw new PairFailure('no-candidates');
    await this.helper.postAnswer(this.session!, { gen: offer.gen, sdp, fresh: !reuse });
    this.gen = offer.gen;
    this.offline = false;
    this.persist();
    this.attempt = this.open ? null : { kind: reuse ? 'restart' : 'fresh', gen: offer.gen, startedAt: this.now(), answeredAt: this.now() };
  }

  private sendHello(): void {
    this.send({ t: 'hello', role: this.role, ...this.helloFields() });
  }

  private ping(): void {
    this.lastPingAt = this.now();
    this.send({ t: 'ping', id: ++this.pingId, t0: this.now() });
  }

  private receive(data: unknown): void {
    const p = parse(data);
    if (p.kind === 'ignore') return;
    if (p.kind === 'version') return this.versionMismatch(p.v, p.app ?? null);
    const m = p.msg;
    switch (m.t) {
      case 'ping':
        this.send({ t: 'pong', id: m.id, t0: m.t0, t1: this.now(), t2: this.now() });
        return;
      case 'pong': {
        const t3 = this.now();
        this.lastPongAt = t3;
        this.clock.add(m.t0, m.t1, m.t2, t3);
        if (!this.open && this.snap.remote) this.sendHello(); // the path is back (ICE restart): say hello again
        return;
      }
      case 'hello': {
        const wasOpen = this.open;
        this.lastPongAt = this.now();
        this.open = true;
        this.down = null;
        if (this.attempt?.answeredAt != null) this.attempt = null; // an offer still waiting for its answer is kept
        this.offline = false;
        this.releaseHeldCapture();
        this.persist();
        if (!wasOpen) {
          this.log('link', `open: the other phone runs ${m.app}`);
          this.sendHello();
          void this.checkPath();
        }
        this.set({
          remote: { deviceId: m.deviceId, app: m.app, ua: m.ua },
          otherBuild: m.app !== this.helloFields().app ? m.app : null,
          everOpened: true,
          room: null,
          error: null,
        });
        this.onOpen();
        return;
      }
      case 'bye':
        if (m.reason === 'unpaired') {
          this.reset();
          this.saved.save(null);
          this.set({ ...INITIAL });
        } else if (m.reason === 'version') this.versionMismatch(null, null);
        else this.goDown('closed');
        return;
      default:
        this.onMessage(m);
    }
  }

  /** R-PAIR-7: the other phone speaks another protocol version. Stop, and say which phone to update. */
  private versionMismatch(v: unknown, theirs: string | null): void {
    this.send({ t: 'bye', reason: 'version' });
    this.log('error', `protocol mismatch, the other phone runs ${theirs ?? 'another version'}`);
    const newer = typeof v === 'number' ? (v > PROTOCOL_VERSION ? 'other' : 'this') : null;
    this.reset();
    this.saved.save(null);
    this.set({ ...INITIAL, mismatch: { theirs, newer } });
  }

  private goDown(cause: DownCause): void {
    if (!this.session) return;
    const now = this.now();
    if (this.open) {
      this.open = false;
      this.log('link', `down: ${cause}`);
      this.log('path', 'none');
      this.lastPathLine = '';
      this.down = { since: cause === 'pongs' ? this.lastPongAt : now, cause };
      // The scoreboard was polling at the idle 15 s: look for the camera's new offer now, then every 2 s.
      this.nextPollAt = Math.min(this.nextPollAt, now);
    } else if (this.down) {
      if (cause !== 'pongs' && this.attempt?.answeredAt != null) {
        // The connection an attempt brought up has failed too: the next attempt is a fresh connection.
        this.attempt = null;
        this.down = { ...this.down, cause: 'closed' };
        this.retryAt = now + POLL_FAST_MS;
      } else if (cause === 'closed' || (cause === 'ice-failed' && this.down.cause === 'pongs')) this.down = { ...this.down, cause };
    } else this.down = { since: now, cause };
    this.set({ path: 'none' });
  }

  private canRestart(): boolean {
    return !!this.pc && this.pc.connectionState !== 'closed' && this.pc.signalingState === 'stable' && this.dc?.readyState === 'open';
  }

  private tick(): void {
    const now = this.now();
    if (!this.session) return this.set({});
    if (this.dc?.readyState === 'open' && now - this.lastPingAt >= PING_EVERY_MS) this.ping();
    if (this.open && this.dc?.readyState !== 'open') this.goDown('closed'); // gone without a close event
    else if (this.open && pongsMissed(now, this.lastPongAt)) this.goDown('pongs');
    if (this.open && now - this.lastPathAt >= PATH_EVERY_MS) void this.checkPath();
    this.checkSlow(now);
    if (this.role === 'camera') this.tickCamera(now);
    else this.tickScoreboard(now);
    this.set({});
  }

  /**
   * Still not open SLOW_CONNECT_MS after the first answer (the camera meanwhile tries new connections): log
   * why, once until the link opens.
   */
  private checkSlow(now: number): void {
    if (this.open) {
      this.stuckSince = null;
      this.slowLogged = false;
      return;
    }
    this.stuckSince ??= this.attempt?.answeredAt ?? null;
    if (this.stuckSince == null || this.slowLogged || now - this.stuckSince < SLOW_CONNECT_MS) return;
    this.slowLogged = true;
    const net = this.snap.net;
    const why = net?.verdict === 'different' ? `different networks and ${relayReason(this.snap.relay, net)}` : `network ${net?.verdict ?? 'not checked'}`;
    this.log('link', `not connected ${Math.round((now - this.stuckSince) / 1000)} s after the answer: ${why}`);
  }

  private tickCamera(now: number): void {
    if (this.busy) return;
    // A relayed link is cut when its credentials expire: restart ICE with new ones while it still works.
    const renew = this.ice && now >= this.ice.expiresAt - ICE_REFRESH_BEFORE_MS && now >= this.iceRetryAt;
    if (this.open && !this.attempt && this.snap.path === 'relay' && renew) {
      this.log('relay', 'credentials expire soon · ICE restart with new ones');
      void this.runAttempt('restart');
      return;
    }
    const room = this.snap.room;
    if (!this.open && room && now >= room.expiresAt - ROOM_RENEW_BEFORE_MS && !this.attempt?.answeredAt) {
      void this.pair(); // nobody took the code: show a new one
      return;
    }
    // A posted offer is always seen through, even when the old path came back by itself meanwhile: once the
    // scoreboard has answered it, both ends must apply the same ICE restart.
    const a = this.attempt;
    if (a && a.answeredAt == null) {
      if (now >= this.nextPollAt) void this.pollAnswer(a);
      return;
    }
    if (this.open || !this.down || now < this.retryAt) return;
    const next = nextAttempt(now, this.down, a, this.canRestart());
    if (next !== 'wait') void this.runAttempt(next);
  }

  private tickScoreboard(now: number): void {
    if (this.busy || now < this.nextPollAt) return;
    void this.pollOffer();
  }

  private async pollAnswer(a: Attempt): Promise<void> {
    const epoch = this.epoch;
    this.busy = true;
    try {
      const ans = await this.helper.getAnswer(this.session!, a.gen);
      if (epoch !== this.epoch || this.attempt !== a) return;
      this.offline = false;
      if (!ans) return;
      if (ans.fresh && a.kind === 'restart' && this.open) {
        this.attempt = null; // cannot happen with a working channel; nothing to apply
        return;
      }
      if (ans.fresh && a.kind === 'restart') {
        // The scoreboard lost its connection (reloaded): a restart cannot work, build a fresh one now.
        this.attempt = null;
        if (this.down) this.down = { ...this.down, cause: 'closed' };
        return;
      }
      await this.pc!.setRemoteDescription({ type: 'answer', sdp: ans.sdp });
      this.remote(`answer gen ${ans.gen}`, ans.sdp);
      a.answeredAt = this.now();
      if (this.open) this.attempt = null;
      if (this.snap.room) this.set({ room: null });
    } catch (err) {
      if (epoch === this.epoch) this.helperFailed(err);
      if (epoch === this.epoch && !(err instanceof HelperError) && this.attempt === a) {
        this.attempt = null; // the answer did not apply to this connection: start over fresh
        if (this.down) this.down = { ...this.down, cause: 'closed' };
      }
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
        this.nextPollAt = this.now() + pollEvery(this.now(), this.down ?? { since: this.now(), cause: 'pongs' }, this.offline);
        this.set({});
      }
    }
  }

  private async runAttempt(kind: 'restart' | 'fresh'): Promise<void> {
    const epoch = this.epoch;
    this.busy = true;
    try {
      this.holdCapture(await this.ensureCapture('reconnect'));
      const gen = this.gen + 1;
      let sdp: string;
      try {
        sdp = await this.makeOffer(kind, gen);
      } catch (err) {
        if (kind === 'fresh') throw err;
        kind = 'fresh';
        sdp = await this.makeOffer('fresh', gen);
      }
      await this.helper.postOffer(this.session!, { gen, sdp, fresh: kind === 'fresh' });
      if (epoch !== this.epoch) return;
      this.gen = gen;
      this.offline = false;
      this.persist();
      this.attempt = { kind, gen, startedAt: this.now(), answeredAt: null };
      this.nextPollAt = this.now() + POLL_FAST_MS;
    } catch (err) {
      if (epoch === this.epoch) {
        this.helperFailed(err);
        if (err instanceof HelperError && err.kind === 'stale' && err.gen != null) this.gen = err.gen;
        // The scoreboard never saw this restart offer: take it back so the connection stays usable.
        if (kind === 'restart' && this.pc?.signalingState === 'have-local-offer')
          await this.pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
        this.retryAt = this.now() + pollEvery(this.now(), this.down, this.offline);
      }
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
        this.set({});
      }
    }
  }

  private async pollOffer(): Promise<void> {
    const epoch = this.epoch;
    this.busy = true;
    try {
      const offer = await this.helper.getOffer(this.session!, this.gen);
      if (epoch !== this.epoch) return;
      this.offline = false;
      if (offer) await this.answer(offer);
    } catch (err) {
      if (epoch === this.epoch) this.helperFailed(err);
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
        this.nextPollAt = this.now() + pollEvery(this.now(), this.open ? null : this.down, this.offline);
        this.set({});
      }
    }
  }

  /** A helper call failed mid-link: offline is shown on the chip, an expired session ends the pairing. */
  private helperFailed(err: unknown): void {
    if (!(err instanceof HelperError)) return;
    if (err.kind === 'offline') this.offline = !this.open;
    if (err.kind === 'no-session') {
      this.log('error', 'the helper no longer knows this pairing (expired)');
      this.reset();
      this.saved.save(null);
      this.set({ ...INITIAL, error: { kind: 'expired' } });
    }
  }
}

class PairFailure extends Error {
  readonly kind: PairErrorKind;
  constructor(kind: PairErrorKind) {
    super(kind);
    this.kind = kind;
  }
}
