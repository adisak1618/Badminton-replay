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
  rallies,
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
import type { BandKind } from './draw';
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

/**
 * When the things that move started, from event times (scoreboard clock): the draw animates from these and the
 * frame's own `now`, so a frame depends on nothing but the log and its time (motion.ts).
 */
export interface OverlayAnim {
  /** The latest counted point, on the side of the box it was scored. */
  point: { side: 'left' | 'right'; at: number } | null;
  /** The latest change of serving side. */
  serve: { side: 'left' | 'right'; at: number } | null;
  /** The current status badge and the event that started it (the stale badge has none: it is not in the log). */
  band: { kind: BandKind; at: number } | null;
  /** The game that just finished: its column, counted from the left. */
  col: { index: number; at: number } | null;
}
export const NO_ANIM: OverlayAnim = { point: null, serve: null, band: null, col: null };

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
  /** Level at pointsToWin - 1 or more and nobody on game point yet (20-20 in a game to 21). */
  deuce: boolean;
  /** The scoreboard time the interval or the break between games ends (phaseSince + intervalMs), for the countdown. */
  intervalEndsAt: number | null;
  intervalTotal: number | null;
  /** The ends change when this interval closes (the deciding game). */
  pendingSwap: boolean;
  server: { team: Team; name: string; court: Court };
  winner: Team | null;
  mirrored: boolean;
  /** The link is down: the score shown may be behind the scoreboard (ux-design.md E1). */
  stale: boolean;
  /** The player stats table for the chosen team, when the camera asks for it and the match records reasons. */
  table: StatsTable | null;
  /** The end-of-game summary card: after the last point is resolved, until the operator closes it or play resumes. */
  card: EndCard | null;
  anim: OverlayAnim;
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
  const flag = flagOf(s);
  const interval = s.intervalKind && s.phaseSince != null ? cfg.intervalMs[s.intervalKind] : null;
  return {
    left: side(leftTeam),
    right: side(rightTeam),
    game: s.game,
    games,
    phase: s.phase,
    flag,
    deuce: deuceOf(cfg, s),
    intervalEndsAt: interval == null ? null : s.phaseSince! + interval,
    intervalTotal: interval,
    pendingSwap: s.phase === 'interval' && s.pendingSwap,
    server: { team: s.server, name: cfg.teams[s.server].players[s.serverIdx] ?? cfg.teams[s.server].name, court: servingCourt(s) },
    winner: s.winner,
    mirrored: opts.mirrored,
    stale: opts.stale,
    table: null,
    card: null,
    anim: NO_ANIM,
  };
}

const flagOf = (s: MatchState): OverlayModel['flag'] =>
  s.matchPoint ? { kind: 'matchPoint', team: s.matchPoint } : s.gamePoint ? { kind: 'gamePoint', team: s.gamePoint } : null;
const deuceOf = (cfg: MatchConfig, s: MatchState): boolean =>
  s.phase === 'playing' && !s.gamePoint && s.score.A === s.score.B && s.score.A >= cfg.pointsToWin - 1;

/** The badge the state calls for, as `bandOf` names it (without the link state, which is not in the log). */
function bandKind(cfg: MatchConfig, s: MatchState): BandKind | null {
  if (s.phase === 'matchOver') return s.winner ? 'matchOver' : 'draw';
  if (s.phase === 'gameOver') return 'gameOver';
  if (s.phase === 'interval') return 'interval';
  const f = flagOf(s);
  if (f) return f.kind;
  return deuceOf(cfg, s) ? 'deuce' : null;
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

/** The live table's numbers for team `t` in `game` at `cutoff`. */
function tableNumbers(cfg: MatchConfig, events: readonly MatchEvent[], cutoff: number, game: number, t: Team, opp: boolean, ms?: MatchStats) {
  const g = gameStats(ms ?? matchStats(cfg, events, cutoff), cfg, game);
  return { rows: rowsOf(cfg, g, t), opp: opp ? g.teams[t].oppForced + g.teams[t].oppUnforced : null };
}

/** How many of the latest tags of the game are diffed for the table's flash; older ones have long stopped flashing. */
const RECENT_TAGS = 3;

/**
 * The table and the card for the match state `s` at scoreboard time `cutoff`. The table shows the current game, so
 * its counts start from zero with each game; tags count from the moment they were saved, which is how a tag added
 * later from the rally list simply updates the numbers, and the counts a recent tag changed carry its time so the
 * cell can flash. Nothing is shown unless the match records reasons.
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
  const voided = voidSet(events);
  const visible = (e: MatchEvent) => e.at <= cutoff && !voided.has(e.seq);
  const rs = rallies(cfg, events, cutoff);
  let table: StatsTable | null = null;
  if (o.table) {
    const t = o.table.team;
    const now = tableNumbers(cfg, events, cutoff, s.game, t, o.table.opp, stats);
    const inGame = new Set(rs.filter((r) => r.game === s.game).map((r) => r.id));
    const recent = events.filter((e) => (e.type === 'tag' || e.type === 'tag.clear') && visible(e) && inGame.has(e.point)).slice(-RECENT_TAGS);
    const changed: Record<string, number> = {};
    for (const e of recent) {
      const before = tableNumbers(cfg, events, e.at - 1, s.game, t, o.table.opp);
      const after = tableNumbers(cfg, events, e.at, s.game, t, o.table.opp);
      after.rows.forEach((row, i) => {
        for (const k of ['W', 'A', 'F', 'FE', 'UE'] as const) if (row[k] !== before.rows[i][k]) changed[`${i}:${k}`] = e.at;
      });
      if (after.opp !== before.opp) changed.opp = e.at;
    }
    table = { team: t, color: cfg.teams[t].color, doubles: cfg.doubles, game: s.game, rows: now.rows, opp: now.opp, changed };
  }
  let card: EndCard | null = null;
  const sum = o.card ? summaryStatus(cfg, events, s, cutoff) : null;
  // The summary waits for the last point to be resolved (tagged, or the operator chose not to), then stays until the
  // operator closes it (it fades out from the close); it also ends with the next game's first rally (summaryStatus)
  // and with the recording (camera).
  if (sum && sum.resolved) {
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
    const last = rs.filter((r) => sum.kind === 'match' || r.game === sum.game).pop() ?? null;
    let shownAt = last?.at ?? s.phaseSince ?? 0;
    if (last) for (const e of events) if ((e.type === 'tag' || e.type === 'tag.clear') && e.point === last.id && visible(e)) shownAt = Math.max(shownAt, e.at);
    const close = sum.closed ? events.find((e) => e.type === 'summary.close' && visible(e) && e.seq > sum.seq) : undefined;
    const games: Array<[number, number]> = s.completed.slice(0, sum.kind === 'match' ? undefined : sum.game).map((g) => [g[left], g[other(left)]]);
    card = {
      kind: sum.kind,
      game: sum.game,
      seq: sum.seq,
      tagged: st.tagged,
      rallies: st.rallies,
      doubles: cfg.doubles,
      teams,
      games,
      minutes: st.rallies > 1 ? Math.max(1, Math.round(st.durationMs / 60_000)) : null,
      shownAt,
      closedAt: close ? close.at : null,
    };
  }
  return { table, card };
}

/**
 * The match state the overlay shows at `cutoff` (scoreboard clock): only events with `at <= cutoff` are
 * replayed, but undos are taken from the whole known log. With an overlay delay that is what makes a quick
 * undo never reach the video (R-REC-4): the voided point is skipped even though its undo is "in the future".
 */
export function stateAt(cfg: MatchConfig, events: readonly MatchEvent[], cutoff: number): MatchState {
  return replay(cfg, events, cutoff).state;
}

/**
 * `stateAt` plus when each moving part last changed (`OverlayAnim`, by team; `sideAnim` maps it onto the box).
 * One pass over the visible log, like `stateAt`.
 */
export function replay(cfg: MatchConfig, events: readonly MatchEvent[], cutoff: number): { state: MatchState; anim: TeamAnim } {
  const voided = voidSet(events);
  const s = initialState(cfg);
  const anim: TeamAnim = { point: null, serve: null, band: null, col: null };
  let band = bandKind(cfg, s);
  for (const e of events) {
    if (e.at > cutoff || voided.has(e.seq)) continue;
    const server = s.server;
    const games = s.completed.length;
    const counted = e.type === 'point' && (s.phase === 'playing' || s.phase === 'interval');
    apply(cfg, s, e);
    if (counted && e.type === 'point') anim.point = { team: e.team, at: e.at };
    if (s.server !== server) anim.serve = { team: s.server, at: e.at };
    if (s.completed.length > games) anim.col = { index: s.completed.length - 1, at: e.at };
    const k = bandKind(cfg, s);
    if (k !== band) anim.band = k ? { kind: k, at: e.at } : null;
    band = k;
  }
  return { state: s, anim };
}

/** The anim with teams, before it is put on the left or right of a (maybe mirrored) box. */
export interface TeamAnim {
  point: { team: Team; at: number } | null;
  serve: { team: Team; at: number } | null;
  band: OverlayAnim['band'];
  col: OverlayAnim['col'];
}
export function sideAnim(a: TeamAnim, m: Pick<OverlayModel, 'left'>): OverlayAnim {
  const side = (t: Team): 'left' | 'right' => (m.left.team === t ? 'left' : 'right');
  return {
    point: a.point && { side: side(a.point.team), at: a.point.at },
    serve: a.serve && { side: side(a.serve.team), at: a.serve.at },
    band: a.band,
    col: a.col,
  };
}

/**
 * Per-frame overlay source with memoisation: the reducer runs only when the visible slice of the log
 * changes, not 30 times a second.
 */
export class OverlayClock {
  private key = '';
  private cfg: MatchConfig | null = null;
  private model: OverlayModel | null = null;
  /** The scoreboard time of the last frame asked for: the draw animates against it. */
  cutoff = 0;

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
    this.cutoff = cutoff;
    let visible = 0;
    for (const e of events) if (e.at <= cutoff) visible++;
    const last = events[events.length - 1];
    const st = o.stats ?? NO_STATS;
    const stKey = st.table ? `${st.table.team}${st.table.opp ? 1 : 0}` : '-';
    const key = `${events.length}:${last?.id ?? ''}:${visible}:${o.mirrored}:${o.stale}:${stKey}:${st.card ? 1 : 0}`;
    if (key !== this.key || !this.model || cfg !== this.cfg) {
      this.key = key;
      this.cfg = cfg;
      const { state, anim } = replay(cfg, events, cutoff);
      const model = overlayModel(cfg, state, o);
      this.model = { ...model, ...statsOverlay(cfg, events, state, cutoff, st), anim: sideAnim(anim, model) };
    }
    return this.model;
  }
}
