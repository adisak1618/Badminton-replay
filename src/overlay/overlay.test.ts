import { describe, expect, it } from 'vitest';
import { reduce } from '../engine';
import { doublesConfig, makeConfig, Match } from '../engine/test-utils';
import { bandText, DEFAULT_THEME, drawLogo, drawOverlay, PANEL, panelMaxHeight, panelSize } from './draw';
import { inset, overlayLayout, panelScale, type Corner } from './layout';
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
    expect(bandText(iv)).toBe('Interval');
    m.endInterval().scoreTo(20, 3);
    expect(overlayModel(m.cfg, m.state, plain).flag).toEqual({ kind: 'matchPoint', team: 'A' });
    m.point('A');
    const fin = overlayModel(m.cfg, m.state, plain);
    expect(fin.phase).toBe('matchOver');
    expect(fin.winner).toBe('A');
    expect(fin.left.serving || fin.right.serving).toBe(false);
    expect(bandText(fin)).toBe('Match');
  });

  it('names the doubles server and court (R-SCORE-3 sequence)', () => {
    const m = new Match(doublesConfig()).rallies('AB');
    expect(overlayModel(m.cfg, m.state, plain).server).toEqual({ team: 'B', name: 'Tao', court: 'left' });
  });

  it('marks a stale link above every other status', () => {
    const m = new Match(makeConfig()).scoreTo(20, 15);
    expect(bandText(overlayModel(m.cfg, m.state, { mirrored: false, stale: true }))).toBe('Link lost');
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

describe('overlay layout: corners, inset, logo', () => {
  const sizes = [
    [1920, 1080],
    [1280, 720],
  ] as const;
  const panel = { w: 500, h: 132 };
  const lay = (W: number, H: number, o: Partial<Parameters<typeof overlayLayout>[2]> = {}) =>
    overlayLayout(W, H, { scoreCorner: 'tl', score: panel, scoreMaxH: 186, logo: null, ...o });

  it('puts the score panel top-left by default, inset by the same fraction at 1080p and 720p', () => {
    expect(lay(1920, 1080)).toEqual({ score: { x: 43, y: 43, w: 500, h: 132 }, logo: null, table: null });
    expect(lay(1280, 720).score).toMatchObject({ x: 29, y: 29 });
    for (const [, H] of sizes) expect(inset(H) / H).toBeCloseTo(0.04, 2);
  });

  it('places the panel in each of the four corners, inside the frame', () => {
    for (const [W, H] of sizes) {
      const m = inset(H);
      const at = (c: Corner) => lay(W, H, { scoreCorner: c }).score!;
      expect(at('tl')).toMatchObject({ x: m, y: m });
      expect(at('tr')).toMatchObject({ x: W - m - panel.w, y: m });
      expect(at('bl')).toMatchObject({ x: m, y: H - m - panel.h });
      expect(at('br')).toMatchObject({ x: W - m - panel.w, y: H - m - panel.h });
    }
  });

  it('logo top-right by size, keeping its aspect; a very wide logo is capped', () => {
    const l = lay(1920, 1080, { logo: { corner: 'tr', size: 'medium', aspect: 2 } }).logo!;
    expect(l).toEqual({ x: 1920 - 43 - 260, y: 43, w: 260, h: 130 });
    const small = lay(1920, 1080, { logo: { corner: 'tr', size: 'small', aspect: 1 } }).logo!;
    const large = lay(1920, 1080, { logo: { corner: 'tr', size: 'large', aspect: 1 } }).logo!;
    expect(small.h).toBeLessThan(l.h);
    expect(large.h).toBeGreaterThan(l.h);
    const wide = lay(1920, 1080, { logo: { corner: 'br', size: 'large', aspect: 10 } }).logo!;
    expect(wide).toEqual({ x: 1920 - 43 - 576, y: 1080 - 43 - 58, w: 576, h: 58 });
  });

  it('stacks the logo past the tallest panel (band included) when both share a corner, so it never jumps', () => {
    for (const [W, H] of sizes)
      for (const c of ['tl', 'tr', 'bl', 'br'] as const) {
        const { score, logo } = lay(W, H, { scoreCorner: c, logo: { corner: c, size: 'medium', aspect: 1.5 } });
        if (c[0] === 't') expect(logo!.y).toBeGreaterThan(score!.y + 186);
        else expect(logo!.y + logo!.h).toBeLessThan(score!.y + score!.h - 186);
        if (c[1] === 'l') expect(logo!.x).toBe(score!.x);
        else expect(logo!.x + logo!.w).toBe(score!.x + score!.w);
        // The same logo box whatever the panel's current height.
        expect(lay(W, H, { scoreCorner: c, score: { w: 300, h: 80 }, logo: { corner: c, size: 'medium', aspect: 1.5 } }).logo).toEqual(logo);
      }
  });

  it('logo alone when there is no score to show; no logo box without a usable image', () => {
    expect(lay(1920, 1080, { score: null, logo: { corner: 'tl', size: 'small', aspect: 1 } })).toEqual({ score: null, logo: { x: 43, y: 43, w: 86, h: 86 }, table: null });
    expect(lay(1920, 1080, { logo: { corner: 'tr', size: 'small', aspect: 0 } }).logo).toBeNull();
  });
});

describe('game columns (round 3)', () => {
  it('one live column in game 1, then finished games with their winner, the live game last', () => {
    const m = new Match(makeConfig()).rallies('AAB');
    expect(overlayModel(m.cfg, m.state, plain).games).toEqual([{ left: 2, right: 1, winner: null, live: true }]);
    m.game(21, 15).game(17, 21).scoreTo(5, 3);
    // Game 3: A is on the left again (ends changed after games 1 and 2).
    expect(overlayModel(m.cfg, m.state, plain).games).toEqual([
      { left: 21, right: 15, winner: 'left', live: false },
      { left: 17, right: 21, winner: 'right', live: false },
      { left: 5, right: 3, winner: null, live: true },
    ]);
  });

  it('no live column between games or after the match; fixed 2 and fixed 1 give 2 and 1 columns', () => {
    const g = new Match(makeConfig()).game(21, 15, { start: false });
    expect(overlayModel(g.cfg, g.state, plain).games).toHaveLength(1);
    expect(overlayModel(g.cfg, g.state, plain).games[0].live).toBe(false);
    const f2 = new Match(makeConfig({ format: 'fixed2' })).game(21, 15).game(15, 21);
    const d = overlayModel(f2.cfg, f2.state, plain);
    expect(d.phase).toBe('matchOver');
    expect(d.games.map((x) => x.live)).toEqual([false, false]);
    expect(bandText(d)).toBe('Draw');
    const f1 = new Match(makeConfig({ format: 'fixed1' })).game(21, 3);
    expect(overlayModel(f1.cfg, f1.state, plain).games).toHaveLength(1);
  });

  it('mirroring swaps the points in every column', () => {
    const m = new Match(makeConfig()).game(21, 15).point('A');
    expect(overlayModel(m.cfg, m.state, { mirrored: true, stale: false }).games).toEqual([
      { left: 21, right: 15, winner: 'left', live: false },
      { left: 1, right: 0, winner: null, live: true },
    ]);
  });
});

describe('drawOverlay: BWF TV panel (round 4)', () => {
  const U = 1; // 1080p, size M
  const at = (b: { x: number; y: number }, m: Match, opts = plain, u = U) => {
    const model = overlayModel(m.cfg, m.state, opts);
    const r = fakeCtx();
    const size = panelSize(r.ctx, model, u);
    const box = { x: b.x, y: b.y, ...size };
    const d = fakeCtx();
    drawOverlay(d.ctx, model, box, u);
    const texts = d.calls.filter((c) => c.op === 'fillText');
    return { box, model, calls: d.calls, texts, words: texts.map((t) => String(t.args[0])) };
  };
  const origin = { x: 43, y: 43 };
  const inBox = (box: { x: number; y: number; w: number; h: number }, calls: ReturnType<typeof fakeCtx>['calls']) => {
    for (const r of calls.filter((c) => c.op === 'fillRect' || c.op === 'fillText')) {
      const [x, y] = (r.op === 'fillRect' ? r.args : r.args.slice(1)) as number[];
      expect(x).toBeGreaterThanOrEqual(box.x - 0.001);
      expect(x).toBeLessThanOrEqual(box.x + box.w + 0.001);
      expect(y).toBeGreaterThanOrEqual(box.y - 0.001);
      expect(y).toBeLessThanOrEqual(box.y + box.h + 0.001);
    }
  };
  const named = (a: string, b: string) =>
    makeConfig({
      doubles: true,
      teams: {
        A: { name: 'A', color: 0, players: [a, b], startRight: 0 },
        B: { name: 'B', color: 1, players: ['Bank', 'Tao'], startRight: 0 },
      },
    });

  it('is only as wide as its names: short names make a small panel, longer ones a wider one, capped', () => {
    const short = at(origin, new Match(named('Goh', 'Izz')).point('A'));
    const long = at(origin, new Match(named('Chaiyakulsiri', 'Wongsuwanchai')).point('A'));
    const huge = at(origin, new Match(named('Supercalifragilisticexpialidocious', 'Pneumonoultramicroscopic')).point('A'));
    expect(short.box.w).toBeLessThan(long.box.w);
    expect(long.box.w).toBeLessThan(huge.box.w);
    // Width = padding + name slot + shuttle slot + one cell per game; the name slot stops at the cap.
    const fixed = 2 * PANEL.edge + PANEL.namePadL + PANEL.nameGap + PANEL.shuttle + PANEL.namePadR + PANEL.cellGap + PANEL.cell;
    expect(huge.box.w).toBe(fixed + PANEL.nameMax);
    expect(huge.words.find((w) => w.startsWith('SUPER'))!.endsWith('…')).toBe(true);
    expect(long.words).toContain('CHAIYAKULSIRI / WONGSUWANCHAI');
  });

  it('keeps padding between the name and the first score cell', () => {
    const { texts, calls } = at(origin, new Match(named('Chaiyakulsiri', 'Wongsuwanchai')).point('B'));
    const name = texts.find((t) => String(t.args[0]).startsWith('CHAI'))!;
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(name.font)![1]);
    const nameEnd = (name.args[1] as number) + String(name.args[0]).length * px * 0.6;
    const score = texts.find((t) => t.args[0] === '0')!; // A's live score, centred in the first cell
    const cellLeft = (score.args[1] as number) - PANEL.cell / 2;
    expect(cellLeft - nameEnd).toBeGreaterThanOrEqual(PANEL.nameGap + PANEL.shuttle + PANEL.namePadR + PANEL.cellGap - 1);
    inBox(at(origin, new Match(named('Chaiyakulsiri', 'Wongsuwanchai')).point('B')).box, calls);
  });

  it('cells run in game order: finished games white with dark digits, the live game grey with white, at the right end', () => {
    const m = new Match(makeConfig()).game(21, 15).game(17, 21).scoreTo(5, 3);
    const { words, texts, calls, box } = at(origin, m);
    expect(words).toEqual(['A', '21', '17', '5', 'B', '15', '21', '3']);
    const D = DEFAULT_THEME;
    expect(texts.filter((t) => /^\d+$/.test(String(t.args[0]))).map((t) => t.fill)).toEqual([D.doneFg, D.doneFg, D.liveFg, D.doneFg, D.doneFg, D.liveFg]);
    const cellFills = calls.filter((c) => c.op === 'fill' && (c.fill === D.doneBg || c.fill === D.liveBg)).map((c) => c.fill);
    expect(cellFills).toEqual([D.doneBg, D.doneBg, D.liveBg, D.doneBg, D.doneBg, D.liveBg]);
    const xs = texts.filter((t) => /^\d+$/.test(String(t.args[0]))).slice(0, 3).map((t) => t.args[1] as number);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    expect(xs[2] + PANEL.cell / 2).toBeLessThanOrEqual(box.x + box.w - PANEL.edge + 0.001);
    inBox(box, calls);
  });

  it('a new game adds a cell and widens the panel', () => {
    const m = new Match(makeConfig()).point('A');
    const one = at(origin, m).box.w;
    m.game(21, 15).point('B');
    expect(at(origin, m).box.w).toBe(one + PANEL.cell + PANEL.cellGap);
  });

  it('the status band shows while a state applies, and the panel is taller only then', () => {
    const rows = 2 * PANEL.edge + 2 * PANEL.row + PANEL.rowGap;
    const withBand = rows + PANEL.bandGap + PANEL.band;
    const band = (m: Match, opts = plain) => {
      const r = at(origin, m, opts);
      return { h: r.box.h, text: r.words[r.words.length - 1] };
    };
    expect(band(new Match(makeConfig()).scoreTo(5, 3)).h).toBe(rows);
    expect(band(new Match(makeConfig()).scoreTo(20, 13))).toEqual({ h: withBand, text: 'Game Point' });
    expect(band(new Match(makeConfig()).game(21, 10).scoreTo(20, 4))).toEqual({ h: withBand, text: 'Match Point' });
    expect(band(new Match(makeConfig()).scoreTo(11, 4))).toEqual({ h: withBand, text: 'Interval' });
    expect(band(new Match(makeConfig()).game(21, 10, { start: false }))).toEqual({ h: withBand, text: 'Game' });
    expect(band(new Match(makeConfig()).game(21, 10).game(21, 12))).toEqual({ h: withBand, text: 'Match' });
    expect(band(new Match(makeConfig({ format: 'fixed2' })).game(21, 15).game(15, 21))).toEqual({ h: withBand, text: 'Draw' });
    expect(band(new Match(makeConfig()).scoreTo(5, 3), { mirrored: false, stale: true })).toEqual({ h: withBand, text: 'Link lost' });
    expect(panelMaxHeight(1)).toBe(withBand);
  });

  it('a small grey shuttle at the end of the serving team name cell only', () => {
    const { calls } = at(origin, new Match(makeConfig()).point('B'));
    expect(calls.filter((c) => c.op === 'arc')).toHaveLength(1);
    expect(calls.find((c) => c.op === 'arc')!.fill).toBe(DEFAULT_THEME.shuttle);
  });

  it('sizes S, M and L scale the whole panel', () => {
    const m = new Match(named('Chaiyakulsiri', 'Wongsuwanchai')).game(21, 15).scoreTo(20, 13);
    const [s, md, l] = (['small', 'medium', 'large'] as const).map((z) => at(origin, m, plain, panelScale(1080, z)).box);
    expect(s.w).toBeLessThan(md.w);
    expect(md.w).toBeLessThan(l.w);
    expect(l.h / md.h).toBeCloseTo(1.25, 1);
    expect(at(origin, m, plain, panelScale(720, 'medium')).box.h).toBe(Math.round(md.h * (720 / 1080)));
  });

  it('the mirrored panel puts the other team on top', () => {
    const { words } = at(origin, new Match(doublesConfig()).point('A'), { mirrored: true, stale: false });
    expect(words[0]).toBe('BANK / TAO');
  });

  it('draws a logo into its box', () => {
    const { ctx, calls } = fakeCtx();
    const img = {} as CanvasImageSource;
    drawLogo(ctx, img, { x: 1, y: 2, w: 3, h: 4 });
    expect(calls).toEqual([expect.objectContaining({ op: 'drawImage', args: [img, 1, 2, 3, 4] })]);
  });
});
