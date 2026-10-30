// The live match: config + append-only event log, state derived by the pure reducer. Every change is
// persisted before the next one is queued (writes are serialised).
//
// Paired (D14), the camera holds the match: this store shows the camera's log (`confirmed`) with this phone's
// own inputs that the camera has not answered yet applied on top (`pending`), so a tap shows at once and
// scoring never waits for the link (R-PAIR-3). Each input is sent to the camera through the sink; the camera's
// events confirm it, its result settles one it did not count. Unpaired, the store keeps its own log.
import {
  append,
  applyInput,
  randomId,
  reduce,
  redoBody,
  undoBody,
  type EventBody,
  type InputBody,
  type InputResult,
  type MatchConfig,
  type MatchEvent,
  type MatchState,
} from '../engine';
import type { MatchLog } from '../link/source';
import type { PendingInput, StoredMatch } from './persist';

export interface Snapshot {
  match: StoredMatch | null;
  state: MatchState | null;
  /** Who made the last change: this phone, or the camera it is paired with. */
  origin: 'local' | 'remote';
}

export interface Change {
  prev: MatchState;
  next: MatchState;
  event: MatchEvent;
  config: MatchConfig;
}

type Save = (m: StoredMatch) => Promise<void>;

/** Where a paired store's inputs go, and how this phone's clock maps onto the camera's. */
export interface RemoteSink {
  send(p: PendingInput): void;
  toCamera(at: number): number;
}

export class MatchStore {
  private snap: Snapshot = { match: null, state: null, origin: 'local' };
  private listeners = new Set<() => void>();
  private writes: Promise<void> = Promise.resolve();
  /** Paired: the camera's log (null while it holds none) and this phone's unanswered inputs. */
  private remote: { confirmed: MatchLog | null; pending: PendingInput[] } | null = null;
  private sink: RemoteSink | null = null;
  onSaveError: (err: unknown) => void = (err) => console.warn('saving the match failed', err);
  /** A tap the camera had already counted from the other scoreboard (paired only). */
  onDuplicate: () => void = () => {};

  constructor(
    private readonly save: Save,
    private readonly device: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => this.snap;

  private set(match: StoredMatch | null, origin: Snapshot['origin'] = 'local'): void {
    this.snap = { match, state: match ? reduce(match.config, match.events) : null, origin };
    for (const fn of this.listeners) fn();
  }

  private persist(m: StoredMatch): Promise<void> {
    this.writes = this.writes.then(() => this.save(m)).catch((err) => this.onSaveError(err));
    return this.writes;
  }

  /** Resolves when every queued write has finished. */
  flushed(): Promise<void> {
    return this.writes;
  }

  start(config: MatchConfig): Change {
    const at = this.now();
    const matchId = `m-${at}-${randomId().slice(0, 4)}`;
    if (this.remote) {
      const body = { type: 'match.start', config } as const;
      this.input(matchId, body, at);
      const state = this.snap.state!;
      return { prev: state, next: state, event: this.snap.match!.events[0], config };
    }
    const events = append([], { type: 'match.start', config }, { at, by: this.device(), id: randomId() });
    const m: StoredMatch = { matchId, config, events, createdAt: at, updatedAt: at };
    this.set(m);
    void this.persist(m);
    const state = this.snap.state!;
    return { prev: state, next: state, event: events[0], config };
  }

  load(m: StoredMatch): void {
    if (m.remote) {
      const confirmed = m.remote.confirmed > 0 ? { matchId: m.matchId, config: m.config, events: m.events.slice(0, m.remote.confirmed) } : null;
      this.remote = { confirmed, pending: m.remote.pending };
      this.show('local');
    } else {
      this.remote = null;
      this.set(m);
    }
  }

  close(): void {
    this.remote = null;
    this.set(null);
  }

  emit(body: EventBody): Change | null {
    const { match, state } = this.snap;
    if (!match || !state) return null;
    const at = this.now();
    if (this.remote) {
      const result = this.input(match.matchId, toInput(body), at);
      if (result === 'duplicate') this.onDuplicate();
      const next = this.snap.match!;
      return result === 'applied' ? { prev: state, next: this.snap.state!, event: next.events[next.events.length - 1], config: match.config } : null;
    }
    const stamp = { at, by: this.device(), id: randomId() };
    // A tag follows the camera's rule here too: only for a live point of a match that asks why (D15).
    if ((body.type === 'tag' || body.type === 'tag.clear') && applyInput(match.config, match.events, { ...stamp, body }, at).result !== 'applied')
      return null;
    const events = append(match.events, body, stamp);
    const m: StoredMatch = { ...match, events, updatedAt: at };
    this.set(m);
    void this.persist(m);
    return { prev: state, next: this.snap.state!, event: events[events.length - 1], config: match.config };
  }

  undo(): Change | null {
    const b = this.snap.match && undoBody(this.snap.match.events);
    return b ? this.emit(b) : null;
  }

  redo(): Change | null {
    const b = this.snap.match && redoBody(this.snap.match.events);
    return b ? this.emit(b) : null;
  }

  canRedo(): boolean {
    return !!this.snap.match && redoBody(this.snap.match.events) !== null;
  }

  canUndo(): boolean {
    return !!this.snap.match && undoBody(this.snap.match.events) !== null;
  }

  // ---- paired with a camera (D14) ----

  get paired(): boolean {
    return this.remote !== null;
  }

  /** Where inputs go while paired; null while there is no link to send them on. */
  setSink(sink: RemoteSink | null): void {
    this.sink = sink;
  }

  /** Inputs the camera has not answered, oldest first: sent again whenever the link has the camera's state. */
  pending(): readonly PendingInput[] {
    return this.remote?.pending ?? [];
  }

  /**
   * The camera's whole match: shown from now on. Pending inputs for that match stay and are sent again; any
   * other match this phone was showing is dropped (a new pairing, or the camera moved on meanwhile). A match this
   * phone started while the camera could not hear it, later than the camera's, goes on instead: its start and
   * inputs stay pending and are sent, and the camera takes it as it takes a new match from a linked scoreboard.
   * An input already in the camera's log is answered: a drop cut the camera's reply, and resending it would only
   * be answered `applied` again, which never settles it.
   */
  adopt(log: MatchLog): void {
    const applied = new Set(log.events.map((e) => e.id));
    const pending = (this.remote?.pending ?? []).filter((p) => !applied.has(p.input.id));
    const toCamera = this.sink?.toCamera ?? ((t: number) => t);
    const start = pending.findLast((p) => p.input.body.type === 'match.start');
    const newer = start && start.matchId !== log.matchId && toCamera(start.input.at) > (log.events[0]?.at ?? -Infinity) ? start.matchId : null;
    const keep = pending.filter((p) => (p.matchId === log.matchId && p.input.body.type !== 'match.start') || p.matchId === newer);
    this.remote = { confirmed: log, pending: keep };
    this.show(newer ? 'local' : 'remote');
  }

  /**
   * The camera holds no match: it adopts the one this phone shows (the log returned, to send as `sync`), or
   * this phone waits for one (null).
   */
  offer(): MatchLog | null {
    const m = this.snap.match;
    this.remote = { confirmed: m && { matchId: m.matchId, config: m.config, events: m.events }, pending: [] };
    this.show('local');
    return this.remote.confirmed;
  }

  /** One event the camera applied. False when it does not follow on from this copy (ask for the whole state). */
  confirm(matchId: string, e: MatchEvent): boolean {
    const c = this.remote?.confirmed;
    if (!this.remote || !c || c.matchId !== matchId || e.seq !== c.events.length + 1) return false;
    this.remote.confirmed = { ...c, events: [...c.events, e] };
    this.remote.pending = this.remote.pending.filter((p) => p.input.id !== e.id);
    this.show('remote');
    return true;
  }

  /** The camera's answer to one input: one it did not apply is no longer shown. */
  settle(id: string, result: InputResult): void {
    if (!this.remote || result === 'applied') return;
    const before = this.remote.pending.length;
    this.remote.pending = this.remote.pending.filter((p) => p.input.id !== id);
    if (this.remote.pending.length !== before) this.show('remote');
  }

  /** Unpaired: what is shown becomes this phone's own match again (R-PAIR-3). */
  local(): void {
    if (!this.remote) return;
    const m = this.snap.match;
    this.remote = null;
    if (!m) return this.set(null);
    const own: StoredMatch = { matchId: m.matchId, config: m.config, events: m.events, createdAt: m.createdAt, updatedAt: m.updatedAt };
    this.set(own);
    void this.persist(own);
  }

  private input(matchId: string, body: InputBody, at: number): InputResult {
    const p: PendingInput = { matchId, input: { id: randomId(), at, by: this.device(), body } };
    this.remote!.pending.push(p);
    const result = this.show('local', p.input.id);
    this.sink?.send(p);
    return result ?? 'ignored';
  }

  /** The camera's log with the pending inputs on top; returns what became of input `id`. */
  private show(origin: Snapshot['origin'], id?: string): InputResult | undefined {
    const r = this.remote!;
    let log = r.confirmed;
    let result: InputResult | undefined;
    const toCamera = this.sink?.toCamera ?? ((t: number) => t);
    for (const p of r.pending) {
      const b = p.input.body;
      let res: InputResult;
      if (b.type === 'match.start') {
        const at = toCamera(p.input.at);
        log = { matchId: p.matchId, config: b.config, events: [{ ...b, seq: 1, id: p.input.id, at, by: p.input.by } as MatchEvent] };
        res = 'applied';
      } else if (!log || log.matchId !== p.matchId) res = 'ignored';
      else {
        const a = applyInput(log.config, log.events, p.input, toCamera(p.input.at));
        log = { ...log, events: a.events };
        res = a.result;
      }
      if (p.input.id === id) result = res;
    }
    const prev = this.snap.match;
    const now = this.now();
    const m: StoredMatch | null = log && {
      matchId: log.matchId,
      config: log.config,
      events: log.events,
      createdAt: prev?.matchId === log.matchId ? prev.createdAt : (log.events[0]?.at ?? now),
      updatedAt: now,
      remote: { confirmed: r.confirmed?.matchId === log.matchId ? r.confirmed.events.length : 0, pending: r.pending },
    };
    this.set(m, origin);
    if (m) void this.persist(m);
    return result;
  }
}

/** A paired scoreboard's event as an input: undo and redo leave the target to the camera. */
function toInput(b: EventBody): InputBody {
  return b.type === 'undo' || b.type === 'redo' ? { type: b.type } : b;
}
