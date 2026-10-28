// Test helpers: build an event log step by step. Imported only by *.test.ts.
import { configFromSetup, DEFAULT_SETUP, type MatchSetup } from './config';
import { append, redoBody, undoBody } from './log';
import { reduce } from './reducer';
import type { EventBody, MatchConfig, MatchEvent, MatchState, Team } from './types';

export function makeConfig(over: Partial<MatchSetup> = {}): MatchConfig {
  return configFromSetup({ ...DEFAULT_SETUP, ...over, teams: over.teams ?? DEFAULT_SETUP.teams });
}

/** A (Nok right, Pae left) vs B (Bank right, Tao left): the R-SCORE-3 example. */
export function doublesConfig(over: Partial<MatchSetup> = {}): MatchConfig {
  return makeConfig({
    doubles: true,
    teams: {
      A: { name: 'A', color: 0, players: ['Nok', 'Pae'], startRight: 0 },
      B: { name: 'B', color: 1, players: ['Bank', 'Tao'], startRight: 0 },
    },
    ...over,
  });
}

export class Match {
  events: MatchEvent[] = [];
  private t = 1_000_000;
  constructor(readonly cfg: MatchConfig) {
    this.push({ type: 'match.start', config: cfg });
  }
  push(body: EventBody): this {
    this.t += 1000;
    this.events = append(this.events, body, { at: this.t, by: 'test', id: `e${this.events.length + 1}` });
    return this;
  }
  get state(): MatchState {
    return reduce(this.cfg, this.events);
  }
  point(team: Team, n = 1): this {
    for (let i = 0; i < n; i++) this.push({ type: 'point', team });
    return this;
  }
  /** Points in sequence, e.g. 'AABAB'. */
  rallies(seq: string): this {
    for (const c of seq) this.point(c as Team);
    return this;
  }
  undo(): this {
    const b = undoBody(this.events);
    if (!b) throw new Error('nothing to undo');
    return this.push(b);
  }
  redo(): this {
    const b = redoBody(this.events);
    if (!b) throw new Error('nothing to redo');
    return this.push(b);
  }
  endInterval(): this {
    return this.push({ type: 'interval.end' });
  }
  startGame(serverIdx?: number, receiverIdx?: number): this {
    return this.push({ type: 'game.start', game: this.state.game + 1, serverIdx, receiverIdx });
  }
  /**
   * Play the current game from its present score to a-b without anyone winning early: points alternate
   * while both teams are short, then the rest go to the team still short. Mid-game intervals are dismissed.
   */
  scoreTo(a: number, b: number): this {
    for (;;) {
      const s = this.state;
      const needA = s.score.A < a;
      const needB = s.score.B < b;
      if (!needA && !needB) return this;
      if (s.phase === 'interval') {
        this.endInterval();
        continue;
      }
      if (s.phase !== 'playing') throw new Error(`cannot score in phase ${s.phase} at ${s.score.A}-${s.score.B}`);
      if (needA && (!needB || s.score.A <= s.score.B)) this.point('A');
      else this.point('B');
    }
  }
  /** Finish the current game at a-b and start the next one when the match goes on. */
  game(a: number, b: number, opts: { start?: boolean } = {}): this {
    this.scoreTo(a, b);
    if (opts.start !== false && this.state.phase === 'gameOver') this.startGame();
    return this;
  }
}
