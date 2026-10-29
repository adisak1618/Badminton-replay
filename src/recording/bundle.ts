// match.json, the export bundle's log (technical-design.md §8; R-EXP-1, R-BURN-1): config, every event with
// its time on the recording, the derived state after it, and which team was on the camera's left. With point
// reasons on (D15) also `stats`, derived from the tags in `events` like `after` is from the points.
import { matchStats, other, reasonsOn, reduce, type MatchConfig, type MatchEvent, type MatchState, type MatchStats, type Team } from '../engine';
import type { ClockEstimate, PeerInfo } from '../link/source';
import type { MirrorLog, RecordingMeta } from './meta';
import type { Segment } from './session';

export type BundleEvent = MatchEvent & {
  tRec: { segment: number; ms: number } | null; // null when no segment was recording
  after: MatchState; // derived state after this event, positions included
  leftOnCamera: Team; // after.leftTeam, flipped when the segment is mirrored
};

export interface MatchBundle {
  format: 'badminton-scoreboard/match';
  version: 1;
  matchId: string;
  createdAt: number;
  app: string;
  /** Null only for a recording made unpaired, which has no match to describe. */
  config: MatchConfig | null;
  devices: { scoreboard: PeerInfo; camera?: PeerInfo };
  clock?: ClockEstimate;
  recording?: { segments: Segment[] };
  events: BundleEvent[];
  result: { winner: Team | null; games: Record<Team, number>; completed: Array<Record<Team, number>> };
  /** D15: why points were won, per game and for the match; absent when the match did not ask. */
  stats?: MatchStats;
}

/** The segment recording at camera time `t`, if any. */
export function segmentAt(segments: readonly Segment[], t: number): Segment | null {
  for (const s of segments) if (t >= s.startedAt && (s.endedAt == null || t <= s.endedAt)) return s;
  return null;
}

/** §8: tRec.ms = (event.at + clock.offsetMs) − segment.startedAt − segment.startLatencyMs. */
export function tRecFor(at: number, offsetMs: number, segments: readonly Segment[]): { segment: number; ms: number } | null {
  const t = at + offsetMs;
  const seg = segmentAt(segments, t);
  return seg ? { segment: seg.index, ms: Math.round(t - seg.startedAt - seg.startLatencyMs) } : null;
}

/** Mirroring in force at camera time `t`: the segment recording then, else the latest one started before, else the first. */
function mirroredAt(segments: readonly Segment[], t: number): boolean {
  const seg = segmentAt(segments, t) ?? [...segments].reverse().find((s) => s.startedAt <= t) ?? segments[0];
  return seg?.overlay.mirrored ?? false;
}

/** Exported names keep the files of one match together wherever they land: match-<yyyymmdd-hhmm>-video-<n>.mp4. */
export function bundleName(createdAt: number): string {
  const d = new Date(createdAt);
  const p = (n: number) => String(n).padStart(2, '0');
  return `match-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export const exportFileName = (createdAt: number, file: string): string => `${bundleName(createdAt)}-${file}`;

export function buildBundle(input: { meta: RecordingMeta; log: MirrorLog | null; app: string; now: number }): MatchBundle {
  const { meta, log, app, now } = input;
  const clock = meta.clock ?? { offsetMs: 0, samples: 0, medianRttMs: 0 };
  const segments = meta.segments.map((s) => ({ ...s, file: exportFileName(meta.createdAt, s.file) }));
  const cfg = log?.config ?? null;
  const events: MatchBundle['events'] = [];
  if (log && cfg)
    log.events.forEach((e, i) => {
      // The state after each event is a replay of the prefix, so a later undo does not rewrite history.
      const after = reduce(cfg, log.events.slice(0, i + 1));
      const t = e.at + clock.offsetMs;
      events.push({
        ...e,
        tRec: tRecFor(e.at, clock.offsetMs, meta.segments),
        after,
        leftOnCamera: mirroredAt(meta.segments, t) ? other(after.leftTeam) : after.leftTeam,
      });
    });
  const final = cfg && log ? reduce(cfg, log.events) : null;
  const scoreboard = meta.scoreboard ?? { id: log?.events[0]?.by ?? 'unknown', ua: '' };
  const stats = cfg && log && reasonsOn(cfg) ? { stats: matchStats(cfg, log.events) } : {};
  return {
    format: 'badminton-scoreboard/match',
    version: 1,
    matchId: log?.matchId ?? meta.matchId ?? meta.id,
    createdAt: now,
    app,
    config: cfg,
    devices: { scoreboard, camera: meta.camera },
    clock,
    recording: { segments },
    events,
    result: final
      ? { winner: final.winner, games: final.games, completed: final.completed }
      : { winner: null, games: { A: 0, B: 0 }, completed: [] },
    ...stats,
  };
}

/**
 * The scoreboard's own match.json (R-EXP-1): the same shape without a recording, so no clock, no segments and
 * no times on a video (`tRec` null); it replays to the final score.
 */
export function buildLogBundle(input: { matchId: string; config: MatchConfig; events: MatchEvent[]; scoreboard: PeerInfo; app: string; now: number }): MatchBundle {
  const { matchId, config: cfg, events: log, scoreboard, app, now } = input;
  const events: MatchBundle['events'] = log.map((e, i) => {
    const after = reduce(cfg, log.slice(0, i + 1));
    return { ...e, tRec: null, after, leftOnCamera: after.leftTeam };
  });
  const final = reduce(cfg, log);
  return {
    format: 'badminton-scoreboard/match',
    version: 1,
    matchId,
    createdAt: now,
    app,
    config: cfg,
    devices: { scoreboard },
    events,
    result: { winner: final.winner, games: final.games, completed: final.completed },
    ...(reasonsOn(cfg) ? { stats: matchStats(cfg, log) } : {}),
  };
}
