// Segments and interruptions as a pure state machine (technical-design.md §6.5, §6.6; R-REC-5). The camera
// controller feeds it what the browser reports; the UI and the `rec` report are read from it.
import type { Box, Corner, LogoSize, PanelSize } from '../overlay';

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
  /**
   * Where the overlays were burned in. The score panel follows its content, so `box` is the area it covered
   * over the whole segment and `boxes` its exact box from each camera time `at` on; the logo's box is fixed.
   */
  overlay: {
    box: Box;
    boxes: Array<{ at: number; box: Box }>;
    corner: Corner;
    size: PanelSize;
    delayMs: number;
    mirrored: boolean;
    theme: string;
    logo: { box: Box; corner: Corner; size: LogoSize } | null;
  };
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
  | { type: 'panelBox'; at: number; box: Box } // the score panel changed size or place while recording
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

const sameBox = (a: Box, b: Box): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** The smallest box covering both. */
export function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

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
    case 'panelBox': {
      const seg = current(s);
      if (!seg) return s;
      const last = seg.overlay.boxes[seg.overlay.boxes.length - 1]?.box;
      if (last && sameBox(last, a.box)) return s;
      const box = seg.overlay.boxes.length ? union(seg.overlay.box, a.box) : a.box;
      return { ...s, segments: withLast(s, { overlay: { ...seg.overlay, box, boxes: [...seg.overlay.boxes, { at: a.at, box: a.box }] } }) };
    }
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
