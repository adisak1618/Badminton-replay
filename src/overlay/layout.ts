// Where the overlays sit in the frame (technical-design.md §6.2): the score panel and the optional logo each
// take one of the four corners, inset by the same fraction of the frame at 1080p and 720p. Two overlays in
// one corner are stacked, never overlapped. The boxes are recorded per segment for a later re-render.
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

export interface Layout {
  score: Box | null;
  logo: Box | null;
}

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
 * tallest it gets, which is what a logo in the same corner stacks against so it never jumps.
 */
export function overlayLayout(
  W: number,
  H: number,
  o: { scoreCorner: Corner; score: { w: number; h: number } | null; scoreMaxH: number; logo: LogoSpec | null },
): Layout {
  const score = o.score ? place(o.scoreCorner, W, H, o.score.w, o.score.h, 0) : null;
  if (!o.logo || !(o.logo.aspect > 0)) return { score, logo: null };
  let h = Math.round(H * LOGO_HEIGHT[o.logo.size]);
  let w = Math.round(h * o.logo.aspect);
  if (w > W * LOGO_MAX_WIDTH) {
    w = Math.round(W * LOGO_MAX_WIDTH);
    h = Math.round(w / o.logo.aspect);
  }
  const gap = Math.round(H * 0.015);
  const stack = o.score && o.logo.corner === o.scoreCorner ? o.scoreMaxH + gap : 0;
  return { score, logo: place(o.logo.corner, W, H, w, h, stack) };
}
