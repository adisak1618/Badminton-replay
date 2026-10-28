import { DEFAULT_LOGO_CORNER, DEFAULT_SCORE_CORNER, type Corner, type LogoSize, type PanelSize } from '../overlay/layout';

// Recording constants in one place (technical-design.md §6). The default quality is one line: if the
// captain's 60-minute soak says 1080p30 is too hot or drops frames, set DEFAULT_QUALITY to '720p'.
export type Quality = '1080p' | '720p';

export interface QualitySpec {
  width: number;
  height: number;
  fps: number;
  videoBitsPerSecond: number; // D8
}

export const QUALITIES: Record<Quality, QualitySpec> = {
  '1080p': { width: 1920, height: 1080, fps: 30, videoBitsPerSecond: 6_000_000 },
  '720p': { width: 1280, height: 720, fps: 30, videoBitsPerSecond: 3_500_000 },
};

export const DEFAULT_QUALITY: Quality = '1080p';
export const AUDIO_BITS_PER_SECOND = 128_000;

/** §6.3: the first one `MediaRecorder.isTypeSupported` accepts. WebM is a last resort for desktop testing only. */
export const MIME_TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];

export const TIMESLICE_MS = 1000; // R-REC-2: a chunk, and an OPFS write, every second
export const FLUSH_EVERY_MS = 5000; // §6.4
export const START_LATENCY_MS = 0; // A8: calibrated on the phone in phase 0, 0 until then

/** R-REC-4 and C1: 0 s by default; phase 3 decides from real matches. */
export const OVERLAY_DELAYS_MS = [0, 2000, 3000] as const;
export const DEFAULT_OVERLAY_DELAY_MS = 0;

export const LOW_MINUTES = 10; // R-REC-3: amber below this
export const DIM_AFTER_MS = 30_000; // C3: preview dims after 30 s without a touch
export const HOLD_TO_STOP_MS = 1000; // R-REC-7

export interface CameraSettings {
  quality: Quality;
  audio: boolean; // D7
  mirrored: boolean; // R-REC-4
  delayMs: number;
  scoreCorner: Corner;
  scoreSize: PanelSize;
  logoCorner: Corner;
  logoSize: LogoSize;
}

export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  quality: DEFAULT_QUALITY,
  audio: true,
  mirrored: false,
  delayMs: DEFAULT_OVERLAY_DELAY_MS,
  scoreCorner: DEFAULT_SCORE_CORNER,
  scoreSize: 'medium',
  logoCorner: DEFAULT_LOGO_CORNER,
  logoSize: 'medium',
};

export function bytesPerMinute(q: Quality, audio: boolean): number {
  return ((QUALITIES[q].videoBitsPerSecond + (audio ? AUDIO_BITS_PER_SECOND : 0)) / 8) * 60;
}

/** R-REC-3: (quota - usage) / bytes per minute, floored; null when the browser gives no estimate. */
export function minutesLeft(est: { usage?: number | null; quota?: number | null } | null, q: Quality, audio: boolean): number | null {
  if (!est || est.quota == null || est.usage == null) return null;
  return Math.max(0, Math.floor((est.quota - est.usage) / bytesPerMinute(q, audio)));
}
