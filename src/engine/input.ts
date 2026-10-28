// What a paired scoreboard sends instead of a finished event (technical-design.md §3.5): an input, applied by
// the camera to the one match log it holds (D14). The camera gives it its place (seq), its time on the camera's
// clock and, for undo and redo, its target: the newest event whichever scoreboard sent it. Inputs that make
// no sense in the current phase are ignored, and a second point to the same side from another scoreboard
// within DUPLICATE_WINDOW_MS of the first is the same rally tapped twice. The scoreboard runs the same
// function over its pending inputs to show them before the camera has answered.
import { lastRedoable, lastUndoable, reduce, voidSet } from './reducer';
import type { EventBody, MatchConfig, MatchEvent } from './types';

/**
 * Two friends tap the same rally: a point to the same side from a different scoreboard within this many ms of
 * the first counts once. One rally plus the next serve takes longer than this, and the same scoreboard tapping
 * twice is never merged (that is what undo is for). Firstmate's default for D14; the captain may change it.
 */
export const DUPLICATE_WINDOW_MS = 1500;

/** Undo and redo name no target: the camera undoes its newest event, whoever sent it. */
export type InputBody = Exclude<EventBody, { type: 'undo' } | { type: 'redo' }> | { type: 'undo' } | { type: 'redo' };

export interface Input {
  /** Becomes the event's id, so a resent input is recognised. */
  id: string;
  /** Wall clock of the scoreboard that sent it. */
  at: number;
  /** That scoreboard's device id. */
  by: string;
  body: InputBody;
}

export type InputResult = 'applied' | 'duplicate' | 'ignored';

export interface Applied {
  result: InputResult;
  events: MatchEvent[];
}

/**
 * Apply one input to a match log (not `match.start`, which begins a new log). `at` is the input's time on the
 * log's clock; the event gets at least the last event's time so the log stays in time order for the overlay.
 */
export function applyInput(config: MatchConfig, events: readonly MatchEvent[], input: Input, at: number): Applied {
  const same = (result: InputResult): Applied => ({ result, events: events as MatchEvent[] });
  if (events.some((e) => e.id === input.id)) return same('applied');
  const s = reduce(config, events);
  const b = input.body;
  let body: EventBody;
  switch (b.type) {
    case 'match.start':
      return same('ignored');
    case 'undo': {
      const t = lastUndoable(events);
      if (!t) return same('ignored');
      body = { type: 'undo', target: t.seq };
      break;
    }
    case 'redo': {
      const t = lastRedoable(events);
      if (!t) return same('ignored');
      body = { type: 'redo', target: t.seq };
      break;
    }
    case 'point':
      if (s.phase !== 'playing') return same('ignored');
      if (isDuplicate(events, input.by, b.team, at)) return same('duplicate');
      body = b;
      break;
    case 'interval.end':
      if (s.phase !== 'interval') return same('ignored');
      body = b;
      break;
    case 'game.start':
      if (s.phase !== 'gameOver' || b.game !== s.game + 1) return same('ignored');
      body = b;
      break;
    case 'match.end':
      if (s.phase === 'matchOver') return same('ignored');
      body = b;
      break;
    default:
      body = b;
  }
  const last = events[events.length - 1];
  const e = { ...body, seq: events.length + 1, id: input.id, at: Math.max(at, last?.at ?? at), by: input.by } as MatchEvent;
  return { result: 'applied', events: [...events, e] };
}

/** A live point to `team` from another scoreboard within the window: this tap is that same rally. */
export function isDuplicate(events: readonly MatchEvent[], by: string, team: string, at: number): boolean {
  const voided = voidSet(events);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.at < at - DUPLICATE_WINDOW_MS) break;
    if (e.type === 'point' && !voided.has(e.seq) && e.team === team && e.by !== by && Math.abs(e.at - at) <= DUPLICATE_WINDOW_MS) return true;
  }
  return false;
}
