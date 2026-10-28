// Small per-device settings in localStorage: last role (R-SETUP-1), last setup (R-SETUP-3), sound and voice.
import { DEFAULT_SETUP, PALETTE, type MatchSetup } from '../engine';
import { randomId } from '../engine';
import type { Lang } from '../speech/phrases';

export type Role = 'scoreboard' | 'camera';

export interface Prefs {
  sound: boolean;
  voice: boolean;
  lang: Lang; // D5: English by default
}

const KEYS = { role: 'bs.role', setup: 'bs.setup', prefs: 'bs.prefs', device: 'bs.device' } as const;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or storage full: settings are a convenience, carry on without them.
  }
}

export const loadRole = (): Role | null => read<Role>(KEYS.role);
export const saveRole = (r: Role) => write(KEYS.role, r);

/** The previous match's setup, or null on a fresh install. */
export function loadLastSetup(): MatchSetup | null {
  const s = read<MatchSetup>(KEYS.setup);
  if (!s || !s.teams?.A || !s.teams?.B) return null;
  const color = (c: unknown, d: number) => (typeof c === 'number' && c >= 0 && c < PALETTE.length ? c : d);
  return {
    ...DEFAULT_SETUP,
    ...s,
    teams: {
      A: { ...DEFAULT_SETUP.teams.A, ...s.teams.A, color: color(s.teams.A.color, 0) },
      B: { ...DEFAULT_SETUP.teams.B, ...s.teams.B, color: color(s.teams.B.color, 1) },
    },
  };
}
export const saveLastSetup = (s: MatchSetup) => write(KEYS.setup, s);

export const DEFAULT_PREFS: Prefs = { sound: true, voice: true, lang: 'en' };
export const loadPrefs = (): Prefs => ({ ...DEFAULT_PREFS, ...read<Partial<Prefs>>(KEYS.prefs) });
export const savePrefs = (p: Prefs) => write(KEYS.prefs, p);

export function deviceId(): string {
  let id = read<string>(KEYS.device);
  if (!id) {
    id = `sb-${randomId().slice(0, 6)}`;
    write(KEYS.device, id);
  }
  return id;
}
