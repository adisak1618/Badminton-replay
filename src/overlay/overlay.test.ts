import { describe, expect, it } from 'vitest';
import { reduce } from '../engine';
import { doublesConfig, makeConfig, Match } from '../engine/test-utils';
import { DEFAULT_THEME, drawOverlay, overlayBox, statusText } from './draw';
import { OverlayClock, overlayModel, stateAt } from './model';

const plain = { mirrored: false, stale: false };

describe('overlay model', () => {
  it('maps the scoreboard left team to the left of the box, and flips when mirrored', () => {
    const m = new Match(makeConfig()).rallies('AAB');
    const s = m.state;
    const a = overlayModel(m.cfg, s, plain);
    expect([a.left.team, a.left.score, a.right.team, a.right.score]).toEqual(['A', 2, 'B', 1]);
    expect(a.right.serving).toBe(true);
    expect(a.left.serving).toBe(false);
    const b = overlayModel(m.cfg, s, { mirrored: true, stale: false });
    expect([b.left.team, b.right.team, b.mirrored]).toEqual(['B', 'A', true]);
    expect(b.left.color).toBe(m.cfg.teams.B.color);
  });

  it('follows the ends change after a game', () => {
    const m = new Match(makeConfig()).game(21, 10);
    expect(overlayModel(m.cfg, m.state, plain).left.team).toBe('B');
    expect(overlayModel(m.cfg, m.state, plain).left.games).toBe(0);
    expect(overlayModel(m.cfg, m.state, plain).right.games).toBe(1);
  });

  it('carries game point, match point, interval, game over and final', () => {
    const m = new Match(makeConfig()).scoreTo(20, 15);
    expect(overlayModel(m.cfg, m.state, plain).flag).toEqual({ kind: 'gamePoint', team: 'A' });
    m.point('A').startGame().scoreTo(11, 3);
    const iv = overlayModel(m.cfg, m.state, plain);
    expect(iv.phase).toBe('interval');
    expect(statusText(iv)).toBe('INTERVAL');
    m.endInterval().scoreTo(20, 3);
    expect(overlayModel(m.cfg, m.state, plain).flag).toEqual({ kind: 'matchPoint', team: 'A' });
    m.point('A');
    const fin = overlayModel(m.cfg, m.state, plain);
    expect(fin.phase).toBe('matchOver');
    expect(fin.winner).toBe('A');
    expect(fin.left.serving || fin.right.serving).toBe(false);
    expect(statusText(fin)).toBe('FINAL');
  });

  it('names the doubles server and court (R-SCORE-3 sequence)', () => {
    const m = new Match(doublesConfig()).rallies('AB');
    expect(overlayModel(m.cfg, m.state, plain).server).toEqual({ team: 'B', name: 'Tao', court: 'left' });
  });

  it('marks a stale link above every other status', () => {
    const m = new Match(makeConfig()).scoreTo(20, 15);
    expect(statusText(overlayModel(m.cfg, m.state, { mirrored: false, stale: true }))).toBe('LINK LOST');
  });
});

describe('stateAt and the overlay delay (R-REC-4)', () => {
  // Points one second apart from t = 1_001_000 (match.start), so point n is at 1_001_000 + n * 1000.
  it('replays only events up to the cutoff', () => {
    const m = new Match(makeConfig()).rallies('AAB');
    const t0 = m.events[0].at;
    expect(stateAt(m.cfg, m.events, t0).score).toEqual({ A: 0, B: 0 });
    expect(stateAt(m.cfg, m.events, t0 + 2000).score).toEqual({ A: 2, B: 0 });
    expect(stateAt(m.cfg, m.events, t0 + 1e9)).toEqual(reduce(m.cfg, m.events));
  });

  it('with delay 3 s a point undone after 2 s never shows; with delay 0 it shows for 2 s', () => {
    const m = new Match(makeConfig()).point('A');
    const tap = m.events[1].at;
    m.point('B').undo(); // the B point at tap+1000 is undone at tap+2000
    const wrong = m.events[2].at;
    const undoAt = m.events[3].at;
    expect(undoAt - wrong).toBe(1000);
    const clock = new OverlayClock();
    const at = (now: number, delayMs: number) =>
      clock.at(m.cfg, m.events.filter((e) => e.at <= now), now, { delayMs, offsetMs: 0, mirrored: false, stale: false })!;
    // Delay 0: between the wrong tap and its undo the video shows B 1.
    expect(at(wrong + 500, 0).right.score).toBe(1);
    expect(at(undoAt, 0).right.score).toBe(0);
    // Delay 3 s: by the time the wrong point would show, its undo is known, so B never shows 1.
    for (let now = tap; now < undoAt + 6000; now += 100) expect(at(now, 3000).right.score).toBe(0);
    expect(at(tap + 2900, 3000).left.score).toBe(0);
    expect(at(tap + 3000, 3000).left.score).toBe(1);
  });

  it('applies the clock offset (camera minus scoreboard)', () => {
    const m = new Match(makeConfig()).point('A');
    const at = m.events[1].at;
    const c = new OverlayClock();
    const o = { delayMs: 0, offsetMs: 500, mirrored: false, stale: false };
    expect(c.at(m.cfg, m.events, at + 499, o)!.left.score).toBe(0);
    expect(c.at(m.cfg, m.events, at + 500, o)!.left.score).toBe(1);
  });

  it('draws nothing without a match and memoises per visible slice', () => {
    const c = new OverlayClock();
    expect(c.at(null, [], 0, { delayMs: 0, offsetMs: 0, mirrored: false, stale: false })).toBeNull();
    const m = new Match(makeConfig()).point('A');
    const o = { delayMs: 0, offsetMs: 0, mirrored: false, stale: false };
    const a = c.at(m.cfg, m.events, m.events[1].at + 10, o);
    expect(c.at(m.cfg, m.events, m.events[1].at + 20, o)).toBe(a);
    expect(c.at(m.cfg, m.events, m.events[1].at + 20, { ...o, mirrored: true })).not.toBe(a);
  });
});

/** A recording stand-in for CanvasRenderingContext2D: text is 0.6 em per character. */
function fakeCtx() {
  const calls: Array<{ op: string; args: unknown[]; fill: string; font: string }> = [];
  const ctx = {
    fillStyle: '',
    globalAlpha: 1,
    font: '10px x',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    measureText(t: string) {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10);
      return { width: t.length * px * 0.6 };
    },
  } as Record<string, unknown> & { fillStyle: string; font: string };
  for (const op of ['save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'closePath', 'fill', 'clip', 'fillRect', 'fillText'])
    ctx[op] = (...args: unknown[]) => calls.push({ op, args, fill: ctx.fillStyle, font: ctx.font });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('drawOverlay', () => {
  const box = overlayBox(1920, 1080);

  it('uses a fixed box at the bottom-left of the frame', () => {
    expect(box).toEqual({ x: 48, y: 960, w: 806, h: 72 });
    expect(overlayBox(1280, 720)).toEqual({ x: 32, y: 640, w: 538, h: 48 });
  });

  it('draws names on team colours, both scores and the game count, all inside the box', () => {
    const m = new Match(makeConfig()).rallies('AAB');
    const { ctx, calls } = fakeCtx();
    drawOverlay(ctx, overlayModel(m.cfg, m.state, plain), box);
    const texts = calls.filter((c) => c.op === 'fillText').map((c) => c.args[0]);
    expect(texts).toEqual(['A', '2', '1', 'B', 'G1  0-0']);
    const rects = calls.filter((c) => c.op === 'fillRect');
    expect(rects.some((r) => r.fill === m.cfg.teams.A.color)).toBe(true);
    expect(rects.some((r) => r.fill === m.cfg.teams.B.color)).toBe(true);
    for (const r of rects) {
      const [x, y, w, h] = r.args as number[];
      expect(x).toBeGreaterThanOrEqual(box.x - 0.001);
      expect(y).toBeGreaterThanOrEqual(box.y - 0.001);
      expect(x + w).toBeLessThanOrEqual(box.x + box.w + 0.001);
      expect(y + h).toBeLessThanOrEqual(box.y + box.h + 0.001);
    }
    for (const t of calls.filter((c) => c.op === 'fillText')) {
      const x = t.args[1] as number;
      expect(x).toBeGreaterThanOrEqual(box.x);
      expect(x).toBeLessThanOrEqual(box.x + box.w);
    }
    expect(calls[0].op).toBe('save');
    expect(calls[calls.length - 1].op).toBe('restore');
  });

  it('shrinks then ellipsises a long name to fit its cell', () => {
    const cfg = makeConfig({
      teams: {
        A: { name: 'Supercalifragilistic Badminton Club', color: 0, players: ['', ''], startRight: 0 },
        B: { name: 'B', color: 1, players: ['', ''], startRight: 0 },
      },
    });
    const { ctx, calls } = fakeCtx();
    drawOverlay(ctx, overlayModel(cfg, reduce(cfg, new Match(cfg).events), plain), box);
    const name = calls.find((c) => c.op === 'fillText')!;
    expect(String(name.args[0]).endsWith('…')).toBe(true);
    const px = Number(/(\d+)px/.exec(name.font)![1]);
    expect(String(name.args[0]).length * px * 0.6).toBeLessThanOrEqual(0.27 * box.w);
  });

  it('draws the shuttle only for the serving side and a status line when there is one', () => {
    const m = new Match(makeConfig()).scoreTo(20, 15);
    const { ctx, calls } = fakeCtx();
    drawOverlay(ctx, overlayModel(m.cfg, m.state, plain), box, DEFAULT_THEME);
    expect(calls.filter((c) => c.op === 'arc')).toHaveLength(1);
    const status = calls.filter((c) => c.op === 'fillText').pop()!;
    expect(status.args[0]).toBe('GAME POINT');
    expect(status.fill).toBe(DEFAULT_THEME.flagFg);
  });
});
