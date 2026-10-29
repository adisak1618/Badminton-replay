// Where the overlays sit in the frame (technical-design.md §6.2): the score panel and the optional logo each
// take one of the four corners, inset by the same fraction of the frame at 1080p and 720p, and so does the optional
// player stats table (D15). Overlays in one corner are stacked, never overlapped. The boxes are recorded per segment for a later re-render.
import type { Box } from './draw';

export type Corner = 'tl' | 'tr' | 'bl' | 'br';
export const CORNERS: readonly Corner[] = ['tl', 'tr', 'bl', 'br'];
export const DEFAULT_SCORE_CORNER: Corner = 'tl';
export const DEFAULT_LOGO_CORNER: Corner = 'tr';

export type LogoSize = 'small' | 'medium' | 'large';
export const LOGO_SIZES: readonly LogoSize[] = ['small', 'medium', 'large'];
/** The score panel has the same three sizes (round 4). */
export type PanelSize = LogoSize;
const PANEL_SCALE: Record<PanelSize, number> = { small: 0.8, medium: 1, large: 1.25 };

/** Pixels per panel unit for a frame `H` tall: 1 at 1080p, size M. */
export const panelScale = (H: number, size: PanelSize): number => (H / 1080) * PANEL_SCALE[size];
/** Logo height as a fraction of the frame height. */
const LOGO_HEIGHT: Record<LogoSize, number> = { small: 0.08, medium: 0.12, large: 0.17 };
const LOGO_MAX_WIDTH = 0.3; // of the frame width, for very wide logos

export interface LogoSpec {
  corner: Corner;
  size: LogoSize;
  aspect: number; // width / height of the image
}

const hit = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Where the player stats table goes: a free corner chosen for it, or the corner the user picked (it stacks last). */
export type TablePlace = 'auto' | Corner;
export const TABLE_PLACES: readonly TablePlace[] = ['auto', ...CORNERS];
export interface TableSpec {
  place: TablePlace;
  w: number;
  h: number;
}

export interface Layout {
  score: Box | null;
  logo: Box | null;
  table: Box | null;
}

const MIRROR_V: Record<Corner, Corner> = { tl: 'bl', bl: 'tl', tr: 'br', br: 'tr' };
const MIRROR_H: Record<Corner, Corner> = { tl: 'tr', tr: 'tl', bl: 'br', br: 'bl' };
const OPPOSITE: Record<Corner, Corner> = { tl: 'br', br: 'tl', tr: 'bl', bl: 'tr' };

/** The safe inset from the frame edges: 4 % of the height (43 px at 1080p, 29 px at 720p). */
export const inset = (H: number): number => Math.round(H * 0.04);

function place(corner: Corner, W: number, H: number, w: number, h: number, stackOffset: number): Box {
  const m = inset(H);
  const x = corner === 'tl' || corner === 'bl' ? m : W - m - w;
  const y = corner === 'tl' || corner === 'tr' ? m + stackOffset : H - m - h - stackOffset;
  return { x, y, w, h };
}

/**
 * `score` is the panel's current size (it follows the names and the number of games); `scoreMaxH` is the
 * tallest it gets, which is what a logo or the table in the same corner stacks against so it never jumps.
 *
 * Each corner is a stack that grows away from the frame edge in a fixed order: score panel, logo, stats table. The
 * table is the last tenant, so nothing that was already placed moves when it is switched on. Its place is the first
 * corner nobody owns (the panel's vertical mirror, then the diagonal, then the horizontal mirror; four corners and
 * at most two owners leave one free), or the corner the user picked, stacked after whatever is already there.
 */
export function overlayLayout(
  W: number,
  H: number,
  o: { scoreCorner: Corner; score: { w: number; h: number } | null; scoreMaxH: number; logo: LogoSpec | null; table?: TableSpec | null },
): Layout {
  const gap = Math.round(H * 0.015);
  const score = o.score ? place(o.scoreCorner, W, H, o.score.w, o.score.h, 0) : null;
  const end: Partial<Record<Corner, number>> = {}; // where each occupied corner's stack stops, from the frame edge
  if (o.score) end[o.scoreCorner] = o.scoreMaxH;
  let logo: Box | null = null;
  if (o.logo && o.logo.aspect > 0) {
    let h = Math.round(H * LOGO_HEIGHT[o.logo.size]);
    let w = Math.round(h * o.logo.aspect);
    if (w > W * LOGO_MAX_WIDTH) {
      w = Math.round(W * LOGO_MAX_WIDTH);
      h = Math.round(w / o.logo.aspect);
    }
    const stack = o.score && o.logo.corner === o.scoreCorner ? o.scoreMaxH + gap : 0;
    logo = place(o.logo.corner, W, H, w, h, stack);
    end[o.logo.corner] = stack + h;
  }
  let table: Box | null = null;
  if (o.table) {
    const t = o.table;
    const corner =
      t.place === 'auto'
        ? ([MIRROR_V[o.scoreCorner], OPPOSITE[o.scoreCorner], MIRROR_H[o.scoreCorner]] as Corner[]).find((c) => end[c] == null) ?? MIRROR_V[o.scoreCorner]
        : t.place;
    const at = end[corner];
    let off = at == null ? 0 : at + gap;
    // Very wide boxes (long names) can reach across the frame into the other corner on the same side: step past them.
    for (let i = 0; i < 2; i++) {
      table = place(corner, W, H, t.w, t.h, off);
      const b = [score, logo].find((q) => q && hit(table!, q));
      if (!b) break;
      const top = corner === 'tl' || corner === 'tr';
      off = (top ? b.y + b.h - inset(H) : H - inset(H) - b.y) + gap;
    }
  }
  return { score, logo, table };
}
