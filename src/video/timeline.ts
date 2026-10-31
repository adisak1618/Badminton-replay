// The score at a moment of the video (D17, R-VID-8): what the board shows while a saved video is sought back and
// forth. Pure. The state at log-clock time `t` replays the events with `at <= t` and takes undos from the whole log,
// the same rule as the overlay's `stateAt` (overlay/model.ts) and `rallies(cutoff)`: a point that was undone never
// shows, even at the moment it was tapped. Only events that change the state count (a tag or a replay mark never
// makes the board "past"), so the states after each of them are worked out once per log and a position is a binary
// search away.
import { UNDOABLE, apply, initialState, reduce, voidSet, type MatchConfig, type MatchEvent, type MatchState } from '../engine';

export interface Moment {
  /** The match as it stood at that time. */
  state: MatchState;
  /** Some state change in the log is later than that time: the board shows a past moment, not the latest. */
  past: boolean;
  /** The log-clock time of the latest state change (the match start when nothing else happened). */
  latestAt: number;
}

export class Timeline {
  /** After the match start and each live state change, in log order. */
  private readonly steps: Array<{ at: number; state: MatchState }> = [];
  /** The steps' times never go back: a time is a binary search (always so for a log scored with this build). */
  private readonly ordered: boolean;
  readonly latestAt: number;

  constructor(
    private readonly cfg: MatchConfig,
    private readonly events: readonly MatchEvent[],
  ) {
    const voided = voidSet(events);
    const s = initialState(cfg);
    let ordered = true;
    let latest = events[0]?.at ?? 0;
    for (const e of events) {
      if (voided.has(e.seq) || !(e.type === 'match.start' || UNDOABLE.has(e.type))) continue;
      apply(cfg, s, e);
      const prev = this.steps[this.steps.length - 1];
      if (prev && e.at < prev.at) ordered = false;
      latest = Math.max(latest, e.at);
      this.steps.push({ at: e.at, state: structuredClone(s) });
    }
    this.ordered = ordered;
    this.latestAt = latest;
  }

  /** The match at log-clock time `t`. Before the first event: the start (a video match's clock never reads earlier). */
  at(t: number): Moment {
    const past = t < this.latestAt;
    const steps = this.steps;
    if (!steps.length) return { state: reduce(this.cfg, this.events), past: false, latestAt: this.latestAt };
    if (!past) return { state: steps[steps.length - 1].state, past, latestAt: this.latestAt };
    if (!this.ordered) return { state: this.replayTo(t), past, latestAt: this.latestAt };
    // The last step at or before t.
    let lo = 0;
    let hi = steps.length - 1;
    if (steps[0].at > t) return { state: initialState(this.cfg), past, latestAt: this.latestAt };
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (steps[mid].at <= t) lo = mid;
      else hi = mid - 1;
    }
    return { state: steps[lo].state, past, latestAt: this.latestAt };
  }

  /** A log whose times go back (taps made after seeking back, before this build): replay the events up to t. */
  private replayTo(t: number): MatchState {
    const voided = voidSet(this.events);
    const s = initialState(this.cfg);
    for (const e of this.events) if (e.at <= t && !voided.has(e.seq)) apply(this.cfg, s, e);
    return s;
  }
}
