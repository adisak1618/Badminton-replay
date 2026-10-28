// The live overlay as data (technical-design.md §6.2, §7): what the camera burns into every frame. Pure, so a
// later Mac re-render (R-BURN-2) and the paired camera (phase 2b) reuse it unchanged.
import {
  apply,
  initialState,
  other,
  servingCourt,
  voidSet,
  type Court,
  type MatchConfig,
  type MatchEvent,
  type MatchState,
  type Phase,
  type Team,
} from '../engine';

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

export interface OverlayModel {
  /** The team drawn on the left of the box: the scoreboard's left team, or the other one when mirrored. */
  left: OverlaySide;
  right: OverlaySide;
  game: number;
  phase: Phase;
  /** Game or match point, for the team that has it. */
  flag: { kind: 'gamePoint' | 'matchPoint'; team: Team } | null;
  server: { team: Team; name: string; court: Court };
  winner: Team | null;
  mirrored: boolean;
  /** The link is down: the score shown may be behind the scoreboard (ux-design.md E1). */
  stale: boolean;
}

export interface OverlayOptions {
  mirrored: boolean;
  stale: boolean;
}

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
  const flag = s.matchPoint
    ? { kind: 'matchPoint' as const, team: s.matchPoint }
    : s.gamePoint
      ? { kind: 'gamePoint' as const, team: s.gamePoint }
      : null;
  return {
    left: side(leftTeam),
    right: side(other(leftTeam)),
    game: s.game,
    phase: s.phase,
    flag,
    server: { team: s.server, name: cfg.teams[s.server].players[s.serverIdx] ?? cfg.teams[s.server].name, court: servingCourt(s) },
    winner: s.winner,
    mirrored: opts.mirrored,
    stale: opts.stale,
  };
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
    o: { delayMs: number; offsetMs: number; mirrored: boolean; stale: boolean },
  ): OverlayModel | null {
    if (!cfg) return null;
    const cutoff = now - o.delayMs - o.offsetMs;
    let visible = 0;
    for (const e of events) if (e.at <= cutoff) visible++;
    const last = events[events.length - 1];
    const key = `${events.length}:${last?.id ?? ''}:${visible}:${o.mirrored}:${o.stale}`;
    if (key !== this.key || !this.model || cfg !== this.cfg) {
      this.key = key;
      this.cfg = cfg;
      this.model = overlayModel(cfg, stateAt(cfg, events, cutoff), o);
    }
    return this.model;
  }
}
