// The live match: config + append-only event log, state derived by the pure reducer. Every change is
// persisted before the next one is queued (writes are serialised).
import {
  append,
  randomId,
  reduce,
  redoBody,
  undoBody,
  type EventBody,
  type MatchConfig,
  type MatchEvent,
  type MatchState,
} from '../engine';
import type { StoredMatch } from './persist';

export interface Snapshot {
  match: StoredMatch | null;
  state: MatchState | null;
}

export interface Change {
  prev: MatchState;
  next: MatchState;
  event: MatchEvent;
  config: MatchConfig;
}

type Save = (m: StoredMatch) => Promise<void>;

export class MatchStore {
  private snap: Snapshot = { match: null, state: null };
  private listeners = new Set<() => void>();
  private writes: Promise<void> = Promise.resolve();
  onSaveError: (err: unknown) => void = (err) => console.warn('saving the match failed', err);

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

  private set(match: StoredMatch | null): void {
    this.snap = { match, state: match ? reduce(match.config, match.events) : null };
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
    const events = append([], { type: 'match.start', config }, { at, by: this.device(), id: randomId() });
    const m: StoredMatch = { matchId: `m-${at}-${randomId().slice(0, 4)}`, config, events, createdAt: at, updatedAt: at };
    this.set(m);
    void this.persist(m);
    const state = this.snap.state!;
    return { prev: state, next: state, event: events[0], config };
  }

  load(m: StoredMatch): void {
    this.set(m);
  }

  close(): void {
    this.set(null);
  }

  emit(body: EventBody): Change | null {
    const { match, state } = this.snap;
    if (!match || !state) return null;
    const at = this.now();
    const events = append(match.events, body, { at, by: this.device(), id: randomId() });
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
}
