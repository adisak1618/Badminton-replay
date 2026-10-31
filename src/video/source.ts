// Score a saved video (D17, R-VID): what a match remembers about the file it is scored from, the log's clock on that
// file, and the one recording segment match.json describes the file with (technical-design.md §3.5, §8). Pure.
//
// The log of a video match runs on the video's clock: an event's `at` is the match start's `at` (T0) plus where the
// video stood when it was made, less the tap offset. The file's t = 0 is T0, so the export's existing arithmetic
// (`tRecFor` in recording/bundle.ts: at − the segment's first frame) gives each event's place on the file.
import type { MatchConfig, MatchEvent } from '../engine';
import type { PeerInfo } from '../link/source';
import { recordingId, type RecordingMeta } from '../recording/meta';
import type { Segment } from '../recording/session';

/** The picked file and how far the scorer got in it; kept with the match in IndexedDB (StoredMatch.video). */
export interface VideoSource {
  name: string;
  size: number;
  /** File.type, else guessed from the name. */
  type: string;
  lastModified: number;
  /** Read from the video element once it has loaded the file; null until then. */
  durationMs: number | null;
  width: number | null;
  height: number | null;
  /** Measured while it played (requestVideoFrameCallback); null while unknown. */
  fps: number | null;
  /** Subtracted from the video time of every tap, for the scorer's reaction delay; later taps only. */
  tapOffsetMs: number;
  /** Where the video was last: a reload comes back here. */
  positionMs: number;
}

/** The tap offset's range and step in the menu. */
export const TAP_OFFSET = { step: 100, max: 2000 } as const;

const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
};

/** The file's media type: what the browser says, else from its extension, else a generic one. */
export function mimeOf(name: string, type: string): string {
  if (type) return type;
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** A just-picked file, before the video element has read it. */
export function describeFile(f: { name: string; size: number; type: string; lastModified: number }): VideoSource {
  return {
    name: f.name,
    size: f.size,
    type: mimeOf(f.name, f.type),
    lastModified: f.lastModified,
    durationMs: null,
    width: null,
    height: null,
    fps: null,
    tapOffsetMs: 0,
    positionMs: 0,
  };
}

/** The file re-picked after a reload is the one the match was scored on: same name and size. */
export const sameFile = (v: Pick<VideoSource, 'name' | 'size'>, f: { name: string; size: number }): boolean => v.name === f.name && v.size === f.size;

/** The log's clock at video time `ms` (ms from the file's t = 0): T0 + the time less the offset, never before T0. */
export const videoClock = (t0: number, ms: number, offsetMs: number): number => t0 + Math.max(0, Math.round(ms - offsetMs));

/** Where an event of the log sits on the file: ms from its t = 0 (the inverse of `videoClock`). */
export const fileMs = (t0: number, at: number): number => at - t0;

/** Standard frame rates a measured one snaps to: the nearest, when within 0.05 % (29.97 and 30 are 0.1 % apart). */
const RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120];
const SNAP = 0.0005;

/**
 * The frame rate from the media-time steps between frames shown one after another (seconds): the median step, snapped
 * to the nearest standard rate when that close. Null without enough steps.
 */
export function fpsFromSteps(steps: readonly number[]): number | null {
  const ok = steps.filter((d) => Number.isFinite(d) && d > 0.002 && d < 0.5).sort((a, b) => a - b);
  if (ok.length < 8) return null;
  const fps = 1 / ok[Math.floor(ok.length / 2)];
  const near = RATES.reduce((a, b) => (Math.abs(b - fps) < Math.abs(a - fps) ? b : a));
  return Math.abs(near - fps) / near <= SNAP ? near : Math.round(fps * 100) / 100;
}

/**
 * The file as the one segment of a recording (§8): index 1, its own name, t = 0 at the match start's `at`, ending
 * its duration later, nothing burned in. The unknowns are 0 (fps, width, height) so the shape stays a Segment.
 */
export function importedSegment(v: VideoSource, t0: number): Segment {
  return {
    index: 1,
    file: v.name,
    mimeType: v.type,
    width: v.width ?? 0,
    height: v.height ?? 0,
    fps: v.fps ?? 0,
    startedAt: t0,
    startLatencyMs: 0,
    firstFrameAt: t0,
    endedAt: t0 + Math.max(0, Math.round(v.durationMs ?? v.positionMs)),
    bytes: v.size,
    endReason: null,
    overlay: {
      box: { x: 0, y: 0, w: 0, h: 0 },
      boxes: [],
      corner: 'tl',
      size: 'medium',
      delayMs: 0,
      mirrored: false,
      theme: 'none',
      logo: null,
    },
  };
}

/** A video match as the recording metadata the export reads (recording/bundle.ts `buildBundle`). */
export function importedMeta(m: { matchId: string; createdAt: number; events: readonly MatchEvent[]; video: VideoSource }, scoreboard: PeerInfo): RecordingMeta {
  const t0 = m.events[0]?.at ?? m.createdAt;
  return {
    format: 'badminton-scoreboard/recording',
    version: 1,
    id: recordingId(m.matchId, t0),
    matchId: m.matchId,
    createdAt: m.createdAt,
    updatedAt: m.createdAt,
    camera: scoreboard, // not exported for an imported file: there was no camera
    scoreboard,
    clock: { offsetMs: 0, samples: 0, medianRttMs: 0 }, // one device, one clock
    segments: [importedSegment(m.video, t0)],
  };
}

/** The log a video match exports, in the shape `buildBundle` takes. */
export const importedLog = (m: { matchId: string; config: MatchConfig; events: MatchEvent[] }) => ({
  matchId: m.matchId,
  config: m.config,
  events: m.events,
  receivedAt: {},
});
