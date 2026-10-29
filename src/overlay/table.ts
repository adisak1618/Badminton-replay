// The player stats table and the end-of-game card burned into the video (D15 in the video, ux-design.md C1): a small
// Thai table that stays on screen for the chosen team, and a card for both teams when a game or the match ends.
// Plain Canvas 2D like draw.ts: rectangles, rounded rectangles, text and alpha, so it runs per camera frame on the
// phone and in a later re-render. The numbers come from `matchStats` in the engine; nothing here counts anything.
import type { Team } from '../engine';
import { DEFAULT_THEME, fit, type Box, type OverlayTheme } from './draw';

type Ctx = CanvasRenderingContext2D;

export type StatKey = 'W' | 'A' | 'F' | 'FE' | 'UE';

export interface StatsRow {
  name: string;
  W: number; // winners
  A: number; // assists ("ทำเกมดี"), doubles only
  F: number; // opponents' errors this player forced
  FE: number; // forced errors made
  UE: number; // unforced errors made
}

/** The live table: the chosen team's players for the current game. */
export interface StatsTable {
  team: Team;
  color: string;
  doubles: boolean;
  rows: StatsRow[];
  /** The other side's errors that gave this team a point (forced + unforced), one number and no detail; null = line off. */
  opp: number | null;
}

export interface CardTeam {
  team: Team;
  color: string;
  /** 'NOK / PAE' */
  label: string;
  rows: StatsRow[];
  points: number;
  winners: number;
  oppForced: number;
  oppUnforced: number;
  untagged: number;
  longestRun: number;
  wonOnServe: number;
}

/** The end-of-game card: both teams, for the game that just ended or (kind 'match') the whole match. */
export interface EndCard {
  kind: 'game' | 'match';
  game: number;
  tagged: number;
  rallies: number;
  doubles: boolean;
  teams: CardTeam[];
}

/** Thai column words (round 2 board): the short form is what the table shows, the long one the card. */
export const STAT_WORDS: Record<StatKey, { long: string; short: string; tint: string }> = {
  W: { long: 'วินเนอร์', short: 'วินเนอร์', tint: '#8ff0c4' },
  A: { long: 'ทำเกมดี', short: 'ทำเกม', tint: '#8cc4ff' },
  F: { long: 'บีบให้พลาด', short: 'บีบได้', tint: '#c9b4ff' },
  FE: { long: 'โดนบีบพลาด', short: 'โดนบีบ', tint: '#ffd27a' },
  UE: { long: 'ตีเสียเอง', short: 'เสียเอง', tint: '#ffa3a3' },
};
export const OPP_LINE = 'ฝั่งตรงข้ามตีพลาด';
/** Assists exist only in doubles (validTag), so singles has one column fewer. */
export const statColumns = (doubles: boolean): StatKey[] => (doubles ? ['W', 'A', 'F', 'FE', 'UE'] : ['W', 'F', 'FE', 'UE']);

const BG = 'rgba(16,20,26,0.84)';
const CARD_BG = 'rgba(16,20,26,0.9)';
const ZERO = 'rgba(255,255,255,0.4)';
const RULE = 'rgba(255,255,255,0.16)';

function rr(ctx: Ctx, b: Box, r: number): void {
  ctx.beginPath();
  ctx.moveTo(b.x + r, b.y);
  ctx.arcTo(b.x + b.w, b.y, b.x + b.w, b.y + b.h, r);
  ctx.arcTo(b.x + b.w, b.y + b.h, b.x, b.y + b.h, r);
  ctx.arcTo(b.x, b.y + b.h, b.x, b.y, r);
  ctx.arcTo(b.x, b.y, b.x + b.w, b.y, r);
  ctx.closePath();
}

/** Text on a centre line. Thai tone marks and vowels sit above and below the line, so every row is >= 1.3 x its font. */
function text(ctx: Ctx, s: string, x: number, cy: number, font: string, color: string, align: CanvasTextAlign = 'left'): void {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(s, x, cy + 1);
}

const width = (ctx: Ctx, font: string, s: string): number => {
  ctx.font = font;
  return ctx.measureText(s).width;
};

/** Table geometry in units: one unit is 1 px of a 1080p frame at size M (the same `u` as the score panel). */
export const TABLE = {
  pad: 4,
  head: 22,
  row: 28,
  gap: 1,
  headFont: 18,
  valFont: 22,
  nameFont: 22,
  tick: 3,
  colPad: 14,
  nameMin: 56,
  nameMax: 150,
  oppRow: 24,
  oppFont: 18,
  radius: 7,
} as const;

interface TableGeo {
  w: number;
  h: number;
  nameW: number;
  nameCol: number;
  cols: StatKey[];
  colW: number[];
  heads: string;
  vals: string;
  names: string;
}

function tableGeo(ctx: Ctx, t: StatsTable, u: number, theme: OverlayTheme): TableGeo {
  const heads = `600 ${TABLE.headFont * u}px ${theme.font}`;
  const vals = `800 ${TABLE.valFont * u}px ${theme.font}`;
  const names = `700 ${TABLE.nameFont * u}px ${theme.font}`;
  const cols = statColumns(t.doubles);
  const nameW = Math.min(TABLE.nameMax, Math.ceil(Math.max(0, ...t.rows.map((r) => width(ctx, names, r.name))) / u));
  const nameCol = Math.max(TABLE.nameMin, TABLE.tick + 10 + nameW + 8);
  const slot = width(ctx, vals, '88'); // two digits are always reserved: a count going 9 -> 10 never moves the layout
  const colW = cols.map((k) => Math.ceil(Math.max(width(ctx, heads, STAT_WORDS[k].short), slot) / u) + TABLE.colPad);
  const w = TABLE.pad * 2 + nameCol + colW.reduce((a, b) => a + b, 0);
  const h = TABLE.pad * 2 + TABLE.head + t.rows.length * (TABLE.row + TABLE.gap) + (t.opp != null ? TABLE.oppRow + TABLE.gap : 0);
  return { w: w * u, h: h * u, nameW, nameCol, cols, colW, heads, vals, names };
}

/** The table's size in pixels for scale `u`. Height is fixed for the match (2 rows, or 1 in singles), width by the names. */
export function statsTableSize(ctx: Ctx, t: StatsTable, u: number, theme: OverlayTheme = DEFAULT_THEME): { w: number; h: number } {
  const g = tableGeo(ctx, t, u, theme);
  return { w: Math.round(g.w), h: Math.round(g.h) };
}

export function drawStatsTable(ctx: Ctx, t: StatsTable, box: Box, u: number, theme: OverlayTheme = DEFAULT_THEME): void {
  const g = tableGeo(ctx, t, u, theme);
  const { x, y } = box;
  const pad = TABLE.pad * u;
  ctx.save();
  rr(ctx, box, TABLE.radius * u);
  ctx.fillStyle = BG;
  ctx.fill();
  rr(ctx, { x: x + pad, y: y + pad, w: TABLE.tick * u, h: box.h - 2 * pad }, 2 * u); // the team marker, in the team's colour
  ctx.fillStyle = t.color;
  ctx.fill();
  const x0 = x + (TABLE.pad + g.nameCol) * u;
  let cx = x0;
  g.cols.forEach((k, i) => {
    const cw = g.colW[i] * u;
    text(ctx, STAT_WORDS[k].short, cx + cw / 2, y + (TABLE.pad + TABLE.head / 2) * u, g.heads, STAT_WORDS[k].tint, 'center');
    cx += cw;
  });
  const ruleX = x + (TABLE.pad + TABLE.tick + 6) * u;
  const ruleW = x + box.w - pad - ruleX;
  const rule = Math.max(1, u);
  ctx.fillStyle = RULE;
  ctx.fillRect(ruleX, y + (TABLE.pad + TABLE.head) * u, ruleW, rule);
  t.rows.forEach((r, i) => {
    const ry = y + (TABLE.pad + TABLE.head + TABLE.gap + i * (TABLE.row + TABLE.gap)) * u;
    const cy = ry + (TABLE.row * u) / 2;
    const name = fit(ctx, r.name, g.nameW * u, TABLE.nameFont * u, 14 * u, theme.font);
    text(ctx, name, x + (TABLE.pad + TABLE.tick + 10) * u, cy, ctx.font, '#ffffff');
    let vx = x0;
    g.cols.forEach((k, c) => {
      const cw = g.colW[c] * u;
      text(ctx, String(r[k]), vx + cw / 2, cy, g.vals, r[k] === 0 ? ZERO : '#ffffff', 'center');
      vx += cw;
    });
    if (i < t.rows.length - 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(ruleX, ry + (TABLE.row + TABLE.gap / 2) * u, ruleW, rule);
    }
  });
  if (t.opp != null) {
    const oy = y + (TABLE.pad + TABLE.head + TABLE.gap + t.rows.length * (TABLE.row + TABLE.gap)) * u;
    const cy = oy + (TABLE.oppRow * u) / 2;
    ctx.fillStyle = RULE;
    ctx.fillRect(ruleX, oy - (TABLE.gap / 2 + 0.5) * u, ruleW, rule);
    const lx = x + (TABLE.pad + TABLE.tick + 10) * u;
    const lf = `600 ${TABLE.oppFont * u}px ${theme.font}`;
    text(ctx, OPP_LINE, lx, cy, lf, '#cfd6dd');
    text(ctx, String(t.opp), lx + width(ctx, lf, OPP_LINE) + 10 * u, cy, `800 ${(TABLE.oppFont + 4) * u}px ${theme.font}`, '#ffffff');
  }
  ctx.restore();
}

/** One team's total in words; it adds up to the team's points (21 = 9 + 6 + 5 + 1). */
export function cardLine(t: CardTeam): string {
  return `${t.label}  ${t.points} แต้ม = วินเนอร์ ${t.winners} + คู่แข่งโดนบีบพลาด ${t.oppForced} + คู่แข่งตีเสียเอง ${t.oppUnforced} + ไม่ได้ระบุ ${t.untagged}`;
}
export const cardTitle = (c: EndCard): string => (c.kind === 'match' ? 'จบแมตช์ · แต้มมาจากอะไร' : `เกม ${c.game} · แต้มมาจากอะไร`);

const CARD = { w: 720, pad: 22, nameCol: 118, row: 36, head: 30, line: 30, title: 46, foot: 34, gap: 8 } as const;

/** The card's size at scale `u`. */
export function endCardSize(c: EndCard, u: number): { w: number; h: number } {
  const rows = c.teams.reduce((n, t) => n + t.rows.length, 0);
  const h = CARD.pad + CARD.title + CARD.head + rows * CARD.row + c.teams.length * (CARD.line + CARD.gap) + CARD.foot + CARD.pad - CARD.gap;
  return { w: Math.round(CARD.w * u), h: Math.round(h * u) };
}

/** The end-of-game card in the middle of a `W` x `H` frame: nobody is playing while it shows. Returns its box. */
export function drawEndCard(ctx: Ctx, c: EndCard, W: number, H: number, u: number, theme: OverlayTheme = DEFAULT_THEME): Box {
  const size = endCardSize(c, u);
  const box = { x: Math.round((W - size.w) / 2), y: Math.round((H - size.h) / 2), ...size };
  const cols = statColumns(c.doubles);
  const pad = CARD.pad * u;
  const nameCol = CARD.nameCol * u;
  const colW = (box.w - 2 * pad - nameCol) / cols.length;
  ctx.save();
  rr(ctx, box, 10 * u);
  ctx.fillStyle = CARD_BG;
  ctx.fill();
  let y = box.y + pad;
  // The tagged count sits at the right. It is placed from its measured width with left alignment instead of
  // textAlign 'right' (the only right-aligned text in the overlay): on the captain's phone it ran past the card's
  // edge as if drawn from its right end. A measured start does not depend on the browser's alignment handling, and
  // fit() keeps a wide label inside the card either way.
  const tagged = fit(ctx, `ติดแท็ก ${c.tagged}/${c.rallies} แต้ม`, (box.w - 2 * pad) * 0.4, 20 * u, 12 * u, theme.font, 500);
  const taggedFont = ctx.font;
  const taggedW = ctx.measureText(tagged).width;
  const title = fit(ctx, cardTitle(c), box.w - 2 * pad - taggedW - 16 * u, 30 * u, 18 * u, theme.font, 800);
  text(ctx, title, box.x + pad, y + (CARD.title * u) / 2, ctx.font, '#ffffff');
  text(ctx, tagged, box.x + box.w - pad - taggedW, y + (CARD.title * u) / 2, taggedFont, '#9aa4ae');
  y += CARD.title * u;
  cols.forEach((k, i) =>
    text(ctx, STAT_WORDS[k].long, box.x + pad + nameCol + colW * i + colW / 2, y + (CARD.head * u) / 2, `600 ${18 * u}px ${theme.font}`, STAT_WORDS[k].tint, 'center'),
  );
  y += CARD.head * u;
  ctx.fillStyle = RULE;
  ctx.fillRect(box.x + pad, y, box.w - 2 * pad, Math.max(1, u));
  for (const t of c.teams) {
    for (const r of t.rows) {
      const cy = y + (CARD.row * u) / 2;
      rr(ctx, { x: box.x + pad, y: y + 6 * u, w: 4 * u, h: (CARD.row - 12) * u }, 2 * u);
      ctx.fillStyle = t.color;
      ctx.fill();
      const name = fit(ctx, r.name, nameCol - 20 * u, 24 * u, 14 * u, theme.font);
      text(ctx, name, box.x + pad + 14 * u, cy, ctx.font, '#ffffff');
      cols.forEach((k, i) =>
        text(ctx, String(r[k]), box.x + pad + nameCol + colW * i + colW / 2, cy, `800 ${26 * u}px ${theme.font}`, r[k] === 0 ? ZERO : '#ffffff', 'center'),
      );
      y += CARD.row * u;
    }
    const line = fit(ctx, cardLine(t), box.w - 2 * pad, 18 * u, 12 * u, theme.font, 600);
    text(ctx, line, box.x + pad, y + (CARD.line * u) / 2, ctx.font, '#c9d1d9');
    y += (CARD.line + CARD.gap) * u;
  }
  const [a, b] = c.teams;
  text(
    ctx,
    `แต้มติดกันสูงสุด ${a.longestRun} · ${b.longestRun}     ได้แต้มตอนเสิร์ฟ ${a.wonOnServe} · ${b.wonOnServe}`,
    box.x + pad,
    y + (CARD.foot * u) / 2 - (CARD.gap * u) / 2,
    `500 ${18 * u}px ${theme.font}`,
    '#9aa4ae',
  );
  ctx.restore();
  return box;
}
