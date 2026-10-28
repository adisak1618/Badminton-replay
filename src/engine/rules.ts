// Rule helpers shared by the reducer and the UI. BWF Laws of Badminton, Laws 7, 8, 10, 11, 16.2.
import type { Court, Format, MatchConfig, MatchState, Points, Team } from './types';

export const TEAMS: readonly Team[] = ['A', 'B'];
export const other = (t: Team): Team => (t === 'A' ? 'B' : 'A');

/** Cap per R-SCORE-1: 21 / 30, 15 / 24, 11 / 20. */
export const capFor = (points: Points): number => (points === 21 ? 30 : points + 9);

export const totalGames = (format: Format): number => (format === 'fixed1' ? 1 : format === 'fixed2' ? 2 : 3);

/** Ends change mid-game only in the deciding game (Law 8.1.3): game 3 of a best of 3, or a fixed-1 game. */
export const isDecidingGame = (cfg: MatchConfig, game: number): boolean =>
  cfg.format === 'fixed1' || (cfg.format === 'bestOf3' && game === 3);

/** Laws 7.2, 7.4, 7.5: win at pointsToWin with a two-point lead, or at the cap. */
export const winsGame = (cfg: MatchConfig, me: number, op: number): boolean =>
  (me >= cfg.pointsToWin && me - op >= cfg.winBy) || me >= cfg.cap;

/** Laws 10.1, 11.1: serve from the right when the server's score is even, left when odd. */
export const parityCourt = (score: number): Court => (score % 2 === 0 ? 'right' : 'left');

/**
 * The court the server serves from. In doubles this is where the serving player stands, which equals
 * the parity court unless a `courts.swap` moved the players; in singles it is the parity court.
 */
export function servingCourt(s: MatchState): Court {
  if (s.doubles) {
    const p = s.pos[s.server];
    if (p.right === s.serverIdx) return 'right';
    if (p.left === s.serverIdx) return 'left';
  }
  return parityCourt(s.score[s.server]);
}

/** The receiver is the player of the other team standing diagonally opposite, in the court of the same name. */
export const receiverIdx = (s: MatchState): number => s.pos[other(s.server)][servingCourt(s)];

/** Whether a game won now would also decide the match (no match point for a game that ends in a fixed-2 1-1). */
export function decidesMatch(cfg: MatchConfig, s: Pick<MatchState, 'game' | 'games'>, t: Team): boolean {
  const g = s.games[t] + 1;
  if (cfg.format === 'bestOf3') return g === 2;
  return s.game >= totalGames(cfg.format) && g > s.games[other(t)];
}

export const matchWinner = (games: Record<Team, number>): Team | null =>
  games.A === games.B ? null : games.A > games.B ? 'A' : 'B';

export const totalPoints = (completed: Array<Record<Team, number>>): Record<Team, number> =>
  completed.reduce((a, g) => ({ A: a.A + g.A, B: a.B + g.B }), { A: 0, B: 0 });

