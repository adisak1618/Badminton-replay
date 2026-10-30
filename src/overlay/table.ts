// The player stats table and the end-of-game card burned into the video (D15 in the video, ux-design.md C1): a small
// table that stays on screen for the chosen team, and a card for both teams when a game or the match ends. Plain
// Canvas 2D like draw.ts, in the same BWF look: a red header, white rows, the points-lost columns on a deeper red.
// The card follows the broadcast match summaries (Wimbledon, WTT): the two sides head to head with the better value
// in bold, then every player. The numbers come from `matchStats` in the engine; nothing here counts anything.
import type { Team } from '../engine';
import { DEFAULT_THEME, fit, hgrad, measure, pill, roundRectPath, text, type Box, type OverlayTheme } from './draw';
import { clamp01, easeInOut, easeOut, MOTION, progress, type DrawClock, type Motion } from './motion';
import { ERROR_COLUMNS, STAT_WORDS, WORDS } from './words';

type Ctx = CanvasRenderingContext2D;

export type StatKey = 'W' | 'A' | 'F' | 'FE' | 'UE';

export interface StatsRow {
  name: string;
  W: number; // winners
  A: number; // assists ("สร้างโอกาส"), doubles only
  F: number; // opponents' errors this player forced
  FE: number; // forced errors made
  UE: number; // unforced errors made
}

/** The live table: the chosen team's players for the current game. */
export interface StatsTable {
  team: Team;
  color: string;
  doubles: boolean;
  /** The game its counts are for: they start from zero with each game. */
  game: number;
  rows: StatsRow[];
  /** The other side's errors that gave this team a point (forced + unforced), one number and no detail; null = line off. */
  opp: number | null;
  /** When a count last changed because a tag arrived: 'row:key' (e.g. '0:W') or 'opp' -> the tag's time. */
  changed: Record<string, number>;
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
  /** The game it summarises, 0 for the match. */
  game: number;
  /** The seq of the last point it covers: identifies this summary (the camera ends a match card with the recording). */
  seq: number;
  tagged: number;
  rallies: number;
  doubles: boolean;
  teams: CardTeam[];
  /** The finished games' scores in the teams' order, for the match card. */
  games: Array<[number, number]>;
  /** Playing time in whole minutes (first to last rally of each game), or null when there is none to show. */
  minutes: number | null;
  /** When it became due: the last point's tag (or "No tag"), on the scoreboard clock. */
  shownAt: number;
  /** When the operator closed it (ปิดสรุป): it fades out from here, then is gone. */
  closedAt: number | null;
}

/** Assists exist only in doubles (validTag), so singles has one column fewer. */
export const statColumns = (doubles: boolean): StatKey[] => (doubles ? ['W', 'A', 'F', 'FE', 'UE'] : ['W', 'F', 'FE', 'UE']);

/** Whether the card is on screen at scoreboard time `now`: a closed one fades out over the set's cardOut. */
export const cardShown = (c: EndCard | null, now: number, motion: Motion): boolean =>
  !!c && (c.closedAt == null || now < c.closedAt + MOTION[motion].cardOut);

/** Table geometry in units: one unit is 1 px of a 1080p frame at size M (the same `u` as the score panel). */
export const TABLE = {
  head: 28, // the red header: the game over the names, then the words
  row: 32,
  rowGap: 1,
  opp: 27,
  padL: 10,
  chip: 5, // the team marker before each name
  chipGap: 9,
  padR: 8,
  colPad: 10,
  groupGap: 3, // before the points-lost columns
  headGap: 4, // the least room between a header and its column's edge, each side
  headFont: 16,
  valFont: 23,
  nameFont: 20,
  oppFont: 16,
  nameMax: 150,
  radius: 3,
} as const;

interface TableGeo {
  w: number;
  h: number;
  nameW: number;
  nameCol: number;
  cols: StatKey[];
  colW: number[];
  title: string;
}

function tableGeo(ctx: Ctx, t: StatsTable, u: number, theme: OverlayTheme): TableGeo {
  const heads = `600 ${TABLE.headFont * u}px ${theme.font}`;
  const vals = `700 ${TABLE.valFont * u}px ${theme.font}`;
  const names = `600 ${TABLE.nameFont * u}px ${theme.font}`;
  const cols = statColumns(t.doubles);
  const title = WORDS.tableGame(t.game);
  const nameW = Math.min(TABLE.nameMax, Math.ceil(Math.max(measure(ctx, heads, title), ...t.rows.map((r) => measure(ctx, names, r.name))) / u));
  const nameCol = TABLE.padL + TABLE.chip + TABLE.chipGap + nameW + TABLE.padR;
  const slot = measure(ctx, vals, '88'); // two digits are always reserved: a count going 9 -> 10 never moves the layout
  const colW = cols.map((k) => Math.ceil(Math.max(measure(ctx, heads, STAT_WORDS[k]), slot) / u) + TABLE.colPad);
  const w = nameCol + colW.reduce((a, b) => a + b, 0) + TABLE.groupGap;
  const h = TABLE.head + t.rows.length * (TABLE.row + TABLE.rowGap) + (t.opp != null ? TABLE.opp : 0);
  return { w: w * u, h: h * u, nameW, nameCol, cols, colW, title };
}

/** The table's size in pixels for scale `u`. Height is fixed for the match (2 rows, or 1 in singles), width by the names. */
export function statsTableSize(ctx: Ctx, t: StatsTable, u: number, theme: OverlayTheme = DEFAULT_THEME): { w: number; h: number } {
  const g = tableGeo(ctx, t, u, theme);
  return { w: Math.round(g.w), h: Math.round(g.h) };
}

/** One column of the drawn table: its key, left edge and width in pixels. */
export interface TableColumn {
  key: StatKey;
  x: number;
  w: number;
}

/**
 * The columns as `drawStatsTable` draws them in `box`, which the layout reserved from a measurement made earlier (and
 * maybe with another font): they are fitted to the box, so a wider font makes them narrower, never wider than it.
 */
export function tableColumns(ctx: Ctx, t: StatsTable, box: Box, u: number, theme: OverlayTheme = DEFAULT_THEME): TableColumn[] {
  const g = tableGeo(ctx, t, u, theme);
  const avail = box.w / u - g.nameCol - TABLE.groupGap;
  const sum = g.colW.reduce((a, b) => a + b, 0);
  const k = sum > avail ? Math.max(0.4, avail / sum) : 1;
  let x = box.x + g.nameCol * u;
  return g.cols.map((key, i) => {
    if (ERROR_COLUMNS.has(key) && !ERROR_COLUMNS.has(g.cols[i - 1])) x += TABLE.groupGap * u;
    const c = { key, x, w: g.colW[i] * k * u };
    x += c.w;
    return c;
  });
}

/**
 * The size the header words are drawn at: one size for the whole row, the largest at which every word fits inside
 * its own column with TABLE.headGap on each side, and never cut: smaller words rather than words that touch. The
 * columns are measured from these words, so with the font that measured the box it is headFont.
 */
export function tableHeadPx(ctx: Ctx, cols: readonly TableColumn[], u: number, theme: OverlayTheme = DEFAULT_THEME): number {
  const full = TABLE.headFont * u;
  let px = full;
  for (const c of cols) {
    const w = measure(ctx, `600 ${full}px ${theme.font}`, STAT_WORDS[c.key]);
    const room = c.w - 2 * TABLE.headGap * u;
    if (w > room) px = Math.min(px, (full * room) / w);
  }
  return Math.max(1, Math.floor(px * 4) / 4);
}

/**
 * Draws into `box` (see tableColumns): every word fits its column, and nothing is drawn outside the box, so an
 * unknown or wider Thai font can make the words smaller but never cross a column or the edge. A count that just went
 * up flashes.
 */
export function drawStatsTable(ctx: Ctx, t: StatsTable, box: Box, u: number, theme: OverlayTheme = DEFAULT_THEME, o: DrawClock = {}): void {
  const g = tableGeo(ctx, t, u, theme);
  const C = theme.table;
  const T = MOTION[o.motion ?? 'none'];
  const columns = tableColumns(ctx, t, box, u, theme);
  const colW = columns.map((c) => c.w / u);
  const colX = columns.map((c) => c.x);
  const r = TABLE.radius * u;
  ctx.save();
  ctx.fillStyle = theme.shadow;
  roundRectPath(ctx, { x: box.x + 2 * u, y: box.y + 3 * u, w: box.w, h: box.h }, r);
  ctx.fill();
  roundRectPath(ctx, box, r);
  ctx.fillStyle = C.rowA;
  ctx.fill();
  ctx.save();
  roundRectPath(ctx, box, r);
  ctx.clip(); // whatever a font does, nothing shows outside the box
  const headH = TABLE.head * u;
  ctx.fillStyle = C.head;
  ctx.fillRect(box.x, box.y, box.w, headH);
  const errX = columns.find((c) => ERROR_COLUMNS.has(c.key))!.x;
  ctx.fillStyle = C.headErr;
  ctx.fillRect(errX, box.y, box.x + box.w - errX, headH);
  const title = fit(ctx, g.title, (g.nameW + TABLE.chip + TABLE.chipGap) * u, TABLE.headFont * u, 10 * u, theme.font, 600);
  text(ctx, title, box.x + TABLE.padL * u, box.y + headH / 2, ctx.font, C.headFg);
  const headFont = `600 ${tableHeadPx(ctx, columns, u, theme)}px ${theme.font}`;
  for (const c of columns) text(ctx, STAT_WORDS[c.key], c.x + c.w / 2, box.y + headH / 2, headFont, C.headFg, 'center');
  t.rows.forEach((row, i) => {
    const ry = box.y + headH + i * (TABLE.row + TABLE.rowGap) * u;
    const rh = TABLE.row * u;
    const cy = ry + rh / 2;
    ctx.fillStyle = i % 2 ? C.rowB : C.rowA;
    ctx.fillRect(box.x, ry, box.w, rh);
    ctx.fillStyle = t.color;
    roundRectPath(ctx, { x: box.x + TABLE.padL * u, y: ry + 6 * u, w: TABLE.chip * u, h: rh - 12 * u }, 2 * u);
    ctx.fill();
    const name = fit(ctx, row.name, g.nameW * u, TABLE.nameFont * u, 12 * u, theme.font, 600);
    text(ctx, name, box.x + (TABLE.padL + TABLE.chip + TABLE.chipGap) * u, cy + u, ctx.font, C.nameFg);
    g.cols.forEach((key, c) => {
      const cw = colW[c] * u;
      const at = t.changed[`${i}:${key}`];
      const f = progress(o.now, at, T.cell);
      if (f < 1) {
        ctx.fillStyle = C.flash;
        ctx.globalAlpha = 1 - easeInOut(f);
        ctx.fillRect(colX[c] + 2 * u, ry + 3 * u, cw - 4 * u, rh - 6 * u);
        ctx.globalAlpha = 1;
      }
      const p = progress(o.now, at, T.pop);
      const scale = p < 1 ? 1 + 0.35 * (1 - easeOut(p)) : 1;
      const v = row[key];
      const color = f < 1 ? C.val : v === 0 ? C.zero : ERROR_COLUMNS.has(key) ? C.valErr : C.val;
      const val = fit(ctx, String(v), cw - 2 * u, TABLE.valFont * scale * u, 9 * u, theme.font, 700);
      text(ctx, val, colX[c] + cw / 2, cy + 2 * u, ctx.font, color, 'center');
    });
  });
  if (t.opp != null) {
    const oy = box.y + headH + t.rows.length * (TABLE.row + TABLE.rowGap) * u;
    const oh = TABLE.opp * u;
    ctx.fillStyle = C.oppBg;
    ctx.fillRect(box.x, oy, box.w, oh);
    const lx = box.x + (TABLE.padL + TABLE.chip + TABLE.chipGap) * u;
    const num = String(t.opp);
    const nf = `700 ${(TABLE.oppFont + 4) * u}px ${theme.font}`;
    const numW = measure(ctx, nf, num);
    const room = box.w - (TABLE.padL + TABLE.chip + TABLE.chipGap + TABLE.padR) * u - numW - 12 * u;
    const label = fit(ctx, WORDS.opp, Math.max(10 * u, room), TABLE.oppFont * u, 9 * u, theme.font, 500);
    const labelFont = ctx.font;
    const lw = ctx.measureText(label).width;
    text(ctx, label, lx, oy + oh / 2, labelFont, C.oppFg);
    const f = progress(o.now, t.changed.opp, T.cell);
    if (f < 1) {
      ctx.fillStyle = C.flash;
      ctx.globalAlpha = 1 - easeInOut(f);
      ctx.fillRect(lx + lw + 4 * u, oy + 3 * u, numW + 14 * u, oh - 6 * u);
      ctx.globalAlpha = 1;
    }
    text(ctx, num, lx + lw + 11 * u, oy + oh / 2 + u, nf, C.val);
  }
  ctx.restore();
  ctx.strokeStyle = theme.outline;
  ctx.lineWidth = Math.max(1, 1.5 * u);
  roundRectPath(ctx, { x: box.x + 0.75 * u, y: box.y + 0.75 * u, w: box.w - 1.5 * u, h: box.h - 1.5 * u }, r);
  ctx.stroke();
  ctx.restore();
}

export const cardTitle = (c: EndCard): string => (c.kind === 'match' ? WORDS.cardMatch : WORDS.cardGame(c.game));

/** Card geometry in units (1 unit = 1 px at 1080p, size M): a red header, the teams and the score, two columns, a footer. */
export const CARD = { w: 1240, pad: 26, head: 66, team: 92, section: 34, row: 37, prow: 36, teamGap: 8, foot: 40, radius: 4 } as const;
const OVERVIEW_ROWS = 8; // total, four sources, a rule, longest run, won on serve

/** The card's size at scale `u`: the same for every match, whichever column is taller. */
export function endCardSize(c: EndCard, u: number): { w: number; h: number } {
  const players = c.teams.reduce((n, t) => n + t.rows.length, 0);
  const left = CARD.section + OVERVIEW_ROWS * CARD.row;
  const right = CARD.section + CARD.prow + players * CARD.prow + (c.teams.length - 1) * CARD.teamGap;
  const h = CARD.head + CARD.team + CARD.pad + Math.max(left, right) + CARD.pad * 0.6 + CARD.foot;
  return { w: Math.round(CARD.w * u), h: Math.round(h * u) };
}

/**
 * The card in `box` (layout.ts `cardPlace`: the middle of the frame, smaller only when it would cover the panel or
 * the logo). Its scale is the box's width over the card's. It fades in and rises when it becomes due, its rows
 * follow one by one, and it fades out after ปิดสรุป.
 */
export function drawEndCard(ctx: Ctx, c: EndCard, box: Box, theme: OverlayTheme = DEFAULT_THEME, o: DrawClock = {}): void {
  const C = theme.card;
  const T = MOTION[o.motion ?? 'none'];
  const now = o.now;
  const u = box.w / CARD.w;
  const inT = easeOut(progress(now, c.shownAt, T.cardIn));
  const outT = c.closedAt == null || now == null ? 0 : T.cardOut ? clamp01((now - c.closedAt) / T.cardOut) : 1;
  const alpha = inT * (1 - outT);
  if (alpha <= 0) return;
  const stagger = (i: number) => (now == null || !T.stagger ? 1 : clamp01((now - c.shownAt - T.cardIn * 0.4 - i * T.stagger) / 260));
  const b = { x: box.x, y: box.y + (1 - inT) * 28 * u, w: box.w, h: box.h };
  const pad = CARD.pad * u;
  const r = CARD.radius * u;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = theme.shadow;
  roundRectPath(ctx, { x: b.x + 3 * u, y: b.y + 5 * u, w: b.w, h: b.h }, r);
  ctx.fill();
  roundRectPath(ctx, b, r);
  ctx.fillStyle = C.body;
  ctx.fill();
  roundRectPath(ctx, b, r);
  ctx.clip();
  // The header: the title in Thai, its English name smaller, and the discipline and the playing time on the right.
  const hh = CARD.head * u;
  ctx.fillStyle = hgrad(ctx, b.x, b.x + b.w, theme.badge);
  ctx.fillRect(b.x, b.y, b.w, hh);
  const sub = [WORDS.event(c.doubles), c.minutes != null ? WORDS.duration(c.minutes) : null].filter(Boolean).join('  ·  ');
  const subFont = `500 ${19 * u}px ${theme.font}`;
  const subW = measure(ctx, subFont, sub);
  const title = fit(ctx, cardTitle(c), b.w - 2 * pad - subW - 220 * u, 34 * u, 20 * u, theme.font, 700);
  const titleFont = ctx.font;
  text(ctx, title, b.x + pad, b.y + hh / 2 + u, titleFont, C.headFg);
  const tw = measure(ctx, titleFont, title);
  text(ctx, WORDS.cardEn(c.kind, c.game), b.x + pad + tw + 16 * u, b.y + hh / 2 + 3 * u, `600 ${18 * u}px ${theme.font}`, C.headSub);
  text(ctx, sub, b.x + b.w - pad, b.y + hh / 2 + u, subFont, C.headSub, 'right');
  // The teams and the score: points for a game, games won for the match with each game's score under it.
  const ty = b.y + hh;
  const th = CARD.team * u;
  ctx.fillStyle = C.teamBg;
  ctx.fillRect(b.x, ty, b.w, th);
  ctx.fillStyle = C.rule;
  ctx.fillRect(b.x, ty + th - Math.max(1, u), b.w, Math.max(1, u));
  const [ta, tb] = c.teams;
  const match = c.kind === 'match';
  const gamesA = c.games.filter(([x, y]) => x > y).length;
  const gamesB = c.games.filter(([x, y]) => y > x).length;
  const bigA = match ? gamesA : ta.points;
  const bigB = match ? gamesB : tb.points;
  const midX = b.x + b.w / 2;
  const scoreFont = `800 ${52 * u}px ${theme.font}`;
  const scoreCy = ty + th / 2 + (match ? -8 * u : 2 * u);
  text(ctx, String(bigA), midX - 30 * u, scoreCy, scoreFont, bigA > bigB ? C.fg : C.lose, 'right');
  text(ctx, '–', midX, scoreCy - 2 * u, `600 ${40 * u}px ${theme.font}`, C.mut, 'center');
  text(ctx, String(bigB), midX + 30 * u, scoreCy, scoreFont, bigB > bigA ? C.fg : C.lose);
  if (match) text(ctx, c.games.map(([x, y]) => `${x}–${y}`).join('   '), midX, ty + th - 16 * u, `600 ${18 * u}px ${theme.font}`, C.mut, 'center');
  const chipW = 34 * u;
  const chipH = 22 * u;
  const nameRoom = b.w / 2 - 120 * u - pad - chipW - 14 * u - 70 * u;
  const nameA = fit(ctx, ta.label, nameRoom, 28 * u, 16 * u, theme.font, 700);
  const nameAFont = ctx.font;
  const nameB = fit(ctx, tb.label, nameRoom, 28 * u, 16 * u, theme.font, 700);
  const nameBFont = ctx.font;
  ctx.fillStyle = ta.color;
  roundRectPath(ctx, { x: b.x + pad, y: ty + th / 2 - chipH / 2, w: chipW, h: chipH }, 2 * u);
  ctx.fill();
  ctx.fillStyle = tb.color;
  roundRectPath(ctx, { x: b.x + b.w - pad - chipW, y: ty + th / 2 - chipH / 2, w: chipW, h: chipH }, 2 * u);
  ctx.fill();
  const axL = b.x + pad + chipW + 14 * u;
  text(ctx, nameA, axL, ty + th / 2 + u, nameAFont, bigA >= bigB ? C.fg : C.lose);
  const bxR = b.x + b.w - pad - chipW - 14 * u;
  text(ctx, nameB, bxR, ty + th / 2 + u, nameBFont, bigB >= bigA ? C.fg : C.lose, 'right');
  if (match && bigA !== bigB) {
    if (bigA > bigB) pill(ctx, WORDS.win, axL + measure(ctx, nameAFont, nameA) + 34 * u, ty + th / 2, u, theme);
    else pill(ctx, WORDS.win, bxR - measure(ctx, nameBFont, nameB) - 34 * u, ty + th / 2, u, theme);
  }
  // Left: where each side's points came from, head to head, the better value in bold; thin bars from the middle out.
  const by = ty + th + pad;
  const colGap = 26 * u;
  const leftW = (b.w - 2 * pad - colGap) * 0.47;
  const lx = b.x + pad;
  section(ctx, WORDS.overview, lx, by, leftW, u, theme);
  const overview: Array<{ label: string; a: number; b: number; strong?: boolean; quiet?: boolean } | null> = [
    { label: WORDS.total, a: ta.points, b: tb.points, strong: true },
    { label: WORDS.fromWinners, a: ta.winners, b: tb.winners },
    { label: WORDS.fromForced, a: ta.oppForced, b: tb.oppForced },
    { label: WORDS.fromUnforced, a: ta.oppUnforced, b: tb.oppUnforced },
    { label: WORDS.untagged, a: ta.untagged, b: tb.untagged, quiet: true },
    null,
    { label: WORDS.longestRun, a: ta.longestRun, b: tb.longestRun },
    { label: WORDS.wonOnServe, a: ta.wonOnServe, b: tb.wonOnServe },
  ];
  const max = Math.max(1, ta.points, tb.points);
  overview.forEach((row, i) => {
    const cy = by + CARD.section * u + i * CARD.row * u + (CARD.row * u) / 2;
    if (!row) {
      ctx.fillStyle = C.rule;
      ctx.fillRect(lx, cy, leftW, Math.max(1, u));
      return;
    }
    ctx.globalAlpha = alpha * stagger(i);
    const vf = `${row.strong ? 800 : 700} ${(row.strong ? 26 : 23) * u}px ${theme.font}`;
    const lead = row.quiet ? 0 : Math.sign(row.b - row.a);
    text(ctx, String(row.a), lx + 34 * u, cy + 2 * u, vf, row.quiet ? C.mut : lead <= 0 ? C.fg : C.lose, 'center');
    text(ctx, String(row.b), lx + leftW - 34 * u, cy + 2 * u, vf, row.quiet ? C.mut : lead >= 0 ? C.fg : C.lose, 'center');
    const label = fit(ctx, row.label, leftW - 150 * u, 18 * u, 11 * u, theme.font, row.strong ? 700 : 500);
    text(ctx, label, lx + leftW / 2, cy - 3 * u, ctx.font, row.strong ? C.fg : C.mut, 'center');
    if (i <= 4) {
      const grow = now == null || !T.bars ? 1 : easeOut(progress(now, c.shownAt + T.cardIn * 0.5 + i * T.stagger, T.bars));
      const half = leftW / 2 - 78 * u;
      const yb = cy + 11 * u;
      ctx.fillStyle = C.bar;
      ctx.fillRect(lx + 72 * u, yb, half, 4 * u);
      ctx.fillRect(lx + leftW / 2 + 6 * u, yb, half, 4 * u);
      const wa = ((half * Math.min(row.a, max)) / max) * grow;
      ctx.fillStyle = ta.color;
      ctx.fillRect(lx + 72 * u + half - wa, yb, wa, 4 * u);
      ctx.fillStyle = tb.color;
      ctx.fillRect(lx + leftW / 2 + 6 * u, yb, ((half * Math.min(row.b, max)) / max) * grow, 4 * u);
    }
    ctx.globalAlpha = alpha;
  });
  // Right: every player with the five words of the live table.
  const rx = lx + leftW + colGap;
  const rw = b.x + b.w - pad - rx;
  section(ctx, WORDS.players, rx, by, rw, u, theme);
  const cols = statColumns(c.doubles);
  const nameCol = rw * 0.3;
  const cw = (rw - nameCol) / cols.length;
  const hy = by + CARD.section * u;
  cols.forEach((k, i) => {
    const head = fit(ctx, STAT_WORDS[k], cw - 6 * u, 16 * u, 10 * u, theme.font, 600);
    text(ctx, head, rx + nameCol + cw * i + cw / 2, hy + (CARD.prow * u) / 2, ctx.font, ERROR_COLUMNS.has(k) ? C.section : C.mut, 'center');
  });
  let py = hy + CARD.prow * u;
  let n = 0;
  c.teams.forEach((tm, ti) => {
    if (ti > 0) py += CARD.teamGap * u;
    for (const row of tm.rows) {
      ctx.globalAlpha = alpha * stagger(n++);
      ctx.fillStyle = C.rule;
      ctx.fillRect(rx, py, rw, Math.max(1, u));
      const cy = py + (CARD.prow * u) / 2;
      ctx.fillStyle = tm.color;
      roundRectPath(ctx, { x: rx, y: py + 8 * u, w: 5 * u, h: CARD.prow * u - 16 * u }, 2 * u);
      ctx.fill();
      text(ctx, fit(ctx, row.name, nameCol - 22 * u, 21 * u, 12 * u, theme.font, 600), rx + 16 * u, cy + u, ctx.font, C.fg);
      cols.forEach((k, i) => {
        const v = row[k];
        text(ctx, String(v), rx + nameCol + cw * i + cw / 2, cy + 2 * u, `700 ${23 * u}px ${theme.font}`, v === 0 ? C.zero : ERROR_COLUMNS.has(k) ? theme.table.valErr : C.fg, 'center');
      });
      py += CARD.prow * u;
      ctx.globalAlpha = alpha;
    }
  });
  const fy = b.y + b.h - CARD.foot * u;
  ctx.fillStyle = C.foot;
  ctx.fillRect(b.x, fy, b.w, CARD.foot * u);
  text(ctx, fit(ctx, WORDS.tagged(c.tagged, c.rallies), b.w - 2 * pad, 18 * u, 11 * u, theme.font, 500), b.x + pad, fy + (CARD.foot * u) / 2, ctx.font, C.footFg);
  ctx.restore();
}

function section(ctx: Ctx, s: string, x: number, y: number, w: number, u: number, theme: OverlayTheme): void {
  const f = `700 ${17 * u}px ${theme.font}`;
  const cy = y + (CARD.section * u) / 2 - 2 * u;
  text(ctx, s, x, cy, f, theme.card.section);
  const sw = measure(ctx, f, s);
  ctx.fillStyle = theme.card.rule;
  ctx.fillRect(x + sw + 12 * u, cy, Math.max(0, w - sw - 12 * u), Math.max(1, u));
}
