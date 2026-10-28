// drawOverlay(ctx, model, box, theme): the score panel burned into every frame, in plain Canvas 2D so it runs
// per camera frame on the phone and in node-canvas for a later re-render (technical-design.md §6.2, §7). A
// canvas cannot rasterise HTML, so this is not the scoreboard's DOM. The look follows a broadcast score
// panel: two rows, one per team, players' names in white capitals, the score in a lighter cell at the end.
import type { OverlayModel, OverlaySide } from './model';

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
  scoreBg: string;
  scoreFg: string;
  gamesBg: string;
  gamesFg: string;
  footFg: string;
  flagFg: string;
  staleFg: string;
}

export const DEFAULT_THEME: OverlayTheme = {
  id: 'panel-v2',
  font: "-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif",
  panelBg: 'rgba(12,14,18,0.78)',
  nameFg: '#ffffff',
  scoreBg: 'rgba(255,255,255,0.22)',
  scoreFg: '#ffffff',
  gamesBg: 'rgba(255,255,255,0.08)',
  gamesFg: '#c9d0da',
  footFg: '#9aa3b0',
  flagFg: '#ffb020',
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

/** A small shuttlecock, cork towards `corkLeft`: a solid cork and a lighter feather skirt; vector, no emoji font. */
function shuttle(ctx: Ctx, cx: number, cy: number, size: number, color: string, corkLeft: boolean): void {
  const d = corkLeft ? -1 : 1;
  const r = size * 0.22;
  const corkX = cx + d * (size / 2 - r);
  const rimX = cx - d * (size / 2);
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(corkX, cy - r * 0.8);
  ctx.lineTo(rimX, cy - size * 0.46);
  ctx.lineTo(rimX, cy + size * 0.46);
  ctx.lineTo(corkX, cy + r * 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(corkX, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Panel geometry in units of box.h / 160 (the 1080p panel is 768 x 160): padding, two 54-unit rows, a footer.
const PAD = 8;
const ROW = 54;
const GAP = 4;
const FOOT = 28;
const ACCENT = 6;
const SCORE_W = 76;
const GAMES_W = 36;
const MARK_W = 34;

export function drawOverlay(ctx: Ctx, m: OverlayModel, box: Box, theme: OverlayTheme = DEFAULT_THEME): void {
  const u = box.h / 160;
  ctx.save();
  roundRectPath(ctx, box, 12 * u);
  ctx.fillStyle = theme.panelBg;
  ctx.fill();
  ctx.clip();
  ctx.textBaseline = 'middle';

  const x0 = box.x + PAD * u;
  const x1 = box.x + box.w - PAD * u;
  const row = (i: number, s: OverlaySide) => {
    const y = box.y + (PAD + i * (ROW + GAP)) * u;
    const h = ROW * u;
    const cy = y + h / 2;
    // A thin team-colour accent keeps A and B recognisable without flags.
    ctx.fillStyle = s.color;
    ctx.fillRect(x0, y, ACCENT * u, h);
    const scoreX = x1 - SCORE_W * u;
    ctx.fillStyle = theme.scoreBg;
    ctx.fillRect(scoreX, y, SCORE_W * u, h);
    ctx.fillStyle = theme.scoreFg;
    ctx.textAlign = 'center';
    ctx.fillText(fit(ctx, String(s.score), (SCORE_W - 8) * u, 42 * u, 22 * u, theme.font, 800), scoreX + (SCORE_W * u) / 2, cy + 2 * u);
    if (m.flag?.team === s.team) {
      // The team with game or match point gets an amber underline under its score.
      ctx.fillStyle = theme.flagFg;
      ctx.fillRect(scoreX, y + h - 4 * u, SCORE_W * u, 4 * u);
    }
    const gamesX = scoreX - GAMES_W * u;
    ctx.fillStyle = theme.gamesBg;
    ctx.fillRect(gamesX, y, GAMES_W * u, h);
    ctx.fillStyle = theme.gamesFg;
    ctx.fillText(fit(ctx, String(s.games), (GAMES_W - 6) * u, 24 * u, 14 * u, theme.font), gamesX + (GAMES_W * u) / 2, cy);
    const markX = gamesX - MARK_W * u;
    if (s.serving) shuttle(ctx, markX + (MARK_W * u) / 2, cy, 26 * u, theme.nameFg, false);
    const nameX = x0 + (ACCENT + 12) * u;
    ctx.fillStyle = theme.nameFg;
    ctx.textAlign = 'left';
    ctx.fillText(fit(ctx, s.players, markX - 6 * u - nameX, 30 * u, 18 * u, theme.font), nameX, cy + u);
  };
  row(0, m.left);
  row(1, m.right);

  // Footer: the game number, and the status (game/match point, interval, final, link lost) when there is one.
  const fy = box.y + (PAD + 2 * (ROW + GAP)) * u + (FOOT * u) / 2;
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.footFg;
  ctx.fillText(fit(ctx, `GAME ${m.game}`, 200 * u, 20 * u, 12 * u, theme.font), x0 + (ACCENT + 12) * u, fy);
  const status = statusText(m);
  if (status) {
    ctx.textAlign = 'right';
    ctx.fillStyle = m.stale ? theme.staleFg : theme.flagFg;
    ctx.fillText(fit(ctx, status, x1 - x0 - 230 * u, 20 * u, 12 * u, theme.font, 800), x1 - 4 * u, fy);
  }
  ctx.restore();
}

/** The optional channel or show logo (round 2): drawn as is, into its box. */
export function drawLogo(ctx: Ctx, image: CanvasImageSource, box: Box): void {
  ctx.drawImage(image, box.x, box.y, box.w, box.h);
}

export function statusText(m: OverlayModel): string {
  if (m.stale) return 'LINK LOST';
  if (m.phase === 'matchOver') return m.winner ? 'FINAL' : 'FINAL · DRAW';
  if (m.phase === 'gameOver') return 'GAME OVER';
  if (m.phase === 'interval') return 'INTERVAL';
  if (m.flag) return m.flag.kind === 'matchPoint' ? 'MATCH POINT' : 'GAME POINT';
  return '';
}
