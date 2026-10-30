// Overlay animation (broadcast design): every movement is a pure function of the frame's scoreboard time `now` (the
// overlay cutoff) and the time of the event that started it, never of the wall clock or a frame count. The same log
// and the same `now` give the same frame, live on the camera and in a later re-render, at any overlay delay.

/** C1 "Motion": the full set, a light one for a slow phone, or none (the countdown digits are data and always show). */
export type Motion = 'full' | 'light' | 'none';
export const MOTIONS: readonly Motion[] = ['full', 'light', 'none'];
export const DEFAULT_MOTION: Motion = 'full';

/** Durations in ms; 0 is off. */
export interface MotionTimes {
  tick: number; // the live score digit rolls up
  flash: number; // the live cell lights up and fades
  serve: number; // the shuttle fades in on the new server's row
  bandIn: number; // a status badge wipes in from the corner side
  shine: number; // one light sweep across a badge as it arrives
  pulse: number; // match point: one brightness cycle
  col: number; // a game just finished: its cell lights up, digits rise
  cell: number; // a table count went up: the cell flashes
  pop: number; // and its digit pops
  cardIn: number; // the end-of-game card fades in and rises
  stagger: number; // per card row
  bars: number; // the card's proportion bars grow
  cardOut: number; // the card fades out after ปิดสรุป
}

export const MOTION: Record<Motion, MotionTimes> = {
  full: { tick: 420, flash: 650, serve: 280, bandIn: 360, shine: 900, pulse: 1600, col: 500, cell: 1800, pop: 320, cardIn: 520, stagger: 45, bars: 700, cardOut: 300 },
  light: { tick: 0, flash: 450, serve: 0, bandIn: 240, shine: 0, pulse: 0, col: 0, cell: 1200, pop: 0, cardIn: 300, stagger: 0, bars: 0, cardOut: 0 },
  none: { tick: 0, flash: 0, serve: 0, bandIn: 0, shine: 0, pulse: 0, col: 0, cell: 0, pop: 0, cardIn: 0, stagger: 0, bars: 0, cardOut: 0 },
};

/** What a draw call needs to animate: the frame's scoreboard time and the set. Without `now` nothing moves. */
export interface DrawClock {
  now?: number;
  motion?: Motion;
}

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Progress 0..1 of a `dur` ms animation that started at `at`; with no clock, no trigger or no duration it is done. */
export const progress = (now: number | undefined, at: number | null | undefined, dur: number): number =>
  now == null || at == null || !dur ? 1 : clamp01((now - at) / dur);
