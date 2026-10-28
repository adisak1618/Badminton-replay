// The camera's match (D14, technical-design.md §3.5): one log, held here, for up to two paired scoreboards.
// Each scoreboard sends inputs; the hub applies them in arrival order (engine/input.ts: the place, the time on
// the camera's clock, undo of the newest event whoever sent it, the same rally tapped on both scoreboards
// counted once) and sends every applied event to every scoreboard, which render what the camera holds. Each
// newly opened link gets the whole match; a camera without a match adopts the first scoreboard's live one.
// To the recording code this is just another ScoreSource.
import { applyInput, type Input, type InputResult, type MatchEvent } from '../engine';
import type { MsgOf } from '../protocol/messages';
import { SyncAssembler, stateParts } from '../protocol/sync';
import type { LinkPort } from '../pairing/port';
import type { ClockEstimate, LinkState, MatchLog, PeerInfo, RecReport, ScoreSource, SourceListener } from './source';

/** Where the camera keeps its match across a reload (localStorage in the app, a variable in tests). */
export interface HubStore {
  load(): MatchLog | null;
  save(log: MatchLog | null): void;
}

const HUB_KEY = 'bs.hub';
/** A kept match older than this is not resumed: the helper's session has expired by then too. */
const HUB_KEEP_MS = 6 * 3600_000;

export const localHubStore = (now: () => number = Date.now): HubStore => ({
  load() {
    try {
      const v = JSON.parse(localStorage.getItem(HUB_KEY) ?? 'null') as { log: MatchLog; at: number } | null;
      return v && now() - v.at < HUB_KEEP_MS ? v.log : null;
    } catch {
      return null;
    }
  },
  save(log) {
    try {
      if (log) localStorage.setItem(HUB_KEY, JSON.stringify({ log, at: now() }));
      else localStorage.removeItem(HUB_KEY);
    } catch {
      // storage full or private mode: the match is still held in memory
    }
  },
});

/** Linked is better than trying, trying better than a code on show: the chip shows the best slot's state. */
const RANK: LinkState[] = ['paired', 'reconnecting', 'lost', 'offline', 'connecting', 'unpaired'];

export interface HubSnapshot {
  /** Scoreboards linked right now. */
  linked: number;
  matchId: string | null;
}

export class MatchHub implements ScoreSource {
  readonly kind = 'peer' as const;
  private match: MatchLog | null;
  private listener: SourceListener | null = null;
  private assemblers = new Map<LinkPort, SyncAssembler>();
  private results = new Map<string, InputResult>();
  private cmdFrom = new Map<string, LinkPort>();
  private lastReport: RecReport | null = null;
  private lastLink: LinkState;
  private snap: HubSnapshot;
  private listeners = new Set<() => void>();

  constructor(
    private readonly ports: readonly LinkPort[],
    private readonly store: HubStore,
  ) {
    this.match = store.load();
    this.lastLink = this.link();
    this.snap = { linked: 0, matchId: this.match?.matchId ?? null };
    for (const port of ports) {
      this.assemblers.set(port, new SyncAssembler());
      let paired = port.getSnapshot().state !== 'unpaired';
      port.onOpen = () => this.opened(port);
      port.onMessage = (m) => this.receive(port, m);
      port.subscribe(() => {
        const s = port.getSnapshot().state;
        const was = paired;
        paired = s !== 'unpaired';
        if (was && !paired && this.ports.every((p) => p.getSnapshot().state === 'unpaired')) this.forget();
        this.changed();
      });
    }
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): HubSnapshot => this.snap;

  /** The match this camera holds (tests, diagnostics). */
  current(): MatchLog | null {
    return this.match;
  }

  /** No scoreboard is paired any more: the next one to pair brings its own match. */
  forget(): void {
    this.match = null;
    this.results.clear();
    this.store.save(null);
    this.changed();
  }

  private changed(): void {
    const link = this.link();
    if (link !== this.lastLink) {
      this.lastLink = link;
      this.listener?.link(link);
    }
    const linked = this.ports.filter((p) => p.isOpen()).length;
    if (linked !== this.snap.linked) {
      for (const p of this.ports) if (p.isOpen()) p.send({ t: 'peers', count: linked });
    }
    const matchId = this.match?.matchId ?? null;
    if (linked !== this.snap.linked || matchId !== this.snap.matchId) {
      this.snap = { linked, matchId };
      for (const fn of this.listeners) fn();
    }
  }

  /** A link (re)opened: that scoreboard gets the whole match, the recording state, and who else is linked. */
  private opened(port: LinkPort): void {
    this.sendState(port);
    if (this.lastReport) port.send({ t: 'rec', ...this.lastReport });
    this.snap = { ...this.snap, linked: -1 }; // make changed() tell every scoreboard the new count
    this.changed();
  }

  private sendState(port: LinkPort): void {
    for (const part of stateParts(this.match)) if (!port.sendRaw(part)) return;
  }

  private broadcastState(): void {
    for (const p of this.ports) if (p.isOpen()) this.sendState(p);
  }

  private receive(port: LinkPort, m: Parameters<LinkPort['onMessage']>[0]): void {
    switch (m.t) {
      case 'sync': {
        const log = this.assemblers.get(port)!.add(m);
        if (log) this.adopt(port, log);
        return;
      }
      case 'input':
        return this.input(port, m);
      case 'resync':
        return this.sendState(port);
      case 'cmd':
        this.cmdFrom.set(m.id, port);
        this.listener?.command({ id: m.id, action: m.action });
        return;
    }
  }

  /** A scoreboard offers its match: taken when the camera holds none, else that scoreboard takes the camera's. */
  private adopt(port: LinkPort, log: MatchLog): void {
    if (this.match) return this.sendState(port);
    this.setMatch(log);
    this.broadcastState();
  }

  private setMatch(log: MatchLog): void {
    this.match = log;
    this.results.clear();
    this.store.save(log);
    this.listener?.sync(log);
    this.changed();
  }

  /** The input's time on this phone's clock: the scoreboard's time minus its offset, as measured on this link. */
  private cameraTime(port: LinkPort, at: number): number {
    const c = port.clockEstimate(); // scoreboard minus camera
    return c && c.samples > 0 ? Math.round(at - c.offsetMs) : at;
  }

  private input(port: LinkPort, m: MsgOf<'input'>): void {
    const { input, matchId } = m;
    let result = this.results.get(input.id);
    if (!result) {
      result = this.apply(port, matchId, input);
      this.results.set(input.id, result);
    }
    port.send({ t: 'result', id: input.id, result });
  }

  private apply(port: LinkPort, matchId: string, input: Input): InputResult {
    const at = this.cameraTime(port, input.at);
    const b = input.body;
    if (b.type === 'match.start') {
      if (this.match?.matchId === matchId) return 'applied'; // a resend
      const first = { ...b, seq: 1, id: input.id, at, by: input.by } as MatchEvent;
      this.setMatch({ matchId, config: b.config, events: [first] });
      this.broadcastState();
      return 'applied';
    }
    const cur = this.match;
    if (!cur || cur.matchId !== matchId) return 'ignored'; // for a match the camera no longer holds
    const r = applyInput(cur.config, cur.events, input, at);
    if (r.events === cur.events) return r.result;
    const event = r.events[r.events.length - 1];
    this.match = { ...cur, events: r.events };
    this.store.save(this.match);
    for (const p of this.ports) if (p.isOpen()) p.send({ t: 'event', matchId, event });
    this.listener?.event(event);
    return r.result;
  }

  // ---- ScoreSource ----

  connect(l: SourceListener): () => void {
    this.listener = l;
    l.link(this.link());
    if (this.match) l.sync(this.match);
    return () => {
      if (this.listener === l) this.listener = null;
    };
  }

  link(): LinkState {
    const states = this.ports.map((p) => (p.isOpen() ? 'paired' : p.getSnapshot().state));
    return RANK.find((s) => states.includes(s)) ?? 'unpaired';
  }

  /** The events are on this phone's clock already (cameraTime), so the offset is 0; samples and rtt as measured. */
  clock(): ClockEstimate | null {
    const p = this.ports.find((x) => x.isOpen() && x.clockEstimate()) ?? this.ports.find((x) => x.clockEstimate());
    const c = p?.clockEstimate();
    return c ? { offsetMs: 0, samples: c.samples, medianRttMs: c.medianRttMs } : null;
  }

  peer(): PeerInfo | null {
    const p = this.ports.find((x) => x.isOpen() && x.getSnapshot().remote) ?? this.ports.find((x) => x.getSnapshot().remote);
    const r = p?.getSnapshot().remote;
    return r ? { id: r.deviceId, ua: r.ua ?? '', app: r.app } : null;
  }

  report(r: RecReport): void {
    this.lastReport = r;
    for (const p of this.ports) if (p.isOpen()) p.send({ t: 'rec', ...r });
  }

  /** The answer goes to the scoreboard that asked. */
  ack(id: string, ok: boolean, error?: string): void {
    const p = this.cmdFrom.get(id);
    p?.send(error ? { t: 'ack', id, ok, error } : { t: 'ack', id, ok });
  }
}
