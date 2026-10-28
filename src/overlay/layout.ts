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
/** Logo height as a fraction of the frame height. */
const LOGO_HEIGHT: Record<LogoSize, number> = { small: 0.08, medium: 0.12, large: 0.17 };
const LOGO_MAX_WIDTH = 0.3; // of the frame width, for very wide logos

export interface LogoSpec {
  corner: Corner;
  size: LogoSize;
  aspect: number; // width / height of the image
}

export interface Layout {
  score: Box;
  logo: Box | null;
}

/** The safe inset from the frame edges: 4 % of the height (43 px at 1080p, 29 px at 720p). */
export const inset = (H: number): number => Math.round(H * 0.04);

/** The score panel's size, room for names and three game columns, in units of H / 1080 (840 x 122 at 1080p). */
export function scorePanelSize(H: number): { w: number; h: number } {
  const u = H / 1080;
  return { w: Math.round(840 * u), h: Math.round(122 * u) };
}

function place(corner: Corner, W: number, H: number, w: number, h: number, stackOffset: number): Box {
  const m = inset(H);
  const x = corner === 'tl' || corner === 'bl' ? m : W - m - w;
  const y = corner === 'tl' || corner === 'tr' ? m + stackOffset : H - m - h - stackOffset;
  return { x, y, w, h };
}

export function overlayLayout(W: number, H: number, o: { scoreCorner: Corner; logo: LogoSpec | null }): Layout {
  const sp = scorePanelSize(H);
  const score = place(o.scoreCorner, W, H, sp.w, sp.h, 0);
  if (!o.logo || !(o.logo.aspect > 0)) return { score, logo: null };
  let h = Math.round(H * LOGO_HEIGHT[o.logo.size]);
  let w = Math.round(h * o.logo.aspect);
  if (w > W * LOGO_MAX_WIDTH) {
    w = Math.round(W * LOGO_MAX_WIDTH);
    h = Math.round(w / o.logo.aspect);
  }
  const gap = Math.round(H * 0.015);
  const stack = o.logo.corner === o.scoreCorner ? sp.h + gap : 0;
  return { score, logo: place(o.logo.corner, W, H, w, h, stack) };
}
