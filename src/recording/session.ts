// Segments and interruptions as a pure state machine (technical-design.md §6.5, §6.6; R-REC-5). The camera
// controller feeds it what the browser reports; the UI and the `rec` report are read from it.
import type { Box } from '../overlay';

export type EndReason = 'user' | 'interrupted' | 'quota' | 'error';

/** §6.6, stored in recording.json. */
export interface Segment {
  index: number; // 1-based; the file is video-<index>.<ext>
  file: string;
  mimeType: string;
  width: number;
  height: number;
  fps: number;
  startedAt: number; // camera wall clock at the recorder 'start' event
  startLatencyMs: number; // A8, default 0
  endedAt: number | null;
  bytes: number;
  endReason: EndReason | null;
  overlay: { box: Box; delayMs: number; mirrored: boolean; theme: string };
}

/**
 * idle: nothing recording (also after a user stop). starting: recorder asked to start. recording.
 * stopping: waiting for the last chunk and the file close. interrupted: the camera or recorder stopped under
 * us; the segment is saved and "Resume (segment n+1)" is offered. full: storage ran out (R-REC-3).
 * failed: could not start at all.
 */
export type RecPhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'interrupted' | 'full' | 'failed';

export interface Session {
  phase: RecPhase;
  segments: Segment[];
  stopReason: EndReason | null;
  message: string | null;
}

export type SegmentDraft = Omit<Segment, 'index' | 'file' | 'startedAt' | 'endedAt' | 'bytes' | 'endReason'> & { ext: string };

export type SessionAction =
  | { type: 'load'; segments: Segment[] } // a recording directory was opened (earlier segments of this match)
  | { type: 'start'; at: number; draft: SegmentDraft }
  | { type: 'started'; at: number }
  | { type: 'bytes'; bytes: number }
  | { type: 'stop'; reason: EndReason; message?: string }
  | { type: 'closed'; at: number; bytes: number }
  | { type: 'failed'; message: string }
  | { type: 'dismiss' }; // the user acknowledged an interruption, full storage or failure without resuming

export const initialSession: Session = { phase: 'idle', segments: [], stopReason: null, message: null };

const PHASE_AFTER: Record<EndReason, RecPhase> = { user: 'idle', interrupted: 'interrupted', error: 'interrupted', quota: 'full' };

export const isActive = (p: RecPhase): boolean => p === 'starting' || p === 'recording' || p === 'stopping';

export const current = (s: Session): Segment | null =>
  isActive(s.phase) ? (s.segments[s.segments.length - 1] ?? null) : null;

export const nextIndex = (s: Session): number => s.segments.length + 1;

const withLast = (s: Session, patch: Partial<Segment>): Segment[] => {
  const segs = s.segments.slice();
  segs[segs.length - 1] = { ...segs[segs.length - 1], ...patch };
  return segs;
};

export function sessionReduce(s: Session, a: SessionAction): Session {
  switch (a.type) {
    case 'load':
      return isActive(s.phase) ? s : { ...initialSession, segments: a.segments };
    case 'start': {
      if (isActive(s.phase)) return s;
      const { ext, ...draft } = a.draft;
      const index = nextIndex(s);
      const seg: Segment = { ...draft, index, file: `video-${index}.${ext}`, startedAt: a.at, endedAt: null, bytes: 0, endReason: null };
      return { phase: 'starting', segments: [...s.segments, seg], stopReason: null, message: null };
    }
    case 'started':
      return s.phase === 'starting' ? { ...s, phase: 'recording', segments: withLast(s, { startedAt: a.at }) } : s;
    case 'bytes':
      return isActive(s.phase) ? { ...s, segments: withLast(s, { bytes: a.bytes }) } : s;
    case 'stop':
      // The first reason wins: a quota error that arrives while a user stop is closing the file changes nothing.
      if (s.phase !== 'starting' && s.phase !== 'recording') return s;
      return { ...s, phase: 'stopping', stopReason: a.reason, message: a.message ?? null };
    case 'closed': {
      if (!isActive(s.phase)) return s;
      // A recorder that stops by itself (no stop asked) counts as an error, so Resume is offered.
      const reason = s.phase === 'stopping' && s.stopReason ? s.stopReason : 'error';
      return {
        ...s,
        phase: PHASE_AFTER[reason],
        stopReason: reason,
        segments: withLast(s, { endedAt: a.at, bytes: a.bytes, endReason: reason }),
      };
    }
    case 'failed':
      // Nothing was recorded: drop the segment that never started.
      return {
        phase: 'failed',
        segments: s.phase === 'starting' ? s.segments.slice(0, -1) : s.segments,
        stopReason: null,
        message: a.message,
      };
    case 'dismiss':
      return isActive(s.phase) ? s : { ...s, phase: 'idle', message: null };
  }
}

/** Duration of a closed or running segment. */
export const segmentMs = (seg: Segment, now: number): number => Math.max(0, (seg.endedAt ?? now) - seg.startedAt);
