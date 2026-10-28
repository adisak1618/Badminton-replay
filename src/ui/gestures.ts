// Touch handling on the tap zones (ux-design.md §3, R-DISP-6), as a pure recognizer fed by Pointer Events.
//  - point: one pointer, down-to-up in 30 to 400 ms, moved less than 24 px, no other pointer active,
//    at least 800 ms after the previous point;
//  - long-press: 600 ms or more with little movement (opens the correction sheet);
//  - swipe down: 80 px or more within 500 ms (Undo).

export type Zone = 'left' | 'right';
export type Gesture = { kind: 'point'; zone: Zone } | { kind: 'longPress'; zone: Zone } | { kind: 'swipeDown' };

export const GESTURE = {
  tapMinMs: 30,
  tapMaxMs: 400,
  moveMaxPx: 24,
  refractoryMs: 800,
  longPressMs: 600,
  swipeMinPx: 80,
  swipeMaxMs: 500,
} as const;

interface Track {
  id: number;
  zone: Zone;
  x: number;
  y: number;
  t: number;
  maxDist: number;
}

export class GestureRecognizer {
  private active = new Set<number>();
  private track: Track | null = null;
  private voided = false; // a second finger joined: nothing counts until every finger is up
  private lastPointAt = -Infinity;

  down(id: number, x: number, y: number, t: number, zone: Zone): void {
    this.active.add(id);
    if (this.active.size > 1) {
      this.track = null;
      this.voided = true;
      return;
    }
    this.voided = false;
    this.track = { id, zone, x, y, t, maxDist: 0 };
  }

  move(id: number, x: number, y: number): void {
    const tr = this.track;
    if (!tr || tr.id !== id) return;
    tr.maxDist = Math.max(tr.maxDist, Math.hypot(x - tr.x, y - tr.y));
  }

  /** Call when the long-press timer fires; returns the long-press if the touch still qualifies. */
  longPress(id: number, t: number): Gesture | null {
    const tr = this.track;
    if (!tr || tr.id !== id || this.voided) return null;
    if (t - tr.t < GESTURE.longPressMs || tr.maxDist >= GESTURE.moveMaxPx) return null;
    this.track = null; // consumed: the release does nothing
    return { kind: 'longPress', zone: tr.zone };
  }

  up(id: number, x: number, y: number, t: number): Gesture | null {
    this.active.delete(id);
    const tr = this.track;
    if (!tr || tr.id !== id || this.voided) {
      if (this.active.size === 0) this.voided = false;
      return null;
    }
    this.track = null;
    const dt = t - tr.t;
    const dx = x - tr.x;
    const dy = y - tr.y;
    const dist = Math.max(tr.maxDist, Math.hypot(dx, dy));
    if (dy >= GESTURE.swipeMinPx && dt <= GESTURE.swipeMaxMs && Math.abs(dx) < dy) return { kind: 'swipeDown' };
    if (dt < GESTURE.tapMinMs || dt > GESTURE.tapMaxMs || dist >= GESTURE.moveMaxPx) return null;
    if (t - this.lastPointAt < GESTURE.refractoryMs) return null;
    this.lastPointAt = t;
    return { kind: 'point', zone: tr.zone };
  }

  cancel(id: number): void {
    this.active.delete(id);
    if (this.track?.id === id) this.track = null;
    if (this.active.size === 0) this.voided = false;
  }

  /** Start the refractory period without a point, e.g. when a tap dismissed the interval overlay. */
  holdOff(t: number): void {
    this.lastPointAt = t;
  }
}
