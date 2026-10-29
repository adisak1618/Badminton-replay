// The live overlay as data (technical-design.md §6.2, §7): what the camera burns into every frame. Pure, so a
// later Mac re-render (R-BURN-2) and the paired camera reuse it unchanged.
import {
  apply,
  initialState,
  other,
  servingCourt,
  voidSet,
  gameStats,
  matchStats,
  reasonsOn,
  summaryStatus,
  type MatchStats,
  type Stats,
  type Court,
  type MatchConfig,
  type MatchEvent,
  type MatchState,
  type Phase,
  type Team,
} from '../engine';
import type { CardTeam, EndCard, StatsRow, StatsTable } from './table';

export interface OverlaySide {
  team: Team;
  name: string;
  /** What the panel shows: 'NOK / PAE' in doubles, the one name in singles, the team name when no names were set. */
  players: string;
  color: string;
  score: number;
  games: number;
  serving: boolean;
}

/** One column of the panel: a finished game with its winner, or the game being played (live). */
export interface OverlayGame {
  left: number;
  right: number;
  winner: 'left' | 'right' | null;
  live: boolean;
}

export interface OverlayModel {
  /** The team drawn on the left of the box: the scoreboard's left team, or the other one when mirrored. */
  left: OverlaySide;
  right: OverlaySide;
  game: number;
  /** Every finished game, then the live one while a game is in play; games not started are absent. */
  games: OverlayGame[];
  phase: Phase;
  /** Game or match point, for the team that has it. */
  flag: { kind: 'gamePoint' | 'matchPoint'; team: Team } | null;
  server: { team: Team; name: string; court: Court };
  winner: Team | null;
  mirrored: boolean;
  /** The link is down: the score shown may be behind the scoreboard (ux-design.md E1). */
  stale: boolean;
  /** The player stats table for the chosen team, when the camera asks for it and the match records reasons. */
  table: StatsTable | null;
  /** The end-of-game summary card: after the last point is resolved, until the operator closes it or play resumes. */
  card: EndCard | null;
}

export interface OverlayOptions {
  mirrored: boolean;
  stale: boolean;
}

/** What the camera asks the video to show about the point reasons (C1 "Player stats" and "End-of-game summary"). */
export interface StatsOptions {
  table: { team: Team; opp: boolean } | null;
  card: boolean;
}
export const NO_STATS: StatsOptions = { table: null, card: false };

/** The players' names for the panel, upper case (doubles 'NAME1 / NAME2'). */
export function playersLabel(cfg: MatchConfig, team: Team): string {
  const t = cfg.teams[team];
  // configFromSetup fills blank doubles names with "<team> 1", "<team> 2": those are not names.
  const named = t.players.filter((p, i) => p.trim() && p !== `${t.name} ${i + 1}`);
  const label = cfg.doubles && named.length === t.players.length ? t.players.join(' / ') : cfg.doubles ? t.name : (t.players[0] ?? t.name);
  return label.toUpperCase();
}

export function overlayModel(cfg: MatchConfig, s: MatchState, opts: OverlayOptions): OverlayModel {
  const leftTeam = opts.mirrored ? other(s.leftTeam) : s.leftTeam;
  const side = (team: Team): OverlaySide => ({
    team,
    name: cfg.teams[team].name,
    players: playersLabel(cfg, team),
    color: cfg.teams[team].color,
    score: s.score[team],
    games: s.games[team],
    serving: s.server === team && (s.phase === 'playing' || s.phase === 'interval'),
  });
  const rightTeam = other(leftTeam);
  const games: OverlayGame[] = s.completed.map((g) => ({
    left: g[leftTeam],
    right: g[rightTeam],
    winner: g[leftTeam] > g[rightTeam] ? 'left' : g[rightTeam] > g[leftTeam] ? 'right' : null,
    live: false,
  }));
  if (s.phase === 'playing' || s.phase === 'interval')
    games.push({ left: s.score[leftTeam], right: s.score[rightTeam], winner: null, live: true });
  const flag = s.matchPoint
    ? { kind: 'matchPoint' as const, team: s.matchPoint }
    : s.gamePoint
      ? { kind: 'gamePoint' as const, team: s.gamePoint }
      : null;
  return {
    left: side(leftTeam),
    right: side(rightTeam),
    game: s.game,
    games,
    phase: s.phase,
    flag,
    server: { team: s.server, name: cfg.teams[s.server].players[s.serverIdx] ?? cfg.teams[s.server].name, court: servingCourt(s) },
    winner: s.winner,
    mirrored: opts.mirrored,
    stale: opts.stale,
    table: null,
    card: null,
  };
}

const playerNames = (cfg: MatchConfig, team: Team): string[] => {
  const t = cfg.teams[team];
  const names = cfg.doubles ? t.players : t.players.slice(0, 1);
  return names.map((p) => (p.trim() || t.name).toUpperCase());
};
const rowsOf = (cfg: MatchConfig, st: Stats, team: Team): StatsRow[] => playerNames(cfg, team).map((name, i) => {
    const p = st.players[team][i];
    return { name, W: p.W, A: p.A, F: p.forced, FE: p.FE, UE: p.UE };
  });

/**
 * The table and the card for the match state `s` at scoreboard time `cutoff`. The table shows the current game, so
 * its counts start from zero with each game; tags count from the moment they were saved, which is how a tag added
 * later from the rally list simply updates the numbers. Nothing is shown unless the match records reasons.
 */
export function statsOverlay(
  cfg: MatchConfig,
  events: readonly MatchEvent[],
  s: MatchState,
  cutoff: number,
  o: StatsOptions,
  ms: MatchStats | null = null,
): Pick<OverlayModel, 'table' | 'card'> {
  if (!reasonsOn(cfg) || (!o.table && !o.card)) return { table: null, card: null };
  const stats = ms ?? matchStats(cfg, events, cutoff);
  let table: StatsTable | null = null;
  if (o.table) {
    const t = o.table.team;
    const g = gameStats(stats, cfg, s.game);
    table = {
      team: t,
      color: cfg.teams[t].color,
      doubles: cfg.doubles,
      rows: rowsOf(cfg, g, t),
      opp: o.table.opp ? g.teams[t].oppForced + g.teams[t].oppUnforced : null,
    };
  }
  let card: EndCard | null = null;
  const sum = o.card ? summaryStatus(cfg, events, s, cutoff) : null;
  // The summary waits for the last point to be resolved (tagged, or the operator chose not to), then stays until the
  // operator closes it; it also ends with the next game's first rally (summaryStatus) and with the recording (camera).
  if (sum && sum.resolved && !sum.closed) {
    const st = sum.kind === 'match' ? stats.match : gameStats(stats, cfg, sum.game);
    const left = s.leftTeam; // the same order as the panel
    const teams: CardTeam[] = [left, other(left)].map((t) => {
      const p = st.teams[t];
      return {
        team: t,
        color: cfg.teams[t].color,
        label: playersLabel(cfg, t),
        rows: rowsOf(cfg, st, t),
        points: p.won,
        winners: p.winners,
        oppForced: p.oppForced,
        oppUnforced: p.oppUnforced,
        untagged: p.untagged,
        longestRun: st.longestRun[t],
        wonOnServe: st.wonOnServe[t],
      };
    });
    card = { kind: sum.kind, game: sum.game, seq: sum.seq, tagged: st.tagged, rallies: st.rallies, doubles: cfg.doubles, teams };
  }
  return { table, card };
}

/**
 * The match state the overlay shows at `cutoff` (scoreboard clock): only events with `at <= cutoff` are
 * replayed, but undos are taken from the whole known log. With an overlay delay that is what makes a quick
 * undo never reach the video (R-REC-4): the voided point is skipped even though its undo is "in the future".
 */
export function stateAt(cfg: MatchConfig, events: readonly MatchEvent[], cutoff: number): MatchState {
  const voided = voidSet(events);
  const s = initialState(cfg);
  for (const e of events) if (e.at <= cutoff && !voided.has(e.seq)) apply(cfg, s, e);
  return s;
}

/**
 * Per-frame overlay source with memoisation: the reducer runs only when the visible slice of the log
 * changes, not 30 times a second.
 */
export class OverlayClock {
  private key = '';
  private cfg: MatchConfig | null = null;
  private model: OverlayModel | null = null;

  /**
   * `now` is the camera's wall clock; `offsetMs` is camera minus scoreboard (technical-design.md §4.5), so an
   * event is shown once `at + offsetMs <= now - delayMs`.
   */
  at(
    cfg: MatchConfig | null,
    events: readonly MatchEvent[],
    now: number,
    o: { delayMs: number; offsetMs: number; mirrored: boolean; stale: boolean; stats?: StatsOptions },
  ): OverlayModel | null {
    if (!cfg) return null;
    const cutoff = now - o.delayMs - o.offsetMs;
    let visible = 0;
    for (const e of events) if (e.at <= cutoff) visible++;
    const last = events[events.length - 1];
    const st = o.stats ?? NO_STATS;
    const stKey = st.table ? `${st.table.team}${st.table.opp ? 1 : 0}` : '-';
    const key = `${events.length}:${last?.id ?? ''}:${visible}:${o.mirrored}:${o.stale}:${stKey}:${st.card ? 1 : 0}`;
    if (key !== this.key || !this.model || cfg !== this.cfg) {
      this.key = key;
      this.cfg = cfg;
      const s = stateAt(cfg, events, cutoff);
      this.model = { ...overlayModel(cfg, s, o), ...statsOverlay(cfg, events, s, cutoff, st) };
    }
    return this.model;
  }
}
