import { describe, expect, it } from 'vitest';
import { reduce } from '../engine';
import { doublesConfig, makeConfig, Match } from '../engine/test-utils';
import { DEFAULT_THEME, drawLogo, drawOverlay, statusText } from './draw';
import { inset, overlayLayout, scorePanelSize, type Corner } from './layout';
import { OverlayClock, overlayModel, playersLabel, stateAt } from './model';

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
  for (const op of ['save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'closePath', 'fill', 'clip', 'fillRect', 'fillText', 'drawImage'])
    ctx[op] = (...args: unknown[]) => calls.push({ op, args, fill: ctx.fillStyle, font: ctx.font });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('players on the panel (round 2)', () => {
  it('doubles shows NAME1 / NAME2 in capitals, singles the one name', () => {
    const d = doublesConfig();
    expect(playersLabel(d, 'A')).toBe('NOK / PAE');
    expect(playersLabel(d, 'B')).toBe('BANK / TAO');
    const sg = makeConfig({
      teams: {
        A: { name: 'Adisak', color: 0, players: ['', ''], startRight: 0 },
        B: { name: 'Nut', color: 1, players: ['', ''], startRight: 0 },
      },
    });
    expect(playersLabel(sg, 'A')).toBe('ADISAK');
    expect(overlayModel(sg, reduce(sg, new Match(sg).events), plain).right.players).toBe('NUT');
  });

  it('falls back to the team name when doubles names were left blank', () => {
    const d = makeConfig({
      doubles: true,
      teams: {
        A: { name: 'Club', color: 0, players: ['', ''], startRight: 0 },
        B: { name: 'B', color: 1, players: ['Bank', ''], startRight: 0 },
      },
    });
    expect(playersLabel(d, 'A')).toBe('CLUB');
    expect(playersLabel(d, 'B')).toBe('B');
  });
});

describe('overlay layout: corners, inset, logo (round 2)', () => {
  const sizes = [
    [1920, 1080],
    [1280, 720],
  ] as const;

  it('puts the score panel top-left by default, inset by the same fraction at 1080p and 720p', () => {
    expect(overlayLayout(1920, 1080, { scoreCorner: 'tl', logo: null })).toEqual({ score: { x: 43, y: 43, w: 768, h: 160 }, logo: null });
    expect(overlayLayout(1280, 720, { scoreCorner: 'tl', logo: null }).score).toEqual({ x: 29, y: 29, w: 512, h: 107 });
    for (const [, H] of sizes) expect(inset(H) / H).toBeCloseTo(0.04, 2);
  });

  it('places the panel in each of the four corners, inside the frame', () => {
    for (const [W, H] of sizes) {
      const m = inset(H);
      const { w, h } = scorePanelSize(H);
      const at = (c: Corner) => overlayLayout(W, H, { scoreCorner: c, logo: null }).score;
      expect(at('tl')).toMatchObject({ x: m, y: m });
      expect(at('tr')).toMatchObject({ x: W - m - w, y: m });
      expect(at('bl')).toMatchObject({ x: m, y: H - m - h });
      expect(at('br')).toMatchObject({ x: W - m - w, y: H - m - h });
    }
  });

  it('logo top-right by size, keeping its aspect; a very wide logo is capped', () => {
    const l = overlayLayout(1920, 1080, { scoreCorner: 'tl', logo: { corner: 'tr', size: 'medium', aspect: 2 } }).logo!;
    expect(l).toEqual({ x: 1920 - 43 - 260, y: 43, w: 260, h: 130 });
    const small = overlayLayout(1920, 1080, { scoreCorner: 'tl', logo: { corner: 'tr', size: 'small', aspect: 1 } }).logo!;
    const large = overlayLayout(1920, 1080, { scoreCorner: 'tl', logo: { corner: 'tr', size: 'large', aspect: 1 } }).logo!;
    expect(small.h).toBeLessThan(l.h);
    expect(large.h).toBeGreaterThan(l.h);
    const wide = overlayLayout(1920, 1080, { scoreCorner: 'tl', logo: { corner: 'br', size: 'large', aspect: 10 } }).logo!;
    expect(wide.w).toBe(576);
    expect(wide.h).toBe(58);
    expect(wide.x + wide.w).toBe(1920 - 43);
    expect(wide.y + wide.h).toBe(1080 - 43);
  });

  it('stacks the logo under (top) or over (bottom) the panel when both share a corner', () => {
    for (const [W, H] of sizes)
      for (const c of ['tl', 'tr', 'bl', 'br'] as const) {
        const { score, logo } = overlayLayout(W, H, { scoreCorner: c, logo: { corner: c, size: 'medium', aspect: 1.5 } });
        const overlap = logo!.x < score.x + score.w && score.x < logo!.x + logo!.w && logo!.y < score.y + score.h && score.y < logo!.y + logo!.h;
        expect(overlap).toBe(false);
        if (c[0] === 't') expect(logo!.y).toBeGreaterThan(score.y + score.h);
        else expect(logo!.y + logo!.h).toBeLessThan(score.y);
        // Same edge as the panel.
        if (c[1] === 'l') expect(logo!.x).toBe(score.x);
        else expect(logo!.x + logo!.w).toBe(score.x + score.w);
        expect(logo!.y).toBeGreaterThanOrEqual(0);
        expect(logo!.y + logo!.h).toBeLessThanOrEqual(H);
      }
  });

  it('no logo box without a usable image', () => {
    expect(overlayLayout(1920, 1080, { scoreCorner: 'tl', logo: { corner: 'tr', size: 'small', aspect: 0 } }).logo).toBeNull();
  });
});

describe('drawOverlay', () => {
  const box = overlayLayout(1920, 1080, { scoreCorner: 'tl', logo: null }).score;
  const inBox = (b: typeof box, calls: ReturnType<typeof fakeCtx>['calls']) => {
    for (const r of calls.filter((c) => c.op === 'fillRect')) {
      const [x, y, w, h] = r.args as number[];
      expect(x).toBeGreaterThanOrEqual(b.x - 0.001);
      expect(y).toBeGreaterThanOrEqual(b.y - 0.001);
      expect(x + w).toBeLessThanOrEqual(b.x + b.w + 0.001);
      expect(y + h).toBeLessThanOrEqual(b.y + b.h + 0.001);
    }
    for (const t of calls.filter((c) => c.op === 'fillText')) {
      const [, x, y] = t.args as number[];
      expect(x).toBeGreaterThanOrEqual(b.x);
      expect(x).toBeLessThanOrEqual(b.x + b.w);
      expect(y).toBeGreaterThanOrEqual(b.y);
      expect(y).toBeLessThanOrEqual(b.y + b.h);
    }
  };

  it('two rows: players in capitals, games and score per team, the game in the footer, all inside the box', () => {
    const m = new Match(doublesConfig()).rallies('AAB');
    const { ctx, calls } = fakeCtx();
    drawOverlay(ctx, overlayModel(m.cfg, m.state, plain), box);
    const texts = calls.filter((c) => c.op === 'fillText').map((c) => c.args[0]);
    expect(texts).toEqual(['2', '0', 'NOK / PAE', '1', '0', 'BANK / TAO', 'GAME 1']);
    const rects = calls.filter((c) => c.op === 'fillRect');
    expect(rects.some((r) => r.fill === m.cfg.teams.A.color)).toBe(true); // team accents
    expect(rects.some((r) => r.fill === m.cfg.teams.B.color)).toBe(true);
    inBox(box, calls);
    expect(calls[0].op).toBe('save');
    expect(calls[calls.length - 1].op).toBe('restore');
  });

  it('fits two 14-letter doubles names at 1080p and 720p, and ellipsises longer ones', () => {
    const named = (a: string, b: string) =>
      makeConfig({
        doubles: true,
        teams: {
          A: { name: 'A', color: 0, players: [a, b], startRight: 0 },
          B: { name: 'B', color: 1, players: ['Bank', 'Tao'], startRight: 0 },
        },
      });
    for (const H of [1080, 720]) {
      const b = overlayLayout((H * 16) / 9, H, { scoreCorner: 'tl', logo: null }).score;
      const fits = named('Chaiyakulsiri', 'Wongsuwanchai');
      const { ctx, calls } = fakeCtx();
      drawOverlay(ctx, overlayModel(fits, reduce(fits, new Match(fits).events), plain), b);
      expect(calls.find((c) => c.op === 'fillText' && String(c.args[0]).includes('/'))!.args[0]).toBe('CHAIYAKULSIRI / WONGSUWANCHAI');
      inBox(b, calls);
      const long = named('Supercalifragilisticexpialidocious', 'Pneumonoultramicroscopicsilicovolcano');
      const r = fakeCtx();
      drawOverlay(r.ctx, overlayModel(long, reduce(long, new Match(long).events), plain), b);
      const t = r.calls.find((c) => c.op === 'fillText' && String(c.args[0]).startsWith('SUPER'))!;
      expect(String(t.args[0]).endsWith('…')).toBe(true);
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(t.font)![1]);
      expect(String(t.args[0]).length * px * 0.6).toBeLessThanOrEqual(b.w);
    }
  });

  it('draws the shuttle only beside the serving team, with flag underline and status', () => {
    const m = new Match(makeConfig()).scoreTo(20, 15);
    const { ctx, calls } = fakeCtx();
    drawOverlay(ctx, overlayModel(m.cfg, m.state, plain), box, DEFAULT_THEME);
    expect(calls.filter((c) => c.op === 'arc')).toHaveLength(1);
    const status = calls.filter((c) => c.op === 'fillText').pop()!;
    expect(status.args[0]).toBe('GAME POINT');
    expect(status.fill).toBe(DEFAULT_THEME.flagFg);
    expect(calls.some((c) => c.op === 'fillRect' && c.fill === DEFAULT_THEME.flagFg)).toBe(true);
  });

  it('the mirrored panel puts the other team on top', () => {
    const m = new Match(doublesConfig());
    const { ctx, calls } = fakeCtx();
    drawOverlay(ctx, overlayModel(m.cfg, m.state, { mirrored: true, stale: false }), box);
    expect(calls.filter((c) => c.op === 'fillText').map((c) => c.args[0])[2]).toBe('BANK / TAO');
  });

  it('draws a logo into its box', () => {
    const { ctx, calls } = fakeCtx();
    const img = {} as CanvasImageSource;
    drawLogo(ctx, img, { x: 1, y: 2, w: 3, h: 4 });
    expect(calls).toEqual([expect.objectContaining({ op: 'drawImage', args: [img, 1, 2, 3, 4] })]);
  });
});
