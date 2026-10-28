// The camera's copy of the scoreboard's log (technical-design.md §3.5): replaced wholesale on every sync,
// extended by events, deduplicated by id (R-PAIR-4). Each event also gets the camera's receive time.
import type { MatchConfig, MatchEvent } from '../engine';
import type { LinkState, MatchLog, RecCommand, ScoreSource, SourceListener } from './source';

export interface MirrorSnapshot {
  matchId: string | null;
  config: MatchConfig | null;
  events: MatchEvent[];
  /** Camera wall clock at which each event (by id) first arrived. */
  receivedAt: Record<string, number>;
  link: LinkState;
}

const EMPTY: MirrorSnapshot = { matchId: null, config: null, events: [], receivedAt: {}, link: 'unpaired' };

export class Mirror implements SourceListener {
  private snap: MirrorSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  onCommand: (c: RecCommand) => void = () => {};

  constructor(private readonly now: () => number = Date.now) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): MirrorSnapshot => this.snap;

  private set(next: Partial<MirrorSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const fn of this.listeners) fn();
  }

  /** Follow `source` until the returned stop is called; the old match stays visible until a new sync. */
  attach(source: ScoreSource): () => void {
    return source.connect(this);
  }

  sync(log: MatchLog): void {
    const t = this.now();
    const same = log.matchId === this.snap.matchId;
    const receivedAt: Record<string, number> = {};
    const byId = new Map<string, MatchEvent>();
    for (const e of log.events) byId.set(e.id, e);
    const events = [...byId.values()].sort((a, b) => a.seq - b.seq);
    for (const e of events) receivedAt[e.id] = (same && this.snap.receivedAt[e.id]) || t;
    this.set({ matchId: log.matchId, config: log.config, events, receivedAt });
  }

  event(e: MatchEvent): void {
    if (!this.snap.config || this.snap.receivedAt[e.id] != null) return; // no match yet, or a duplicate
    const events = [...this.snap.events, e];
    if (events.length > 1 && events[events.length - 2].seq > e.seq) events.sort((a, b) => a.seq - b.seq);
    this.set({ events, receivedAt: { ...this.snap.receivedAt, [e.id]: this.now() } });
  }

  command(c: RecCommand): void {
    this.onCommand(c);
  }

  link(state: LinkState): void {
    if (state !== this.snap.link) this.set({ link: state });
  }

  /** The last match's log as plain data, for log.json. */
  log(): (MatchLog & { receivedAt: Record<string, number> }) | null {
    const s = this.snap;
    return s.matchId && s.config ? { matchId: s.matchId, config: s.config, events: s.events, receivedAt: s.receivedAt } : null;
  }
}
