// The on-device pairing log: what the captain copies or shares from ⋯ › Pairing diagnostics.
import { describe, expect, it } from 'vitest';
import { MemoryStore, createHandler } from '../../api/signal';
import { DIAG_MAX, PairingDiag, buildStamp, helperPath, loggedFetch, setUpdateWaiting } from './diag';
import { HelperClient } from './helper';

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

const T0 = Date.UTC(2026, 9, 28, 13, 3, 39, 305);

describe('pairing diagnostics', () => {
  it('collapses a repeated line (the 2 s polls) into one with a count', () => {
    let t = T0;
    const d = new PairingDiag('scoreboard', null, () => (t += 2250));
    for (let i = 0; i < 12; i++) d.log('helper', 'GET /sessions/ff8a33…/offer?gen=1 → 204');
    d.log('ice', 'ice checking');
    const e = d.getSnapshot().entries;
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ n: 12 });
    expect(d.report({})).toContain('13:03:41.555 helper GET /sessions/ff8a33…/offer?gen=1 → 204 (×12, last 13:04:06.305)');
  });

  it('keeps the newest lines only', () => {
    const d = new PairingDiag('camera', null, () => T0);
    for (let i = 0; i < DIAG_MAX + 50; i++) d.log('link', `line ${i}`);
    const e = d.getSnapshot().entries;
    expect(e).toHaveLength(DIAG_MAX);
    expect(e[0].text).toBe('line 50');
  });

  it('survives a reload through storage, per role', () => {
    const storage = new MemStorage();
    const a = new PairingDiag('camera', storage, () => T0);
    a.log('error', 'no-room');
    a.flush();
    expect(new PairingDiag('camera', storage).getSnapshot().latest.error).toBe('no-room');
    expect(new PairingDiag('scoreboard', storage).getSnapshot().entries).toHaveLength(0);
    a.clear();
    a.flush();
    expect(storage.data.size).toBe(0);
  });

  it('sums up role, build, path, relay, network, ICE and the last error in one line', () => {
    const d = new PairingDiag('scoreboard', null, () => T0);
    expect(d.summary()).toBe(`scoreboard · build ${buildStamp()} · path none · relay: not checked · net not checked · ice not started · no error`);
    d.log('relay', 'not configured · no TURN key on the helper, local network only');
    d.log('net', 'different (this phone 10.131.171.124, other 10.195.144.160)');
    d.log('ice', 'ice checking');
    d.log('error', 'no-room');
    setUpdateWaiting(true);
    try {
      expect(d.summary()).toBe(
        `scoreboard · build ${buildStamp()} (update waiting) · path none · relay: not configured · net different (this phone 10.131.171.124, other 10.195.144.160) · ice checking · error no-room at 13:03:39`,
      );
    } finally {
      setUpdateWaiting(false);
    }
    d.log('relay', 'ready until 14:03:39 UTC · stun:stun.cloudflare.com:3478, turn:turn.cloudflare.com:3478?transport=udp');
    d.log('path', 'relay: this phone relay/udp ↔ other phone srflx');
    expect(d.summary()).toContain(' · path relay · relay: ready until 14:03:39 UTC · net different');
    d.log('path', 'none');
    expect(d.summary()).toContain(' · path none · ');
    expect(buildStamp('badminton-scoreboard@0.3.0+2026-10-28T13:00')).toBe('2026-10-28T13:00');
  });

  it('logs each helper request with its status and error code, with a short session id and never the secret', async () => {
    const store = new MemoryStore();
    const handler = createHandler(() => store);
    const d = new PairingDiag('scoreboard', null, () => T0);
    const helper = new HelperClient('/api/signal', loggedFetch(d, async (url, init) => handler(new Request(`https://app.test${url}`, init))));
    const room = await helper.createRoom('v=0\r\na=candidate:1 1 udp 1 10.0.0.2 5000 typ host\r\n');
    await helper.claimRoom(room.code);
    await helper.claimRoom(room.code).catch(() => {});
    await helper.poll(room, 1, 'camera');
    const text = d.report({});
    expect(text).toContain('POST /rooms → 201');
    expect(text).toContain(`GET /rooms/${room.code} → 200`);
    expect(text).toContain(`GET /rooms/${room.code} → 404 no-room`);
    expect(text).toContain(`GET /sessions/${room.session.slice(0, 6)}…/poll?gen=1&role=camera → 204`);
    expect(text).not.toContain(room.secret);
    expect(text).not.toContain(room.session);
  });

  it('a request that never got an answer says so', async () => {
    const d = new PairingDiag('camera', null, () => T0);
    const helper = new HelperClient('/api/signal', loggedFetch(d, async () => Promise.reject(new TypeError('Load failed'))));
    await expect(helper.createRoom('v=0')).rejects.toThrow();
    expect(d.getSnapshot().latest.helper).toBe('POST /rooms → no answer (TypeError)');
  });

  it('helper paths', () => {
    expect(helperPath('/api/signal/sessions/b39230cb7f65070a9a008cfec05a2de5/offer?gen=2')).toBe('/sessions/b39230…/offer?gen=2');
    expect(helperPath('/api/signal/rooms/368325?claim=a1b2c3d4e5f60718')).toBe('/rooms/368325');
  });
});
