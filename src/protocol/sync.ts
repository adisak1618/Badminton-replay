// A whole match log split into parts so every message stays under 16 kB (technical-design.md §4.4): the
// camera's `state` to each scoreboard, and a scoreboard's `sync` when the camera adopts its match. The channel
// is ordered and reliable, so parts arrive in sequence; a part 0 starts over.
import type { MatchEvent } from '../engine';
import type { MatchLog } from '../link/source';
import { MAX_MESSAGE_BYTES, encode, type MsgOf } from './messages';

const size = (s: string) => new TextEncoder().encode(s).length;

type LogMsg = 'sync' | 'state';

/** Encoded `t` messages for `log`, each under `max` bytes (one message when it fits). */
export function logParts(t: LogMsg, log: MatchLog, max = MAX_MESSAGE_BYTES): string[] {
  const whole = encode({ t, matchId: log.matchId, config: log.config, events: log.events });
  if (size(whole) <= max) return [whole];
  // The envelope with a part marker and no events, plus a comma per event, bounds each part's size.
  const envelope = size(encode({ t, matchId: log.matchId, config: log.config, events: [], part: [99999, 99999] }));
  const groups: MatchEvent[][] = [];
  let cur: MatchEvent[] = [];
  let used = envelope;
  for (const e of log.events) {
    const n = size(JSON.stringify(e)) + 1;
    if (cur.length && used + n > max) {
      groups.push(cur);
      cur = [];
      used = envelope;
    }
    cur.push(e);
    used += n;
  }
  groups.push(cur);
  return groups.map((events, i) => encode({ t, matchId: log.matchId, config: log.config, events, part: [i, groups.length] }));
}

/** The scoreboard's `sync` parts. */
export const syncParts = (log: MatchLog, max?: number) => logParts('sync', log, max);

/** The camera's `state` parts: the whole match, or one message saying it holds none. */
export function stateParts(log: MatchLog | null, max?: number): string[] {
  return log ? logParts('state', log, max) : [encode({ t: 'state', matchId: null })];
}

export class SyncAssembler {
  private buf: { matchId: string; count: number; next: number; events: MatchEvent[] } | null = null;

  /** Feed one `sync` or `state`; returns the whole log once its last part has arrived (null for "none"). */
  add(m: MsgOf<'sync'> | MsgOf<'state'>): MatchLog | null | undefined {
    if (m.matchId === null || !m.config || !m.events) {
      this.buf = null;
      return null;
    }
    if (!m.part) {
      this.buf = null;
      return { matchId: m.matchId, config: m.config, events: m.events };
    }
    const [index, count] = m.part;
    if (index === 0) this.buf = { matchId: m.matchId, count, next: 0, events: [] };
    const b = this.buf;
    if (!b || b.matchId !== m.matchId || b.count !== count || b.next !== index) {
      this.buf = null; // a gap: wait for the next full one
      return undefined;
    }
    b.events.push(...m.events);
    b.next++;
    if (b.next < count) return undefined;
    this.buf = null;
    return { matchId: m.matchId, config: m.config, events: b.events };
  }
}
