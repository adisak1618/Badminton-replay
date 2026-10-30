// Every word the camera burns into the video (broadcast design, ux-design.md C1): the status badges in BWF's own
// English, the stats table and the end-of-game card in formal Thai. The captain chose this one set; the scoreboard
// phone's screens have their own words and are not drawn from here.
import type { StatKey } from './table';

export const WORDS = {
  gamePoint: 'GAME POINT',
  matchPoint: 'MATCH POINT',
  deuce: (a: number, b: number) => `DEUCE ${a}–${b}`,
  interval: 'INTERVAL',
  intervalSwap: 'INTERVAL · CHANGE ENDS',
  gameOver: (game: number) => `END OF GAME ${game}`,
  /** Before the between-games countdown; dropped when the panel is too narrow for both. */
  rest: 'BREAK',
  matchOver: 'END OF MATCH',
  draw: (a: number, b: number) => `DRAW ${a}–${b}`,
  stale: 'LINK LOST',
  win: 'WIN',
  /** The table's header over the names: its counts start from zero with each game. */
  tableGame: (game: number) => `GAME ${game}`,
  /** The line under the table: the other side's errors that gave this team a point, one number. */
  opp: 'คะแนนจากคู่แข่งเสีย',
  cardGame: (game: number) => `สรุปเกมที่ ${game}`,
  cardMatch: 'สรุปผลการแข่งขัน',
  cardEn: (kind: 'game' | 'match', game: number) => (kind === 'match' ? 'MATCH SUMMARY' : `GAME ${game} SUMMARY`),
  event: (doubles: boolean) => (doubles ? 'ประเภทคู่' : 'ประเภทเดี่ยว'),
  duration: (minutes: number) => `เวลาแข่งขัน ${minutes} นาที`,
  overview: 'ภาพรวมคะแนน',
  players: 'สถิติรายบุคคล',
  total: 'คะแนนรวม',
  fromWinners: 'จากวินเนอร์',
  fromForced: 'จากการบีบให้คู่แข่งเสีย',
  fromUnforced: 'จากคู่แข่งเสียเอง',
  untagged: 'ไม่ได้บันทึกเหตุผล',
  longestRun: 'คะแนนติดต่อกันสูงสุด',
  wonOnServe: 'ได้คะแนนขณะส่งลูก',
  tagged: (tagged: number, rallies: number) => `บันทึกเหตุผล ${tagged} จาก ${rallies} คะแนน`,
} as const;

/** The five columns, the same words in the live table and on the card. */
export const STAT_WORDS: Record<StatKey, string> = {
  W: 'วินเนอร์',
  A: 'สร้างโอกาส',
  F: 'บีบให้เสีย',
  FE: 'ถูกบีบเสีย',
  UE: 'เสียเอง',
};
/** The columns of points lost: their header sits on the deeper red and their counts are red. */
export const ERROR_COLUMNS: ReadonlySet<StatKey> = new Set<StatKey>(['FE', 'UE']);
