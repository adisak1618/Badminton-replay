// drawOverlay(ctx, model, box, theme): the score strip of the mockup's C3 frame, in plain Canvas 2D so it
// runs per camera frame on the phone and in node-canvas for a later re-render (technical-design.md §6.2, §7).
// A canvas cannot rasterise HTML, so this is not the scoreboard's DOM; it reuses its colours and type.
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
  nameFg: string;
  scoreBg: string;
  scoreFg: string;
  gameBg: string;
  gameFg: string;
  flagFg: string;
  staleFg: string;
  edge: string;
}

/** The mockup's strip: team-coloured name cells with black text, white digits on near-black, a grey game cell. */
export const DEFAULT_THEME: OverlayTheme = {
  id: 'strip-v1',
  font: "-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif",
  nameFg: '#000000',
  scoreBg: '#111111',
  scoreFg: '#ffffff',
  gameBg: '#222222',
  gameFg: '#cccccc',
  flagFg: '#ffb020',
  staleFg: '#ff4d4d',
  edge: 'rgba(0,0,0,0.55)',
};

/** Cell widths as fractions of the box: name, score, score, name, game. */
const CELLS = [0.27, 0.115, 0.115, 0.27, 0.23] as const;

/** The fixed overlay box, bottom-left, for a W x H frame. It does not move with mirroring or the score. */
export function overlayBox(W: number, H: number): Box {
  const m = Math.round(H * 0.044);
  const h = Math.round(H * 0.067);
  return { x: m, y: H - m - h, w: Math.round(W * 0.42), h };
}

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

export function drawOverlay(ctx: Ctx, m: OverlayModel, box: Box, theme: OverlayTheme = DEFAULT_THEME): void {
  const u = box.h / 72; // sizes below are for the 72 px tall box of a 1080p frame
  const xs: number[] = [];
  let acc = box.x;
  for (const f of CELLS) {
    xs.push(acc);
    acc += f * box.w;
  }
  const cellW = (i: number) => CELLS[i] * box.w;
  const cy = box.y + box.h / 2;

  ctx.save();
  roundRectPath(ctx, box, 10 * u);
  ctx.fillStyle = theme.edge;
  ctx.fill();
  ctx.clip();
  ctx.textBaseline = 'middle';

  const nameCell = (i: number, s: OverlaySide, markerLeft: boolean) => {
    const x = xs[i];
    const w = cellW(i);
    ctx.fillStyle = s.color;
    ctx.fillRect(x, box.y, w, box.h);
    const pad = 12 * u;
    const mark = 30 * u; // reserved even when not serving, so the name never jumps
    const textW = w - 2 * pad - mark;
    const text = fit(ctx, s.name, textW, 34 * u, 20 * u, theme.font);
    ctx.fillStyle = theme.nameFg;
    if (markerLeft) {
      ctx.textAlign = 'right';
      ctx.fillText(text, x + w - pad, cy);
      if (s.serving) shuttle(ctx, x + pad + mark / 2, cy, mark, theme.nameFg, true);
    } else {
      ctx.textAlign = 'left';
      ctx.fillText(text, x + pad, cy);
      if (s.serving) shuttle(ctx, x + w - pad - mark / 2, cy, mark, theme.nameFg, false);
    }
  };
  const scoreCell = (i: number, score: number) => {
    ctx.fillStyle = theme.scoreBg;
    ctx.fillRect(xs[i], box.y, cellW(i), box.h);
    ctx.fillStyle = theme.scoreFg;
    ctx.textAlign = 'center';
    ctx.fillText(fit(ctx, String(score), cellW(i) - 8 * u, 48 * u, 24 * u, theme.font, 800), xs[i] + cellW(i) / 2, cy + 2 * u);
  };

  nameCell(0, m.left, false);
  scoreCell(1, m.left.score);
  scoreCell(2, m.right.score);
  nameCell(3, m.right, true);
  // A hairline between the two scores.
  ctx.fillStyle = theme.gameBg;
  ctx.fillRect(xs[2] - u, box.y + 12 * u, 2 * u, box.h - 24 * u);

  // Game cell: "G2  1-0" on top; the status (game/match point, interval, final, stale link) below.
  const gx = xs[4];
  const gw = cellW(4);
  ctx.fillStyle = theme.gameBg;
  ctx.fillRect(gx, box.y, gw, box.h);
  ctx.textAlign = 'center';
  ctx.fillStyle = theme.gameFg;
  const top = `G${m.game}  ${m.left.games}-${m.right.games}`;
  const status = statusText(m);
  ctx.fillText(fit(ctx, top, gw - 12 * u, status ? 26 * u : 30 * u, 16 * u, theme.font), gx + gw / 2, status ? box.y + box.h * 0.33 : cy);
  if (status) {
    ctx.fillStyle = m.stale ? theme.staleFg : theme.flagFg;
    ctx.fillText(fit(ctx, status, gw - 12 * u, 20 * u, 12 * u, theme.font, 800), gx + gw / 2, box.y + box.h * 0.72);
  }
  ctx.restore();
}

export function statusText(m: OverlayModel): string {
  if (m.stale) return 'LINK LOST';
  if (m.phase === 'matchOver') return m.winner ? 'FINAL' : 'FINAL · DRAW';
  if (m.phase === 'gameOver') return `GAME ${m.game} END`;
  if (m.phase === 'interval') return 'INTERVAL';
  if (m.flag) return m.flag.kind === 'matchPoint' ? 'MATCH POINT' : 'GAME POINT';
  return '';
}
