// Client for the signaling helper (api/signal.ts, technical-design.md §4.2). Every call times out quickly so
// "no internet" shows within 5 s (R-PAIR-1); the helper's error codes become one of a few kinds the UI words.
import type { Offer, Side, TurnServer } from '../../api/signal';

export type Desc = Pick<Offer, 'gen' | 'sdp' | 'fresh' | 'by'>;

/** What the other phone posted for this one: its newer offer, or the answer to this phone's offer. */
export type PollReply = { offer: Desc } | { answer: Desc } | null;

export type HelperErrorKind =
  | 'offline' // no internet, or the helper cannot be reached
  | 'no-room' // the code is wrong, used or expired
  | 'no-session' // the pairing expired (6 h without a write) or never existed
  | 'rate-limited'
  | 'stale' // another description for this session is newer
  | 'ended' // the other phone unpaired
  | 'helper'; // the helper answered with an error: store not configured, store down

export class HelperError extends Error {
  readonly kind: HelperErrorKind;
  readonly status: number;
  /** On 'stale': the newest generation the helper holds. */
  readonly gen?: number;
  constructor(kind: HelperErrorKind, status: number, message?: string, gen?: number) {
    super(message ?? kind);
    this.kind = kind;
    this.status = status;
    this.gen = gen;
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
    if (res.status === 410 && code === 'ended') throw new HelperError('ended', 410);
    if (res.status === 409) throw new HelperError('stale', 409, code, typeof json?.gen === 'number' ? json.gen : undefined);
    // A gateway error or an HTML page instead of JSON: the helper is not reachable as such.
    if (!code || res.status === 502 || res.status === 504) throw new HelperError('offline', res.status);
    throw new HelperError('helper', res.status, json?.reason ? `${code}: ${json.reason}` : code);
  }

  /** Camera: open a room with the first offer. */
  async createRoom(sdp: string): Promise<Session & { code: string; expiresIn: number }> {
    return (await this.call('POST', '/rooms', { offer: sdp })).json;
  }

  /** Scoreboard: take the room (one-shot) and get the session and the camera's offer. */
  async claimRoom(code: string): Promise<Session & { offer: Desc }> {
    return (await this.call('GET', `/rooms/${encodeURIComponent(code)}`)).json;
  }

  async postOffer(s: Session, d: Desc): Promise<void> {
    await this.call('POST', `/sessions/${s.session}/offer`, { secret: s.secret, gen: d.gen, offer: d.sdp, fresh: d.fresh, by: d.by });
  }

  /** The other phone's offer newer than `gen`, or the answer to this phone's offer `gen`, or null. */
  async poll(s: Session, gen: number, side: Side): Promise<PollReply> {
    const r = await this.call('GET', `/sessions/${s.session}/poll?gen=${gen}&role=${side}`, undefined, s.secret);
    return r.json?.offer ? { offer: r.json.offer } : r.json?.answer ? { answer: r.json.answer } : null;
  }

  /** This phone unpaired: the other one learns it at its next poll, whatever became of the goodbye. */
  async end(s: Session): Promise<void> {
    await this.call('POST', `/sessions/${s.session}/end`, { secret: s.secret });
  }

  async postAnswer(s: Session, d: Desc): Promise<void> {
    await this.call('POST', `/sessions/${s.session}/answer`, { secret: s.secret, gen: d.gen, answer: d.sdp, fresh: d.fresh });
  }

  /** Short-lived TURN credentials for this session (api/signal.ts, mintTurn). */
  async getIce(s: Session): Promise<IceReply> {
    return (await this.call('GET', `/sessions/${s.session}/ice`, undefined, s.secret)).json;
  }
}
