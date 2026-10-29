// Small per-device settings in localStorage: last role (R-SETUP-1), last setup (R-SETUP-3), sound and voice,
// camera settings (R-SETUP-4).
import { DEFAULT_SETUP, PALETTE, type MatchSetup } from '../engine';
import { randomId } from '../engine';
import { CORNERS, LOGO_SIZES, TABLE_PLACES, type Corner, type LogoSize, type TablePlace } from '../overlay/layout';
import { MOTIONS, type Motion } from '../overlay/motion';
import { DEFAULT_CAMERA_SETTINGS, OVERLAY_DELAYS_MS, QUALITIES, type CameraSettings } from '../recording/config';
import type { Lang } from '../speech/phrases';

export type Role = 'scoreboard' | 'camera';

export interface Prefs {
  sound: boolean;
  voice: boolean;
  lang: Lang; // D5: English by default
  /** D15: open the why-was-this-point-won popup on this phone (the net-post phone the players tap may say no). */
  askReasons: boolean;
  /** Seconds before an untagged popup closes by itself; 0 = never. */
  tagCloseS: TagCloseS;
}

export const TAG_CLOSE_OPTIONS = [4, 6, 10, 0] as const;
export type TagCloseS = (typeof TAG_CLOSE_OPTIONS)[number];

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

export const DEFAULT_PREFS: Prefs = { sound: true, voice: true, lang: 'en', askReasons: true, tagCloseS: 6 };
export function loadPrefs(): Prefs {
  const p = { ...DEFAULT_PREFS, ...read<Partial<Prefs>>(KEYS.prefs) };
  if (!(TAG_CLOSE_OPTIONS as readonly unknown[]).includes(p.tagCloseS)) p.tagCloseS = DEFAULT_PREFS.tagCloseS;
  return p;
}
export const savePrefs = (p: Prefs) => write(KEYS.prefs, p);

export function deviceId(): string {
  let id = read<string>(KEYS.device);
  if (!id) {
    id = `sb-${randomId().slice(0, 6)}`;
    write(KEYS.device, id);
  }
  return id;
}

const CAMERA_KEY = 'bs.camera';

/** Camera role settings (R-SETUP-4), kept per device. */
export function loadCameraSettings(): CameraSettings {
  const s = read<Partial<CameraSettings>>(CAMERA_KEY) ?? {};
  const quality = s.quality && s.quality in QUALITIES ? s.quality : DEFAULT_CAMERA_SETTINGS.quality;
  const delayMs = (OVERLAY_DELAYS_MS as readonly number[]).includes(s.delayMs as number) ? (s.delayMs as number) : DEFAULT_CAMERA_SETTINGS.delayMs;
  const corner = (c: unknown, d: Corner): Corner => ((CORNERS as readonly unknown[]).includes(c) ? (c as Corner) : d);
  return {
    ...DEFAULT_CAMERA_SETTINGS,
    ...s,
    quality,
    delayMs,
    scoreCorner: corner(s.scoreCorner, DEFAULT_CAMERA_SETTINGS.scoreCorner),
    logoCorner: corner(s.logoCorner, DEFAULT_CAMERA_SETTINGS.logoCorner),
    logoSize: (LOGO_SIZES as readonly unknown[]).includes(s.logoSize) ? (s.logoSize as LogoSize) : DEFAULT_CAMERA_SETTINGS.logoSize,
    scoreSize: (LOGO_SIZES as readonly unknown[]).includes(s.scoreSize) ? (s.scoreSize as LogoSize) : DEFAULT_CAMERA_SETTINGS.scoreSize,
    statsTeam: s.statsTeam === 'A' || s.statsTeam === 'B' ? s.statsTeam : 'off',
    statsPlace: (TABLE_PLACES as readonly unknown[]).includes(s.statsPlace) ? (s.statsPlace as TablePlace) : DEFAULT_CAMERA_SETTINGS.statsPlace,
    statsOpp: typeof s.statsOpp === 'boolean' ? s.statsOpp : DEFAULT_CAMERA_SETTINGS.statsOpp,
    endCard: s.endCard === true,
    overlayMotion: (MOTIONS as readonly unknown[]).includes(s.overlayMotion) ? (s.overlayMotion as Motion) : DEFAULT_CAMERA_SETTINGS.overlayMotion,
  };
}
export const saveCameraSettings = (s: CameraSettings) => write(CAMERA_KEY, s);
