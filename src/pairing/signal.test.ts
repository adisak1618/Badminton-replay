// The signaling helper (api/signal.ts) against the in-memory store: one-shot codes, generations, secrets,
// TTL expiry, rate limits, size caps, and that nothing but descriptors and secrets is ever stored (R-PAIR-9).
import { describe, expect, it } from 'vitest';
import {
  CLAIM_LIMIT_PER_MIN,
  MAX_BODY_BYTES,
  MemoryStore,
  ROOM_TTL_S,
  SESSION_TTL_S,
  createHandler,
  redisCredentials,
  storeFromEnv,
} from '../../api/signal';
import { HelperClient, HelperError } from './helper';

const SDP = (tag: string) => `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=${tag}\r\na=candidate:1 1 udp 1 abc.local 5000 typ host\r\n`;

function setup() {
  let t = 1_800_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const store = new MemoryStore(clock.now);
  let ip = '10.0.0.1';
  const handler = createHandler(() => store, { now: clock.now });
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('x-forwarded-for', ip);
    return handler(new Request(`https://app.test${url}`, { ...init, headers }));
  };
  const client = new HelperClient('/api/signal', fetchImpl);
  return { store, clock, client, handler, setIp: (v: string) => (ip = v), fetchImpl };
}

async function kind(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof HelperError ? err.kind : String(err);
  }
}

describe('signaling helper', () => {
  it('pairs: room -> one-shot claim -> answer for that generation', async () => {
    const { client } = setup();
    const room = await client.createRoom(SDP('offer1'));
    expect(room.code).toMatch(/^\d{6}$/);
    expect(room.session).toMatch(/^[0-9a-f]{32}$/);
    expect(room.secret).toMatch(/^[0-9a-f]{32}$/);
    expect(room.expiresIn).toBe(ROOM_TTL_S);

    const claimed = await client.claimRoom(room.code);
    expect(claimed.session).toBe(room.session);
    expect(claimed.secret).toBe(room.secret);
    expect(claimed.offer).toMatchObject({ gen: 1, sdp: SDP('offer1'), fresh: true });
    expect(await kind(client.claimRoom(room.code))).toBe('no-room'); // one-shot

    expect(await client.poll(room, 1, 'camera')).toBeNull();
    await client.postAnswer(claimed, { gen: 1, sdp: SDP('answer1'), fresh: true });
    expect(await client.poll(room, 1, 'camera')).toEqual({ answer: expect.objectContaining({ gen: 1, sdp: SDP('answer1') }) });
    expect(await client.poll(room, 1, 'scoreboard')).toBeNull(); // nothing new for the scoreboard
  });

  it('reconnect generations: offers must grow, answers must match the current offer', async () => {
    const { client } = setup();
    const room = await client.createRoom(SDP('o1'));
    await client.claimRoom(room.code);
    expect(await client.poll(room, 1, 'scoreboard')).toBeNull(); // nothing newer than what the scoreboard answered

    await client.postOffer(room, { gen: 2, sdp: SDP('restart'), fresh: false });
    expect(await client.poll(room, 1, 'scoreboard')).toEqual({ offer: expect.objectContaining({ gen: 2, fresh: false, by: 'camera' }) });
    expect(await client.poll(room, 2, 'scoreboard')).toBeNull();

    const stale = await client.postOffer(room, { gen: 2, sdp: SDP('again'), fresh: true }).catch((e) => e);
    expect(stale).toBeInstanceOf(HelperError);
    expect(stale).toMatchObject({ kind: 'stale', gen: 2 });

    expect(await kind(client.postAnswer(room, { gen: 1, sdp: SDP('late'), fresh: false }))).toBe('stale');
    await client.postAnswer(room, { gen: 2, sdp: SDP('a2'), fresh: false });
    await client.postOffer(room, { gen: 3, sdp: SDP('fresh'), fresh: true });
    expect(await client.poll(room, 2, 'scoreboard')).toEqual({ offer: expect.objectContaining({ gen: 3, fresh: true }) });
    expect(await client.poll(room, 3, 'camera')).toBeNull(); // not answered yet
  });

  it('either phone may offer: a scoreboard back from a locked screen offers, the camera answers (§4.5)', async () => {
    const { client } = setup();
    const room = await client.createRoom(SDP('o1'));
    const sb = await client.claimRoom(room.code);
    await client.postAnswer(sb, { gen: 1, sdp: SDP('a1'), fresh: true });
    await client.postOffer(room, { gen: 2, sdp: SDP('restart'), fresh: false, by: 'camera' }); // the camera's waiting restart
    // The scoreboard does not trust the old connection: a fresh offer of its own, above the camera's.
    expect(await kind(client.postOffer(sb, { gen: 2, sdp: SDP('sb'), fresh: true, by: 'scoreboard' }))).toBe('stale');
    await client.postOffer(sb, { gen: 3, sdp: SDP('sb'), fresh: true, by: 'scoreboard' });
    expect(await client.poll(sb, 3, 'scoreboard')).toBeNull(); // its own offer is not handed back to it
    // The camera, waiting on gen 2, sees the newer offer from the other side and answers it.
    expect(await client.poll(room, 2, 'camera')).toEqual({ offer: expect.objectContaining({ gen: 3, by: 'scoreboard', sdp: SDP('sb') }) });
    await client.postAnswer(room, { gen: 3, sdp: SDP('cam-answer'), fresh: true });
    expect(await client.poll(sb, 3, 'scoreboard')).toEqual({ answer: expect.objectContaining({ gen: 3, sdp: SDP('cam-answer') }) });
  });

  it('a phone that unpairs ends the session: the other one hears "ended" at its next call, and the code is dead', async () => {
    const { client, store } = setup();
    const room = await client.createRoom(SDP('o1'));
    const sb = await client.claimRoom(room.code);
    await client.end(sb);
    expect(await kind(client.poll(room, 1, 'camera'))).toBe('ended');
    expect(await kind(client.postOffer(room, { gen: 2, sdp: SDP('x'), fresh: true }))).toBe('ended');
    expect(await kind(client.end(room))).toBe('ended');
    expect(store.keys().filter((k) => k.startsWith('offer:') || k.startsWith('answer:'))).toEqual([]);
    // A code withdrawn before anyone claimed it cannot be claimed afterwards.
    const r2 = await client.createRoom(SDP('o2'));
    await client.end(r2);
    expect(await kind(client.claimRoom(r2.code))).toBe('no-room');
  });

  it('every session call needs the secret', async () => {
    const { client } = setup();
    const room = await client.createRoom(SDP('o1'));
    const wrong = { session: room.session, secret: '0'.repeat(32) };
    expect(await kind(client.postOffer(wrong, { gen: 2, sdp: SDP('x'), fresh: true }))).toBe('helper');
    expect(await kind(client.poll(wrong, 1, 'camera'))).toBe('helper');
    expect(await kind(client.end(wrong))).toBe('helper');
    expect(await kind(client.poll({ session: 'f'.repeat(32), secret: room.secret }, 0, 'scoreboard'))).toBe('no-session');
  });

  it('room codes expire after 10 minutes, sessions 6 h after their last write', async () => {
    const { client, clock, store } = setup();
    const room = await client.createRoom(SDP('o1'));
    clock.advance(ROOM_TTL_S * 1000 + 1);
    expect(await kind(client.claimRoom(room.code))).toBe('no-room');

    const r2 = await client.createRoom(SDP('o2'));
    await client.claimRoom(r2.code);
    clock.advance(SESSION_TTL_S * 1000 - 60_000);
    await client.postOffer(r2, { gen: 2, sdp: SDP('o3'), fresh: true }); // a write refreshes the whole session
    clock.advance(SESSION_TTL_S * 1000 - 60_000);
    expect(await client.poll(r2, 1, 'scoreboard')).toEqual({ offer: expect.objectContaining({ gen: 2 }) });
    clock.advance(120_000);
    expect(await kind(client.poll(r2, 0, 'scoreboard'))).toBe('no-session');
    clock.advance(61_000); // the rate-limit counters are gone too
    expect(store.keys()).toEqual([]);
  });

  it('rate-limits claims per IP so a code cannot be brute-forced', async () => {
    const { client, clock, setIp } = setup();
    for (let i = 0; i < CLAIM_LIMIT_PER_MIN; i++) expect(await kind(client.claimRoom(String(100000 + i)))).toBe('no-room');
    expect(await kind(client.claimRoom('123456'))).toBe('rate-limited');
    setIp('10.0.0.2');
    expect(await kind(client.claimRoom('123456'))).toBe('no-room');
    setIp('10.0.0.1');
    clock.advance(60_000);
    expect(await kind(client.claimRoom('123456'))).toBe('no-room');
  });

  it('caps sizes and rejects bad input', async () => {
    const { handler, client } = setup();
    const post = (path: string, body: string) =>
      handler(new Request(`https://app.test/api/signal${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } }));
    expect((await post('/rooms', 'x'.repeat(MAX_BODY_BYTES + 1))).status).toBe(413);
    expect((await post('/rooms', JSON.stringify({ offer: SDP('x') + 'a'.repeat(13_000) }))).status).toBe(413);
    expect((await post('/rooms', JSON.stringify({ offer: 'not an sdp' }))).status).toBe(400);
    expect((await post('/rooms', '{bad json')).status).toBe(400);
    const room = await client.createRoom(SDP('o'));
    const bad = await post(`/sessions/${room.session}/offer`, JSON.stringify({ secret: room.secret, gen: 1.5, offer: SDP('o') }));
    expect(bad.status).toBe(400);
    expect((await handler(new Request('https://app.test/api/signal/nope'))).status).toBe(404);
    expect((await handler(new Request('https://app.test/api/signal/rooms'))).status).toBe(405);
  });

  it('stores only descriptors, the secret and counters, never match data (R-PAIR-9)', async () => {
    const { client, store } = setup();
    const room = await client.createRoom(SDP('o1'));
    await client.claimRoom(room.code);
    await client.postAnswer(room, { gen: 1, sdp: SDP('a1'), fresh: true });
    const prefixes = new Set(store.keys().map((k) => k.split(':')[0]));
    expect([...prefixes].sort()).toEqual(['answer', 'offer', 'rl', 'sess']);
    for (const k of store.keys()) {
      const v = (await store.get(k))!;
      if (k.startsWith('sess:')) expect(Object.keys(JSON.parse(v))).toEqual(['secret']);
      if (k.startsWith('offer:') || k.startsWith('answer:')) expect(Object.keys(JSON.parse(v)).sort()).toEqual(['at', 'fresh', 'gen', 'sdp']);
    }
  });

  it('routes the rewrite form (/api/signal?path=...) too, and reports a missing store', async () => {
    const { handler } = setup();
    const r = await handler(new Request('https://app.test/api/signal?path=rooms/123456'));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'no-room' });
    const none = createHandler(() => null);
    const res = await none(new Request('https://app.test/api/signal/rooms', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'store-not-configured' });
  });

  it('a network failure or gateway error is "offline" to the client (R-PAIR-1)', async () => {
    const down = new HelperClient('/api/signal', async () => {
      throw new TypeError('Load failed');
    });
    expect(await kind(down.createRoom(SDP('o')))).toBe('offline');
    const gateway = new HelperClient('/api/signal', async () => new Response('<html>', { status: 502 }));
    expect(await kind(gateway.claimRoom('123456'))).toBe('offline');
  });
});

describe('helper store from the environment', () => {
  it('reads Upstash, Marketplace KV and prefixed names, in that order', () => {
    expect(redisCredentials({ UPSTASH_REDIS_REST_URL: 'u', UPSTASH_REDIS_REST_TOKEN: 't', KV_REST_API_URL: 'k', KV_REST_API_TOKEN: 'kt' })).toEqual({
      url: 'u',
      token: 't',
    });
    expect(redisCredentials({ KV_REST_API_URL: 'k', KV_REST_API_TOKEN: 'kt', KV_URL: 'redis://x' })).toEqual({ url: 'k', token: 'kt' });
    expect(redisCredentials({ SIGNAL_KV_REST_API_URL: 'p', SIGNAL_KV_REST_API_TOKEN: 'pt' })).toEqual({ url: 'p', token: 'pt' });
    expect(redisCredentials({ KV_REST_API_URL: 'k' })).toBeNull();
    expect(storeFromEnv({})).toBeNull();
    expect(storeFromEnv({ SIGNAL_STORE: 'memory' })).toBeInstanceOf(MemoryStore);
  });
});
