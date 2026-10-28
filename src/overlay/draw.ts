// drawOverlay(ctx, model, box, theme): the score panel burned into every frame, in plain Canvas 2D so it runs
// per camera frame on the phone and in node-canvas for a later re-render (technical-design.md §6.2, §7). A
// canvas cannot rasterise HTML, so this is not the scoreboard's DOM. The look follows the BWF TV panel: two
// light rows with dark names, one cell per game (finished white, live grey), a band for game point and
// the like; the panel is only as wide as its content.
import type { OverlayModel } from './model';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlayTheme {
  id: string; // recorded per segment so a re-render knows which look was burned in
  font: string;
  panelBg: string;
  nameBg: string;
  nameFg: string;
  doneBg: string; // a finished game's cell
  doneFg: string;
  liveBg: string; // the game being played
  liveFg: string;
  shuttle: string;
  bandBg: string;
  bandFg: string;
  staleBg: string;
}

/** BWF TV style: light rows with dark names, white cells for finished games, a grey cell for the live one. */
export const DEFAULT_THEME: OverlayTheme = {
  id: 'bwf-tv-v4',
  font: "-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif",
  panelBg: 'rgba(255,255,255,0.22)',
  nameBg: 'rgba(244,245,247,0.92)',
  nameFg: '#16191e',
  doneBg: 'rgba(255,255,255,0.96)',
  doneFg: '#111317',
  liveBg: 'rgba(120,124,131,0.94)',
  liveFg: '#ffffff',
  shuttle: '#8a9099',
  bandBg: 'rgba(118,122,129,0.92)',
  bandFg: '#ffffff',
  staleBg: 'rgba(200,40,40,0.92)',
};

type Ctx = CanvasRenderingContext2D;

function roundRectPath(ctx: Ctx, b: Box, r: number): void {
  ctx.beginPath();
  ctx.moveTo(b.x + r, b.y);
  ctx.arcTo(b.x + b.w, b.y, b.x + b.w, b.y + b.h, r);
  ctx.arcTo(b.x + b.w, b.y + b.h, b.x, b.y + b.h, r);
  ctx.arcTo(b.x, b.y + b.h, b.x, b.y, r);
  ctx.arcTo(b.x, b.y, b.x + b.w, b.y, r);
  ctx.closePath();
}

/** Set a bold font no larger than `px` that makes `text` fit `maxW`, ellipsising below `minPx`. */
function fit(ctx: Ctx, text: string, maxW: number, px: number, minPx: number, font: string, weight = 700): string {
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

/** A small shuttlecock, cork towards the left: a solid cork and a lighter feather skirt; vector, no emoji font. */
function shuttle(ctx: Ctx, cx: number, cy: number, size: number, color: string): void {
  const r = size * 0.22;
  const corkX = cx - size / 2 + r;
  const rimX = cx + size / 2;
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.moveTo(corkX, cy - r * 0.8);
  ctx.lineTo(rimX, cy - size * 0.42);
  ctx.lineTo(rimX, cy + size * 0.42);
  ctx.lineTo(corkX, cy + r * 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(corkX, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Panel geometry, in units: one unit is 1 px of a 1080p frame at size M. The panel is as small as its
 * content: the longer name (up to NAME_MAX, then it shrinks and ellipsises) plus one cell per game.
 */
export const PANEL = {
  edge: 8, // panel padding around the cells
  row: 58,
  rowGap: 4,
  namePadL: 18,
  namePadR: 14,
  nameGap: 14, // between the name and the shuttle slot
  shuttle: 30, // reserved in every name cell so the width does not change with the serve
  nameMax: 600, // two 14-letter names in capitals fit whole
  nameMin: 80,
  nameFont: 32,
  cellGap: 6, // between the name cell and the first score cell, and between score cells
  cell: 72,
  digits: 44,
  bandGap: 4,
  band: 50,
  bandFont: 30,
  radius: 8,
} as const;

/** The status band's text while a state applies (BWF TV wording), or null. */
export function bandText(m: OverlayModel): string | null {
  if (m.stale) return 'Link lost';
  if (m.phase === 'matchOver') return m.winner ? 'Match' : 'Draw';
  if (m.phase === 'gameOver') return 'Game';
  if (m.phase === 'interval') return 'Interval';
  if (m.flag) return m.flag.kind === 'matchPoint' ? 'Match Point' : 'Game Point';
  return null;
}

const nameFontAt = (u: number, px: number, font: string) => `700 ${px * u}px ${font}`;

interface Geometry {
  w: number;
  h: number;
  nameW: number; // width of the name text slot
  cells: number;
  band: string | null;
}

function geometry(ctx: Ctx, m: OverlayModel, u: number, theme: OverlayTheme): Geometry {
  ctx.font = nameFontAt(u, PANEL.nameFont, theme.font);
  const widest = Math.max(ctx.measureText(m.left.players).width, ctx.measureText(m.right.players).width) / u;
  const nameW = Math.min(PANEL.nameMax, Math.max(PANEL.nameMin, Math.ceil(widest)));
  const cells = m.games.length;
  const nameCell = PANEL.namePadL + nameW + PANEL.nameGap + PANEL.shuttle + PANEL.namePadR;
  const w = PANEL.edge * 2 + nameCell + cells * (PANEL.cellGap + PANEL.cell);
  const band = bandText(m);
  const h = PANEL.edge * 2 + 2 * PANEL.row + PANEL.rowGap + (band ? PANEL.bandGap + PANEL.band : 0);
  return { w: w * u, h: h * u, nameW, cells, band };
}

/** The panel's size in pixels for scale `u` (frame height / 1080 times the S/M/L factor). */
export function panelSize(ctx: Ctx, m: OverlayModel, u: number, theme: OverlayTheme = DEFAULT_THEME): { w: number; h: number } {
  const g = geometry(ctx, m, u, theme);
  return { w: Math.round(g.w), h: Math.round(g.h) };
}

/** The tallest the panel gets (with the band), so a logo stacked under it never has to move. */
export const panelMaxHeight = (u: number): number =>
  Math.round((PANEL.edge * 2 + 2 * PANEL.row + PANEL.rowGap + PANEL.bandGap + PANEL.band) * u);

export function drawOverlay(ctx: Ctx, m: OverlayModel, box: Box, u: number, theme: OverlayTheme = DEFAULT_THEME): void {
  const g = geometry(ctx, m, u, theme);
  ctx.save();
  roundRectPath(ctx, box, PANEL.radius * u);
  ctx.fillStyle = theme.panelBg;
  ctx.fill();
  ctx.textBaseline = 'middle';

  const x0 = box.x + PANEL.edge * u;
  const nameCellW = (PANEL.namePadL + g.nameW + PANEL.nameGap + PANEL.shuttle + PANEL.namePadR) * u;
  const rowH = PANEL.row * u;
  [m.left, m.right].forEach((side, i) => {
    const y = box.y + (PANEL.edge + i * (PANEL.row + PANEL.rowGap)) * u;
    const cy = y + rowH / 2;
    roundRectPath(ctx, { x: x0, y, w: nameCellW, h: rowH }, 4 * u);
    ctx.fillStyle = theme.nameBg;
    ctx.fill();
    ctx.fillStyle = side.color; // a hairline the eye barely notices, so the two teams can still be told apart
    ctx.fillRect(x0, y + 6 * u, 3 * u, rowH - 12 * u);
    ctx.fillStyle = theme.nameFg;
    ctx.textAlign = 'left';
    const nameX = x0 + PANEL.namePadL * u;
    ctx.fillText(fit(ctx, side.players, g.nameW * u, PANEL.nameFont * u, 18 * u, theme.font), nameX, cy + u);
    if (side.serving) shuttle(ctx, x0 + nameCellW - (PANEL.namePadR + PANEL.shuttle / 2) * u, cy, 24 * u, theme.shuttle);
    // Score cells in game order: finished games white with dark digits, the live game grey with white.
    m.games.forEach((game, c) => {
      const x = x0 + nameCellW + (PANEL.cellGap + c * (PANEL.cell + PANEL.cellGap)) * u;
      roundRectPath(ctx, { x, y, w: PANEL.cell * u, h: rowH }, 4 * u);
      ctx.fillStyle = game.live ? theme.liveBg : theme.doneBg;
      ctx.fill();
      ctx.fillStyle = game.live ? theme.liveFg : theme.doneFg;
      ctx.textAlign = 'center';
      const pts = String(i === 0 ? game.left : game.right);
      ctx.fillText(fit(ctx, pts, (PANEL.cell - 10) * u, PANEL.digits * u, 22 * u, theme.font, 800), x + (PANEL.cell * u) / 2, cy + 2 * u);
    });
  });

  if (g.band) {
    const y = box.y + (PANEL.edge + 2 * PANEL.row + PANEL.rowGap + PANEL.bandGap) * u;
    const w = box.w - 2 * PANEL.edge * u;
    roundRectPath(ctx, { x: x0, y, w, h: PANEL.band * u }, 6 * u);
    ctx.fillStyle = m.stale ? theme.staleBg : theme.bandBg;
    ctx.fill();
    ctx.fillStyle = theme.bandFg;
    ctx.textAlign = 'center';
    ctx.fillText(fit(ctx, g.band, w - 20 * u, PANEL.bandFont * u, 16 * u, theme.font), x0 + w / 2, y + (PANEL.band * u) / 2 + u);
  }
  ctx.restore();
}

/** The optional channel or show logo (round 2): drawn as is, into its box. */
export function drawLogo(ctx: Ctx, image: CanvasImageSource, box: Box): void {
  ctx.drawImage(image, box.x, box.y, box.w, box.h);
}
