// Words for point reasons (D15). English like the rest of the scoreboard; a Thai label switch is a follow-up.
import type { How, MatchConfig, PlayerRef, Shot, TagBody } from '../../engine';
import { playerName } from '../format';

export const SHOT_LABEL: Record<Shot, string> = {
  smash: 'Smash',
  kill: 'Net kill',
  drop: 'Drop',
  net: 'Net shot',
  drive: 'Drive / push',
  clear: 'Clear / lift',
  serve: 'Serve',
};

export const HOW_LABEL: Record<How, string> = { winner: 'winner', forced: 'forced error', unforced: 'unforced error' };

export const nameOf = (cfg: MatchConfig, r: PlayerRef): string => playerName(cfg, r.team, r.idx);

/** "Pae · winner · smash · assist Nok", "Bank · serve fault", "Tao · forced error · forced by Pae". */
export function tagText(cfg: MatchConfig, t: TagBody): string {
  const fault = t.how === 'unforced' && t.shot === 'serve';
  const parts = [nameOf(cfg, t.hit), fault ? 'serve fault' : HOW_LABEL[t.how]];
  if (t.shot && !fault) parts.push(SHOT_LABEL[t.shot].toLowerCase());
  if (t.forcedBy) parts.push(`forced by ${nameOf(cfg, t.forcedBy)}`);
  if (t.assist) parts.push(`assist ${nameOf(cfg, t.assist)}`);
  return parts.join(' · ');
}
