// One phone's end of the paired link: an RTCPeerConnection with one ordered data channel over the local
// network (no STUN, D13), its descriptors carried by the helper (D2), liveness pings both ways, the clock
// samples, the version check (R-PAIR-7) and automatic reconnect (R-PAIR-8). The camera offers, the scoreboard
// answers (technical-design.md §4.3). What the messages mean is the role's business (scoreboard.ts, peer.ts);
// this class only delivers them.
import { ClockSampler } from '../protocol/clock';
import { PROTOCOL_VERSION, encode, parse, type Msg, type Role } from '../protocol/messages';
import type { ClockEstimate, LinkState } from '../link/source';
import { HelperError, type Desc, type HelperClient, type HelperErrorKind, type Session } from './helper';
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

export const GATHER_MAX_MS = 2000;
const TICK_MS = 250;
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
}

export type HelloFields = { deviceId: string; app: string; ua?: string; matchId?: string; lastSeq?: number };
type Body = Parameters<typeof encode>[0];

export interface PeerLinkDeps {
  role: Role;
  helper: HelperClient;
  hello: () => HelloFields;
  createPc?: () => RTCPeerConnection;
  now?: () => number;
  /**
   * Before every ICE gathering: make sure this page holds capture permission, without which WebKit offers no
   * host candidates (§4.3). Returns a release, called once the link is open.
   */
  ensureCapture?: (why: 'pair' | 'reconnect') => Promise<(() => void) | void>;
  /** Persisted pairing; defaults to localStorage. */
  saved?: { load(): SavedPairing | null; save(p: SavedPairing | null): void };
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
};

export function hasCandidates(sdp: string): boolean {
  return /^a=candidate:/m.test(sdp);
}

/** Resolve when ICE gathering is complete, or after `max` ms with whatever was gathered (no trickle ICE). */
export function gathered(pc: RTCPeerConnection, max = GATHER_MAX_MS): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const timer = setTimeout(done, max);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export class PeerLink {
  readonly role: Role;
  private readonly helper: HelperClient;
  private readonly helloFields: () => HelloFields;
  private readonly createPc: () => RTCPeerConnection;
  private readonly now: () => number;
  private readonly ensureCapture: NonNullable<PeerLinkDeps['ensureCapture']>;
  private readonly saved: NonNullable<PeerLinkDeps['saved']>;

  private snap: LinkSnapshot = INITIAL;
  private listeners = new Set<() => void>();
  private session: Session | null = null;
  /** Scoreboard: the room code the current pairing was claimed with. */
  private joined: string | null = null;
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
    this.createPc = deps.createPc ?? (() => new RTCPeerConnection({ iceServers: [] })); // D13: no STUN
    this.now = deps.now ?? Date.now;
    this.ensureCapture = deps.ensureCapture ?? (async () => {});
    this.saved = deps.saved ?? { load: () => loadPairing(deps.role), save: (p) => savePairing(deps.role, p) };
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
    this.set({ error: null, mismatch: null, room: null });
    try {
      this.holdCapture(await this.ensureCapture('pair'));
      const sdp = await this.makeOffer('fresh');
      if (!hasCandidates(sdp)) throw new PairFailure('no-candidates');
      const r = await this.helper.createRoom(sdp);
      if (epoch !== this.epoch) return;
      this.session = { session: r.session, secret: r.secret };
      this.gen = 1;
      this.persist();
      this.down = { since: this.now(), cause: 'closed' };
      this.attempt = { kind: 'fresh', gen: 1, startedAt: this.now(), answeredAt: null };
      this.nextPollAt = this.now() + POLL_FAST_MS;
      this.offline = false;
      this.set({ room: { code: r.code, expiresAt: this.now() + r.expiresIn * 1000 }, everOpened: false });
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
    this.set({ error: null, mismatch: null });
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
    this.releaseHeldCapture();
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
    try {
      pc?.close();
    } catch {
      // already closed
    }
  }

  private newPc(): RTCPeerConnection {
    this.closePc();
    const pc = this.createPc();
    this.pc = pc;
    pc.addEventListener('connectionstatechange', () => {
      if (this.pc !== pc) return;
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
      this.lastPongAt = this.now();
      this.sendHello();
      this.ping();
    });
    dc.addEventListener('close', () => mine() && this.goDown('closed'));
    dc.addEventListener('message', (e) => mine() && this.receive(e.data));
  }

  /** Camera: a local offer on a new connection ('fresh') or an ICE restart of the current one. */
  private async makeOffer(kind: 'fresh' | 'restart'): Promise<string> {
    const pc = kind === 'fresh' || !this.pc ? this.newPc() : this.pc;
    await pc.setLocalDescription(await pc.createOffer(kind === 'restart' ? { iceRestart: true } : undefined));
    await gathered(pc);
    return pc.localDescription!.sdp;
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
    const pc = reuse ? this.pc! : this.newPc();
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    const sdp = pc.localDescription!.sdp;
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
        if (!wasOpen) this.sendHello();
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
      this.down = { since: cause === 'pongs' ? this.lastPongAt : now, cause };
    } else if (this.down) {
      if (cause !== 'pongs' && this.attempt?.answeredAt != null) {
        // The connection an attempt brought up has failed too: the next attempt is a fresh connection.
        this.attempt = null;
        this.down = { ...this.down, cause: 'closed' };
        this.retryAt = now + POLL_FAST_MS;
      } else if (cause === 'closed' || (cause === 'ice-failed' && this.down.cause === 'pongs')) this.down = { ...this.down, cause };
    } else this.down = { since: now, cause };
    this.set({});
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
    if (this.role === 'camera') this.tickCamera(now);
    else this.tickScoreboard(now);
    this.set({});
  }

  private tickCamera(now: number): void {
    if (this.busy) return;
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
      let sdp: string;
      try {
        sdp = await this.makeOffer(kind);
      } catch (err) {
        if (kind === 'fresh') throw err;
        kind = 'fresh';
        sdp = await this.makeOffer('fresh');
      }
      const gen = this.gen + 1;
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
