// The signaling helper (technical-design.md §4.2): a mailbox for WebRTC session descriptions between the
// camera and the scoreboard phone. One fetch handler routes /api/signal/*. It only ever holds a room code, a
// session secret and the latest offer/answer, all with a TTL; no score, name or video reaches it (R-PAIR-9,
// N-PRIV-1).
//
// Self-contained on purpose: Vercel builds one function per file under api/, and server/local.ts runs this
// same file under Node's type stripping, so it is erasable TypeScript with no relative imports.
import { Redis } from '@upstash/redis';

export const ROOM_TTL_S = 600; // a room code lives 10 minutes and is deleted on first read
export const SESSION_TTL_S = 6 * 3600; // refreshed on every write, so a match never outlives its session
export const CLAIM_LIMIT_PER_MIN = 20; // GET rooms/:code per IP: a six-digit code cannot be brute-forced in 10 min
export const CREATE_LIMIT_PER_MIN = 10; // POST rooms per IP: keeps the store from being flooded
export const MAX_BODY_BYTES = 16_384;
export const MAX_SDP_BYTES = 12_000; // a data-channel-only description with mDNS candidates is 1 to 2 kB

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

// ---- protocol of the mailbox ----

export interface Offer {
  gen: number;
  sdp: string;
  /** A description for a new RTCPeerConnection rather than an ICE restart of the current one. */
  fresh: boolean;
  at: number;
}
export type Answer = Offer;

interface Session {
  secret: string;
}

export interface HandlerOptions {
  now?: () => number;
  randomBytes?: (n: number) => Uint8Array;
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

/** The path below /api/signal: from the pathname, or from the `path` query a rewrite may add. */
function routeOf(url: URL): string[] {
  let p = url.pathname.replace(/^\/api\/signal\/?/, '');
  if (!p && url.searchParams.get('path')) p = url.searchParams.get('path')!;
  return p.split('/').filter(Boolean);
}

export function createHandler(getStore: () => SignalStore | null, opts: HandlerOptions = {}): (req: Request) => Promise<Response> {
  const now = opts.now ?? Date.now;
  const randomBytes = opts.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));

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
      const offer: Offer = { gen: 1, sdp, fresh: true, at: now() };
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
        const desc: Offer = { gen, sdp, fresh: body.fresh === true, at: now() };
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
  fetch: createHandler(() => (store === undefined ? (store = storeFromEnv(process.env)) : store)),
};
