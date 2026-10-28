// The pairing this phone is part of, kept across reloads so either phone rejoins on its own while the
// helper's session lives (6 h, refreshed on every write): never a second scan for the same match.
import type { Role } from '../protocol/messages';
import type { Session } from './helper';

export interface SavedPairing extends Session {
  /** Camera: the last offer generation it posted. Scoreboard: the last one it answered. */
  gen: number;
  /** Last write, ms; the helper forgets the session 6 h after its last write (SESSION_TTL_S in api/signal.ts). */
  at: number;
}

const SESSION_MS = 6 * 3600_000;
/** The camera keeps one pairing per scoreboard slot; the first keeps the key it always had. */
const key = (role: Role, slot = 0) => (slot ? `bs.pair.${role}.${slot + 1}` : `bs.pair.${role}`);

export function loadPairing(role: Role, now = Date.now(), slot = 0): SavedPairing | null {
  try {
    const p = JSON.parse(localStorage.getItem(key(role, slot)) ?? 'null') as SavedPairing | null;
    if (!p || typeof p.session !== 'string' || typeof p.secret !== 'string' || typeof p.gen !== 'number') return null;
    return now - p.at < SESSION_MS ? p : null;
  } catch {
    return null;
  }
}

export function savePairing(role: Role, p: SavedPairing | null, slot = 0): void {
  try {
    if (p) localStorage.setItem(key(role, slot), JSON.stringify(p));
    else localStorage.removeItem(key(role, slot));
  } catch {
    // private mode or storage full: pairing still works, it just does not survive a reload
  }
}
