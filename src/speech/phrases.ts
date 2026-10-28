// What the scoreboard says after each action (ux-design.md §4, D5): English umpire style by default, Thai
// selectable. The server's score is called first; "service over" is not spoken, the marker shows it.
import { other, type EventBody, type MatchConfig, type MatchState, type Team } from '../engine';

export type Lang = 'en' | 'th';

const EN_NUMBERS = [
  'love', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
  'twenty-one', 'twenty-two', 'twenty-three', 'twenty-four', 'twenty-five', 'twenty-six', 'twenty-seven',
  'twenty-eight', 'twenty-nine', 'thirty',
];
const EN_ORDINALS = ['', 'first', 'second', 'third'];

const num = (n: number, lang: Lang): string => (lang === 'en' ? (EN_NUMBERS[n] ?? String(n)) : n === 0 ? 'ศูนย์' : String(n));

/** "Twelve, nine" / "Five all" / "Twenty, game point, fifteen" / "Twenty-nine, game point all". */
export function scoreCall(s: MatchState, lang: Lang): string {
  const sv = s.score[s.server];
  const rc = s.score[other(s.server)];
  const flag = s.matchPoint ? 'match' : s.gamePoint ? 'game' : null;
  if (lang === 'th') {
    const f = flag === 'match' ? 'แมตช์พอยต์' : flag === 'game' ? 'เกมพอยต์' : '';
    if (sv === rc) return f ? `${num(sv, lang)} ${f} เท่า` : `${num(sv, lang)} เท่า`;
    return f ? `${num(sv, lang)} ${f} ${num(rc, lang)}` : `${num(sv, lang)} ต่อ ${num(rc, lang)}`;
  }
  if (sv === rc) return flag ? `${num(sv, lang)}, ${flag} point all` : `${num(sv, lang)} all`;
  return flag ? `${num(sv, lang)}, ${flag} point, ${num(rc, lang)}` : `${num(sv, lang)}, ${num(rc, lang)}`;
}

const gameName = (n: number, lang: Lang) => (lang === 'en' ? EN_ORDINALS[n] ?? `game ${n}` : `เกมที่ ${n}`);

export function loveAllPlay(game: number, lang: Lang): string {
  if (lang === 'th') return game === 1 ? 'ศูนย์เท่า เล่นได้' : `${gameName(game, lang)} ศูนย์เท่า เล่นได้`;
  return game === 1 ? 'Love all, play' : `${capitalise(gameName(game, lang))} game, love all, play`;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function gameWon(cfg: MatchConfig, s: MatchState, lang: Lang): string {
  const g = s.completed[s.completed.length - 1];
  const w = s.lastGameWinner as Team;
  const name = cfg.teams[w].name;
  const n = s.completed.length;
  if (lang === 'th') return `จบเกม. ${gameName(n, lang)} ${name} ชนะ ${g[w]} ต่อ ${g[other(w)]}`;
  return `Game. ${capitalise(gameName(n, lang))} game to ${name}, ${num(g[w], lang)}, ${num(g[other(w)], lang)}`;
}

function matchResult(cfg: MatchConfig, s: MatchState, lang: Lang): string {
  if (!s.winner) {
    const n = s.games.A;
    if (lang === 'th') return `จบการแข่งขัน เสมอ ${n} ต่อ ${n} เกม`;
    return n === 0 ? 'Match ended, no games completed' : `Match drawn, ${num(n, lang)} game${n === 1 ? '' : 's'} all`;
  }
  const w = s.winner;
  const name = cfg.teams[w].name;
  const a = s.games[w];
  const b = s.games[other(w)];
  if (lang === 'th') return `จบการแข่งขัน ${name} ชนะ ${a} ต่อ ${b} เกม`;
  return `Match won by ${name}, ${num(a, lang)} game${a === 1 ? '' : 's'} to ${num(b, lang)}`;
}

export type Chime = 'click' | 'interval' | 'game' | 'ends';

export interface Feedback {
  speech: string | null;
  chime: Chime | null;
}

/** Spoken text and sound for an action that moved the match from `prev` to `next`. */
export function feedbackFor(cfg: MatchConfig, prev: MatchState, next: MatchState, body: EventBody, lang: Lang): Feedback {
  const endsChanged = prev.leftTeam !== next.leftTeam;
  switch (body.type) {
    case 'match.start':
      return { speech: loveAllPlay(1, lang), chime: null };
    case 'point': {
      if (next.phase === 'matchOver') return { speech: `${gameWon(cfg, next, lang)}. ${matchResult(cfg, next, lang)}`, chime: 'game' };
      if (next.phase === 'gameOver') return { speech: gameWon(cfg, next, lang), chime: 'game' };
      if (next.phase === 'interval') {
        const extra = next.pendingSwap ? (lang === 'th' ? ' เปลี่ยนแดน' : ', change ends') : '';
        return { speech: `${scoreCall(next, lang)}${lang === 'th' ? ' พักครึ่งเกม' : ', interval'}${extra}`, chime: 'interval' };
      }
      return { speech: scoreCall(next, lang), chime: endsChanged ? 'ends' : 'click' };
    }
    case 'game.start':
      return { speech: loveAllPlay(next.game, lang), chime: 'ends' };
    case 'interval.end':
      return endsChanged
        ? { speech: lang === 'th' ? 'เปลี่ยนแดน' : 'Change ends', chime: 'ends' }
        : { speech: null, chime: null };
    case 'match.end':
      return { speech: matchResult(cfg, next, lang), chime: 'game' };
    case 'sides.swap':
      return { speech: null, chime: 'ends' };
    case 'undo':
    case 'redo':
    case 'correct':
    case 'courts.swap':
    case 'server.set':
      return {
        speech: next.phase === 'playing' || next.phase === 'interval' ? scoreCall(next, lang) : null,
        chime: null,
      };
  }
}
