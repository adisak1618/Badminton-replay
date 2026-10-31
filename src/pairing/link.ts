// One phone's end of the paired link: an RTCPeerConnection with one ordered data channel, over the local
// network when the phones share one and through a TURN relay when they do not (ice.ts; D13), its descriptors
// and the relay credentials carried by the helper (D2), liveness pings both ways, the clock samples, the
// version check (R-PAIR-7) and automatic reconnect (R-PAIR-8). The camera offers, the scoreboard answers
// (technical-design.md §4.3); a scoreboard whose page comes back from a locked screen may offer a fresh
// connection itself (§4.5). The camera holds one of these per scoreboard (slots.ts). What the messages mean is
// the role's business (scoreboard.ts, hub.ts); this class only delivers them.
import { ClockSampler } from '../protocol/clock';
import { PROTOCOL_VERSION, encode, parse, type Msg, type Role } from '../protocol/messages';
import type { ClockEstimate, LinkState } from '../link/source';
import type { DiagKind } from './diag';
import { HelperError, type Desc, type HelperClient, type HelperErrorKind, type PollReply, type Session } from './helper';
import { PAIR_GIVE_UP_MS, PEER_SILENT_MS, relayTag, unreachable, type Unreachable } from './unreachable';
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
  ATTEMPT_TIMEOUT_MS,
  PING_EVERY_MS,
  POLL_FAST_MS,
  POLL_SLOW_MS,
  PROBE_MS,
  answerPollEvery,
  cameraPollEvery,
  chipState,
  nextAttempt,
  pollEvery,
  pongsMissed,
  resumeAction,
  resumeReply,
  type Attempt,
  type Down,
  type DownCause,
} from './reconnect';
import { loadPairing, loadShown, savePairing, saveShown, type SavedPairing } from './saved';

const TICK_MS = 250;
/** Not open this long after the answer: the pairing screens say why (pairText.ts) and the log records it. */
export const SLOW_CONNECT_MS = 15_000;
/** How often an open link reads which candidate pair carries it (it can change after an ICE restart). */
const PATH_EVERY_MS = 10_000;
/**
 * After a failed credential fetch, and after "not configured", ask the helper again only this much later. A first
 * pairing gives up PAIR_GIVE_UP_MS after its first answer, so the answer to the camera's second attempt (10 s
 * after the first) must be able to ask again.
 */
const ICE_RETRY_FAILED_MS = 10_000;
const ICE_RETRY_UNCONFIGURED_MS = 10 * 60_000;
/** Renew the camera's code shortly before the helper forgets the room. */
const ROOM_RENEW_BEFORE_MS = 20_000;
/** On unpair the goodbye is given this long to leave before the connection is closed. */
const BYE_DRAIN_MS = 1000;
/** visibilitychange, pageshow and online often fire together: one resume per this. */
const RESUME_DEBOUNCE_MS = 500;

/** unreachable: a first pairing that never opened (unreachable.ts); withdrawn: the other phone ended it first. */
export type PairErrorKind = HelperErrorKind | 'expired' | 'no-candidates' | 'failed' | 'unreachable' | 'withdrawn';

export interface PairError {
  kind: PairErrorKind;
  detail?: string;
  /** unreachable: why, from what this phone saw. */
  why?: Unreachable;
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
  /** Since when the link has been down (the last pong when pongs stopped); null while open or unpaired. */
  downSince: number | null;
  /** Scoreboard, first pairing: the camera has not fetched the answer PEER_SILENT_MS after it was posted. */
  peerSilent: boolean;
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
  /** Camera: the session of the code on show, withdrawn at the next launch if the page died with it (saved.ts). */
  shown?: { load(): Session | null; save(s: Session | null): void };
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
  downSince: null,
  peerSilent: false,
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
  private readonly shown: NonNullable<PeerLinkDeps['shown']>;
  private readonly log: NonNullable<PeerLinkDeps['log']>;

  private snap: LinkSnapshot = INITIAL;
  private listeners = new Set<() => void>();
  private session: Session | null = null;
  /** Scoreboard: the room code the current pairing was claimed with. */
  private joined: string | null = null;
  /** Scoreboard: this phone's claim id for a code, the same for every try at that code (api/signal.ts CLAIMED_TTL_S). */
  private claimFor: { code: string; id: string } | null = null;
  /** The last description this phone sent and the last one it received, for the network check. */
  private localSdp: string | null = null;
  private remoteSdp: string | null = null;
  /** The last description the other phone posted: what it said about its build, protocol and relay. */
  private peer: Desc | null = null;
  /** A first pairing: when its first answer was posted (scoreboard) or applied (camera); the camera gives up PAIR_GIVE_UP_MS later. */
  private firstAnswerAt: number | null = null;
  /** Scoreboard, first pairing: when the camera was first seen running (it fetched the answer, or offered); it gives up PAIR_GIVE_UP_MS later. */
  private peerSeenAt: number | null = null;
  private lastPollAt = 0;
  /** Camera: its code on show was withdrawn on pagehide; a page restored from the back-forward cache shows a new one. */
  private withdrewCode = false;
  /** The link was last carried by the relay: a reconnect offer without a relay candidate cannot reach the other phone. */
  private relayed = false;
  private gen = 0;
  /** The newest generation the helper said it holds (a 409): the next offer goes above it. */
  private latestGen = 0;
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
  /** The page came back and its link was found dead: the scoreboard offers a fresh connection (§4.5). */
  private resuming = false;
  /**
   * The helper answered that it no longer knows this session while the link was open: the link is kept (it needs
   * no helper), the idle polls stop, and the pairing ends only if the link goes down and needs the helper.
   */
  private sessionLost = false;
  /** A resume probe: the ping sent at `since` must be answered within PROBE_MS. */
  private probe: { since: number } | null = null;
  private lastResumeAt = 0;
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
    this.shown = deps.shown ?? { load: () => loadShown(deps.role), save: (s) => saveShown(deps.role, s) };
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
    next.downSince = this.session && !this.open && next.everOpened ? (this.down?.since ?? null) : null;
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
    // A new code replaces the one on show: withdraw that one, so a scoreboard that typed it is told.
    const old = this.snap.room && !this.snap.everOpened ? this.session : null;
    const epoch = this.reset();
    if (old) void this.helper.end(old, { reason: 'withdrawn', ...this.meta() }).catch(() => {});
    this.setBusy(true);
    this.set({ error: null, mismatch: null, room: null, net: null });
    try {
      this.holdCapture(await this.ensureCapture('pair'));
      const sdp = await this.makeOffer('fresh', 1);
      if (!hasCandidates(sdp)) throw new PairFailure('no-candidates');
      const r = await this.helper.createRoom(sdp, this.meta());
      if (epoch !== this.epoch) return;
      this.session = { session: r.session, secret: r.secret };
      this.gen = 1;
      this.latestGen = 1;
      // The room needs a session before TURN credentials can be had; with them, a new offer carrying relay
      // candidates replaces the local-network one before the code is shown (the claim gets the latest offer).
      if ((await this.iceServersForPairing()).length) {
        if (epoch !== this.epoch) return;
        const relayed = await this.makeOffer('fresh', 2);
        await this.helper.postOffer(this.session, { gen: 2, sdp: relayed, fresh: true, by: 'camera', ...this.meta() });
        if (epoch !== this.epoch) return;
        this.gen = 2;
      }
      // Saved once the link opens (hello): a code nobody claimed is not a pairing to rejoin after a reload.
      this.saved.save(null);
      this.down = { since: this.now(), cause: 'closed' };
      this.attempt = { kind: 'fresh', gen: this.gen, startedAt: this.now(), answeredAt: null };
      this.nextPollAt = this.now() + POLL_FAST_MS;
      this.offline = false;
      this.set({ room: { code: r.code, expiresAt: this.now() + r.expiresIn * 1000 }, everOpened: false });
      this.shown.save(this.session);
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
      if (this.claimFor?.code !== code) this.claimFor = { code, id: claimId() };
      let r: Awaited<ReturnType<HelperClient['claimRoom']>>;
      try {
        r = await this.helper.claimRoom(code, this.claimFor.id);
      } catch (err) {
        // No reply in time: the helper may have taken the code all the same. The same claim gets that session.
        if (!(err instanceof HelperError) || err.kind !== 'offline' || epoch !== this.epoch) throw err;
        this.log('link', 'the claim got no reply in time; asking again with the same claim');
        r = await this.helper.claimRoom(code, this.claimFor.id);
      }
      if (epoch !== this.epoch) return;
      this.session = { session: r.session, secret: r.secret };
      if (this.refuses(r.offer)) return;
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
    const left = this.session ? null : this.shown.load();
    if (left) {
      // The page that showed this code went away without withdrawing it (killed rather than unloaded).
      this.log('link', `withdrawing the code a previous page left on show (session ${left.session.slice(0, 6)}…)`);
      void this.helper.end(left, { reason: 'withdrawn', ...this.meta() }).catch(() => {});
      this.shown.save(null);
    }
    const p = this.saved.load();
    if (!p || this.session) return false;
    this.session = { session: p.session, secret: p.secret };
    this.gen = p.gen;
    this.latestGen = p.gen;
    this.down = { since: this.now(), cause: 'closed' };
    this.set({ everOpened: true, error: null });
    this.log('link', `rejoining the saved pairing (session ${p.session.slice(0, 6)}…, gen ${p.gen})`);
    this.startTimer();
    return true;
  }

  /**
   * Forget the pairing on both phones. The goodbye gets a moment to leave before the connection closes (closing
   * at once dropped it), and the helper marks the session ended, so the other phone learns it at its next poll
   * even if the goodbye never arrives.
   */
  unpair(): void {
    const s = this.session;
    this.log('link', 'unpaired on this phone');
    this.send({ t: 'bye', reason: 'unpaired' });
    if (s) void this.helper.end(s, { reason: 'unpaired', ...this.meta() }).catch(() => {});
    this.reset(true);
    this.saved.save(null);
    this.set({ ...INITIAL });
  }

  /** Camera: take back a code nobody has used yet (the pairing screen closed with this slot still free). */
  cancel(): void {
    if (!this.snap.room || this.snap.everOpened) return;
    const s = this.session;
    this.log('link', `code ${this.snap.room.code} withdrawn`);
    if (s) void this.helper.end(s, { reason: 'withdrawn', ...this.meta() }).catch(() => {});
    this.reset();
    this.saved.save(null);
    this.set({ ...INITIAL });
  }

  /**
   * The page is visible again (screen on, `pageshow`, back `online`). iOS suspends the page while the screen
   * is locked, so the connection from before is probed with one ping, or given up at once when it already
   * says so, and recovery starts now instead of after missed pongs (technical-design.md §4.5).
   */
  resume(why: string): void {
    if (!this.session) return;
    const now = this.now();
    if (now - this.lastResumeAt < RESUME_DEBOUNCE_MS) return;
    this.lastResumeAt = now;
    this.nextPollAt = Math.min(this.nextPollAt, now);
    // Not while still pairing. A helper call that was in flight when the page was suspended does not stop it:
    // its answer is judged by what this decides (an attempt it belonged to is dropped). A first pairing's clocks
    // start again: the page was away, not the network.
    if (!this.snap.everOpened) {
      if (this.firstAnswerAt != null) this.firstAnswerAt = now;
      if (this.peerSeenAt != null) this.peerSeenAt = now;
      if (this.withdrewCode && this.snap.room) {
        this.withdrewCode = false;
        void this.pair(); // its code was withdrawn when the page was hidden away: show a new one
      }
      return void this.set({});
    }
    const facts = {
      channelOpen: this.open && this.dc?.readyState === 'open',
      connectionState: this.pc?.connectionState ?? ('none' as const),
      iceConnectionState: this.pc?.iceConnectionState ?? ('none' as const),
    };
    const action = resumeAction(facts);
    this.log('link', `resume (${why}): ${action === 'probe' ? 'probing the link' : 'the link is gone'} (connection ${facts.connectionState}, ICE ${facts.iceConnectionState})`);
    if (action === 'recover') return this.recover();
    this.probe = { since: now };
    this.ping();
  }

  /** The link did not survive the page being away: start over now, with a fresh connection. */
  private recover(): void {
    const now = this.now();
    this.probe = null;
    this.resuming = this.role === 'scoreboard';
    this.attempt = null;
    if (this.open) this.goDown('closed');
    this.down = { since: now, cause: 'closed' }; // the fast cadence again, from now
    this.closePc();
    this.retryAt = 0;
    this.nextPollAt = now;
    this.tick(); // now, not at the next tick
  }

  /** The page is going away: tell the other phone so it reconnects at once instead of waiting for pongs. */
  leave(): void {
    this.send({ t: 'bye', reason: 'leaving' });
    // A code on show dies with the page: withdraw it, so a scoreboard that types it is told so.
    if (this.session && this.snap.room && !this.snap.everOpened) {
      this.helper.endBeacon?.(this.session, { reason: 'withdrawn', ...this.meta() });
      this.shown.save(null);
      this.withdrewCode = true;
    }
  }

  // ---- internals ----

  private reset(drain = false): number {
    this.stopTimer();
    this.closePc(drain);
    this.session = null;
    this.gen = 0;
    this.latestGen = 0;
    this.resuming = false;
    this.probe = null;
    this.open = false;
    this.down = null;
    this.attempt = null;
    this.offline = false;
    this.busy = false;
    this.retryAt = 0;
    this.localSdp = null;
    this.remoteSdp = null;
    this.peer = null;
    this.firstAnswerAt = null;
    this.peerSeenAt = null;
    this.withdrewCode = false;
    this.relayed = false;
    this.sessionLost = false;
    this.shown.save(null);
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

  /** Close the connection; with `drain`, only once what was sent has left (or after BYE_DRAIN_MS). */
  private closePc(drain = false): void {
    if (this.open && this.session) this.down = { since: this.now(), cause: 'closed' };
    const pc = this.pc;
    const dc = this.dc;
    this.pc = null;
    this.dc = null;
    this.open = false;
    if (this.snap.path !== 'none') this.set({ path: 'none' });
    const close = () => {
      try {
        pc?.close();
      } catch {
        // already closed
      }
    };
    if (!drain || !pc || !dc || dc.readyState !== 'open' || dc.bufferedAmount === 0) {
      // Even an empty buffer gets one turn: send() hands the message to the transport asynchronously.
      if (drain && pc) setTimeout(close, 100);
      else close();
      return;
    }
    const start = this.now();
    const wait = setInterval(() => {
      if (dc.readyState !== 'open' || dc.bufferedAmount === 0 || this.now() - start >= BYE_DRAIN_MS) {
        clearInterval(wait);
        setTimeout(close, 100);
      }
    }, 50);
  }

  /** A new connection; the side that offers it creates the data channel, the other receives it. */
  private newPc(servers: RTCIceServer[], offerer: boolean): RTCPeerConnection {
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
    if (offerer) this.attachDc(pc, pc.createDataChannel('match', { ordered: true }));
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

  /** A local offer on a new connection ('fresh') or an ICE restart of the current one (the camera's). */
  private async makeOffer(kind: 'fresh' | 'restart', gen: number): Promise<string> {
    const fresh = kind === 'fresh' || !this.pc;
    const servers = await this.iceServers();
    const pc = fresh ? this.newPc(servers, true) : this.pc!;
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

  /**
   * A new pairing's credentials: a fetch the helper refused is tried once more at once (the pairing gives up 18 s
   * after its first answer). One that got no reply in time is not: that would hold the answer up another 4 s, and
   * the 10 s retry still serves the answer to the camera's second attempt.
   */
  private async iceServersForPairing(): Promise<RTCIceServer[]> {
    const servers = await this.iceServers();
    if (servers.length || this.snap.relay.state !== 'failed' || this.snap.relay.detail?.startsWith('offline')) return servers;
    this.iceRetryAt = 0;
    return this.iceServers();
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
    this.relayed = p.type === 'relay';
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

  /** Answer the other phone's offer, in place for an ICE restart when the channel is still usable. */
  private async answer(offer: Desc, first = false): Promise<void> {
    const reuse =
      !first &&
      !offer.fresh &&
      !!this.pc &&
      this.pc.connectionState !== 'closed' &&
      this.pc.signalingState === 'stable' &&
      this.dc?.readyState === 'open';
    if (!first && !this.open) this.holdCapture(await this.ensureCapture('reconnect'));
    const servers = first ? await this.iceServersForPairing() : await this.iceServers();
    const pc = reuse ? this.pc! : this.newPc(servers, false);
    if (reuse) this.configure(pc, servers, false);
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    this.peer = offer;
    this.remote(`offer gen ${offer.gen} ${offer.fresh ? 'new connection' : 'ICE restart'}`, offer.sdp);
    await pc.setLocalDescription(await pc.createAnswer());
    const start = this.now();
    const relay = this.pcServers.length > 0;
    await gathered(pc, relay ? GATHER_RELAY_MS : GATHER_LAN_MS, relay ? GATHER_SETTLE_MS : undefined);
    const sdp = pc.localDescription!.sdp;
    this.local(`answer gen ${offer.gen} ${reuse ? 'ICE restart' : 'new connection'}`, sdp, this.now() - start);
    if (first && !hasCandidates(sdp)) throw new PairFailure('no-candidates');
    await this.helper.postAnswer(this.session!, { gen: offer.gen, sdp, fresh: !reuse, ...this.meta() });
    if (!this.snap.everOpened) this.firstAnswerAt ??= this.now();
    this.gen = offer.gen;
    this.latestGen = Math.max(this.latestGen, offer.gen);
    this.resuming = false;
    this.offline = false;
    this.persist();
    this.attempt = this.open ? null : { kind: reuse ? 'restart' : 'fresh', gen: offer.gen, startedAt: this.now(), answeredAt: this.now() };
  }

  private sendHello(): void {
    this.send({ t: 'hello', role: this.role, ...this.helloFields() });
  }

  /** What this phone says about itself in every description it posts (api/signal.ts PeerMeta). */
  private meta(): { app: string; v: number; relay: string } {
    return { app: this.helloFields().app, v: PROTOCOL_VERSION, relay: relayTag(this.snap.relay) };
  }

  /**
   * The other phone's description says it speaks another protocol: stop before any connection, and end the
   * session so it is told too (R-PAIR-7). A build that cannot open the channel was never told otherwise.
   */
  private refuses(d: Desc): boolean {
    if (typeof d.v !== 'number' || d.v === PROTOCOL_VERSION) return false;
    const s = this.session;
    if (s) void this.helper.end(s, { reason: 'version', ...this.meta() }).catch(() => {});
    this.versionMismatch(d.v, d.app ?? null);
    return true;
  }

  /**
   * A first pairing that has not opened PAIR_GIVE_UP_MS after its first answer, or that the other phone gave up
   * on: say why (unreachable.ts), end the session so the other phone stops too, and offer nothing more.
   */
  private giveUp(endSession: boolean): void {
    const why = unreachable(this.snap.relay, this.snap.net, this.peer);
    const s = this.session;
    const after = this.firstAnswerAt == null ? '' : ` ${Math.round((this.now() - this.firstAnswerAt) / 1000)} s after the first answer`;
    this.log('error', `could not connect${after}: ${why.reason}${why.detail ? ` (${why.detail})` : ''}${why.peerOld ? '; the other phone did not say its build' : ''}`);
    if (s && endSession) void this.helper.end(s, { reason: 'unreachable', ...this.meta() }).catch(() => {});
    this.reset();
    this.saved.save(null);
    this.set({ ...INITIAL, error: { kind: 'unreachable', why } });
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
        if (!this.open && this.snap.remote) {
          // The path is back (a stall, an ICE restart): say hello again, and count the link open now. The pong
          // proves it carries this phone's ping out and the answer back, and a phone that never saw the drop is
          // still open: it does not answer a hello with one, and offers nothing (2026-10-30, stuck for minutes).
          this.sendHello();
          this.markOpen();
          this.log('link', 'open again: pongs are back');
          void this.checkPath();
          this.set({ error: null });
          this.onOpen();
        }
        if (this.probe) {
          this.log('link', `resume: the link is alive (pong after ${t3 - this.probe.since} ms)`);
          this.probe = null;
        }
        return;
      }
      case 'hello': {
        const wasOpen = this.markOpen();
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
        if (m.reason === 'unpaired') this.ended('the other phone unpaired');
        else if (m.reason === 'version') this.versionMismatch(null, null);
        else this.goDown('closed');
        return;
      default:
        this.onMessage(m);
    }
  }

  /** Scoreboard, first pairing: the camera's page is running; the give-up clock starts. */
  private peerSeen(how: string): void {
    if (this.peerSeenAt != null || this.role !== 'scoreboard') return;
    this.peerSeenAt = this.now();
    if (this.snap.peerSilent) this.log('link', `the camera answers again (it ${how})`);
  }

  /** The link carries both ways again (a hello, or a pong while down). Returns whether it was open before. */
  private markOpen(): boolean {
    const wasOpen = this.open;
    if (!wasOpen && !this.snap.everOpened) this.shown.save(null); // the code on show has done its job
    this.lastPongAt = this.now();
    this.open = true;
    this.down = null;
    if (this.attempt?.answeredAt != null) this.attempt = null; // an offer still waiting for its answer is kept
    this.offline = false;
    this.releaseHeldCapture();
    this.persist();
    return wasOpen;
  }

  /** The other phone unpaired (its goodbye, or the helper's `ended`): back to unpaired, pairing forgotten. */
  private ended(why: string): void {
    this.log('link', why);
    this.reset();
    this.saved.save(null);
    this.set({ ...INITIAL });
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
    if (this.probe && now - this.probe.since >= PROBE_MS) {
      this.log('link', `resume: no pong within ${PROBE_MS} ms, the link is gone`);
      this.recover();
    }
    this.checkSlow(now);
    // The camera's clock starts at its first answer; the scoreboard's once the camera is seen running.
    const since = this.role === 'camera' ? this.firstAnswerAt : this.peerSeenAt;
    if (!this.open && !this.snap.everOpened && since != null && now - since >= PAIR_GIVE_UP_MS) return this.giveUp(true);
    const silent = this.role === 'scoreboard' && !this.open && !this.snap.everOpened && this.firstAnswerAt != null && this.peerSeenAt == null && now - this.firstAnswerAt >= PEER_SILENT_MS;
    if (silent && !this.snap.peerSilent) this.log('link', `the camera has not fetched the answer ${Math.round((now - this.firstAnswerAt!) / 1000)} s after it was posted: its app is not running`);
    if (silent !== this.snap.peerSilent) this.set({ peerSilent: silent });
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
      // An answer may be waiting (the page was suspended past the renewal): look before replacing the code.
      if (now - this.lastPollAt > 3000) return void this.poll();
      void this.pair(); // nobody took the code: show a new one
      return;
    }
    // A posted offer is always seen through, even when the old path came back by itself meanwhile: once the
    // scoreboard has answered it, both ends must apply the same ICE restart.
    const a = this.attempt;
    if (a && a.answeredAt == null) {
      if (now >= this.nextPollAt) void this.poll();
      return;
    }
    if (this.open || !this.down) return;
    // While down, a scoreboard coming back may have posted an offer of its own: look every second.
    if (now >= this.nextPollAt) return void this.poll();
    if (now < this.retryAt) return;
    const next = nextAttempt(now, this.down, a, this.canRestart());
    if (next !== 'wait') void this.runAttempt(next);
  }

  private tickScoreboard(now: number): void {
    if (this.busy) return;
    const a = this.attempt;
    // Its own offer answered but the link never opened: leave reconnecting to the camera's offers.
    if (a && a.answeredAt != null && !this.open && now - a.answeredAt >= ATTEMPT_TIMEOUT_MS) this.attempt = null;
    if (now < this.nextPollAt) return;
    if (this.sessionLost && this.open) return; // nothing to look for: the helper forgot the session
    void this.poll();
  }

  /** How long until the next look at the helper. */
  private cadence(now: number): number {
    if (this.offline) return POLL_SLOW_MS;
    const a = this.attempt;
    const down = this.open ? null : this.down;
    if (this.role === 'camera') {
      if (this.open) return POLL_FAST_MS; // only an attempt on an open link (relay renewal) polls
      if (!this.snap.everOpened) return pollEvery(now, this.down ?? { since: now, cause: 'pongs' }, false); // pairing
      return cameraPollEvery(now, down ?? { since: now, cause: 'pongs' }, false);
    }
    const base = pollEvery(now, down, false);
    return a && a.answeredAt == null ? answerPollEvery(now, a.startedAt, base) : base;
  }

  /**
   * One look at the helper: the other phone's newer offer (answer it), the answer to this phone's own offer
   * (apply it), or nothing. A scoreboard recovering after a resume offers a fresh connection itself when the
   * camera has none waiting, or only an ICE restart of the connection from before the screen locked.
   */
  private async poll(): Promise<void> {
    const epoch = this.epoch;
    const a = this.attempt;
    let soon = false;
    this.busy = true;
    this.lastPollAt = this.now();
    // Scoreboard, first pairing: ask whether the camera has fetched the answer, i.e. whether its page runs at all.
    const askSeen = this.role === 'scoreboard' && !this.snap.everOpened && this.firstAnswerAt != null && this.peerSeenAt == null;
    try {
      const r: PollReply = await this.helper.poll(this.session!, this.gen, this.role, askSeen);
      if (epoch !== this.epoch) return;
      this.offline = false;
      if (r && 'seen' in r) this.peerSeen('fetched the answer');
      else if (r && 'offer' in r) {
        this.latestGen = Math.max(this.latestGen, r.offer.gen);
        if (this.refuses(r.offer)) return;
        if (!this.snap.everOpened) this.peerSeen('offered a new connection');
        if (this.resuming && resumeReply(r.offer) === 'offer') {
          this.log('link', `resume: the camera's offer gen ${r.offer.gen} restarts the old connection; offering a fresh one instead`);
          await this.offer('fresh');
        } else {
          this.attempt = null; // the other phone's newer offer supersedes this phone's own
          await this.answer(r.offer);
        }
      } else if (r && 'answer' in r) {
        if (a && this.attempt === a && a.answeredAt == null && r.answer.gen === a.gen) await this.applyAnswer(a, r.answer);
      } else if (this.resuming && !this.attempt) await this.offer('fresh');
    } catch (err) {
      if (epoch === this.epoch) {
        this.helperFailed(err);
        if (err instanceof HelperError && err.kind === 'stale') {
          this.latestGen = Math.max(this.latestGen, err.gen ?? 0);
          soon = true; // the other phone posted first: take its offer
        } else if (!(err instanceof HelperError) && this.attempt === a && a) {
          this.attempt = null; // the answer did not apply to this connection: start over fresh
          if (this.down) this.down = { ...this.down, cause: 'closed' };
        }
      }
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
        this.nextPollAt = this.now() + (soon ? 0 : this.cadence(this.now()));
        this.set({});
      }
    }
  }

  private async applyAnswer(a: Attempt, ans: Desc): Promise<void> {
    if (ans.fresh && a.kind === 'restart') {
      this.attempt = null;
      // A fresh answer to a restart: the other phone lost its connection (reloaded); nothing to apply on an open
      // channel, and a fresh connection is needed on a closed one.
      if (!this.open && this.down) this.down = { ...this.down, cause: 'closed' };
      return;
    }
    if (this.refuses(ans)) return;
    await this.pc!.setRemoteDescription({ type: 'answer', sdp: ans.sdp });
    this.peer = ans;
    this.remote(`answer gen ${ans.gen}`, ans.sdp);
    a.answeredAt = this.now();
    if (!this.snap.everOpened) this.firstAnswerAt ??= a.answeredAt;
    this.resuming = false;
    if (this.open) this.attempt = null;
    if (this.snap.room) this.set({ room: null });
  }

  /** Post a new offer of this phone's; the helper keeps generations growing. */
  private async offer(kind: 'restart' | 'fresh'): Promise<void> {
    const epoch = this.epoch;
    this.holdCapture(await this.ensureCapture('reconnect'));
    const gen = Math.max(this.gen, this.latestGen) + 1;
    let sdp: string;
    try {
      sdp = await this.makeOffer(kind, gen);
    } catch (err) {
      if (kind === 'fresh') throw err;
      kind = 'fresh';
      sdp = await this.makeOffer('fresh', gen);
    }
    if (!this.reachable(sdp)) {
      // Gathered while this phone's network was down: posting it would only cost a 10 s attempt the other phone
      // cannot connect to (2026-10-31 audit, BUG-7). Try again soon instead.
      if (kind === 'restart' && this.pc?.signalingState === 'have-local-offer') await this.pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
      this.log('sdp', `offer gen ${gen} not posted: nothing in it the other phone could reach`);
      throw new PairFailure('no-candidates');
    }
    try {
      await this.helper.postOffer(this.session!, { gen, sdp, fresh: kind === 'fresh', by: this.role, ...this.meta() });
    } catch (err) {
      // The other phone never saw this restart offer: take it back so the connection stays usable.
      if (kind === 'restart' && this.pc?.signalingState === 'have-local-offer') await this.pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
      throw err;
    }
    if (epoch !== this.epoch) return;
    this.gen = gen;
    this.latestGen = gen;
    this.offline = false;
    this.resuming = false;
    this.persist();
    this.attempt = { kind, gen, startedAt: this.now(), answeredAt: null };
    this.nextPollAt = this.now() + (this.role === 'scoreboard' ? answerPollEvery(this.now(), this.now(), POLL_FAST_MS) : cameraPollEvery(this.now(), this.down, false));
  }

  /**
   * Whether an offer can reach the other phone: it has a candidate at all, and a relay one when the link last ran
   * through the relay or the phones are on different networks (with relay servers to gather from).
   */
  private reachable(sdp: string): boolean {
    if (!hasCandidates(sdp)) return false;
    if (!this.pcServers.length || !(this.relayed || this.snap.net?.verdict === 'different')) return true;
    return / typ relay /.test(sdp);
  }

  private async runAttempt(kind: 'restart' | 'fresh'): Promise<void> {
    const epoch = this.epoch;
    this.busy = true;
    try {
      await this.offer(kind);
    } catch (err) {
      if (epoch === this.epoch && err instanceof PairFailure) this.retryAt = this.now() + POLL_FAST_MS; // not posted: gather again soon
      else if (epoch === this.epoch) {
        this.helperFailed(err);
        if (err instanceof HelperError && err.kind === 'stale') {
          this.latestGen = Math.max(this.latestGen, err.gen ?? 0);
          this.nextPollAt = this.now(); // the scoreboard offered first: answer its offer
        }
        this.retryAt = this.now() + pollEvery(this.now(), this.down, this.offline);
      }
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
        this.set({});
      }
    }
  }

  /** A helper call failed mid-link: offline is shown on the chip, an expired or ended session ends the pairing. */
  private helperFailed(err: unknown): void {
    if (!(err instanceof HelperError)) return;
    if (err.kind === 'offline') this.offline = !this.open;
    if (err.kind === 'ended') {
      const e = err.ended;
      if (e?.reason === 'version') return this.versionMismatch(e.v, e.app ?? null);
      if (this.snap.everOpened) return this.ended('the other phone ended the pairing (helper)');
      // A first pairing the other phone ended before it opened: it gave up too (say why from here), or the
      // camera withdrew the code.
      if (e?.reason === 'unreachable') return this.giveUp(false);
      this.log('link', `the other phone ended the pairing before it opened (${e?.reason ?? 'unpaired'})`);
      this.reset();
      this.saved.save(null);
      return this.set({ ...INITIAL, error: { kind: 'withdrawn' } });
    }
    if (err.kind === 'no-session') {
      // An open link does not need the helper: keep it (it was torn down on both phones, and the camera dropped
      // its match, when a test helper restarted or a session outlived its TTL: 2026-10-31 audit, BUG-3).
      if (this.isOpen()) {
        if (!this.sessionLost) this.log('error', 'the helper no longer knows this pairing; the open link is kept');
        this.sessionLost = true;
        return;
      }
      this.log('error', 'the helper no longer knows this pairing (expired)');
      this.reset();
      this.saved.save(null);
      this.set({ ...INITIAL, error: { kind: 'expired' } });
    }
  }
}

function claimId(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

class PairFailure extends Error {
  readonly kind: PairErrorKind;
  constructor(kind: PairErrorKind) {
    super(kind);
    this.kind = kind;
  }
}
