// Appending to the event log: dense seq, random id, wall-clock time, device id (technical-design.md §3.3).
import { lastRedoable, lastUndoable } from './reducer';
import type { EventBody, MatchEvent } from './types';

export interface Stamp {
  at: number;
  by: string;
  id: string;
}

export const randomId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 12)
    : Math.random().toString(36).slice(2, 14);

export function append(events: readonly MatchEvent[], body: EventBody, stamp: Stamp): MatchEvent[] {
  const e = { ...body, seq: events.length + 1, id: stamp.id, at: stamp.at, by: stamp.by } as MatchEvent;
  return [...events, e];
}

/** The body of an undo for the newest undoable event, or null when there is nothing to undo. */
export function undoBody(events: readonly MatchEvent[]): EventBody | null {
  const t = lastUndoable(events);
  return t ? { type: 'undo', target: t.seq } : null;
}

export function redoBody(events: readonly MatchEvent[]): EventBody | null {
  const t = lastRedoable(events);
  return t ? { type: 'redo', target: t.seq } : null;
}
