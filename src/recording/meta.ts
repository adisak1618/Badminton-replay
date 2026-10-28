// Camera-local records per recorded match (technical-design.md §3.5, §6.6), in OPFS under
// matches/<id>/: recording.json (segments), log.json (the mirrored scoreboard log), video-<n>.mp4.
import type { MatchConfig, MatchEvent } from '../engine';
import type { ClockEstimate, PeerInfo } from '../link/source';
import type { Segment } from './session';

export const MATCHES_DIR = 'matches';
export const RECORDING_FILE = 'recording.json';
export const LOG_FILE = 'log.json';

export interface RecordingMeta {
  format: 'badminton-scoreboard/recording';
  version: 1;
  id: string; // directory name: the scoreboard's matchId when known at the first REC, else cam-<time>
  matchId: string | null; // the scoreboard match this recording follows; null while unpaired
  createdAt: number;
  updatedAt: number;
  camera: PeerInfo;
  scoreboard: PeerInfo | null;
  clock: ClockEstimate | null; // the latest estimate, camera minus scoreboard
  segments: Segment[];
}

export interface MirrorLog {
  matchId: string;
  config: MatchConfig;
  events: MatchEvent[];
  receivedAt: Record<string, number>;
}

/** A directory name that is safe on every file system the bundle may land on. */
export const recordingId = (matchId: string | null, now: number): string =>
  matchId ? matchId.replace(/[^\w.-]/g, '_').slice(0, 80) : `cam-${now}`;

export function newMeta(id: string, matchId: string | null, camera: PeerInfo, now: number): RecordingMeta {
  return {
    format: 'badminton-scoreboard/recording',
    version: 1,
    id,
    matchId,
    createdAt: now,
    updatedAt: now,
    camera,
    scoreboard: null,
    clock: null,
    segments: [],
  };
}

export interface StoredFile {
  name: string;
  size: number;
  lastModified: number;
}

const VIDEO_RE = /^video-(\d+)\.(mp4|webm)$/;

/**
 * Make recording.json agree with the files on disk after a crash or a kill (R-REC-2, N-RES-1): a segment
 * still marked open gets the file's size and last write time, and a video file the metadata does not know
 * (recording.json lost mid-write) is listed with what can be known about it.
 */
export function repairMeta(meta: RecordingMeta | null, id: string, files: StoredFile[], camera: PeerInfo): RecordingMeta {
  const m: RecordingMeta = meta ? { ...meta, segments: meta.segments.map((s) => ({ ...s })) } : newMeta(id, null, camera, 0);
  const byName = new Map(files.map((f) => [f.name, f]));
  for (const seg of m.segments) {
    const f = byName.get(seg.file);
    if (!f) continue;
    if (seg.endedAt == null) {
      seg.endedAt = Math.max(seg.startedAt, f.lastModified);
      seg.endReason = 'error';
    }
    seg.bytes = f.size;
  }
  const known = new Set(m.segments.map((s) => s.file));
  for (const f of files) {
    const hit = VIDEO_RE.exec(f.name);
    if (!hit || known.has(f.name)) continue;
    m.segments.push({
      index: Number(hit[1]),
      file: f.name,
      mimeType: hit[2] === 'mp4' ? 'video/mp4' : 'video/webm',
      width: 0,
      height: 0,
      fps: 30,
      startedAt: f.lastModified,
      startLatencyMs: 0,
      endedAt: f.lastModified,
      bytes: f.size,
      endReason: 'error',
      overlay: { box: { x: 0, y: 0, w: 0, h: 0 }, boxes: [], corner: 'tl', size: 'medium', delayMs: 0, mirrored: false, theme: 'unknown', logo: null },
    });
  }
  m.segments.sort((a, b) => a.index - b.index);
  if (!meta) m.createdAt = m.segments[0]?.startedAt ?? 0;
  return m;
}
