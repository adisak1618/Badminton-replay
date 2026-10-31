// The signaling helper (technical-design.md §4.2): a mailbox for WebRTC session descriptions between the
// camera and the scoreboard phone. One fetch handler routes /api/signal/*. It only ever holds a room code, a
// session secret and the latest offer/answer, all with a TTL; no score, name or video reaches it (R-PAIR-9,
// N-PRIV-1).
//
// Self-contained on purpose: Vercel builds one function per file under api/, and server/local.ts runs this
// same file under Node's type stripping, so it is erasable TypeScript with no relative imports.
//
// It also mints short-lived TURN credentials for a live session (GET sessions/:id/ice), so two phones that
// share no network can still connect through a relay; the TURN key never reaches the phones.
//
// Either phone may offer a new connection (the camera to reconnect, a scoreboard coming back from a locked
// screen); GET sessions/:id/poll gives each side what the other one posted. POST sessions/:id/end marks a
// pairing one phone ended, so the other learns it even when the goodbye on the channel was lost, and why: it
// unpaired, withdrew the code, could not connect, or runs another protocol version.
//
// Each description may say which build and protocol version made it and whether that phone had a relay, so
// the other phone can refuse a build it cannot talk to, or say why a link cannot open, before the data
// channel exists (a build that cannot open the channel was never told, 2026-10-30). Older builds send none of it.
import { Redis } from '@upstash/redis';

export const ROOM_TTL_S = 600; // a room code lives 10 minutes and is deleted on first read
export const SESSION_TTL_S = 6 * 3600; // refreshed on every write, so a match never outlives its session
export const CLAIM_LIMIT_PER_MIN = 20; // GET rooms/:code per IP: a six-digit code cannot be brute-forced in 10 min
export const CREATE_LIMIT_PER_MIN = 10; // POST rooms per IP: keeps the store from being flooded
export const MAX_BODY_BYTES = 16_384;
export const MAX_SDP_BYTES = 12_000; // a data-channel-only description with mDNS candidates is 1 to 2 kB
export const ICE_LIMIT_PER_MIN = 30; // GET sessions/:id/ice per IP: one per new connection or ICE restart
export const TURN_TTL_S = 3600; // TURN credentials live an hour; the phones fetch new ones before that
export const TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';
export const TURN_TIMEOUT_MS = 3000; // inside the phones' 4 s helper timeout

/** The store behind the helper: Redis on Vercel, a Map for local runs and tests. Values are strings. */
export interface SignalStore {
  get(key: string): Promise<string | null>;
  /** Write with a TTL; with `nx` only when the key is absent. Returns whether it was written. */
  set(key: string, value: string, ttlS: number, nx?: boolean): Promise<boolean>;
  /** Read and delete in one step (one-shot room codes). */
  take(key: string): Promise<string | null>;
  /** Increment a counter; its TTL starts with the first increment. */
  incr(key: string, ttlS: number): Promise<number>;
  expire(key: string, ttlS: number): Promise<void>;
}

export class MemoryStore implements SignalStore {
  private data = new Map<string, { v: string; exp: number }>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private live(key: string): { v: string; exp: number } | null {
    const e = this.data.get(key);
    if (!e) return null;
    if (e.exp <= this.now()) {
      this.data.delete(key);
      return null;
    }
    return e;
  }

  async get(key: string) {
    return this.live(key)?.v ?? null;
  }
  async set(key: string, value: string, ttlS: number, nx = false) {
    if (nx && this.live(key)) return false;
    this.data.set(key, { v: value, exp: this.now() + ttlS * 1000 });
    return true;
  }
  async take(key: string) {
    const e = this.live(key);
    this.data.delete(key);
    return e?.v ?? null;
  }
  async incr(key: string, ttlS: number) {
    const e = this.live(key);
    const n = (e ? Number(e.v) : 0) + 1;
    this.data.set(key, { v: String(n), exp: e ? e.exp : this.now() + ttlS * 1000 });
    return n;
  }
  async expire(key: string, ttlS: number) {
    const e = this.live(key);
    if (e) e.exp = this.now() + ttlS * 1000;
  }
  /** Every live key, for tests that check nothing outlives its TTL. */
  keys(): string[] {
    return [...this.data.keys()].filter((k) => this.live(k));
  }
}

export class RedisStore implements SignalStore {
  private r: Redis;

  constructor(url: string, token: string) {
    this.r = new Redis({ url, token, automaticDeserialization: false });
  }

  async get(key: string) {
    return (await this.r.get<string>(key)) ?? null;
  }
  async set(key: string, value: string, ttlS: number, nx = false) {
    const res = nx ? await this.r.set(key, value, { ex: ttlS, nx: true }) : await this.r.set(key, value, { ex: ttlS });
    return res === 'OK';
  }
  async take(key: string) {
    return (await this.r.getdel<string>(key)) ?? null;
  }
  async incr(key: string, ttlS: number) {
    const n = await this.r.incr(key);
    if (n === 1) await this.r.expire(key, ttlS);
    return n;
  }
  async expire(key: string, ttlS: number) {
    await this.r.expire(key, ttlS);
  }
}

type Env = Record<string, string | undefined>;

/**
 * The Redis REST credentials the Vercel Marketplace integration injects. Upstash's own names first, then the
 * KV_* names the Marketplace store uses, then either with the custom prefix that can be chosen when the store
 * is connected to the project (e.g. SIGNAL_KV_REST_API_URL).
 */
export function redisCredentials(env: Env): { url: string; token: string } | null {
  const base: Array<[string, string]> = [
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
  ];
  const pairs = [...base];
  for (const name of Object.keys(env).sort()) {
    for (const [u, t] of base) if (name.endsWith(`_${u}`)) pairs.push([name, name.slice(0, -u.length) + t]);
  }
  for (const [u, t] of pairs) {
    const url = env[u];
    const token = env[t];
    if (url && token) return { url, token };
  }
  return null;
}

/** SIGNAL_STORE=memory for local runs; otherwise Redis, or null when the integration is not installed yet. */
export function storeFromEnv(env: Env): SignalStore | null {
  if (env.SIGNAL_STORE === 'memory') return new MemoryStore();
  const c = redisCredentials(env);
  return c ? new RedisStore(c.url, c.token) : null;
}

// ---- TURN credentials (Cloudflare Realtime TURN) ----

export interface TurnConfig {
  keyId: string;
  token: string;
  /** The keys endpoint; TURN_API_URL replaces it for a local stand-in (e2e). */
  api: string;
}

/** TURN_KEY_ID and TURN_KEY_API_TOKEN, the names Cloudflare's docs use; null when either is missing. */
export function turnFromEnv(env: Env): TurnConfig | null {
  const keyId = env.TURN_KEY_ID?.trim();
  const token = env.TURN_KEY_API_TOKEN?.trim();
  if (!keyId || !token) return null;
  return { keyId, token, api: (env.TURN_API_URL?.trim() || TURN_API).replace(/\/$/, '') };
}

export interface TurnServer {
  urls: string[];
  username: string;
  credential: string;
}

export type TurnFailure = 'auth' | 'upstream' | 'unreachable' | 'bad-response';

export class TurnError extends Error {
  reason: TurnFailure;
  constructor(reason: TurnFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Generate credentials valid for `ttlS` seconds: POST {api}/{keyId}/credentials/generate-ice-servers with the
 * key's API token, which answers 201 with `{iceServers: [{urls}, {urls, username, credential}]}`
 * (https://developers.cloudflare.com/realtime/turn/generate-credentials/). Only the TURN entries are kept:
 * the phones add the STUN servers themselves.
 */
export async function mintTurn(cfg: TurnConfig, ttlS: number, fetchImpl: Fetch = (i, init) => fetch(i, init)): Promise<TurnServer[]> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.api}/${encodeURIComponent(cfg.keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: ttlS }),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new TurnError('unreachable', (err as Error)?.message ?? String(err));
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) throw new TurnError('auth', `TURN key rejected (${res.status})`);
  if (!res.ok) throw new TurnError('upstream', `TURN API answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as { iceServers?: unknown } | null;
  // An array today; a single object in the older generate endpoint.
  const list = Array.isArray(body?.iceServers) ? body.iceServers : body?.iceServers ? [body.iceServers] : [];
  const out: TurnServer[] = [];
  for (const e of list as Array<{ urls?: unknown; username?: unknown; credential?: unknown }>) {
    if (typeof e?.username !== 'string' || typeof e.credential !== 'string') continue;
    const urls = (Array.isArray(e.urls) ? e.urls : [e.urls]).filter((u): u is string => typeof u === 'string' && /^turns?:/.test(u));
    if (urls.length) out.push({ urls, username: e.username, credential: e.credential });
  }
  if (!out.length) throw new TurnError('bad-response', 'no TURN server in the reply');
  return out;
}

// ---- protocol of the mailbox ----

export type Side = 'camera' | 'scoreboard';

/** What the sending phone says about itself: its build, protocol version, and relay state ('ready', 'failed: …'). */
export interface PeerMeta {
  app?: string;
  v?: number;
  relay?: string;
}

export interface Offer extends PeerMeta {
  gen: number;
  sdp: string;
  /** A description for a new RTCPeerConnection rather than an ICE restart of the current one. */
  fresh: boolean;
  at: number;
  /** Which phone made it; offers before this field were the camera's. */
  by?: Side;
}
export type Answer = Offer;

/** Why a phone ended a session: unpaired, withdrew its code (or showed a new one), could not connect, or the other phone's protocol is not its own. */
export const END_REASONS = ['unpaired', 'withdrawn', 'unreachable', 'version'] as const;
export type EndReason = (typeof END_REASONS)[number];

interface Session {
  secret: string;
  /** One phone ended it: every later call on the session answers 410 `ended`, with the reason and that phone's build. */
  ended?: boolean;
  reason?: EndReason;
  app?: string;
  v?: number;
}

export interface HandlerOptions {
  now?: () => number;
  randomBytes?: (n: number) => Uint8Array;
  /** Where TURN credentials come from; none means the phones stay on the local network. */
  turn?: () => TurnConfig | null;
  /** For the TURN API. */
  fetch?: Fetch;
}

const CODE = /^\d{6}$/;
const ID = /^[0-9a-f]{32}$/;

class HttpError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, error: string, extra: Record<string, unknown> = {}) {
    super(error);
    this.status = status;
    this.body = { error, ...extra };
  }
}

function json(status: number, body?: unknown): Response {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (body === undefined) return new Response(null, { status, headers });
  headers['Content-Type'] = 'application/json';
  return new Response(JSON.stringify(body), { status, headers });
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function clientIp(req: Request): string {
  const h = req.headers;
  const fwd = h.get('x-vercel-forwarded-for') ?? h.get('x-forwarded-for') ?? h.get('x-real-ip') ?? '';
  return fwd.split(',')[0].trim() || 'unknown';
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'too-large');
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'too-large');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad-json');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad-body');
  return body as Record<string, unknown>;
}

function sdpOf(v: unknown): string {
  if (typeof v !== 'string' || !v.startsWith('v=0')) throw new HttpError(400, 'bad-sdp');
  if (v.length > MAX_SDP_BYTES) throw new HttpError(413, 'too-large');
  return v;
}

function genOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1_000_000) throw new HttpError(400, 'bad-gen');
  return v;
}

/** The sender's build, protocol and relay state, when present and sane; anything else is dropped, never refused. */
function metaOf(body: Record<string, unknown>): PeerMeta {
  const m: PeerMeta = {};
  if (typeof body.app === 'string' && body.app.length <= 100 && /^[\w.@+:-]+$/.test(body.app)) m.app = body.app;
  if (typeof body.v === 'number' && Number.isInteger(body.v) && body.v >= 1 && body.v <= 1000) m.v = body.v;
  if (typeof body.relay === 'string' && body.relay.length <= 160) m.relay = body.relay;
  return m;
}

/** The path below /api/signal: from the pathname, or from the `path` query a rewrite may add. */
function routeOf(url: URL): string[] {
  let p = url.pathname.replace(/^\/api\/signal\/?/, '');
  if (!p && url.searchParams.get('path')) p = url.searchParams.get('path')!;
  return p.split('/').filter(Boolean);
}

export function createHandler(getStore: () => SignalStore | null, opts: HandlerOptions = {}): (req: Request) => Promise<Response> {
  const now = opts.now ?? Date.now;
  const randomBytes = opts.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const turn = opts.turn ?? (() => null);

  const limit = async (store: SignalStore, bucket: string, req: Request, max: number) => {
    const n = await store.incr(`rl:${bucket}:${clientIp(req)}:${Math.floor(now() / 60_000)}`, 60);
    if (n > max) throw new HttpError(429, 'rate-limited');
  };

  const session = async (store: SignalStore, id: string, secret: unknown): Promise<Session> => {
    if (!ID.test(id)) throw new HttpError(404, 'no-session');
    const raw = await store.get(`sess:${id}`);
    if (!raw) throw new HttpError(404, 'no-session');
    const s = JSON.parse(raw) as Session;
    if (typeof secret !== 'string' || !sameSecret(secret, s.secret)) throw new HttpError(403, 'bad-secret');
    if (s.ended) throw new HttpError(410, 'ended', { reason: s.reason ?? 'unpaired', ...(s.app ? { app: s.app } : {}), ...(s.v ? { v: s.v } : {}) });
    return s;
  };

  const readDesc = async (store: SignalStore, key: string): Promise<Offer | null> => {
    const raw = await store.get(key);
    return raw ? (JSON.parse(raw) as Offer) : null;
  };

  /** Every write keeps the whole session alive for another SESSION_TTL_S. */
  const touch = async (store: SignalStore, id: string) => {
    await Promise.all(['sess', 'offer', 'answer'].map((k) => store.expire(`${k}:${id}`, SESSION_TTL_S)));
  };

  const newCode = async (store: SignalStore, sessionId: string): Promise<string> => {
    for (let i = 0; i < 20; i++) {
      const b = randomBytes(4);
      const n = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
      const code = String(n % 1_000_000).padStart(6, '0');
      if (await store.set(`room:${code}`, sessionId, ROOM_TTL_S, true)) return code;
    }
    throw new HttpError(503, 'no-free-code');
  };

  const route = async (req: Request, store: SignalStore): Promise<Response> => {
    const url = new URL(req.url);
    const [a, b, c] = routeOf(url);
    const m = req.method;
    const headerSecret = req.headers.get('x-signal-secret');

    if (a === 'rooms' && !b) {
      if (m !== 'POST') throw new HttpError(405, 'method');
      await limit(store, 'create', req, CREATE_LIMIT_PER_MIN);
      const body = await readBody(req);
      const sdp = sdpOf(body.offer);
      const id = hex(randomBytes(16));
      const secret = hex(randomBytes(16));
      await store.set(`sess:${id}`, JSON.stringify({ secret } satisfies Session), SESSION_TTL_S);
      const offer: Offer = { gen: 1, sdp, fresh: true, at: now(), ...metaOf(body) };
      await store.set(`offer:${id}`, JSON.stringify(offer), SESSION_TTL_S);
      const code = await newCode(store, id);
      return json(201, { code, session: id, secret, expiresIn: ROOM_TTL_S });
    }

    if (a === 'rooms' && b && !c) {
      if (m !== 'GET') throw new HttpError(405, 'method');
      await limit(store, 'claim', req, CLAIM_LIMIT_PER_MIN);
      if (!CODE.test(b)) throw new HttpError(404, 'no-room');
      const id = await store.take(`room:${b}`);
      if (!id) throw new HttpError(404, 'no-room');
      const raw = await store.get(`sess:${id}`);
      const offer = await readDesc(store, `offer:${id}`);
      if (!raw || !offer) throw new HttpError(404, 'no-room');
      return json(200, { session: id, secret: (JSON.parse(raw) as Session).secret, offer });
    }

    if (a === 'sessions' && b && (c === 'answer' || c === 'offer')) {
      if (m === 'POST') {
        const body = await readBody(req);
        await session(store, b, body.secret ?? headerSecret);
        const gen = genOf(body.gen);
        const sdp = sdpOf(c === 'answer' ? body.answer : body.offer);
        const desc: Offer = { gen, sdp, fresh: body.fresh === true, at: now(), ...metaOf(body) };
        if (c === 'offer') desc.by = body.by === 'scoreboard' ? 'scoreboard' : 'camera';
        const current = await readDesc(store, `offer:${b}`);
        if (c === 'answer' && current?.gen !== gen) throw new HttpError(409, 'stale', { gen: current?.gen ?? 0 });
        if (c === 'offer' && current && gen <= current.gen) throw new HttpError(409, 'stale', { gen: current.gen });
        await store.set(`${c}:${b}`, JSON.stringify(desc), SESSION_TTL_S);
        await touch(store, b);
        return json(204);
      }
      if (m === 'GET') {
        await session(store, b, headerSecret);
        const gen = Number(url.searchParams.get('gen') ?? 0);
        const desc = await readDesc(store, `${c}:${b}`);
        // An answer is fetched for exactly its offer's generation; an offer when it is newer than the last seen.
        const ready = desc && (c === 'answer' ? desc.gen === gen : desc.gen > gen);
        return ready ? json(200, { [c]: desc }) : json(204);
      }
      throw new HttpError(405, 'method');
    }

    if (a === 'sessions' && b && c === 'poll') {
      if (m !== 'GET') throw new HttpError(405, 'method');
      await session(store, b, headerSecret);
      const side = url.searchParams.get('role');
      if (side !== 'camera' && side !== 'scoreboard') throw new HttpError(400, 'bad-role');
      const gen = Number(url.searchParams.get('gen') ?? 0);
      const offer = await readDesc(store, `offer:${b}`);
      const mine = (offer?.by ?? 'camera') === side;
      // The other phone's newer offer comes first: it supersedes whatever this phone is waiting for.
      if (offer && !mine && offer.gen > gen) return json(200, { offer });
      if (offer && mine && offer.gen === gen) {
        const answer = await readDesc(store, `answer:${b}`);
        if (answer?.gen === gen) return json(200, { answer });
      }
      return json(204);
    }

    if (a === 'sessions' && b && c === 'end') {
      if (m !== 'POST') throw new HttpError(405, 'method');
      const body = await readBody(req);
      const s = await session(store, b, body.secret ?? headerSecret);
      const reason = END_REASONS.find((r) => r === body.reason) ?? 'unpaired';
      const { app, v } = metaOf(body);
      await store.set(`sess:${b}`, JSON.stringify({ ...s, ended: true, reason, ...(app ? { app } : {}), ...(v ? { v } : {}) } satisfies Session), SESSION_TTL_S);
      await Promise.all(['offer', 'answer'].map((k) => store.take(`${k}:${b}`)));
      return json(204);
    }

    if (a === 'sessions' && b && c === 'ice') {
      if (m !== 'GET') throw new HttpError(405, 'method');
      await session(store, b, headerSecret);
      await limit(store, 'ice', req, ICE_LIMIT_PER_MIN);
      const cfg = turn();
      if (!cfg) return json(200, { relay: 'not-configured' });
      try {
        const iceServers = await mintTurn(cfg, TURN_TTL_S, opts.fetch);
        return json(200, { relay: 'ok', iceServers, ttl: TURN_TTL_S });
      } catch (err) {
        if (!(err instanceof TurnError)) throw err;
        console.error('TURN credentials failed', err.reason, err.message);
        throw new HttpError(503, 'relay-failed', { reason: err.reason });
      }
    }

    throw new HttpError(404, 'not-found');
  };

  return async (req: Request): Promise<Response> => {
    let store: SignalStore | null;
    try {
      store = getStore();
    } catch {
      store = null;
    }
    if (!store) return json(500, { error: 'store-not-configured' });
    try {
      return await route(req, store);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, err.body);
      console.error('signal helper failed', err);
      return json(503, { error: 'store' });
    }
  };
}

let store: SignalStore | null | undefined;

export default {
  fetch: createHandler(() => (store === undefined ? (store = storeFromEnv(process.env)) : store), { turn: () => turnFromEnv(process.env) }),
};
