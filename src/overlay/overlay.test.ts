import { describe, expect, it } from 'vitest';
import { reduce } from '../engine';
import { doublesConfig, makeConfig, Match } from '../engine/test-utils';
import { bandOf, bandText, clockText, DEFAULT_THEME, drawLogo, drawOverlay, PANEL, panelMaxHeight, panelSize, type Box } from './draw';
import { inset, overlayLayout, panelScale, type Corner } from './layout';
import { OverlayClock, overlayModel, playersLabel, replay, sideAnim, stateAt, type OverlayModel } from './model';
import { MOTION, progress, type Motion } from './motion';
import { fakeCtx, textSpan, words, type Call } from './test-ctx';
import { WORDS } from './words';

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
    expect(bandText(iv)).toBe(WORDS.interval);
    m.endInterval().scoreTo(20, 3);
    expect(overlayModel(m.cfg, m.state, plain).flag).toEqual({ kind: 'matchPoint', team: 'A' });
    m.point('A');
    const fin = overlayModel(m.cfg, m.state, plain);
    expect(fin.phase).toBe('matchOver');
    expect(fin.winner).toBe('A');
    expect(fin.left.serving || fin.right.serving).toBe(false);
    expect(bandText(fin)).toBe(WORDS.matchOver);
  });

  it('names the doubles server and court (R-SCORE-3 sequence)', () => {
    const m = new Match(doublesConfig()).rallies('AB');
    expect(overlayModel(m.cfg, m.state, plain).server).toEqual({ team: 'B', name: 'Tao', court: 'left' });
  });

  it('marks a stale link above every other status', () => {
    const m = new Match(makeConfig()).scoreTo(20, 15);
    expect(bandText(overlayModel(m.cfg, m.state, { mirrored: false, stale: true }))).toBe(WORDS.stale);
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
    expect(bandText(d)).toBe(WORDS.draw(1, 1));
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

describe('the status badge: BWF words, the countdown, deuce (broadcast design)', () => {
  const band = (m: Match, opts = plain) => bandOf(overlayModel(m.cfg, m.state, opts));

  it('names every state in BWF English, the stale link above all', () => {
    expect(band(new Match(makeConfig()).scoreTo(5, 3))).toBeNull();
    expect(band(new Match(makeConfig()).scoreTo(20, 13))!.text).toBe('GAME POINT');
    expect(band(new Match(makeConfig()).game(21, 10).scoreTo(20, 4))!.text).toBe('MATCH POINT');
    expect(band(new Match(makeConfig()).scoreTo(11, 4))!.text).toBe('INTERVAL');
    expect(band(new Match(makeConfig()).game(21, 10, { start: false }))!.text).toBe('END OF GAME 1');
    expect(band(new Match(makeConfig()).game(21, 10).game(21, 12))!.text).toBe('END OF MATCH');
    expect(band(new Match(makeConfig({ format: 'fixed2' })).game(21, 15).game(15, 21))!.text).toBe('DRAW 1–1');
    expect(band(new Match(makeConfig()).scoreTo(20, 13), { mirrored: false, stale: true })!.kind).toBe('stale');
    expect(band(new Match(makeConfig()).scoreTo(20, 20))!.text).toBe('DEUCE 20–20');
  });

  it('deuce is level at pointsToWin - 1 or more with nobody on game point: 20-20, 25-25, not 21-20, not 29-29; 14-14 in a game to 15', () => {
    const at = (cfg: ReturnType<typeof makeConfig>, a: number, b: number) => overlayModel(cfg, new Match(cfg).scoreTo(a, b).state, plain);
    const c21 = makeConfig();
    expect(at(c21, 19, 19).deuce).toBe(false);
    expect(at(c21, 20, 20).deuce).toBe(true);
    expect(at(c21, 25, 25).deuce).toBe(true);
    expect(at(c21, 21, 20)).toMatchObject({ deuce: false, flag: { kind: 'gamePoint' } });
    expect(at(c21, 29, 29)).toMatchObject({ deuce: false, flag: { kind: 'gamePoint' } }); // both sides one point from the cap
    expect(at(makeConfig({ points: 15 }), 14, 14).deuce).toBe(true);
  });

  it('the interval and the break count down from phaseSince + intervalMs; the deciding game says change ends', () => {
    const m = new Match(makeConfig()).scoreTo(11, 4);
    const s = m.state;
    const iv = band(m)!;
    expect(iv.clock).toBe(s.phaseSince! + 60_000);
    expect(iv.total).toBe(60_000);
    const gap = band(new Match(makeConfig()).game(21, 10, { start: false }))!;
    expect(gap).toMatchObject({ total: 120_000, clockLabel: 'BREAK' });
    const decider = new Match(makeConfig()).game(21, 10).game(10, 21).scoreTo(11, 3);
    expect(band(decider)!.text).toBe('INTERVAL · CHANGE ENDS');
    expect(band(new Match(makeConfig()).game(21, 10).game(10, 21).scoreTo(11, 3).endInterval())).toBeNull();
    expect([clockText(60_000), clockText(47_001), clockText(1), clockText(0), clockText(-5)]).toEqual(['1:00', '0:48', '0:01', '0:00', '0:00']);
  });
});

/** Draws the panel for a match into a box at the top-left inset; `o` is the frame's clock and options. */
function panel(m: Match | OverlayModel, o: { now?: number; motion?: Motion; bandAbove?: boolean } = {}, opts = plain, u = 1) {
  const model = m instanceof Match ? { ...overlayModel(m.cfg, m.state, opts), anim: sideAnim(replay(m.cfg, m.events, Infinity).anim, overlayModel(m.cfg, m.state, opts)) } : m;
  const size = panelSize(fakeCtx().ctx, model, u);
  const box: Box = { x: 43, y: 43, ...size };
  const d = fakeCtx();
  drawOverlay(d.ctx, model, box, u, DEFAULT_THEME, o);
  return { box, model, calls: d.calls, texts: d.calls.filter((c) => c.op === 'fillText'), words: words(d.calls) };
}
const inBox = (box: Box, calls: readonly Call[]) => {
  for (const c of calls.filter((x) => x.op === 'fillRect' || x.op === 'fillText')) {
    const [x, y] = (c.op === 'fillRect' ? c.args : c.args.slice(1)) as number[];
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
const lead = PANEL.padL + PANEL.chipW + PANEL.chipGap;
const rows = 2 * PANEL.row + PANEL.rowGap;

describe('drawOverlay: the BWF Championship panel (broadcast design)', () => {
  it('is only as wide as its names: short names make a small panel, longer ones a wider one, capped', () => {
    const short = panel(new Match(makeConfig()).point('A')); // singles A v B: the name slot is at its minimum
    const long = panel(new Match(named('Chaiyakulsiri', 'Wongsuwanchai')).point('A'));
    const huge = panel(new Match(named('Supercalifragilisticexpialidocious', 'Pneumonoultramicroscopic')).point('A'));
    expect(short.box.w).toBe(lead + PANEL.nameMin + PANEL.nameGap + PANEL.slot + PANEL.padR + PANEL.cellGap + PANEL.live);
    expect(short.box.w).toBeLessThan(long.box.w);
    expect(long.box.w).toBeLessThan(huge.box.w);
    expect(huge.box.w).toBe(lead + PANEL.nameMax + PANEL.nameGap + PANEL.slot + PANEL.padR + PANEL.cellGap + PANEL.live);
    expect(huge.words.find((w) => w.startsWith('SUPER'))!.endsWith('…')).toBe(true);
    expect(long.words).toContain('CHAIYAKULSIRI / WONGSUWANCHAI');
    inBox(long.box, long.calls);
  });

  it('keeps the shuttle slot between the name and the first score cell', () => {
    const { texts } = panel(new Match(named('Chaiyakulsiri', 'Wongsuwanchai')).point('B'));
    const name = texts.find((t) => String(t.args[0]).startsWith('CHAI'))!;
    const score = texts.find((t) => t.args[0] === '0')!; // A's live score, centred in the live cell
    const [from, to] = textSpan(score);
    expect((from + to) / 2 - PANEL.live / 2 - textSpan(name)[1]).toBeGreaterThanOrEqual(PANEL.nameGap + PANEL.slot + PANEL.padR + PANEL.cellGap - 1);
  });

  it('finished games are white with the winner dark and the loser grey; the live game is the two-tone red column, last', () => {
    const m = new Match(makeConfig()).game(21, 15).game(17, 21).scoreTo(5, 3);
    const { texts, calls, box } = panel(m);
    const digits = texts.filter((t) => /^\d+$/.test(String(t.args[0])));
    expect(digits.map((t) => t.args[0])).toEqual(['21', '15', '17', '21', '5', '3']);
    const D = DEFAULT_THEME;
    expect(digits.map((t) => t.fill)).toEqual([D.doneWin, D.doneLose, D.doneLose, D.doneWin, D.liveFg, D.liveFg]);
    expect(calls.filter((c) => c.op === 'fillRect' && c.fill === D.doneBg)).toHaveLength(4);
    expect(calls.some((c) => c.op === 'fillRect' && c.fill === D.liveTop)).toBe(true);
    expect(calls.some((c) => c.op === 'fill' && c.fill === D.liveBot)).toBe(true);
    const xs = digits.filter((_, i) => i % 2 === 0).map((t) => (textSpan(t)[0] + textSpan(t)[1]) / 2); // centres
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    expect(xs[2] + PANEL.live / 2).toBeCloseTo(box.x + box.w, 3);
    inBox(box, calls);
  });

  it('a finished game adds a white cell and widens the panel', () => {
    const m = new Match(makeConfig()).point('A');
    const one = panel(m).box.w;
    m.game(21, 15).point('B');
    expect(panel(m).box.w).toBe(one + PANEL.cellGap + PANEL.done);
  });

  it('the badge shows while a state applies, red, under the rows; the panel is taller only then', () => {
    const withBand = rows + PANEL.bandGap + PANEL.band;
    const plainPanel = panel(new Match(makeConfig()).scoreTo(5, 3));
    expect(plainPanel.box.h).toBe(rows);
    for (const m of [new Match(makeConfig()).scoreTo(20, 13), new Match(makeConfig()).scoreTo(20, 20), new Match(makeConfig()).game(21, 10, { start: false })]) {
      const p = panel(m, { now: m.events[m.events.length - 1].at });
      expect(p.box.h).toBe(withBand);
      const badge = p.calls.find((c) => c.op === 'fill' && c.fill.includes(DEFAULT_THEME.badge[0]))!;
      expect(JSON.parse(badge.fill).stops.map((x: [number, string]) => x[1])).toEqual(DEFAULT_THEME.badge);
      expect(p.texts.at(-1)!.args[2] as number).toBeGreaterThan(p.box.y + rows);
    }
    const stale = panel(new Match(makeConfig()).scoreTo(5, 3), {}, { mirrored: false, stale: true });
    expect(stale.calls.some((c) => c.op === 'fill' && c.fill.includes(DEFAULT_THEME.stale[0]))).toBe(true);
    expect(stale.calls.some((c) => c.fill.includes(DEFAULT_THEME.badge[0]))).toBe(false); // never red: it is not a game state
    expect(panelMaxHeight(1)).toBe(withBand);
  });

  it('the interval badge counts down with the frame time and a line that drains; past the end only the word stays', () => {
    const m = new Match(makeConfig()).scoreTo(11, 4);
    const since = m.state.phaseSince!;
    const at = (now: number) => panel(m, { now });
    expect(at(since + 13_000).words).toEqual(expect.arrayContaining(['INTERVAL', '0:47']));
    const line = (now: number) => at(now).calls.filter((c) => c.op === 'fillRect' && c.fill === 'rgba(255,255,255,0.85)')[0].args[2] as number;
    expect(line(since + 30_000) / line(since + 15_000)).toBeCloseTo(30 / 45, 5);
    expect(at(since + 60_000).words).not.toContain('0:00');
    expect(at(since + 60_000).words).toContain('INTERVAL');
    // the break between games puts BREAK before its clock when there is room, and only the clock in a narrow panel
    const g = new Match(named('Chaiyakulsiri', 'Wongsuwanchai')).game(21, 10, { start: false });
    expect(panel(g, { now: g.state.phaseSince! + 8000 }).words).toContain('BREAK 1:52');
    const narrow = new Match(makeConfig()).game(21, 10, { start: false });
    const w = panel(narrow, { now: narrow.state.phaseSince! + 8000 }).words;
    expect(w).toContain('1:52');
    expect(w).toContain('END OF GAME 1');
  });

  it('after the match the winner row shows WIN in the shuttle slot and the other row is dimmed', () => {
    const m = new Match(doublesConfig()).game(21, 10).game(21, 12);
    const { texts, model } = panel(m);
    const win = texts.find((t) => t.args[0] === 'WIN')!;
    const winner = model.left.team === m.state.winner ? model.left : model.right;
    const row = texts.find((t) => t.args[0] === winner.players)!;
    expect(win.args[2] as number).toBeCloseTo(row.args[2] as number, 5);
    const loser = model.left === winner ? model.right : model.left;
    expect(texts.find((t) => t.args[0] === loser.players)!.alpha).toBeLessThan(1);
    expect(texts.find((t) => t.args[0] === winner.players)!.alpha).toBe(1);
  });

  it('in a bottom corner the badge goes above the rows, so the rows stay put when it appears', () => {
    const m = new Match(makeConfig()).scoreTo(20, 13);
    const H = 1080;
    const below = panel(m);
    const above = panel(m, { bandAbove: true });
    const nameY = (p: ReturnType<typeof panel>) => p.texts.find((t) => t.args[0] === 'A')!.args[2] as number;
    expect(nameY(above) - nameY(below)).toBeCloseTo(PANEL.bandGap + PANEL.band, 5);
    const badgeY = (p: ReturnType<typeof panel>) => p.texts.find((t) => t.args[0] === 'GAME POINT')!.args[2] as number;
    expect(badgeY(above)).toBeLessThan(nameY(above));
    // Bottom-anchored boxes: the rows' bottom edge is the same with and without the badge.
    const bottomOfRows = (p: ReturnType<typeof panel>, boxY: number) => boxY + (p.box.h - rows) * 0 + p.box.h;
    const yNo = H - 43 - rows;
    const yBand = H - 43 - (rows + PANEL.bandGap + PANEL.band);
    expect(bottomOfRows(panel(new Match(makeConfig()).scoreTo(5, 3)), yNo)).toBe(bottomOfRows(above, yBand));
  });

  it('a red shuttle at the end of the serving row only', () => {
    const { calls } = panel(new Match(makeConfig()).point('B'));
    expect(calls.filter((c) => c.op === 'arc')).toHaveLength(1);
    expect(calls.find((c) => c.op === 'arc')!.fill).toBe(DEFAULT_THEME.shuttle);
  });

  it('sizes S, M and L scale the whole panel', () => {
    const m = new Match(named('Chaiyakulsiri', 'Wongsuwanchai')).game(21, 15).scoreTo(20, 13);
    const [s, md, l] = (['small', 'medium', 'large'] as const).map((z) => panel(m, {}, plain, panelScale(1080, z)).box);
    expect(s.w).toBeLessThan(md.w);
    expect(md.w).toBeLessThan(l.w);
    expect(l.h / md.h).toBeCloseTo(1.25, 1);
    expect(panel(m, {}, plain, panelScale(720, 'medium')).box.h).toBe(Math.round(md.h * (720 / 1080)));
  });

  it('the mirrored panel puts the other team on top', () => {
    expect(panel(new Match(doublesConfig()).point('A'), {}, { mirrored: true, stale: false }).words[0]).toBe('BANK / TAO');
  });

  it('never asks the browser to centre or right-align: every word is drawn left-aligned from its measured start', () => {
    // The captain's phone ignores textAlign 'center' and 'right' for Thai (PR 10's card, the 2026-10-30 table).
    const states = [
      new Match(makeConfig()).scoreTo(5, 3),
      new Match(makeConfig()).scoreTo(20, 13),
      new Match(makeConfig()).scoreTo(20, 20),
      new Match(makeConfig()).scoreTo(11, 4),
      new Match(makeConfig()).game(21, 10, { start: false }),
      new Match(doublesConfig()).game(21, 10).game(21, 12),
      new Match(makeConfig({ format: 'fixed2' })).game(21, 15).game(15, 21),
    ];
    for (const m of states) {
      const p = panel(m, { now: m.events.at(-1)!.at + 500, motion: 'full' });
      expect(p.texts.length).toBeGreaterThan(3);
      expect(p.texts.every((t) => t.align === 'left')).toBe(true);
    }
    expect(panel(new Match(makeConfig()).scoreTo(5, 3), {}, { mirrored: false, stale: true }).texts.every((t) => t.align === 'left')).toBe(true);
  });

  it('draws a logo into its box', () => {
    const { ctx, calls } = fakeCtx();
    const img = {} as CanvasImageSource;
    drawLogo(ctx, img, { x: 1, y: 2, w: 3, h: 4 });
    expect(calls).toEqual([expect.objectContaining({ op: 'drawImage', args: [img, 1, 2, 3, 4] })]);
  });
});

describe('animation: when things moved, from the log (OverlayAnim)', () => {
  it('records the latest point, serve change, badge and finished game with their event times', () => {
    const m = new Match(makeConfig()).rallies('AB').scoreTo(20, 18);
    const { anim } = replay(m.cfg, m.events, Infinity);
    const lastPoint = m.events.at(-1)!;
    expect(anim.point).toEqual({ team: 'A', at: lastPoint.at });
    expect(anim.band).toEqual({ kind: 'gamePoint', at: lastPoint.at });
    m.point('B'); // 20-19, B serves: the serve moved, still game point (A's), so the badge keeps its start
    const b = replay(m.cfg, m.events, Infinity).anim;
    expect(b.serve).toEqual({ team: 'B', at: m.events.at(-1)!.at });
    expect(b.band).toEqual({ kind: 'gamePoint', at: lastPoint.at });
    m.point('A'); // 21-19: the game ends
    const c = replay(m.cfg, m.events, Infinity).anim;
    expect(c.col).toEqual({ index: 0, at: m.events.at(-1)!.at });
    expect(c.band).toEqual({ kind: 'gameOver', at: m.events.at(-1)!.at });
  });

  it('follows the cutoff and skips an undone point, like the score', () => {
    const m = new Match(makeConfig()).point('A').point('B').undo();
    const a = replay(m.cfg, m.events, Infinity).anim;
    expect(a.point).toEqual({ team: 'A', at: m.events[1].at });
    expect(replay(m.cfg, m.events, m.events[0].at).anim.point).toBeNull();
  });

  it('puts teams on the side of the box they are drawn on, mirrored or not', () => {
    const m = new Match(makeConfig()).point('A');
    const a = replay(m.cfg, m.events, Infinity).anim;
    expect(sideAnim(a, overlayModel(m.cfg, m.state, plain)).point!.side).toBe('left');
    expect(sideAnim(a, overlayModel(m.cfg, m.state, { mirrored: true, stale: false })).point!.side).toBe('right');
  });

  it('the clock model carries the anim; drawn without a frame time nothing moves', () => {
    const m = new Match(makeConfig()).scoreTo(20, 13);
    const model = new OverlayClock().at(m.cfg, m.events, Infinity, { delayMs: 0, offsetMs: 0, ...plain })!;
    expect(model.anim.band!.kind).toBe('gamePoint');
    expect(panel(model).calls).toEqual(panel({ ...model, anim: { point: null, serve: null, band: null, col: null } }).calls);
  });
});

describe('determinism: a frame is a function of the log and its time', () => {
  const m = new Match(doublesConfig()).game(21, 17).scoreTo(19, 20); // game point to B, the latest point was B's
  const t0 = m.events.at(-1)!.at;
  const frame = (now: number, motion: Motion = 'full') => panel(m, { now, motion }).calls;

  it('the same t drawn twice gives the same frame, and a t after another t gives the frame of that t', () => {
    for (const dt of [0, 90, 180, 360, 700, 2000]) {
      const a = frame(t0 + dt);
      expect(frame(t0 + dt)).toEqual(a);
      frame(t0 + dt + 1234); // draw something else in between
      frame(t0 + dt - 50);
      expect(frame(t0 + dt)).toEqual(a);
    }
  });

  it('mid-animation frames differ from the settled one; after the longest movement every frame is the settled one', () => {
    const settled = frame(t0 + 10_000);
    expect(frame(t0 + 100)).not.toEqual(settled);
    const longest = Math.max(MOTION.full.tick, MOTION.full.flash, MOTION.full.bandIn + MOTION.full.shine);
    expect(frame(t0 + longest + 1)).toEqual(settled);
  });

  it('with no motion every frame is the settled one; the light set only flashes and wipes', () => {
    expect(frame(t0 + 100, 'none')).toEqual(frame(t0 + 10_000, 'none'));
    expect(frame(t0 + 100, 'light')).not.toEqual(frame(t0 + 10_000, 'light'));
    expect(MOTION.light.tick + MOTION.light.pulse + MOTION.light.shine).toBe(0);
    expect(progress(undefined, t0, 500)).toBe(1);
  });

  it('match point pulses forever (a cycle of pulse ms), game point does not', () => {
    const mp = new Match(makeConfig()).game(21, 10).scoreTo(20, 4);
    const s0 = mp.events.at(-1)!.at + 5000;
    const f = (now: number) => panel(mp, { now, motion: 'full' }).calls;
    expect(f(s0 + MOTION.full.pulse)).toEqual(f(s0));
    expect(f(s0 + MOTION.full.pulse / 2)).not.toEqual(f(s0));
    expect(frame(t0 + 5000)).toEqual(frame(t0 + 5000 + MOTION.full.pulse / 2));
  });
});
