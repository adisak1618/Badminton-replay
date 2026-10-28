// The paired scoreboard over the data channel (§4.4), behind the same ScoreSource the recording code already
// follows: `sync` parts are reassembled into the whole log, `event`s are passed on once each (by id), `cmd`s
// go to the controller, and the camera's `rec` reports and `ack`s go back. The clock offset comes from this
// phone's own pings (camera clock minus scoreboard clock, §4.5).
import type { MatchEvent } from '../engine';
import { SyncAssembler } from '../protocol/sync';
import type { LinkPort } from '../pairing/port';
import type { ClockEstimate, LinkState, MatchLog, PeerInfo, RecReport, ScoreSource, SourceListener } from './source';

export class PeerSource implements ScoreSource {
  readonly kind = 'peer' as const;
  private listener: SourceListener | null = null;
  private log: MatchLog | null = null;
  private ids = new Set<string>();
  private assembler = new SyncAssembler();
  private lastReport: RecReport | null = null;
  private lastLink: LinkState;

  constructor(private readonly port: LinkPort) {
    this.lastLink = port.getSnapshot().state;
    port.onMessage = (m) => {
      if (m.t === 'sync') {
        const log = this.assembler.add(m);
        if (log) this.sync(log);
      } else if (m.t === 'event') this.event(m.event);
      else if (m.t === 'cmd') this.listener?.command({ id: m.id, action: m.action });
    };
    // Every (re)open: tell the scoreboard where the recording stands (its chip and REC button follow it).
    port.onOpen = () => {
      if (this.lastReport) port.send({ t: 'rec', ...this.lastReport });
    };
    port.subscribe(() => {
      const s = port.getSnapshot().state;
      if (s === this.lastLink) return;
      this.lastLink = s;
      this.listener?.link(s);
    });
  }

  private sync(log: MatchLog): void {
    this.log = log;
    this.ids = new Set(log.events.map((e) => e.id));
    this.listener?.sync(log);
  }

  private event(e: MatchEvent): void {
    if (!this.log || this.ids.has(e.id)) return; // before the first sync, or a resend (R-PAIR-4)
    this.ids.add(e.id);
    this.log = { ...this.log, events: [...this.log.events, e] };
    this.listener?.event(e);
  }

  connect(l: SourceListener): () => void {
    this.listener = l;
    l.link(this.link());
    if (this.log) l.sync(this.log);
    return () => {
      if (this.listener === l) this.listener = null;
    };
  }

  link(): LinkState {
    return this.port.getSnapshot().state;
  }

  /** Camera clock minus scoreboard clock: the negation of what this phone's pings measure. */
  clock(): ClockEstimate | null {
    const e = this.port.clockEstimate();
    return e && { ...e, offsetMs: 0 - e.offsetMs };
  }

  peer(): PeerInfo | null {
    const r = this.port.getSnapshot().remote;
    return r && { id: r.deviceId, ua: r.ua ?? '', app: r.app };
  }

  report(r: RecReport): void {
    this.lastReport = r;
    this.port.send({ t: 'rec', ...r });
  }

  ack(id: string, ok: boolean, error?: string): void {
    this.port.send(error ? { t: 'ack', id, ok, error } : { t: 'ack', id, ok });
  }
}
