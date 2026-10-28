import type { Format, MatchConfig } from '../engine';

export const FORMAT_LABEL: Record<Format, string> = { bestOf3: 'best of 3', fixed2: 'fixed 2', fixed1: 'one game' };

/** m:ss */
export function clock(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** h:mm:ss or mm:ss for an elapsed time. */
export function elapsed(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(t % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const playerName = (cfg: MatchConfig, team: 'A' | 'B', idx: number): string =>
  cfg.teams[team].players[idx] ?? cfg.teams[team].name;
