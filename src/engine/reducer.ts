// Pure, event-sourced score engine: reduce(config, events) -> MatchState.
// Ported from the plain-JS engine in docs/mockup/index.html; rules table in docs/technical-design.md §3.4.
import {
  TEAMS,
  decidesMatch,
  isDecidingGame,
  matchWinner,
  other,
  parityCourt,
  totalGames,
  winsGame,
} from './rules';
import type { EventType, MatchConfig, MatchEvent, MatchState, Positions, Team } from './types';

/**
 * Every event type this build knows. A log may carry types from a newer build: the guards keep them and the
 * reducer passes over them, so an older phone still shows the score (technical-design.md §4.4).
 */
export const EVENT_TYPES: ReadonlySet<string> = new Set<EventType>([
  'match.start',
  'point',
  'undo',
  'redo',
  'correct',
  'sides.swap',
  'courts.swap',
  'server.set',
  'interval.end',
  'game.start',
  'match.end',
  'tag',
  'tag.clear',
  'summary.close',
]);

/**
 * Events a user action creates and Undo can take back. `match.end` is included so "End match" can be undone.
 * Tags are not: Undo always takes back the last scoring action, and a tag is changed by a newer tag (D15).
 */
export const UNDOABLE: ReadonlySet<EventType> = new Set<EventType>([
  'point',
  'correct',
  'sides.swap',
  'courts.swap',
  'server.set',
  'game.start',
  'interval.end',
  'match.end',
]);

export function initialState(cfg: MatchConfig): MatchState {
  const pos = {} as Record<Team, Positions>;
  for (const t of TEAMS) {
    const r = cfg.doubles ? cfg.startRight[t] : 0;
    pos[t] = { right: r, left: cfg.doubles ? 1 - r : 0 };
  }
  const s: MatchState = {
    phase: 'playing',
    game: 1,
    score: { A: 0, B: 0 },
    games: { A: 0, B: 0 },
    completed: [],
    server: cfg.firstServer,
    serverIdx: pos[cfg.firstServer].right,
    pos,
    leftTeam: cfg.leftTeamAtStart,
    doubles: cfg.doubles,
    gamePoint: null,
    matchPoint: null,
    winner: null,
    intervalKind: null,
    pendingSwap: false,
    intervalDone: false,
    lastGameWinner: null,
    phaseSince: null,
  };
  return s;
}

const swapCourts = (p: Positions): Positions => ({ right: p.left, left: p.right });

/** Put the serving player in the court matching the serving team's score (doubles only). */
function placeServerInParityCourt(s: MatchState): void {
  if (!s.doubles) return;
  const want = parityCourt(s.score[s.server]);
  if (s.pos[s.server][want] !== s.serverIdx) s.pos[s.server] = swapCourts(s.pos[s.server]);
}

function setFlags(cfg: MatchConfig, s: MatchState): void {
  s.gamePoint = null;
  s.matchPoint = null;
  if (s.phase !== 'playing' && s.phase !== 'interval') return;
  for (const t of TEAMS) {
    if (!winsGame(cfg, s.score[t] + 1, s.score[other(t)])) continue;
    // At 20-20 neither team is one point from winning; at 29-29 both are. Prefer the server's flag then.
    if (s.gamePoint && s.gamePoint === s.server) continue;
    s.gamePoint = t;
    s.matchPoint = decidesMatch(cfg, s, t) ? t : null;
  }
}

function endInterval(s: MatchState): void {
  s.phase = 'playing';
  s.intervalKind = null;
  s.phaseSince = null;
  if (s.pendingSwap) {
    s.leftTeam = other(s.leftTeam);
    s.pendingSwap = false;
  }
}

function applyPoint(cfg: MatchConfig, s: MatchState, t: Team, at: number): void {
  if (s.phase !== 'playing' && s.phase !== 'interval') return; // a point during gameOver or matchOver is ignored
  if (s.phase === 'interval') endInterval(s);
  s.score[t]++;
  if (!s.doubles) {
    s.server = t;
    s.serverIdx = 0;
  } else if (t === s.server) {
    s.pos[t] = swapCourts(s.pos[t]); // Law 11.2: same server, from the other court
  } else {
    s.server = t; // Law 11.3: nobody moves; the player in the parity court serves
    s.serverIdx = s.pos[t][parityCourt(s.score[t])];
  }
  const me = s.score[t];
  const op = s.score[other(t)];
  if (winsGame(cfg, me, op)) {
    s.games[t]++;
    s.completed.push({ A: s.score.A, B: s.score.B });
    s.lastGameWinner = t;
    const over = s.game >= totalGames(cfg.format) || (cfg.format === 'bestOf3' && s.games[t] === 2);
    s.phase = over ? 'matchOver' : 'gameOver';
    s.intervalKind = over ? null : 'betweenGames';
    s.phaseSince = at;
    s.pendingSwap = false;
    if (over) s.winner = matchWinner(s.games);
  } else if (cfg.intervalAt && !s.intervalDone && Math.max(me, op) === cfg.intervalAt) {
    // Law 16.2.1: interval when the leading score first reaches 11; Law 8.1.3: ends change in the deciding game.
    s.intervalDone = true;
    s.phase = 'interval';
    s.intervalKind = 'midGame';
    s.phaseSince = at;
    s.pendingSwap = isDecidingGame(cfg, s.game);
  }
}

export function apply(cfg: MatchConfig, s: MatchState, e: MatchEvent): void {
  switch (e.type) {
    case 'point':
      applyPoint(cfg, s, e.team, e.at);
      break;
    case 'interval.end':
      if (s.phase === 'interval') endInterval(s);
      break;
    case 'game.start': {
      if (s.phase !== 'gameOver' || !s.lastGameWinner) return;
      s.game++;
      s.score = { A: 0, B: 0 };
      s.intervalDone = false;
      s.intervalKind = null;
      s.phaseSince = null;
      s.phase = 'playing';
      s.leftTeam = other(s.leftTeam); // Laws 8.1.1, 8.1.2
      s.server = s.lastGameWinner; // Law 7.6
      if (s.doubles) {
        // Law 11.1: the chosen server and receiver start in their right courts.
        const rcvTeam = other(s.server);
        const sv = e.serverIdx ?? s.pos[s.server].right;
        const rc = e.receiverIdx ?? s.pos[rcvTeam].right;
        s.pos[s.server] = { right: sv, left: 1 - sv };
        s.pos[rcvTeam] = { right: rc, left: 1 - rc };
        s.serverIdx = sv;
      } else s.serverIdx = 0;
      break;
    }
    case 'correct': {
      // Corrected after a game ended and without games given: the corrected score belongs to that game, so reopen it.
      if (!e.games && (s.phase === 'gameOver' || s.phase === 'matchOver') && s.lastGameWinner && s.completed.length === s.game) {
        s.games[s.lastGameWinner]--;
        s.completed.pop();
      }
      s.score = { ...e.score };
      if (e.games) {
        s.games = { ...e.games };
        s.game = s.games.A + s.games.B + 1;
        s.completed = s.completed.slice(0, s.game - 1);
      }
      if (e.leftTeam) s.leftTeam = e.leftTeam;
      const changedTeam = e.server !== s.server;
      s.server = e.server;
      if (!s.doubles) s.serverIdx = 0;
      else if (e.serverIdx != null) s.serverIdx = e.serverIdx;
      else if (changedTeam) s.serverIdx = s.pos[s.server][parityCourt(s.score[s.server])];
      placeServerInParityCourt(s);
      s.phase = 'playing';
      s.intervalKind = null;
      s.phaseSince = null;
      s.pendingSwap = false;
      s.winner = null;
      s.intervalDone = !!cfg.intervalAt && Math.max(s.score.A, s.score.B) >= cfg.intervalAt;
      break;
    }
    case 'sides.swap':
      s.leftTeam = other(s.leftTeam);
      break;
    case 'courts.swap':
      if (s.doubles) s.pos[e.team] = swapCourts(s.pos[e.team]); // positions only; the server stays the same person
      break;
    case 'server.set':
      s.server = e.team;
      s.serverIdx = s.doubles ? (e.idx ?? s.pos[e.team][parityCourt(s.score[e.team])]) : 0;
      placeServerInParityCourt(s);
      break;
    case 'match.end':
      if (s.phase === 'matchOver') return;
      s.phase = 'matchOver';
      s.intervalKind = null;
      s.pendingSwap = false;
      s.phaseSince = e.at;
      s.winner = matchWinner(s.games);
      break;
    case 'match.start':
    case 'undo':
    case 'redo':
    case 'tag': // why a point was won does not change the score (engine/tags.ts)
    case 'tag.clear':
    case 'summary.close': // only the video's summary card reads it (engine/tags.ts summaryStatus)
      break;
  }
  setFlags(cfg, s);
}

/** Seqs voided by undo; an undo voided by a redo does not count. */
export function voidSet(events: readonly MatchEvent[]): Set<number> {
  const deadUndos = new Set<number>();
  for (const e of events) if (e.type === 'redo') deadUndos.add(e.target);
  const voided = new Set<number>();
  for (const e of events) if (e.type === 'undo' && !deadUndos.has(e.seq)) voided.add(e.target);
  return voided;
}

export function reduce(cfg: MatchConfig, events: readonly MatchEvent[]): MatchState {
  const voided = voidSet(events);
  const s = initialState(cfg);
  for (const e of events) if (!voided.has(e.seq)) apply(cfg, s, e);
  return s;
}

/** The newest non-voided user event, the target of the next undo. */
export function lastUndoable(events: readonly MatchEvent[]): MatchEvent | null {
  const voided = voidSet(events);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (UNDOABLE.has(e.type) && !voided.has(e.seq)) return e;
  }
  return null;
}

/** The newest live undo, but only if no user event was added after it (a new point clears redo). */
export function lastRedoable(events: readonly MatchEvent[]): MatchEvent | null {
  const dead = new Set<number>();
  for (const e of events) if (e.type === 'redo') dead.add(e.target);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (UNDOABLE.has(e.type)) return null;
    if (e.type === 'undo' && !dead.has(e.seq)) return e;
  }
  return null;
}
