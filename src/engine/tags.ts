// Point reasons (D15, technical-design.md §3.3): why each rally was won. A tag is an event of its own that names
// the point by id, appended whenever a scoreboard tags, changes or clears it; the newest valid tag of a live
// point wins, a voided point takes its tags with it and a redo brings them back. The score engine never sees
// tags; everything here is a pure fold over the log.
import { apply, initialState, voidSet } from './reducer';
import { other, receiverIdx } from './rules';
import type { MatchConfig, MatchEvent, PlayerRef, Shot, TagBody, Team } from './types';

export const SHOTS: readonly Shot[] = ['smash', 'kill', 'drop', 'net', 'drive', 'clear', 'serve'];

/** One counted rally: a live point that changed the score, with what the tag picker needs to know about it. */
export interface Rally {
  /** 1-based among counted rallies. */
  n: number;
  id: string;
  seq: number;
  at: number;
  by: string;
  game: number;
  team: Team; // won the rally
  served: PlayerRef; // who served it (singles: index 0)
  received: PlayerRef;
  after: Record<Team, number>; // the game score after it
  tag: TagBody | null;
}

const ref = (cfg: MatchConfig, r: PlayerRef | undefined): boolean =>
  !!r && (r.team === 'A' || r.team === 'B') && Number.isInteger(r.idx) && r.idx >= 0 && r.idx < cfg.teams[r.team].players.length;
export const sameRef = (a: PlayerRef | null | undefined, b: PlayerRef | null | undefined): boolean =>
  !!a && !!b && a.team === b.team && a.idx === b.idx;

/**
 * A tag that fits its rally (Q1, Q2): a winner was hit by the side that won the rally, an error by the side that
 * lost it; forced-by is the winning side and only for a forced error; an assist is the partner of the finisher
 * (winner) or of the player who forced the error, in doubles only.
 */
export function validTag(cfg: MatchConfig, rally: Pick<Rally, 'team'>, t: TagBody): boolean {
  if (!ref(cfg, t.hit)) return false;
  if (t.shot !== undefined && !SHOTS.includes(t.shot)) return false;
  const partnerOf = (r: PlayerRef | undefined) =>
    t.assist === undefined || (cfg.doubles && !!r && ref(cfg, t.assist) && t.assist.team === r.team && t.assist.idx !== r.idx);
  switch (t.how) {
    case 'winner':
      return t.hit.team === rally.team && t.forcedBy === undefined && partnerOf(t.hit);
    case 'forced':
      return (
        t.hit.team === other(rally.team) &&
        (t.forcedBy === undefined || (ref(cfg, t.forcedBy) && t.forcedBy.team === rally.team)) &&
        partnerOf(t.forcedBy)
      );
    case 'unforced':
      return t.hit.team === other(rally.team) && t.forcedBy === undefined && t.assist === undefined;
    default:
      return false;
  }
}

/**
 * Every counted rally in order, each with its newest valid tag. Points made in game over or match over do not count.
 * With `cutoff` only events with `at <= cutoff` count, but undos are still taken from the whole log, the same rule as
 * `stateAt` in the overlay: a quick undo never reaches the video, and a tag counts from the moment it was saved.
 */
export function rallies(cfg: MatchConfig, events: readonly MatchEvent[], cutoff: number = Infinity): Rally[] {
  const voided = voidSet(events);
  const s = initialState(cfg);
  const out: Rally[] = [];
  const byId = new Map<string, Rally>();
  for (const e of events) {
    if (voided.has(e.seq) || e.at > cutoff) continue;
    if (e.type === 'point') {
      const counted = s.phase === 'playing' || s.phase === 'interval';
      const served = { team: s.server, idx: s.serverIdx };
      const received = { team: other(s.server), idx: receiverIdx(s) };
      const game = s.game;
      apply(cfg, s, e);
      if (!counted) continue;
      const r: Rally = { n: out.length + 1, id: e.id, seq: e.seq, at: e.at, by: e.by, game, team: e.team, served, received, after: { ...s.score }, tag: null };
      out.push(r);
      byId.set(e.id, r);
    } else if (e.type === 'tag') {
      const r = byId.get(e.point);
      if (r && validTag(cfg, r, e)) r.tag = e;
    } else if (e.type === 'tag.clear') {
      const r = byId.get(e.point);
      if (r) r.tag = null;
    } else apply(cfg, s, e);
  }
  return out;
}

/** The counted rally with this point id, if it is live. */
export const rallyOf = (cfg: MatchConfig, events: readonly MatchEvent[], id: string): Rally | null =>
  rallies(cfg, events).find((r) => r.id === id) ?? null;

export interface PlayerStats {
  W: number; // winners
  forced: number; // opponents' errors this player forced
  A: number; // assists
  FE: number; // forced errors made
  UE: number; // unforced errors made
}

export interface TeamPoints {
  won: number;
  winners: number; // from own winners
  oppForced: number; // from the other side's forced errors
  oppUnforced: number; // from the other side's unforced errors
  untagged: number;
}

export interface Stats {
  /** 0 for the whole match. */
  game: number;
  rallies: number;
  tagged: number;
  players: Record<Team, PlayerStats[]>;
  teams: Record<Team, TeamPoints>;
  winnersByShot: Record<Team, Partial<Record<Shot, number>>>;
  /** Free extras from the log, no tagging needed. */
  longestRun: Record<Team, number>;
  wonOnServe: Record<Team, number>;
  /** From the first to the last counted rally of the game (0 for one rally). */
  durationMs: number;
}

export interface MatchStats {
  match: Stats;
  games: Stats[];
}

const zeroPlayer = (): PlayerStats => ({ W: 0, forced: 0, A: 0, FE: 0, UE: 0 });
const zeroTeam = (): TeamPoints => ({ won: 0, winners: 0, oppForced: 0, oppUnforced: 0, untagged: 0 });

function fold(cfg: MatchConfig, game: number, rs: readonly Rally[]): Stats {
  const st: Stats = {
    game,
    rallies: rs.length,
    tagged: 0,
    players: { A: cfg.teams.A.players.map(zeroPlayer), B: cfg.teams.B.players.map(zeroPlayer) },
    teams: { A: zeroTeam(), B: zeroTeam() },
    winnersByShot: { A: {}, B: {} },
    longestRun: { A: 0, B: 0 },
    wonOnServe: { A: 0, B: 0 },
    durationMs: rs.length ? rs[rs.length - 1].at - rs[0].at : 0,
  };
  const p = (r: PlayerRef) => st.players[r.team][r.idx];
  let run = 0;
  let runTeam: Team | null = null;
  let lastGame = 0;
  for (const r of rs) {
    const team = st.teams[r.team];
    team.won++;
    if (r.served.team === r.team) st.wonOnServe[r.team]++;
    run = r.team === runTeam && r.game === lastGame ? run + 1 : 1; // a run does not carry over into the next game
    runTeam = r.team;
    lastGame = r.game;
    st.longestRun[r.team] = Math.max(st.longestRun[r.team], run);
    const t = r.tag;
    if (!t) {
      team.untagged++;
      continue;
    }
    st.tagged++;
    if (t.how === 'winner') {
      team.winners++;
      p(t.hit).W++;
      if (t.shot) st.winnersByShot[r.team][t.shot] = (st.winnersByShot[r.team][t.shot] ?? 0) + 1;
    } else if (t.how === 'forced') {
      team.oppForced++;
      p(t.hit).FE++;
      if (t.forcedBy) p(t.forcedBy).forced++;
    } else {
      team.oppUnforced++;
      p(t.hit).UE++;
    }
    if (t.assist) p(t.assist).A++;
  }
  return st;
}

/** Stats per game and for the whole match (Q4 "End of game" cards, match.json `stats`). */
export function matchStats(cfg: MatchConfig, events: readonly MatchEvent[], cutoff: number = Infinity): MatchStats {
  const rs = rallies(cfg, events, cutoff);
  const games: Stats[] = [];
  for (const g of new Set(rs.map((r) => r.game))) games.push(fold(cfg, g, rs.filter((r) => r.game === g)));
  const match = fold(cfg, 0, rs);
  match.durationMs = games.reduce((a, g) => a + g.durationMs, 0);
  return { match, games };
}

/** The stats of one game as the video shows them: all zero while the game has no rally yet. */
export function gameStats(ms: MatchStats, cfg: MatchConfig, game: number): Stats {
  return ms.games.find((g) => g.game === game) ?? fold(cfg, game, []);
}

/** Untagged counted rallies, oldest first (the tag-later list). */
export const untagged = (rs: readonly Rally[]): Rally[] => rs.filter((r) => !r.tag);

/** Whether the scoreboards ask why points were won in this match. */
export const reasonsOn = (cfg: MatchConfig): boolean => cfg.reasons === 'endOfGame';

