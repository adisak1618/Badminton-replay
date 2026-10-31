// Client for the signaling helper (api/signal.ts, technical-design.md §4.2). Every call times out quickly so
// "no internet" shows within 5 s (R-PAIR-1); the helper's error codes become one of a few kinds the UI words.
import type { EndReason, Offer, PeerMeta, Side, TurnServer } from '../../api/signal';

export type Desc = Pick<Offer, 'gen' | 'sdp' | 'fresh' | 'by' | 'app' | 'v' | 'relay'>;

/**
 * What the other phone posted for this one: its newer offer, or the answer to this phone's offer; or, asked with
 * `seen`, that it has fetched this phone's answer.
 */
export type PollReply = { offer: Desc } | { answer: Desc } | { seen: true } | null;

export type HelperErrorKind =
  | 'offline' // no internet, or the helper cannot be reached
  | 'no-room' // the code is wrong, used or expired
  | 'no-session' // the pairing expired (6 h without a write) or never existed
  | 'rate-limited'
  | 'stale' // another description for this session is newer
  | 'ended' // the other phone unpaired
  | 'helper'; // the helper answered with an error: store not configured, store down

/** On 'ended': why the other phone ended the session, and its build and protocol when it said. */
export interface Ended {
  reason: EndReason;
  app?: string;
  v?: number;
}

export class HelperError extends Error {
  readonly kind: HelperErrorKind;
  readonly status: number;
  /** On 'stale': the newest generation the helper holds. */
  readonly gen?: number;
  readonly ended?: Ended;
  constructor(kind: HelperErrorKind, status: number, message?: string, gen?: number, ended?: Ended) {
    super(message ?? kind);
    this.kind = kind;
    this.status = status;
    this.gen = gen;
    this.ended = ended;
  }
}

export const HELPER_TIMEOUT_MS = 4000;

export interface Session {
  session: string;
  secret: string;
}

/** TURN credentials for a session, or that the helper has no TURN key (the link stays on the local network). */
export type IceReply = { relay: 'ok'; iceServers: TurnServer[]; ttl: number } | { relay: 'not-configured' };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class HelperClient {
  private readonly base: string;
  private readonly fetchImpl: Fetch;

  constructor(base = '/api/signal', fetchImpl: Fetch = (i, init) => fetch(i, init)) {
    this.base = base;
    this.fetchImpl = fetchImpl;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: object, secret?: string): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (secret) headers['X-Signal-Secret'] = secret;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(HELPER_TIMEOUT_MS),
      });
    } catch (err) {
      throw new HelperError('offline', 0, (err as Error).message);
    }
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.ok) return { status: res.status, json };
    const code: string | undefined = json?.error;
    if (res.status === 404 && (code === 'no-room' || code === 'no-session')) throw new HelperError(code, 404);
    if (res.status === 429) throw new HelperError('rate-limited', 429);
    if (res.status === 410 && code === 'ended') throw new HelperError('ended', 410, undefined, undefined, { reason: json?.reason ?? 'unpaired', app: json?.app, v: json?.v });
    if (res.status === 409) throw new HelperError('stale', 409, code, typeof json?.gen === 'number' ? json.gen : undefined);
    // A gateway error or an HTML page instead of JSON: the helper is not reachable as such.
    if (!code || res.status === 502 || res.status === 504) throw new HelperError('offline', res.status);
    throw new HelperError('helper', res.status, json?.reason ? `${code}: ${json.reason}` : code);
  }

  /** Camera: open a room with the first offer (and what this phone says about itself). */
  async createRoom(sdp: string, meta: PeerMeta = {}): Promise<Session & { code: string; expiresIn: number }> {
    return (await this.call('POST', '/rooms', { offer: sdp, ...meta })).json;
  }

  /**
   * Scoreboard: take the room (one-shot) and get the session and the camera's offer. With `claim`, the same
   * claim may be asked again for a minute and gets the same session (a claim whose reply never came).
   */
  async claimRoom(code: string, claim?: string): Promise<Session & { offer: Desc }> {
    return (await this.call('GET', `/rooms/${encodeURIComponent(code)}${claim ? `?claim=${claim}` : ''}`)).json;
  }

  async postOffer(s: Session, d: Desc): Promise<void> {
    await this.call('POST', `/sessions/${s.session}/offer`, { secret: s.secret, gen: d.gen, offer: d.sdp, fresh: d.fresh, by: d.by, app: d.app, v: d.v, relay: d.relay });
  }

  /**
   * The other phone's offer newer than `gen`, or the answer to this phone's offer `gen`, or null. With `seen`,
   * also whether the other phone has fetched this phone's answer to `gen`.
   */
  async poll(s: Session, gen: number, side: Side, seen = false): Promise<PollReply> {
    const r = await this.call('GET', `/sessions/${s.session}/poll?gen=${gen}&role=${side}${seen ? '&seen=1' : ''}`, undefined, s.secret);
    return r.json?.offer ? { offer: r.json.offer } : r.json?.answer ? { answer: r.json.answer } : r.json?.seen ? { seen: true } : null;
  }

  /**
   * end() for a page that is going away (pagehide): sendBeacon outlives the page, a fetch may not. Used for a code
   * on show, so a scoreboard that types it is told the code is gone instead of waiting for a page that is not there.
   */
  endBeacon(s: Session, why: { reason?: EndReason } & PeerMeta = {}): void {
    const body = JSON.stringify({ secret: s.secret, reason: why.reason, app: why.app, v: why.v });
    const url = `${this.base}/sessions/${s.session}/end`;
    try {
      if (navigator.sendBeacon?.(url, new Blob([body], { type: 'application/json' }))) return;
    } catch {
      // no beacon here: try a keepalive fetch
    }
    void this.fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }

  /** This phone ended the session: the other one learns it, and why, at its next poll, whatever became of the goodbye. */
  async end(s: Session, why: { reason?: EndReason } & PeerMeta = {}): Promise<void> {
    await this.call('POST', `/sessions/${s.session}/end`, { secret: s.secret, reason: why.reason, app: why.app, v: why.v });
  }

  async postAnswer(s: Session, d: Desc): Promise<void> {
    await this.call('POST', `/sessions/${s.session}/answer`, { secret: s.secret, gen: d.gen, answer: d.sdp, fresh: d.fresh, app: d.app, v: d.v, relay: d.relay });
  }

  /** Short-lived TURN credentials for this session (api/signal.ts, mintTurn). */
  async getIce(s: Session): Promise<IceReply> {
    return (await this.call('GET', `/sessions/${s.session}/ice`, undefined, s.secret)).json;
  }
}
