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
    expect(overlayLayout(1920, 1080, { scoreCorner: 'tl', logo: null })).toEqual({ score: { x: 43, y: 43, w: 840, h: 122 }, logo: null });
    expect(overlayLayout(1280, 720, { scoreCorner: 'tl', logo: null }).score).toEqual({ x: 29, y: 29, w: 560, h: 81 });
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
    expect(statusText(d)).toBe('DRAW');
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
  const draw = (m: Match, b = box, opts = plain) => {
    const r = fakeCtx();
    drawOverlay(r.ctx, overlayModel(m.cfg, m.state, opts), b);
    return { ...r, texts: r.calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0])) };
  };
  const dividers = (calls: ReturnType<typeof fakeCtx>['calls']) => calls.filter((c) => c.op === 'fillRect' && c.fill === DEFAULT_THEME.divider).length;

  it('game 1: two rows, players in capitals and the live score, no footer text, all inside the box', () => {
    const m = new Match(doublesConfig()).rallies('AAB');
    const { calls, texts } = draw(m);
    expect(texts).toEqual(['2', 'NOK / PAE', '1', 'BANK / TAO']);
    expect(texts.some((t) => t.startsWith('GAME'))).toBe(false);
    expect(calls.some((c) => c.op === 'fillRect' && c.fill === m.cfg.teams.A.color)).toBe(true); // team accents
    expect(calls.some((c) => c.op === 'fillRect' && c.fill === m.cfg.teams.B.color)).toBe(true);
    expect(dividers(calls)).toBe(0);
    inBox(box, calls);
    expect(calls[0].op).toBe('save');
    expect(calls[calls.length - 1].op).toBe('restore');
  });

  it('1, 2 and 3 columns with dividers between them; each finished game highlights its winner', () => {
    const m = new Match(makeConfig()).point('A');
    expect(dividers(draw(m).calls)).toBe(0);
    m.game(21, 15).point('B');
    expect(dividers(draw(m).calls)).toBe(1);
    m.game(17, 21).scoreTo(5, 3);
    const { calls, texts } = draw(m);
    expect(dividers(calls)).toBe(2);
    expect(texts).toEqual(['21', '17', '5', 'A', '15', '21', '3', 'B']);
    const fills = calls.filter((c) => c.op === 'fillText').map((c) => c.fill);
    const W = DEFAULT_THEME.winFg;
    const F = DEFAULT_THEME.scoreFg;
    expect(fills.slice(0, 3)).toEqual([W, F, F]); // A won game 1
    expect(fills.slice(4, 7)).toEqual([F, W, F]); // B won game 2; the live game is white
    expect(calls.filter((c) => c.op === 'fillRect' && c.fill === DEFAULT_THEME.liveBg)).toHaveLength(1);
    inBox(box, calls);
  });

  it('long names and three columns fit at 720p: 14-letter names whole, longer ones ellipsised before the scores', () => {
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
      for (const [a1, a2, whole] of [
        ['Chaiyakulsiri', 'Wongsuwanchai', true],
        ['Supercalifragilisticexpialidocious', 'Pneumonoultramicroscopicsilicovolcano', false],
      ] as const) {
        const m = new Match(named(a1, a2)).game(21, 15).game(17, 21).scoreTo(5, 3);
        const { calls } = draw(m, b);
        inBox(b, calls);
        const t = calls.find((c) => c.op === 'fillText' && String(c.args[0]).includes(a1.slice(0, 5).toUpperCase()))!;
        expect(String(t.args[0]).endsWith('…')).toBe(!whole);
        if (whole) expect(t.args[0]).toBe(`${a1} / ${a2}`.toUpperCase());
        // The name ends before the serve bar and the first score column.
        const px = Number(/(\d+(?:\.\d+)?)px/.exec(t.font)![1]);
        const firstScore = calls.find((c) => c.op === 'fillText')!;
        expect((t.args[1] as number) + String(t.args[0]).length * px * 0.6).toBeLessThan(firstScore.args[1] as number);
      }
    }
  });

  it('one serving mark: a bar beside the serving team scores, no shuttle', () => {
    const m = new Match(makeConfig()).point('B');
    const { calls } = draw(m);
    const bars = calls.filter((c) => c.op === 'fillRect' && c.fill === DEFAULT_THEME.serveFg);
    expect(bars).toHaveLength(1);
    expect(bars[0].args[1]).toBeGreaterThan(box.y + box.h / 2 - 10); // bottom row: B
    expect(calls.filter((c) => c.op === 'arc')).toHaveLength(0);
  });

  it('game point is a badge on that team row; interval, final and link lost a badge on the top row', () => {
    const gp = draw(new Match(makeConfig()).scoreTo(15, 20));
    expect(gp.texts).toEqual(['15', 'A', '20', 'GAME PT', 'B']);
    const iv = draw(new Match(makeConfig()).scoreTo(11, 4));
    expect(iv.texts).toEqual(['11', 'INTERVAL', 'A', '4', 'B']);
    const fin = draw(new Match(makeConfig()).game(21, 10).game(21, 12));
    // Ends changed for game 2, so B is the top row at the end.
    expect(fin.texts).toEqual(['10', '12', 'FINAL', 'B', '21', '21', 'A']);
    const lost = draw(new Match(makeConfig()).scoreTo(20, 15), box, { mirrored: false, stale: true });
    expect(lost.texts).toContain('LINK LOST');
    expect(lost.calls.some((c) => c.op === 'fill' && c.fill === DEFAULT_THEME.staleFg)).toBe(true);
  });

  it('the mirrored panel puts the other team on top', () => {
    const { texts } = draw(new Match(doublesConfig()), box, { mirrored: true, stale: false });
    expect(texts[1]).toBe('BANK / TAO');
  });

  it('draws a logo into its box', () => {
    const { ctx, calls } = fakeCtx();
    const img = {} as CanvasImageSource;
    drawLogo(ctx, img, { x: 1, y: 2, w: 3, h: 4 });
    expect(calls).toEqual([expect.objectContaining({ op: 'drawImage', args: [img, 1, 2, 3, 4] })]);
  });
});
