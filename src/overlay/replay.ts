// A point's slow replay inside the video made after the match (D16, research board Q7, Q8): the BWF world feed's
// white card spins in, the picture dissolves to the replay behind it, the card spins out; the score panel stays frozen
// at the score after the point with "REPLAY ×0.5" in its badge slot; the exit is the same backwards. Like the rest of
// the overlay, every frame is a pure function of the output frame's time and the replay's plan, so a render is
// repeatable. Timings were measured frame by frame on BWF TV (World Tour Finals 2025).
import { DEFAULT_THEME, PANEL, hgrad, measure, roundRectPath, text, type Box, type OverlayTheme } from './draw';
import { clamp01, easeInOut, easeOut, type Motion } from './motion';
import { WORDS } from './words';

/** Durations in ms; 0 is off. The light set dissolves, the none set cuts. */
export interface ReplayTimes {
  cardIn: number; // the white card spins in on its vertical axis
  cardHold: number; // it stays face on; the picture changes behind it at the end
  cardOut: number; // and spins away
  mix: number; // the picture dissolves between live and replay
  badgeIn: number; // REPLAY wipes into the panel's badge slot
  chip: number; // the speed chip fades in
  shine: number; // one light sweep across the badge
}

export const REPLAY_TIMES: Record<Motion, ReplayTimes> = {
  full: { cardIn: 180, cardHold: 720, cardOut: 200, mix: 250, badgeIn: 360, chip: 200, shine: 900 },
  light: { cardIn: 0, cardHold: 0, cardOut: 0, mix: 300, badgeIn: 240, chip: 0, shine: 0 },
  none: { cardIn: 0, cardHold: 0, cardOut: 0, mix: 0, badgeIn: 0, chip: 0, shine: 0 },
};

/** One replay on the output timeline: `at` in output ms, `from`/`to` in source (recording) ms. */
export interface ReplayPlan {
  at: number;
  from: number;
  to: number;
  speed: number; // 0.5 = half speed
  motion: Motion;
}

/** When things happen, in output ms: the replay picture starts, is fully on, reaches `to`, live is back, all gone. */
export interface ReplayMarks {
  start: number;
  cut: number;
  end: number;
  back: number;
  done: number;
}

export function replayMarks(p: ReplayPlan): ReplayMarks {
  const T = REPLAY_TIMES[p.motion];
  const card = T.cardIn > 0;
  const cut = p.at + (card ? T.cardIn + T.cardHold : T.mix);
  const start = cut - T.mix;
  const end = start + (p.to - p.from) / p.speed;
  const back = end + T.mix;
  return { start, cut, end, back, done: back + (card ? T.cardOut : 0) };
}

/** Output ms the replay takes out of the live timeline: the live picture is paused from `start` to `back`. */
export const replayPause = (p: ReplayPlan): number => {
  const m = replayMarks(p);
  return m.back - m.start;
};

export interface ReplayFrame {
  /** 0 = the live picture, 1 = the replay picture; between, a dissolve. */
  mix: number;
  /** The source ms to show in the replay picture (between two recorded frames when blending). */
  src: number;
  card: number | null; // the card's face-on amount 0..1 (its horizontal scale), null when not drawn
  badge: number; // REPLAY in the badge slot: 0 none, 1 fully in
  chip: number;
  shine: number | null;
  /** The replay's own graphics are on screen (the panel shows its replay state). */
  on: boolean;
}

export const NO_REPLAY: ReplayFrame = { mix: 0, src: 0, card: null, badge: 0, chip: 0, shine: null, on: false };

export function replayFrame(p: ReplayPlan, t: number): ReplayFrame {
  const T = REPLAY_TIMES[p.motion];
  const m = replayMarks(p);
  if (t < p.at || t >= m.done) return NO_REPLAY;
  const src = p.from + clamp01((t - m.start) / (m.end - m.start || 1)) * (p.to - p.from);
  let mix: number;
  if (t < m.start) mix = 0;
  else if (t < m.cut) mix = T.mix ? easeInOut((t - m.start) / T.mix) : 1;
  else if (t < m.end) mix = 1;
  else mix = T.mix ? 1 - easeInOut(clamp01((t - m.end) / T.mix)) : 0;
  let card: number | null = null;
  if (T.cardIn) {
    const exitAt = m.back - T.cardIn - T.cardHold;
    if (t < m.cut + T.cardOut && t < exitAt) card = t < p.at + T.cardIn ? easeOut((t - p.at) / T.cardIn) : t < m.cut ? 1 : 1 - easeInOut((t - m.cut) / T.cardOut);
    else if (t >= exitAt) card = t < exitAt + T.cardIn ? easeOut((t - exitAt) / T.cardIn) : t < m.back ? 1 : 1 - easeInOut((t - m.back) / T.cardOut);
  }
  let badge: number;
  if (t < m.end) badge = T.badgeIn ? easeOut(clamp01((t - m.start) / T.badgeIn)) : t >= m.start ? 1 : 0;
  else badge = T.badgeIn ? 1 - easeOut(clamp01((t - m.end) / T.badgeIn)) : 0;
  const chip = T.chip && t < m.end ? clamp01((t - m.start - T.badgeIn * 0.6) / T.chip) : badge;
  let shine: number | null = null;
  if (T.shine && t < m.end) {
    const s = clamp01((t - m.start - T.badgeIn * 0.6) / T.shine);
    shine = s > 0 && s < 1 ? s : null;
  }
  return { mix, src, card, badge, chip, shine, on: true };
}

type Ctx = CanvasRenderingContext2D;

/** The red REPLAY badge in the panel's badge slot: GAME POINT's gradient, wipe and shine, the speed framed on the right. */
export function drawReplayBadge(ctx: Ctx, b: Box, u: number, f: ReplayFrame, speed: number, theme: OverlayTheme = DEFAULT_THEME): void {
  if (f.badge <= 0) return;
  const r = PANEL.radius * u;
  ctx.save();
  ctx.beginPath();
  ctx.rect(b.x, b.y, b.w * f.badge, b.h);
  ctx.clip();
  roundRectPath(ctx, b, r);
  ctx.fillStyle = hgrad(ctx, b.x, b.x + b.w, theme.badge);
  ctx.fill();
  if (f.shine != null) {
    const sx = b.x - b.w * 0.3 + f.shine * b.w * 1.6;
    const gr = ctx.createLinearGradient(sx - 60 * u, 0, sx + 60 * u, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.5, 'rgba(255,255,255,0.32)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(b.x, b.y, b.w, b.h);
  }
  const cy = b.y + b.h / 2 + u;
  ctx.globalAlpha = clamp01((f.badge - 0.35) / 0.65);
  const tri = 9 * u;
  ctx.fillStyle = theme.badgeFg;
  ctx.beginPath();
  ctx.moveTo(b.x + 14 * u, cy - tri * 0.6);
  ctx.lineTo(b.x + 14 * u + tri, cy);
  ctx.lineTo(b.x + 14 * u, cy + tri * 0.6);
  ctx.closePath();
  ctx.fill();
  text(ctx, WORDS.replay, b.x + 32 * u, cy, `700 ${PANEL.bandFont * u}px ${theme.font}`, theme.badgeFg);
  if (f.chip > 0) {
    ctx.globalAlpha *= f.chip;
    const cfont = `700 ${(PANEL.bandFont - 2) * u}px ${theme.font}`;
    const s = WORDS.speed(speed);
    const w = measure(ctx, cfont, s) + 14 * u;
    const cb = { x: b.x + b.w - 10 * u - w, y: b.y + 7 * u, w, h: b.h - 14 * u };
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(1, 1.5 * u);
    roundRectPath(ctx, cb, 3 * u);
    ctx.stroke();
    text(ctx, s, cb.x + w / 2, cy, cfont, theme.badgeFg, 'center');
  }
  ctx.restore();
}

/** A red shuttle, cork down, for the card when the camera has no logo. */
function cardShuttle(ctx: Ctx, cx: number, cy: number, size: number, color: string): void {
  const r = size * 0.16;
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.78;
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.85, cy + size * 0.28);
  ctx.lineTo(cx - size * 0.38, cy - size * 0.42);
  ctx.lineTo(cx + size * 0.38, cy - size * 0.42);
  ctx.lineTo(cx + r * 0.85, cy + size * 0.28);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(cx, cy + size * 0.3, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * The BWF-style card: white, rounded, 410×600 at 1080p in the middle of the frame, face on at `amount` 1 and turning on
 * its vertical axis below. It carries the camera's logo when there is one, else a red shuttle, and REPLAY.
 */
export function drawReplayCard(ctx: Ctx, W: number, H: number, amount: number, logo: CanvasImageSource | null, theme: OverlayTheme = DEFAULT_THEME): void {
  if (amount <= 0) return;
  const u = H / 1080;
  const cw = 410 * u;
  const ch = 600 * u;
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(Math.max(0.001, amount), 0.94 + 0.06 * amount);
  const b = { x: -cw / 2, y: -ch / 2, w: cw, h: ch };
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  roundRectPath(ctx, { ...b, x: b.x + 6 * u, y: b.y + 8 * u }, 22 * u);
  ctx.fill();
  const g = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
  g.addColorStop(0, '#FFFFFF');
  g.addColorStop(1, '#ECEDEF');
  ctx.fillStyle = g;
  roundRectPath(ctx, b, 22 * u);
  ctx.fill();
  if (amount < 1) {
    ctx.fillStyle = `rgba(0,0,0,${0.22 * (1 - amount)})`;
    roundRectPath(ctx, b, 22 * u);
    ctx.fill();
  }
  const mark = { x: -120 * u, y: b.y + 70 * u, w: 240 * u, h: 240 * u };
  if (logo) {
    const iw = (logo as { width?: number }).width || 1;
    const ih = (logo as { height?: number }).height || 1;
    const k = Math.min(mark.w / iw, mark.h / ih);
    ctx.drawImage(logo, -(iw * k) / 2, mark.y + (mark.h - ih * k) / 2, iw * k, ih * k);
  } else cardShuttle(ctx, 0, mark.y + mark.h / 2, 220 * u, theme.shuttle);
  ctx.fillStyle = theme.liveTop;
  ctx.fillRect(-150 * u, b.y + 352 * u, 300 * u, 4 * u);
  text(ctx, WORDS.replay, 0, b.y + 430 * u, `800 ${74 * u}px ${theme.font}`, theme.nameFg, 'center');
  ctx.restore();
}

/** A dark plate over what the recording burned in where the panel was, so only the frozen panel shows on the replay. */
export function drawPanelPlate(ctx: Ctx, b: Box, u: number, alpha: number): void {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(19,22,27,0.94)';
  roundRectPath(ctx, { x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 }, PANEL.radius * u);
  ctx.fill();
  ctx.restore();
}
