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

/**
 * The camera's code on show (its session), until a scoreboard links with it: a page that went away without
 * withdrawing it (killed, not unloaded) withdraws it at its next launch, so nobody waits on a code with no page.
 */
const shownKey = (role: Role, slot = 0) => `${key(role, slot)}.shown`;

export function loadShown(role: Role, slot = 0): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(shownKey(role, slot)) ?? 'null') as Session | null;
    return s && typeof s.session === 'string' && typeof s.secret === 'string' ? s : null;
  } catch {
    return null;
  }
}

export function saveShown(role: Role, s: Session | null, slot = 0): void {
  try {
    if (s) localStorage.setItem(shownKey(role, slot), JSON.stringify({ session: s.session, secret: s.secret }));
    else localStorage.removeItem(shownKey(role, slot));
  } catch {
    // private mode or storage full
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
