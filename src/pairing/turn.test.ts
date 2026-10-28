// The helper's TURN credentials (GET sessions/:id/ice) against a stubbed Cloudflare Realtime TURN API: the
// request it sends (key id, bearer token, TTL), the reply it passes on, an unknown or revoked key, an API that
// is down, no TURN key at all (the phones stay on the local network), and the session secret in front of it.
import { describe, expect, it } from 'vitest';
import { ICE_LIMIT_PER_MIN, MemoryStore, TURN_API, TURN_TTL_S, createHandler, mintTurn, turnFromEnv, type TurnConfig } from '../../api/signal';
import { HelperClient, HelperError } from './helper';

const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=candidate:1 1 udp 1 abc.local 5000 typ host\r\n';

/** The reply of generate-ice-servers, as Cloudflare's docs show it (with the port 53 alternates). */
const CLOUDFLARE = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turn:turn.cloudflare.com:80?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'u-0123456789abcdef',
      credential: 'c-fedcba9876543210',
    },
  ],
};

const CFG: TurnConfig = { keyId: 'key-123', token: 'tok-secret', api: TURN_API };

function stubApi(reply: (req: { url: string; init: RequestInit }) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return reply({ url, init });
  };
  return { calls, fetchImpl };
}

const created = () => new Response(JSON.stringify(CLOUDFLARE), { status: 201, headers: { 'Content-Type': 'application/json' } });

function setup(turn: TurnConfig | null, reply: Parameters<typeof stubApi>[0] = created) {
  const store = new MemoryStore();
  const api = stubApi(reply);
  const handler = createHandler(() => store, { turn: () => turn, fetch: api.fetchImpl });
  const client = new HelperClient('/api/signal', async (url, init) => handler(new Request(`https://app.test${url}`, init)));
  return { client, api, handler, store };
}

describe('TURN credentials from the helper', () => {
  it('reads the key from TURN_KEY_ID and TURN_KEY_API_TOKEN; either missing means no relay', () => {
    expect(turnFromEnv({ TURN_KEY_ID: 'k', TURN_KEY_API_TOKEN: 't' })).toEqual({ keyId: 'k', token: 't', api: TURN_API });
    expect(turnFromEnv({ TURN_KEY_ID: 'k', TURN_KEY_API_TOKEN: 't', TURN_API_URL: 'http://127.0.0.1:9/v1/turn/keys/' })?.api).toBe('http://127.0.0.1:9/v1/turn/keys');
    expect(turnFromEnv({ TURN_KEY_ID: 'k' })).toBeNull();
    expect(turnFromEnv({ TURN_KEY_API_TOKEN: 't' })).toBeNull();
    expect(turnFromEnv({ TURN_KEY_ID: ' ', TURN_KEY_API_TOKEN: 't' })).toBeNull();
    expect(turnFromEnv({})).toBeNull();
  });

  it('mints credentials for an hour with the key id and token, and passes on only the TURN entry', async () => {
    const { client, api } = setup(CFG);
    const room = await client.createRoom(SDP);
    const r = await client.getIce(room);
    expect(r).toEqual({ relay: 'ok', iceServers: [CLOUDFLARE.iceServers[1]], ttl: TURN_TTL_S });
    expect(TURN_TTL_S).toBe(3600);
    expect(api.calls).toHaveLength(1);
    const { url, init } = api.calls[0];
    expect(url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key-123/credentials/generate-ice-servers');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok-secret');
    expect(JSON.parse(String(init.body))).toEqual({ ttl: 3600 });
  });

  it('the token never reaches the phone', async () => {
    const { handler, client } = setup(CFG);
    const room = await client.createRoom(SDP);
    const res = await handler(new Request(`https://app.test/api/signal/sessions/${room.session}/ice`, { headers: { 'X-Signal-Secret': room.secret } }));
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain('tok-secret');
    expect(text).not.toContain('key-123');
  });

  it('a rejected key (401/403/404) is relay-failed: auth', async () => {
    for (const status of [401, 403, 404]) {
      const { client } = setup(CFG, () => new Response('{"error":"unauthorized"}', { status }));
      const room = await client.createRoom(SDP);
      const err = await client.getIce(room).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HelperError);
      expect((err as HelperError).kind).toBe('helper');
      expect((err as HelperError).status).toBe(503);
      expect((err as HelperError).message).toBe('relay-failed: auth');
    }
  });

  it('an API that is down, unreachable or answers nonsense is relay-failed with the reason', async () => {
    const cases: Array<[Parameters<typeof stubApi>[0], string]> = [
      [() => new Response('oops', { status: 500 }), 'relay-failed: upstream'],
      [() => Promise.reject(new TypeError('fetch failed')), 'relay-failed: unreachable'],
      [() => new Response(JSON.stringify({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] }), { status: 201 }), 'relay-failed: bad-response'],
      [() => new Response('not json', { status: 201 }), 'relay-failed: bad-response'],
    ];
    for (const [reply, message] of cases) {
      const { client } = setup(CFG, reply);
      const room = await client.createRoom(SDP);
      expect(((await client.getIce(room).catch((e: unknown) => e)) as HelperError).message).toBe(message);
    }
  });

  it('accepts the older single-object reply', async () => {
    const { fetchImpl } = stubApi(() => new Response(JSON.stringify({ iceServers: CLOUDFLARE.iceServers[1] }), { status: 201 }));
    expect(await mintTurn(CFG, 60, fetchImpl)).toEqual([CLOUDFLARE.iceServers[1]]);
  });

  it('without a TURN key: not configured, and Cloudflare is never called', async () => {
    const { client, api } = setup(null);
    const room = await client.createRoom(SDP);
    expect(await client.getIce(room)).toEqual({ relay: 'not-configured' });
    expect(api.calls).toHaveLength(0);
  });

  it('only for a live session with its secret, and rate-limited', async () => {
    const { client, api, handler } = setup(CFG);
    const room = await client.createRoom(SDP);
    const kind = (p: Promise<unknown>) => p.then(() => 'ok', (e: HelperError) => e.kind ?? String(e));
    expect(await kind(client.getIce({ session: room.session, secret: '0'.repeat(32) }))).toBe('helper'); // 403 bad-secret
    expect(await kind(client.getIce({ session: 'f'.repeat(32), secret: room.secret }))).toBe('no-session');
    expect(api.calls).toHaveLength(0);
    const post = await handler(new Request(`https://app.test/api/signal/sessions/${room.session}/ice`, { method: 'POST', body: '{}' }));
    expect(post.status).toBe(405);
    for (let i = 0; i < ICE_LIMIT_PER_MIN; i++) await client.getIce(room);
    expect(await kind(client.getIce(room))).toBe('rate-limited');
  });
});
