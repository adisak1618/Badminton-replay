// Types for the score engine. Mirrors docs/technical-design.md §3.1 to §3.3.

export type Team = 'A' | 'B';
export type Format = 'bestOf3' | 'fixed2' | 'fixed1'; // D12
export type Points = 11 | 15 | 21;
export type Court = 'right' | 'left';

export interface TeamConfig {
  name: string;
  color: string;
  players: string[]; // 1 name in singles, 2 in doubles
}

/** D15: whether the scoreboards ask why each point was won. Absent (matches started before D15) means off. */
export type PointReasons = 'off' | 'endOfGame';

export interface MatchConfig {
  pointsToWin: Points;
  winBy: 2;
  cap: number; // 30 for 21; pointsToWin + 9 otherwise
  format: Format;
  intervalAt: number | null; // 11, or null to disable
  intervalMs: { midGame: number; betweenGames: number };
  doubles: boolean;
  teams: Record<Team, TeamConfig>;
  firstServer: Team;
  startRight: Record<Team, 0 | 1>; // doubles: index of the player who starts in the right court
  leftTeamAtStart: Team; // left of the scoreboard screen (S1)
  reasons?: PointReasons; // D15
}

/** A player by team and index into teams[team].players. */
export interface PlayerRef {
  team: Team;
  idx: number;
}

/** How a rally ended (D15, Q1): the last shot landed untouched, or the other side erred under pressure or not. */
export type How = 'winner' | 'forced' | 'unforced';
/** The rally's last shot. kill = net kill or interception; net = net shot; drive = drive, push or block; clear = clear or lift. */
export type Shot = 'smash' | 'kill' | 'drop' | 'net' | 'drive' | 'clear' | 'serve';

/** Why a point was won: who played the last shot and how; the credit fields are optional (technical-design.md §3.3). */
export interface TagBody {
  type: 'tag';
  point: string; // id of the point event: the same on every phone, whoever orders the log
  how: How;
  hit: PlayerRef; // scoring side for a winner, losing side for an error
  forcedBy?: PlayerRef; // forced errors: the scoring-side player whose shot forced it
  assist?: PlayerRef; // doubles: the finisher's partner who played the side's previous shot
  shot?: Shot;
}

export type Phase = 'playing' | 'interval' | 'gameOver' | 'matchOver';

export interface Positions {
  right: number; // player index standing in the right service court
  left: number;
}

export interface MatchState {
  phase: Phase;
  game: number; // 1-based
  score: Record<Team, number>;
  games: Record<Team, number>;
  completed: Array<Record<Team, number>>;
  server: Team;
  serverIdx: number; // index into teams[server].players
  pos: Record<Team, Positions>; // who stands in which service court
  leftTeam: Team; // which team is on the left of the scoreboard
  doubles: boolean; // copied from the config: `pos` tracks real people only in doubles
  gamePoint: Team | null;
  matchPoint: Team | null;
  winner: Team | null; // null until decided; stays null for a fixed-2 draw
  intervalKind: 'midGame' | 'betweenGames' | null;
  pendingSwap: boolean; // ends change when the current interval closes
  // Bookkeeping the reducer needs; not part of the documented shape but derivable all the same.
  intervalDone: boolean; // the mid-game interval of the current game has happened
  lastGameWinner: Team | null;
  phaseSince: number | null; // `at` of the event that put the match in its current interval/gameOver/matchOver phase
}

export interface EventBase {
  seq: number; // dense and increasing on the scoreboard phone
  id: string; // random, so a resent event is deduplicated
  at: number; // wall clock ms on the scoreboard phone
  by: string; // device id
}

export type EventBody =
  | { type: 'match.start'; config: MatchConfig }
  | { type: 'point'; team: Team }
  | { type: 'undo'; target: number } // seq of the event being voided
  | { type: 'redo'; target: number } // seq of the undo being voided
  | {
      type: 'correct';
      score: Record<Team, number>;
      games?: Record<Team, number>;
      server: Team;
      serverIdx?: number;
      leftTeam?: Team;
    }
  | { type: 'sides.swap' } // ends
  | { type: 'courts.swap'; team: Team } // the two players of one team swap service courts
  | { type: 'server.set'; team: Team; idx?: number }
  | { type: 'interval.end' } // user dismissed or countdown ended
  | { type: 'game.start'; game: number; serverIdx?: number; receiverIdx?: number }
  | { type: 'match.end'; reason: 'won' | 'abandoned' }
  | TagBody // the newest tag of a live point wins; never undone itself (D15)
  | { type: 'tag.clear'; point: string };

export type MatchEvent = EventBase & EventBody;
export type EventType = EventBody['type'];
