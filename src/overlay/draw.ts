// drawOverlay(ctx, model, box, theme): the score panel burned into every frame, in plain Canvas 2D so it runs
// per camera frame on the phone and in node-canvas for a later re-render (technical-design.md §6.2, §7). A
// canvas cannot rasterise HTML, so this is not the scoreboard's DOM. The look is BWF's world feed (World
// Championships 2025-2026): white rows with the team colour where BWF has the flag, white cells for finished games,
// a two-tone red column for the game being played, a red shuttle for the server and a red badge for game point and
// the like. The panel is only as wide as its content.
import type { OverlayModel } from './model';
import { clamp01, easeOut, MOTION, progress, type DrawClock, type MotionTimes } from './motion';
import { WORDS } from './words';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Colours and font of the whole overlay: the panel, the stats table and the end-of-game card. */
export interface OverlayTheme {
  id: string; // recorded per segment so a re-render knows which look was burned in
  font: string;
  rowTop: string; // a name row runs from rowTop to rowBot
  rowBot: string;
  nameFg: string;
  rule: string; // between the two rows
  doneBg: string; // a finished game's cell
  doneWin: string; // the digits of the side that won it
  doneLose: string;
  liveTop: string; // the game being played: two reds, the deeper one below a shallow diagonal
  liveBot: string;
  liveFg: string;
  shuttle: string;
  shadow: string; // a hard drop shadow: one rectangle, no shadowBlur (expensive per frame on the phone)
  outline: string; // keeps white rows apart from a bright hall wall
  badge: readonly string[]; // the status badge's gradient, left to right
  badgeFg: string;
  stale: readonly string[];
  staleDot: string;
  table: {
    head: string;
    headErr: string; // the header over the points-lost columns
    headFg: string;
    rowA: string;
    rowB: string;
    nameFg: string;
    val: string;
    valErr: string;
    zero: string;
    oppBg: string;
    oppFg: string;
    flash: string; // a count that just went up
  };
  card: {
    body: string;
    headFg: string;
    headSub: string;
    teamBg: string;
    fg: string;
    mut: string;
    lose: string;
    rule: string;
    section: string;
    foot: string;
    footFg: string;
    zero: string;
    bar: string;
  };
}

export const KANIT = "Kanit, -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif";

/** BWF Championship look (broadcast design, look A). */
export const DEFAULT_THEME: OverlayTheme = {
  id: 'bwf-championship-v1',
  font: KANIT,
  rowTop: '#FAFAFA',
  rowBot: '#E7E8EA',
  nameFg: '#13161B',
  rule: '#C8102E',
  doneBg: '#FFFFFF',
  doneWin: '#13161B',
  doneLose: '#8C929B',
  liveTop: '#D3132F',
  liveBot: '#A1001C',
  liveFg: '#FFFFFF',
  shuttle: '#D0021B',
  shadow: 'rgba(0,0,0,0.30)',
  outline: 'rgba(0,0,0,0.38)',
  badge: ['#E5142E', '#B0001B', '#62000F'],
  badgeFg: '#FFFFFF',
  stale: ['#3A3F47', '#24282E'],
  staleDot: '#FFB020',
  table: {
    head: '#D3132F',
    headErr: '#8F0018',
    headFg: '#FFFFFF',
    rowA: '#FAFAFA',
    rowB: '#EEEFF1',
    nameFg: '#13161B',
    val: '#13161B',
    valErr: '#B0001B',
    zero: '#A9AEB6',
    oppBg: '#DDE0E4',
    oppFg: '#3A3F47',
    flash: 'rgba(255,196,0,0.85)',
  },
  card: {
    body: '#F6F6F7',
    headFg: '#FFFFFF',
    headSub: 'rgba(255,255,255,0.82)',
    teamBg: '#FFFFFF',
    fg: '#13161B',
    mut: '#6B717A',
    lose: '#9AA0A8',
    rule: 'rgba(0,0,0,0.10)',
    section: '#B0001B',
    foot: '#E6E8EB',
    footFg: '#4A5059',
    zero: '#B3B8BF',
    bar: 'rgba(0,0,0,0.08)',
  },
};

type Ctx = CanvasRenderingContext2D;

export function roundRectPath(ctx: Ctx, b: Box, r: number | readonly [number, number, number, number]): void {
  const m = Math.min(b.w / 2, b.h / 2);
  const [a, c, d, e] = (typeof r === 'number' ? [r, r, r, r] : r).map((x) => Math.max(0, Math.min(x, m)));
  ctx.beginPath();
  ctx.moveTo(b.x + a, b.y);
  ctx.arcTo(b.x + b.w, b.y, b.x + b.w, b.y + b.h, c);
  ctx.arcTo(b.x + b.w, b.y + b.h, b.x, b.y + b.h, d);
  ctx.arcTo(b.x, b.y + b.h, b.x, b.y, e);
  ctx.arcTo(b.x, b.y, b.x + b.w, b.y, a);
  ctx.closePath();
}

/** Set a bold font no larger than `px` that makes `text` fit `maxW`, ellipsising below `minPx`. */
export function fit(ctx: Ctx, text: string, maxW: number, px: number, minPx: number, font: string, weight = 700): string {
  let size = px;
  ctx.font = `${weight} ${size}px ${font}`;
  while (size > minPx && ctx.measureText(text).width > maxW) {
    size -= 1;
    ctx.font = `${weight} ${size}px ${font}`;
  }
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/**
 * Text on a centre line. Right-aligned text is placed from its measured width with left alignment: textAlign
 * 'right' ran past the card's edge on the captain's phone (PR 10), a measured start does not depend on it.
 */
export function text(ctx: Ctx, s: string, x: number, cy: number, font: string, color: string, align: 'left' | 'center' | 'right' = 'left'): void {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  if (align === 'right') {
    ctx.textAlign = 'left';
    ctx.fillText(s, x - ctx.measureText(s).width, cy + 1);
    return;
  }
  ctx.textAlign = align;
  ctx.fillText(s, x, cy + 1);
}

export const measure = (ctx: Ctx, font: string, s: string): number => {
  ctx.font = font;
  return ctx.measureText(s).width;
};

export function hgrad(ctx: Ctx, x0: number, x1: number, stops: readonly string[]): CanvasGradient {
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  return g;
}

/** A small shuttlecock, cork towards the left: a solid cork and a lighter feather skirt; vector, no emoji font. */
function shuttle(ctx: Ctx, cx: number, cy: number, size: number, color: string): void {
  const r = size * 0.22;
  const corkX = cx - size / 2 + r;
  const rimX = cx + size / 2;
  ctx.save();
  ctx.fillStyle = color;
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha * 0.75;
  ctx.beginPath();
  ctx.moveTo(corkX, cy - r * 0.8);
  ctx.lineTo(rimX, cy - size * 0.42);
  ctx.lineTo(rimX, cy + size * 0.42);
  ctx.lineTo(corkX, cy + r * 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(corkX, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A small red label with white text, e.g. WIN in the winner's shuttle slot. */
export function pill(ctx: Ctx, s: string, cx: number, cy: number, u: number, theme: OverlayTheme, alpha = 1): void {
  const font = `700 ${15 * u}px ${theme.font}`;
  const w = Math.max(30 * u, measure(ctx, font, s) + 14 * u);
  const h = 24 * u;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = theme.liveTop;
  roundRectPath(ctx, { x: cx - w / 2, y: cy - h / 2, w, h }, 3 * u);
  ctx.fill();
  text(ctx, s, cx, cy + u, font, theme.badgeFg, 'center');
  ctx.restore();
}

/**
 * Panel geometry, in units: one unit is 1 px of a 1080p frame at size M. The panel is as small as its
 * content: the longer name (up to nameMax, then it shrinks and ellipsises) plus one cell per game.
 */
export const PANEL = {
  row: 50,
  rowGap: 2, // the red rule
  padL: 10,
  chipW: 36, // the team colour, where BWF has the flag
  chipH: 24,
  chipGap: 12,
  nameFont: 28,
  nameMin: 130, // so the narrowest panel still fits END OF GAME 1 and its clock
  nameMax: 560, // two 14-letter names in capitals fit whole
  nameGap: 8,
  slot: 46, // the shuttle, or WIN after the match: reserved in every name cell so the width does not change
  padR: 8,
  cellGap: 2,
  done: 54, // a finished game's cell
  live: 62, // the game being played
  digits: 33,
  bandGap: 3,
  band: 40,
  bandFont: 22,
  radius: 3,
} as const;

export type BandKind = 'stale' | 'matchOver' | 'draw' | 'gameOver' | 'interval' | 'matchPoint' | 'gamePoint' | 'deuce';

/** The status badge while a state applies, or null. `clock` is the scoreboard time the interval or break ends. */
export interface Band {
  kind: BandKind;
  text: string;
  clock: number | null;
  /** The interval's length, for the line that drains with it. */
  total: number | null;
  /** A word before the clock (BREAK), dropped when the panel is too narrow. */
  clockLabel: string | null;
}

function gamesWon(m: OverlayModel): { left: number; right: number } {
  let left = 0;
  let right = 0;
  for (const g of m.games) {
    if (g.live) continue;
    if (g.winner === 'left') left++;
    else if (g.winner === 'right') right++;
  }
  return { left, right };
}

export function bandOf(m: OverlayModel): Band | null {
  const b = (kind: BandKind, text: string, clock: number | null = null, clockLabel: string | null = null): Band => ({
    kind,
    text,
    clock,
    total: clock == null ? null : m.intervalTotal,
    clockLabel,
  });
  if (m.stale) return b('stale', WORDS.stale);
  if (m.phase === 'matchOver') {
    if (m.winner) return b('matchOver', WORDS.matchOver);
    const g = gamesWon(m);
    return b('draw', WORDS.draw(g.left, g.right));
  }
  if (m.phase === 'gameOver') return b('gameOver', WORDS.gameOver(m.game), m.intervalEndsAt, WORDS.rest);
  if (m.phase === 'interval') return b('interval', m.pendingSwap ? WORDS.intervalSwap : WORDS.interval, m.intervalEndsAt);
  if (m.flag) return b(m.flag.kind, m.flag.kind === 'matchPoint' ? WORDS.matchPoint : WORDS.gamePoint);
  if (m.deuce) return b('deuce', WORDS.deuce(m.left.score, m.right.score));
  return null;
}
export const bandText = (m: OverlayModel): string | null => bandOf(m)?.text ?? null;

/** m:ss, rounded up so the last second shows 0:01; never negative. */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const nameFontAt = (u: number, px: number, font: string) => `600 ${px * u}px ${font}`;
const lead = PANEL.padL + PANEL.chipW + PANEL.chipGap;

interface Geometry {
  w: number;
  h: number;
  nameW: number; // width of the name text slot, in units
  nameCell: number; // in units
  band: Band | null;
}

function geometry(ctx: Ctx, m: OverlayModel, u: number, theme: OverlayTheme): Geometry {
  ctx.font = nameFontAt(u, PANEL.nameFont, theme.font);
  const widest = Math.max(ctx.measureText(m.left.players).width, ctx.measureText(m.right.players).width) / u;
  const nameW = Math.min(PANEL.nameMax, Math.max(PANEL.nameMin, Math.ceil(widest)));
  const nameCell = lead + nameW + PANEL.nameGap + PANEL.slot + PANEL.padR;
  const w = nameCell + m.games.reduce((a, g) => a + PANEL.cellGap + (g.live ? PANEL.live : PANEL.done), 0);
  const band = bandOf(m);
  const h = 2 * PANEL.row + PANEL.rowGap + (band ? PANEL.bandGap + PANEL.band : 0);
  return { w: w * u, h: h * u, nameW, nameCell, band };
}

/** The panel's size in pixels for scale `u` (frame height / 1080 times the S/M/L factor). */
export function panelSize(ctx: Ctx, m: OverlayModel, u: number, theme: OverlayTheme = DEFAULT_THEME): { w: number; h: number } {
  const g = geometry(ctx, m, u, theme);
  return { w: Math.round(g.w), h: Math.round(g.h) };
}

/** The tallest the panel gets (with the badge), so a logo stacked under it never has to move. */
export const panelMaxHeight = (u: number): number => Math.round((2 * PANEL.row + PANEL.rowGap + PANEL.bandGap + PANEL.band) * u);

export interface PanelDrawOpts extends DrawClock {
  /** In a bottom corner the badge goes above the rows: it grows away from the frame edge and the rows never move. */
  bandAbove?: boolean;
}

export function drawOverlay(ctx: Ctx, m: OverlayModel, box: Box, u: number, theme: OverlayTheme = DEFAULT_THEME, o: PanelDrawOpts = {}): void {
  const g = geometry(ctx, m, u, theme);
  const T = MOTION[o.motion ?? 'none'];
  const now = o.now;
  const a = m.anim;
  const bandH = g.band ? (PANEL.bandGap + PANEL.band) * u : 0;
  const rowsY = box.y + (o.bandAbove ? bandH : 0);
  const rowsH = (2 * PANEL.row + PANEL.rowGap) * u;
  const rowH = PANEL.row * u;
  const r = PANEL.radius * u;
  const nameCellW = g.nameCell * u;
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.fillStyle = theme.shadow;
  roundRectPath(ctx, { x: box.x + 2 * u, y: rowsY + 3 * u, w: box.w, h: rowsH }, r);
  ctx.fill();
  [m.left, m.right].forEach((side, i) => {
    const y = rowsY + i * (PANEL.row + PANEL.rowGap) * u;
    const cy = y + rowH / 2;
    const rows = ctx.createLinearGradient(0, y, 0, y + rowH);
    rows.addColorStop(0, theme.rowTop);
    rows.addColorStop(1, theme.rowBot);
    ctx.fillStyle = rows;
    roundRectPath(ctx, { x: box.x, y, w: nameCellW, h: rowH }, i === 0 ? [r, 0, 0, 0] : [0, 0, 0, r]);
    ctx.fill();
    const chip = { x: box.x + PANEL.padL * u, y: cy - (PANEL.chipH * u) / 2, w: PANEL.chipW * u, h: PANEL.chipH * u };
    ctx.fillStyle = side.color;
    roundRectPath(ctx, chip, 2 * u);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(chip.x, chip.y, chip.w, chip.h * 0.42);
    const won = m.phase === 'matchOver' && m.winner === side.team;
    ctx.globalAlpha = m.phase === 'matchOver' && m.winner && !won ? 0.72 : 1;
    const name = fit(ctx, side.players, g.nameW * u, PANEL.nameFont * u, 16 * u, theme.font, 600);
    text(ctx, name, box.x + lead * u, cy + u, ctx.font, theme.nameFg);
    ctx.globalAlpha = 1;
    const slotX = box.x + nameCellW - (PANEL.padR + PANEL.slot / 2) * u;
    const mine = i === 0 ? 'left' : 'right';
    if (side.serving) {
      const t = a.serve && a.serve.side === mine ? easeOut(progress(now, a.serve.at, T.serve)) : 1;
      ctx.globalAlpha = t;
      shuttle(ctx, slotX + (1 - t) * 10 * u, cy, 24 * u, theme.shuttle);
      ctx.globalAlpha = 1;
    }
    if (won) pill(ctx, WORDS.win, slotX, cy, u, theme, a.band?.kind === 'matchOver' ? progress(now, a.band.at, T.bandIn) : 1);
  });
  ctx.fillStyle = theme.rule;
  ctx.fillRect(box.x, rowsY + rowH, nameCellW, PANEL.rowGap * u);
  let x = box.x + nameCellW;
  m.games.forEach((game, c) => {
    x += PANEL.cellGap * u;
    const cw = (game.live ? PANEL.live : PANEL.done) * u;
    if (game.live) drawLiveCell(ctx, m, { x, y: rowsY, w: cw, h: rowsH }, u, theme, T, now);
    else {
      const t = a.col && a.col.index === c ? easeOut(progress(now, a.col.at, T.col)) : 1;
      [0, 1].forEach((i) => {
        const y = rowsY + i * (PANEL.row + PANEL.rowGap) * u;
        ctx.fillStyle = theme.doneBg;
        ctx.fillRect(x, y, cw, rowH);
        const won = (i === 0 && game.winner === 'left') || (i === 1 && game.winner === 'right');
        ctx.globalAlpha = t;
        const pts = String(i === 0 ? game.left : game.right);
        text(ctx, pts, x + cw / 2, y + rowH / 2 + 2 * u + (1 - t) * 12 * u, `700 ${PANEL.digits * u}px ${theme.font}`, won ? theme.doneWin : theme.doneLose, 'center');
        ctx.globalAlpha = 1;
      });
      if (t < 1) {
        ctx.fillStyle = `rgba(255,255,255,${0.7 * (1 - t)})`;
        ctx.fillRect(x, rowsY, cw, rowsH);
      }
    }
    x += cw;
  });
  ctx.strokeStyle = theme.outline;
  ctx.lineWidth = Math.max(1, 1.5 * u);
  roundRectPath(ctx, { x: box.x + 0.75 * u, y: rowsY + 0.75 * u, w: box.w - 1.5 * u, h: rowsH - 1.5 * u }, r);
  ctx.stroke();
  if (g.band) {
    const y = o.bandAbove ? box.y : rowsY + rowsH + PANEL.bandGap * u;
    drawBand(ctx, m, g.band, { x: box.x, y, w: box.w, h: PANEL.band * u }, u, theme, T, now);
  }
  ctx.restore();
}

/** The live game's column: the old score rolls up and out, the new one in from below, inside the cell. */
function drawLiveCell(ctx: Ctx, m: OverlayModel, b: Box, u: number, theme: OverlayTheme, T: MotionTimes, now: number | undefined): void {
  const rowH = PANEL.row * u;
  const game = m.games[m.games.length - 1];
  ctx.fillStyle = theme.liveTop;
  ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.fillStyle = theme.liveBot;
  ctx.beginPath();
  ctx.moveTo(b.x, b.y + b.h * 0.6);
  ctx.lineTo(b.x + b.w, b.y + b.h * 0.42);
  ctx.lineTo(b.x + b.w, b.y + b.h);
  ctx.lineTo(b.x, b.y + b.h);
  ctx.closePath();
  ctx.fill();
  const font = `700 ${PANEL.digits * u}px ${theme.font}`;
  [0, 1].forEach((i) => {
    const y = b.y + i * (PANEL.row + PANEL.rowGap) * u;
    const cy = y + rowH / 2 + 2 * u;
    const v = i === 0 ? game.left : game.right;
    const scored = m.anim.point?.side === (i === 0 ? 'left' : 'right') ? m.anim.point : null;
    const t = scored ? progress(now, scored.at, T.tick) : 1;
    if (t < 1) {
      const e = easeOut(t);
      ctx.save();
      ctx.beginPath();
      ctx.rect(b.x, y, b.w, rowH);
      ctx.clip();
      ctx.globalAlpha = 1 - e;
      text(ctx, String(Math.max(0, v - 1)), b.x + b.w / 2, cy - e * rowH * 0.7, font, theme.liveFg, 'center');
      ctx.globalAlpha = e;
      text(ctx, String(v), b.x + b.w / 2, cy + (1 - e) * rowH * 0.7, font, theme.liveFg, 'center');
      ctx.restore();
    } else text(ctx, String(v), b.x + b.w / 2, cy, font, theme.liveFg, 'center');
    const f = scored ? progress(now, scored.at, T.flash) : 1;
    if (f < 1) {
      ctx.fillStyle = `rgba(255,255,255,${0.55 * (1 - easeOut(f))})`;
      ctx.fillRect(b.x, y, b.w, rowH);
    }
  });
}

/** The red badge: it wipes in from the corner side with one light sweep; match point pulses gently. */
function drawBand(ctx: Ctx, m: OverlayModel, band: Band, b: Box, u: number, theme: OverlayTheme, T: MotionTimes, now: number | undefined): void {
  const stale = band.kind === 'stale';
  const since = m.anim.band?.kind === band.kind ? m.anim.band.at : null;
  const inT = progress(now, since, T.bandIn);
  const r = PANEL.radius * u;
  ctx.save();
  ctx.beginPath();
  ctx.rect(b.x, b.y, b.w * easeOut(inT), b.h);
  ctx.clip();
  roundRectPath(ctx, b, r);
  ctx.fillStyle = hgrad(ctx, b.x, b.x + b.w, stale ? theme.stale : theme.badge);
  ctx.fill();
  if (band.kind === 'matchPoint' && T.pulse && now != null && since != null) {
    const ph = (((now - since) % T.pulse) + T.pulse) % T.pulse / T.pulse;
    ctx.fillStyle = `rgba(255,255,255,${0.14 * (0.5 - 0.5 * Math.cos(ph * Math.PI * 2))})`;
    roundRectPath(ctx, b, r);
    ctx.fill();
  }
  if (!stale && T.shine && since != null) {
    const s = progress(now, since + T.bandIn * 0.6, T.shine);
    if (s > 0 && s < 1) {
      const sx = b.x - b.w * 0.3 + s * b.w * 1.6;
      const gr = ctx.createLinearGradient(sx - 60 * u, 0, sx + 60 * u, 0);
      gr.addColorStop(0, 'rgba(255,255,255,0)');
      gr.addColorStop(0.5, 'rgba(255,255,255,0.32)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gr;
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
  }
  const font = `700 ${PANEL.bandFont * u}px ${theme.font}`;
  const cy = b.y + b.h / 2 + u;
  ctx.globalAlpha = T.bandIn ? clamp01((inT - 0.35) / 0.65) : 1;
  if (stale) {
    ctx.fillStyle = theme.staleDot;
    ctx.beginPath();
    ctx.arc(b.x + 18 * u, cy, 6 * u, 0, Math.PI * 2);
    ctx.fill();
    text(ctx, fit(ctx, band.text, b.w - 50 * u, PANEL.bandFont * u, 12 * u, theme.font), b.x + 32 * u, cy, ctx.font, theme.badgeFg);
  } else if (band.clock != null && now != null && band.clock - now > 0) {
    const rem = band.clock - now;
    const cfont = `700 ${(PANEL.bandFont + 2) * u}px ${theme.font}`;
    let label = band.clockLabel ? `${band.clockLabel} ${clockText(rem)}` : clockText(rem);
    if (band.clockLabel && measure(ctx, font, band.text) + measure(ctx, cfont, label) + 44 * u > b.w) label = clockText(rem);
    const cw = measure(ctx, cfont, label);
    text(ctx, fit(ctx, band.text, b.w - cw - 40 * u, PANEL.bandFont * u, 12 * u, theme.font), b.x + 14 * u, cy, ctx.font, theme.badgeFg);
    text(ctx, label, b.x + b.w - 14 * u, cy, cfont, theme.badgeFg, 'right');
    const left = band.total ? clamp01(rem / band.total) : 1;
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(b.x, b.y + b.h - 3 * u, b.w, 3 * u);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(b.x, b.y + b.h - 3 * u, b.w * left, 3 * u);
  } else {
    text(ctx, fit(ctx, band.text, b.w - 24 * u, PANEL.bandFont * u, 12 * u, theme.font), b.x + b.w / 2, cy, ctx.font, theme.badgeFg, 'center');
  }
  ctx.restore();
}

/** The optional channel or show logo (round 2): drawn as is, into its box. */
export function drawLogo(ctx: Ctx, image: CanvasImageSource, box: Box): void {
  ctx.drawImage(image, box.x, box.y, box.w, box.h);
}
