import { describe, expect, it } from 'vitest';
import { current, initialSession, nextIndex, sessionReduce, type Session, type SessionAction, type SegmentDraft } from './session';

const draft: SegmentDraft = {
  ext: 'mp4',
  mimeType: 'video/mp4',
  width: 1920,
  height: 1080,
  fps: 30,
  startLatencyMs: 0,
  overlay: { box: { x: 43, y: 43, w: 840, h: 122 }, corner: 'tl', delayMs: 0, mirrored: false, theme: 'panel-v3', logo: null },
};

const run = (s: Session, ...actions: SessionAction[]) => actions.reduce(sessionReduce, s);
const recording = (at = 1000) => run(initialSession, { type: 'start', at, draft }, { type: 'started', at: at + 40 });

describe('segment state machine (R-REC-5, technical-design.md §6.5)', () => {
  it('start, record, user stop: one closed segment and back to idle', () => {
    let s = recording();
    expect(s.phase).toBe('recording');
    expect(current(s)).toMatchObject({ index: 1, file: 'video-1.mp4', startedAt: 1040, endedAt: null });
    s = run(s, { type: 'bytes', bytes: 750_000 }, { type: 'stop', reason: 'user' });
    expect(s.phase).toBe('stopping');
    s = run(s, { type: 'closed', at: 61_040, bytes: 45_000_000 });
    expect(s.phase).toBe('idle');
    expect(current(s)).toBeNull();
    expect(s.segments).toEqual([expect.objectContaining({ index: 1, endedAt: 61_040, bytes: 45_000_000, endReason: 'user' })]);
  });

  it('an interruption closes the segment and offers segment 2, which records as a new file', () => {
    let s = run(recording(), { type: 'stop', reason: 'interrupted', message: 'camera interrupted' }, { type: 'closed', at: 9000, bytes: 100 });
    expect(s.phase).toBe('interrupted');
    expect(s.message).toBe('camera interrupted');
    expect(nextIndex(s)).toBe(2);
    s = run(s, { type: 'start', at: 20_000, draft }, { type: 'started', at: 20_050 });
    expect(s.phase).toBe('recording');
    expect(s.message).toBeNull();
    expect(s.segments.map((x) => [x.index, x.file, x.endReason])).toEqual([
      [1, 'video-1.mp4', 'interrupted'],
      [2, 'video-2.mp4', null],
    ]);
  });

  it('a recorder error also offers resume; quota ends in "full"', () => {
    expect(run(recording(), { type: 'stop', reason: 'error' }, { type: 'closed', at: 2, bytes: 1 }).phase).toBe('interrupted');
    const full = run(recording(), { type: 'stop', reason: 'quota' }, { type: 'closed', at: 2, bytes: 1 });
    expect(full.phase).toBe('full');
    expect(full.segments[0].endReason).toBe('quota');
  });

  it('the first stop reason wins', () => {
    const s = run(recording(), { type: 'stop', reason: 'user' }, { type: 'stop', reason: 'quota' }, { type: 'closed', at: 5, bytes: 9 });
    expect(s.phase).toBe('idle');
    expect(s.segments[0].endReason).toBe('user');
  });

  it('a recorder that stops by itself counts as an error', () => {
    const s = run(recording(), { type: 'closed', at: 5, bytes: 9 });
    expect(s.phase).toBe('interrupted');
    expect(s.segments[0].endReason).toBe('error');
  });

  it('a start that fails leaves no segment behind', () => {
    const s = run(initialSession, { type: 'start', at: 1, draft }, { type: 'failed', message: 'no MediaRecorder' });
    expect(s).toMatchObject({ phase: 'failed', segments: [], message: 'no MediaRecorder' });
    expect(run(s, { type: 'dismiss' }).phase).toBe('idle');
  });

  it('ignores actions that do not fit the phase', () => {
    const s = recording();
    expect(run(s, { type: 'start', at: 5, draft })).toBe(s);
    expect(run(s, { type: 'load', segments: [] })).toBe(s);
    expect(run(s, { type: 'dismiss' })).toBe(s);
    expect(run(initialSession, { type: 'started', at: 1 })).toBe(initialSession);
    expect(run(initialSession, { type: 'closed', at: 1, bytes: 1 })).toBe(initialSession);
    expect(run(initialSession, { type: 'stop', reason: 'user' })).toBe(initialSession);
  });

  it('continues the numbering of a match recorded before (after a restart)', () => {
    const before = run(recording(), { type: 'stop', reason: 'user' }, { type: 'closed', at: 2000, bytes: 10 }).segments;
    const s = run(initialSession, { type: 'load', segments: before }, { type: 'start', at: 9000, draft });
    expect(current(s)?.file).toBe('video-2.mp4');
  });
});
