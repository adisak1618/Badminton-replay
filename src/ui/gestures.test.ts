import { beforeEach, describe, expect, it } from 'vitest';
import { GestureRecognizer } from './gestures';

describe('GestureRecognizer (R-DISP-6)', () => {
  let g: GestureRecognizer;
  beforeEach(() => {
    g = new GestureRecognizer();
  });
  const tap = (t: number, ms = 100, zone: 'left' | 'right' = 'left', id = 1) => {
    g.down(id, 100, 100, t, zone);
    return g.up(id, 102, 101, t + ms);
  };

  it('a short single touch is a point in its zone', () => {
    expect(tap(1000, 100, 'right')).toEqual({ kind: 'point', zone: 'right' });
  });

  it('ignores touches shorter than 30 ms and longer than 400 ms', () => {
    expect(tap(1000, 20)).toBeNull();
    expect(tap(5000, 450)).toBeNull();
    expect(tap(9000, 30)).not.toBeNull();
  });

  it('ignores a second point within 800 ms (double tap scores once)', () => {
    expect(tap(1000)).not.toBeNull();
    expect(tap(1300)).toBeNull();
    expect(tap(1700)).toBeNull(); // released 700 ms after the first point
    expect(tap(2000)).not.toBeNull();
  });

  it('ignores multi-finger touches (palm press)', () => {
    g.down(1, 100, 100, 1000, 'left');
    g.down(2, 300, 120, 1010, 'left');
    expect(g.up(1, 100, 100, 1100)).toBeNull();
    expect(g.up(2, 300, 120, 1110)).toBeNull();
    expect(tap(3000)).not.toBeNull(); // recovers once every finger is up
  });

  it('ignores a touch that moved 24 px or more', () => {
    g.down(1, 100, 100, 1000, 'left');
    g.move(1, 130, 100);
    expect(g.up(1, 101, 100, 1100)).toBeNull();
  });

  it('recognises a swipe down as undo', () => {
    g.down(1, 100, 100, 1000, 'left');
    g.move(1, 102, 160);
    expect(g.up(1, 105, 200, 1300)).toEqual({ kind: 'swipeDown' });
  });

  it('a slow or sideways drag is not a swipe', () => {
    g.down(1, 100, 100, 1000, 'left');
    expect(g.up(1, 100, 200, 1700)).toBeNull();
    g.down(1, 100, 100, 3000, 'left');
    expect(g.up(1, 220, 190, 3200)).toBeNull();
  });

  it('long-press fires after 600 ms with little movement and swallows the release', () => {
    g.down(1, 100, 100, 1000, 'right');
    expect(g.longPress(1, 1500)).toBeNull();
    expect(g.longPress(1, 1600)).toEqual({ kind: 'longPress', zone: 'right' });
    expect(g.up(1, 100, 100, 1700)).toBeNull();
  });

  it('no long-press after movement', () => {
    g.down(1, 100, 100, 1000, 'left');
    g.move(1, 100, 140);
    expect(g.longPress(1, 1600)).toBeNull();
  });

  it('holdOff starts the refractory period', () => {
    g.holdOff(1000);
    expect(tap(1200)).toBeNull();
    expect(tap(2000)).not.toBeNull();
  });

  it('a cancelled pointer scores nothing', () => {
    g.down(1, 100, 100, 1000, 'left');
    g.cancel(1);
    expect(g.up(1, 100, 100, 1100)).toBeNull();
    expect(tap(2000)).not.toBeNull();
  });
});
