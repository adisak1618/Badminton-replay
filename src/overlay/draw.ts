// drawOverlay(ctx, model, box, theme): the score panel burned into every frame, in plain Canvas 2D so it runs
// per camera frame on the phone and in node-canvas for a later re-render (technical-design.md §6.2, §7). A
// canvas cannot rasterise HTML, so this is not the scoreboard's DOM. The look follows a broadcast score
// panel: two rows, one per team, players' names in white capitals, then one column per game with the
// winner's points highlighted and the live game last.
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
  nameFg: string;
  cellsBg: string;
  liveBg: string;
  divider: string;
  scoreFg: string;
  winFg: string; // the winner's points in a finished game
  serveFg: string; // the bar beside the serving team's scores
  flagFg: string;
  badgeFg: string;
  staleFg: string;
}

export const DEFAULT_THEME: OverlayTheme = {
  id: 'panel-v3',
  font: "-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif",
  panelBg: 'rgba(12,14,18,0.78)',
  nameFg: '#ffffff',
  cellsBg: 'rgba(0,0,0,0.6)',
  liveBg: 'rgba(255,255,255,0.14)',
  divider: 'rgba(255,255,255,0.28)',
  scoreFg: '#ffffff',
  winFg: '#ffd23f',
  serveFg: '#ffd23f',
  flagFg: '#ffb020',
  badgeFg: '#0b0d10',
  staleFg: '#ff4d4d',
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

// Panel geometry in units of box.h / 122 (the 1080p panel is 840 x 122): two 54-unit rows, then up to three
// game columns. The box is sized for three columns so it never changes mid-match; fewer columns leave the
// names more room.
const PAD = 6;
const ROW = 54;
const GAP = 2;
const ACCENT = 6;
const COL = 62;
const DIV = 2;
const SERVE = 6;
export const MAX_COLUMNS = 3;

export function drawOverlay(ctx: Ctx, m: OverlayModel, box: Box, theme: OverlayTheme = DEFAULT_THEME): void {
  const u = box.h / 122;
  ctx.save();
  roundRectPath(ctx, box, 10 * u);
  ctx.fillStyle = theme.panelBg;
  ctx.fill();
  ctx.clip();
  ctx.textBaseline = 'middle';

  const cols = m.games.slice(-MAX_COLUMNS);
  const x1 = box.x + box.w - PAD * u;
  const cellsW = (cols.length * COL + Math.max(0, cols.length - 1) * DIV) * u;
  const cellsX = x1 - cellsW;
  const rowY = (i: number) => box.y + (PAD + i * (ROW + GAP)) * u;
  const h = ROW * u;

  // The dark cell block with thin dividers between games; the live game a shade lighter.
  if (cols.length) {
    ctx.fillStyle = theme.cellsBg;
    ctx.fillRect(cellsX, rowY(0), cellsW, 2 * h + GAP * u);
    cols.forEach((g, c) => {
      const x = cellsX + c * (COL + DIV) * u;
      if (g.live) {
        ctx.fillStyle = theme.liveBg;
        ctx.fillRect(x, rowY(0), COL * u, 2 * h + GAP * u);
      }
      if (c > 0) {
        ctx.fillStyle = theme.divider;
        ctx.fillRect(x - DIV * u, rowY(0), DIV * u, 2 * h + GAP * u);
      }
    });
  }

  const status = statusText(m);
  const global = status && !m.flag ? status : '';
  [m.left, m.right].forEach((side, i) => {
    const y = rowY(i);
    const cy = y + h / 2;
    ctx.fillStyle = side.color; // a thin team-colour accent keeps A and B recognisable without flags
    ctx.fillRect(box.x + PAD * u, y, ACCENT * u, h);
    if (side.serving) {
      ctx.fillStyle = theme.serveFg;
      ctx.fillRect(cellsX - (SERVE + 4) * u, y, SERVE * u, h);
    }
    cols.forEach((g, c) => {
      const pts = i === 0 ? g.left : g.right;
      const won = g.winner === (i === 0 ? 'left' : 'right');
      ctx.fillStyle = won ? theme.winFg : theme.scoreFg;
      ctx.textAlign = 'center';
      const x = cellsX + (c * (COL + DIV) + COL / 2) * u;
      ctx.fillText(fit(ctx, String(pts), (COL - 6) * u, 38 * u, 20 * u, theme.font, 800), x, cy + 2 * u);
    });
    // Names, leaving room for the serve bar and a badge: game/match point on its team's row, the other
    // states (interval, end of game, final, link lost) on the top row.
    const nameX = box.x + (PAD + ACCENT + 12) * u;
    let nameEnd = cellsX - (SERVE + 12) * u;
    const badge = m.flag?.team === side.team ? status : i === 0 ? global : '';
    if (badge) nameEnd = drawBadge(ctx, badge, nameEnd, cy, u, m.stale ? theme.staleFg : theme.flagFg, theme) - 8 * u;
    ctx.fillStyle = theme.nameFg;
    ctx.textAlign = 'left';
    ctx.fillText(fit(ctx, side.players, nameEnd - nameX, 30 * u, 16 * u, theme.font), nameX, cy + u);
  });
  ctx.restore();
}

/** A small filled pill ending at `right`; returns its left edge. */
function drawBadge(ctx: Ctx, text: string, right: number, cy: number, u: number, color: string, theme: OverlayTheme): number {
  ctx.font = `800 ${18 * u}px ${theme.font}`;
  const w = ctx.measureText(text).width + 16 * u;
  const b = { x: right - w, y: cy - 13 * u, w, h: 26 * u };
  roundRectPath(ctx, b, 6 * u);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = theme.badgeFg;
  ctx.textAlign = 'center';
  ctx.fillText(text, b.x + w / 2, cy + u);
  return b.x;
}

/** The optional channel or show logo (round 2): drawn as is, into its box. */
export function drawLogo(ctx: Ctx, image: CanvasImageSource, box: Box): void {
  ctx.drawImage(image, box.x, box.y, box.w, box.h);
}

/** The panel's one short status word, when a state is active. */
export function statusText(m: OverlayModel): string {
  if (m.stale) return 'LINK LOST';
  if (m.phase === 'matchOver') return m.winner ? 'FINAL' : 'DRAW';
  if (m.phase === 'gameOver') return 'GAME END';
  if (m.phase === 'interval') return 'INTERVAL';
  if (m.flag) return m.flag.kind === 'matchPoint' ? 'MATCH PT' : 'GAME PT';
  return '';
}
