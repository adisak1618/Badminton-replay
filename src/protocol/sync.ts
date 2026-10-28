// The full-log `sync` split into parts so every message stays under 16 kB (technical-design.md §4.4), and
// its reassembly on the camera. The channel is ordered and reliable, so parts arrive in sequence; a part 0
// starts over.
import type { MatchEvent } from '../engine';
import type { MatchLog } from '../link/source';
import { MAX_MESSAGE_BYTES, encode, type MsgOf } from './messages';

const size = (s: string) => new TextEncoder().encode(s).length;

/** Encoded `sync` messages for `log`, each under `max` bytes (one message when it fits). */
export function syncParts(log: MatchLog, max = MAX_MESSAGE_BYTES): string[] {
  const whole = encode({ t: 'sync', matchId: log.matchId, config: log.config, events: log.events });
  if (size(whole) <= max) return [whole];
  // The envelope with a part marker and no events, plus a comma per event, bounds each part's size.
  const envelope = size(encode({ t: 'sync', matchId: log.matchId, config: log.config, events: [], part: [99999, 99999] }));
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
  return groups.map((events, i) =>
    encode({ t: 'sync', matchId: log.matchId, config: log.config, events, part: [i, groups.length] }),
  );
}

export class SyncAssembler {
  private buf: { matchId: string; count: number; next: number; events: MatchEvent[] } | null = null;

  /** Feed one `sync`; returns the whole log once its last part has arrived. */
  add(m: MsgOf<'sync'>): MatchLog | null {
    if (!m.part) {
      this.buf = null;
      return { matchId: m.matchId, config: m.config, events: m.events };
    }
    const [index, count] = m.part;
    if (index === 0) this.buf = { matchId: m.matchId, count, next: 0, events: [] };
    const b = this.buf;
    if (!b || b.matchId !== m.matchId || b.count !== count || b.next !== index) {
      this.buf = null; // a gap: wait for the next full sync
      return null;
    }
    b.events.push(...m.events);
    b.next++;
    if (b.next < count) return null;
    this.buf = null;
    return { matchId: m.matchId, config: m.config, events: b.events };
  }
}
