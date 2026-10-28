// Same-phone source: the Phase 1 engine running on this phone plays the scoreboard, so one phone can test the
// camera role end to end. The C3 "Demo score" panel drives the store; this class turns its changes into the
// sync/event stream a paired scoreboard would send, and plays the scoreboard side of remote REC.
import { randomId, type MatchEvent } from '../engine';
import type { MatchStore } from '../match/store';
import type { ClockEstimate, PeerInfo, RecCommand, RecReport, ScoreSource, SourceListener } from './source';

export interface AckRecord {
  id: string;
  ok: boolean;
  error?: string;
}

export class LocalSource implements ScoreSource {
  readonly kind = 'local' as const;
  private listener: SourceListener | null = null;
  private sent: { matchId: string | null; events: readonly MatchEvent[] } = { matchId: null, events: [] };
  private watchers = new Set<() => void>();
  lastReport: RecReport = { state: 'idle' };
  lastAck: AckRecord | null = null;

  constructor(
    private readonly store: MatchStore,
    private readonly device: PeerInfo,
  ) {}

  connect(l: SourceListener): () => void {
    this.listener = l;
    this.sent = { matchId: null, events: [] };
    l.link('paired');
    this.pump();
    const off = this.store.subscribe(() => this.pump());
    return () => {
      off();
      if (this.listener === l) this.listener = null;
    };
  }

  /** Forward what changed in the store: a new match or a shrunk log is a sync, otherwise the new events. */
  private pump(): void {
    const l = this.listener;
    const m = this.store.getSnapshot().match;
    if (!l || !m) return;
    const prev = this.sent;
    const extends_ =
      prev.matchId === m.matchId &&
      m.events.length >= prev.events.length &&
      prev.events.every((e, i) => m.events[i].id === e.id);
    this.sent = { matchId: m.matchId, events: m.events };
    if (!extends_) l.sync({ matchId: m.matchId, config: m.config, events: [...m.events] });
    else for (const e of m.events.slice(prev.events.length)) l.event(e);
  }

  link() {
    return 'paired' as const;
  }

  /** One clock on one phone. */
  clock(): ClockEstimate {
    return { offsetMs: 0, samples: 0, medianRttMs: 0 };
  }

  peer(): PeerInfo {
    return this.device;
  }

  /** Play the scoreboard pressing REC or Stop (D11). */
  command(action: RecCommand['action'], id = randomId()): RecCommand {
    const c = { id, action };
    this.listener?.command(c);
    return c;
  }

  report(r: RecReport): void {
    this.lastReport = r;
    this.notify();
  }

  ack(id: string, ok: boolean, error?: string): void {
    this.lastAck = { id, ok, error };
    this.notify();
  }

  /** For the demo panel: re-render when the camera reports or acknowledges. */
  watch = (fn: () => void): (() => void) => {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  };

  private notify(): void {
    for (const fn of this.watchers) fn();
  }
}
