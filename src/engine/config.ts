// Match setup (S1) to MatchConfig, with the fresh-install defaults of R-SETUP-3.
import { capFor } from './rules';
import type { Format, MatchConfig, Points, Team } from './types';

/** Fixed palette with enough contrast on the dark background (R-SETUP-2). */
export const PALETTE = ['#2bd4a6', '#ff7a59', '#5aa9ff', '#ffd166', '#c792ff', '#ff6fa8'] as const;

export interface TeamSetup {
  name: string;
  color: number; // index into PALETTE
  players: [string, string]; // doubles names
  startRight: 0 | 1; // doubles: which player starts in the right service court
}

/** What S1 edits; `teams.A` is the team on the LEFT of the screen at the start. */
export interface MatchSetup {
  doubles: boolean;
  points: Points;
  format: Format;
  interval: boolean;
  firstServer: Team;
  teams: Record<Team, TeamSetup>;
}

export const DEFAULT_SETUP: MatchSetup = {
  doubles: false,
  points: 21,
  format: 'bestOf3',
  interval: true,
  firstServer: 'A',
  teams: {
    A: { name: 'A', color: 0, players: ['', ''], startRight: 0 },
    B: { name: 'B', color: 1, players: ['', ''], startRight: 0 },
  },
};

export function configFromSetup(setup: MatchSetup): MatchConfig {
  const team = (t: Team) => {
    const ts = setup.teams[t];
    const name = ts.name.trim() || t;
    const players = setup.doubles
      ? ts.players.map((p, i) => p.trim() || `${name} ${i + 1}`)
      : [name];
    return { name, color: PALETTE[ts.color] ?? PALETTE[t === 'A' ? 0 : 1], players };
  };
  return {
    pointsToWin: setup.points,
    winBy: 2,
    cap: capFor(setup.points),
    format: setup.format,
    intervalAt: setup.interval ? 11 : null,
    intervalMs: { midGame: 60_000, betweenGames: 120_000 },
    doubles: setup.doubles,
    teams: { A: team('A'), B: team('B') },
    firstServer: setup.firstServer,
    startRight: { A: setup.doubles ? setup.teams.A.startRight : 0, B: setup.doubles ? setup.teams.B.startRight : 0 },
    leftTeamAtStart: 'A',
  };
}
