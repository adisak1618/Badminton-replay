// The player stats table and the end-of-game card in the video (D15, round 2 board): what the model carries, how it
// follows the log and the overlay clock, how it is drawn, and that it never overlaps the score panel or the logo.
import { describe, expect, it } from 'vitest';
import type { MatchConfig, PlayerRef, TagBody } from '../engine';
import { doublesConfig, makeConfig, Match } from '../engine/test-utils';
import { DEFAULT_THEME, drawOverlay, panelMaxHeight, panelSize } from './draw';
import { CORNERS, inset, overlayLayout, panelScale, type Corner, type LogoSize, type TablePlace } from './layout';
import { CARD_MS, NO_STATS, OverlayClock, overlayModel, stateAt, statsOverlay, type OverlayModel } from './model';
import { cardLine, cardTitle, drawEndCard, drawStatsTable, endCardSize, OPP_LINE, STAT_WORDS, statColumns, statsTableSize, type StatsTable } from './table';

const on = (cfg: MatchConfig): MatchConfig => ({ ...cfg, reasons: 'endOfGame' });
const P = (team: 'A' | 'B', idx: number): PlayerRef => ({ team, idx });
const tag = (point: string, how: TagBody['how'], hit: PlayerRef, more: Partial<TagBody> = {}): TagBody => ({ type: 'tag', point, how, hit, ...more });
const plain = { mirrored: false, stale: false };
const A_TABLE = { table: { team: 'A' as const, opp: true }, card: false };

/** A recording stand-in for CanvasRenderingContext2D: text is 0.6 em per character. */
function fakeCtx() {
  const calls: Array<{ op: string; args: unknown[]; fill: string; font: string; align: string }> = [];
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
    ctx[op] = (...args: unknown[]) => calls.push({ op, args, fill: ctx.fillStyle, font: ctx.font, align: String(ctx.textAlign) });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

/** Doubles, reasons on: Nok wins a point with Pae's assist, Bank errs unforced, then Pae makes a forced error forced by Bank. */
function tagged() {
  const m = new Match(on(doublesConfig())).rallies('AAB'); // e2, e3 for A; e4 for B
  m.push(tag('e2', 'winner', P('A', 0), { assist: P('A', 1) }));
  m.push(tag('e3', 'unforced', P('B', 0)));
  m.push(tag('e4', 'forced', P('A', 1), { forcedBy: P('B', 0) }));
  return m;
}

describe('the live table: the current game of the chosen team', () => {
  it('carries each player\'s winners, assists, forced, forced errors and unforced errors, and the opponent total', () => {
    const m = tagged();
    const { table, card } = statsOverlay(m.cfg, m.events, m.state, Infinity, A_TABLE);
    expect(card).toBeNull();
    expect(table).toMatchObject({ team: 'A', doubles: true, color: m.cfg.teams.A.color, opp: 1 });
    expect(table!.rows).toEqual([
      { name: 'NOK', W: 1, A: 0, F: 0, FE: 0, UE: 0 },
      { name: 'PAE', W: 0, A: 1, F: 0, FE: 1, UE: 0 },
    ]);
  });

  it('shows the other team on request, and leaves the opponent line out when it is off', () => {
    const m = tagged();
    const b = statsOverlay(m.cfg, m.events, m.state, Infinity, { table: { team: 'B', opp: false }, card: false }).table!;
    expect(b.opp).toBeNull();
    expect(b.rows.map((r) => r.name)).toEqual(['BANK', 'TAO']);
    expect(b.rows[0]).toMatchObject({ UE: 1, F: 1 });
  });

  it('singles has one row, and no assists to show', () => {
    const m = new Match(on(makeConfig())).rallies('A');
    m.push(tag('e2', 'winner', P('A', 0)));
    const t = statsOverlay(m.cfg, m.events, m.state, Infinity, A_TABLE).table!;
    expect(t.rows).toHaveLength(1);
    expect(t.doubles).toBe(false);
    expect(statColumns(false)).toEqual(['W', 'F', 'FE', 'UE']);
    expect(statColumns(true)).toEqual(['W', 'A', 'F', 'FE', 'UE']);
  });

  it('counts reset with every game: game 2 starts from zero, game 1 stays in the card', () => {
    const m = new Match(on(doublesConfig())).rallies('A');
    m.push(tag('e2', 'winner', P('A', 0)));
    m.scoreTo(21, 0).startGame();
    expect(m.state.game).toBe(2);
    const t2 = statsOverlay(m.cfg, m.events, m.state, Infinity, A_TABLE).table!;
    expect(t2.rows.every((r) => r.W + r.A + r.F + r.FE + r.UE === 0)).toBe(true);
    expect(t2.opp).toBe(0);
    m.point('A');
    m.push(tag(m.events[m.events.length - 1].id, 'winner', P('A', 1)));
    const t3 = statsOverlay(m.cfg, m.events, m.state, Infinity, A_TABLE).table!;
    expect(t3.rows.map((r) => r.W)).toEqual([0, 1]);
  });

  it('shows nothing when the match does not record reasons (S1 Off), and nothing when both rows are off', () => {
    const off = new Match({ ...doublesConfig(), reasons: 'off' }).rallies('A');
    expect(statsOverlay(off.cfg, off.events, off.state, Infinity, { table: A_TABLE.table, card: true })).toEqual({ table: null, card: null });
    const m = tagged();
    expect(statsOverlay(m.cfg, m.events, m.state, Infinity, NO_STATS)).toEqual({ table: null, card: null });
  });

  it('blank doubles names fall back to the team name; names are upper case', () => {
    const cfg = on(makeConfig({ doubles: true, teams: { A: { name: 'Club', color: 0, players: ['', 'Pae'], startRight: 0 }, B: { name: 'B', color: 1, players: ['x', 'y'], startRight: 0 } } }));
    const m = new Match(cfg).rallies('A');
    expect(statsOverlay(cfg, m.events, m.state, Infinity, A_TABLE).table!.rows.map((r) => r.name)).toEqual(['CLUB 1', 'PAE']);
  });
});

describe('tags, the cutoff and undo (R-REC-4)', () => {
  it('a tag counts from the moment it was saved: the point shows first, the number follows when the tag arrives', () => {
    const m = new Match(on(doublesConfig())).rallies('A');
    const pointAt = m.events[m.events.length - 1].at;
    m.push(tag('e2', 'winner', P('A', 0)));
    const tagAt = m.events[m.events.length - 1].at;
    const at = (cutoff: number) => statsOverlay(m.cfg, m.events, stateAt(m.cfg, m.events, cutoff), cutoff, A_TABLE).table!.rows[0].W;
    expect(at(pointAt)).toBe(0);
    expect(at(tagAt - 1)).toBe(0);
    expect(at(tagAt)).toBe(1);
  });

  it('a point undone after the cutoff never counts, tag and all (the same rule as the score)', () => {
    const m = new Match(on(doublesConfig())).rallies('A');
    m.push(tag('e2', 'winner', P('A', 0)));
    const before = m.events[m.events.length - 1].at;
    m.undo(); // undoes the point (the tag goes with it); the undo is in the "future" of `before`
    const s = stateAt(m.cfg, m.events, before);
    expect(s.score.A).toBe(0);
    expect(statsOverlay(m.cfg, m.events, s, before, A_TABLE).table!.rows[0].W).toBe(0);
  });
});

describe('the end-of-game card', () => {
  const fullGame = () => {
    const m = new Match(on(doublesConfig())).rallies('A');
    m.push(tag('e2', 'winner', P('A', 0), { assist: P('A', 1) }));
    m.rallies('B'); // e4 (the tag above is e3)
    m.push(tag('e4', 'unforced', P('A', 1)));
    m.scoreTo(21, 1); // A wins game 1
    return m;
  };

  it('shows both teams for 20 s after a game, in the panel order, with totals that add up to the points', () => {
    const m = fullGame();
    const s = m.state;
    expect(s.phase).toBe('gameOver');
    const c = statsOverlay(m.cfg, m.events, s, s.phaseSince!, { table: null, card: true }).card!;
    expect(c.kind).toBe('game');
    expect(c.teams.map((t) => t.team)).toEqual([s.leftTeam, s.leftTeam === 'A' ? 'B' : 'A']);
    for (const t of c.teams) expect(t.winners + t.oppForced + t.oppUnforced + t.untagged).toBe(t.points);
    expect(c.teams.find((t) => t.team === 'A')!.points).toBe(21);
    expect(c.rallies).toBe(c.teams[0].points + c.teams[1].points);
    expect(statsOverlay(m.cfg, m.events, s, s.phaseSince! + CARD_MS.game - 1, { table: null, card: true }).card).not.toBeNull();
    expect(statsOverlay(m.cfg, m.events, s, s.phaseSince! + CARD_MS.game, { table: null, card: true }).card).toBeNull();
  });

  it('after the match it shows the whole match for 30 s', () => {
    const m = fullGame().startGame().scoreTo(21, 3);
    const s = m.state;
    expect(s.phase).toBe('matchOver');
    const c = statsOverlay(m.cfg, m.events, s, s.phaseSince! + CARD_MS.match - 1, { table: null, card: true }).card!;
    expect(c.kind).toBe('match');
    expect(c.teams.find((t) => t.team === 'A')!.points).toBe(42);
    expect(statsOverlay(m.cfg, m.events, s, s.phaseSince! + CARD_MS.match, { table: null, card: true }).card).toBeNull();
  });

  it('goes away when the next game starts, and is not drawn while the setting is off', () => {
    const m = fullGame();
    const s = m.state;
    expect(statsOverlay(m.cfg, m.events, s, s.phaseSince!, { table: null, card: false }).card).toBeNull();
    m.startGame();
    expect(statsOverlay(m.cfg, m.events, m.state, m.state.phaseSince ?? Infinity, { table: null, card: true }).card).toBeNull();
  });

  it('is worded in Thai and sized for the middle of the frame', () => {
    const m = fullGame();
    const c = statsOverlay(m.cfg, m.events, m.state, m.state.phaseSince!, { table: null, card: true }).card!;
    expect(cardTitle(c)).toBe('เกม 1 · แต้มมาจากอะไร');
    expect(cardLine(c.teams.find((t) => t.team === 'A')!)).toMatch(/^NOK \/ PAE {2}21 แต้ม = วินเนอร์ 1 \+ คู่แข่งโดนบีบพลาด 0 \+ คู่แข่งตีเสียเอง 0 \+ ไม่ได้ระบุ 20$/);
    const r = fakeCtx();
    const box = drawEndCard(r.ctx, c, 1920, 1080, 1);
    expect(box).toMatchObject({ ...endCardSize(c, 1), x: (1920 - 720) / 2 });
    const words = r.calls.filter((x) => x.op === 'fillText').map((x) => String(x.args[0]));
    for (const k of statColumns(true)) expect(words).toContain(STAT_WORDS[k].long);
    expect(words).toContain('ติดแท็ก ' + c.tagged + '/' + c.rallies + ' แต้ม');
    expect(box.y + box.h).toBeLessThan(1080);
  });

  it('keeps every word inside the card, the tagged count ends inside the right padding, whatever its width or the scale', () => {
    const m = fullGame();
    const base = statsOverlay(m.cfg, m.events, m.state, m.state.phaseSince!, { table: null, card: true }).card!;
    const wide = { ...base, tagged: 123_456, rallies: 123_456, game: 12 };
    const widthOf = (font: string, t: string) => t.length * Number(/(\d+(?:\.\d+)?)px/.exec(font)![1]) * 0.6;
    for (const c of [base, wide])
      for (const u of [0.5, 2 / 3, 1, 1.25]) {
        const r = fakeCtx();
        const box = drawEndCard(r.ctx, c, 1920 * u, 1080 * u, u);
        const pad = 22 * u;
        const texts = r.calls.filter((x) => x.op === 'fillText');
        for (const t of texts) {
          const [s, x] = t.args as [string, number];
          const w = widthOf(t.font, s);
          const [from, to] = t.align === 'center' ? [x - w / 2, x + w / 2] : t.align === 'right' ? [x - w, x] : [x, x + w];
          expect(from).toBeGreaterThanOrEqual(box.x);
          expect(to).toBeLessThanOrEqual(box.x + box.w - pad + 0.01);
        }
        const label = texts.find((t) => String(t.args[0]).startsWith('ติดแท็ก'))!;
        expect(r.calls.filter((x) => x.op === 'fillText').every((x) => x.font.includes('px'))).toBe(true);
        expect((label.args[1] as number) + widthOf(label.font, String(label.args[0]))).toBeLessThanOrEqual(box.x + box.w - pad + 0.01);
      }
  });

  it('never relies on textAlign right or center for the tagged count: it is drawn left-aligned from a measured start', () => {
    const m = fullGame();
    const c = statsOverlay(m.cfg, m.events, m.state, m.state.phaseSince!, { table: null, card: true }).card!;
    const aligns: string[] = [];
    const r = fakeCtx();
    const orig = (r.ctx as unknown as { fillText: (...a: unknown[]) => void }).fillText;
    (r.ctx as unknown as { fillText: (...a: unknown[]) => void }).fillText = (...a: unknown[]) => {
      if (String(a[0]).startsWith('ติดแท็ก')) aligns.push(r.ctx.textAlign);
      orig(...a);
    };
    drawEndCard(r.ctx, c, 1920, 1080, 1);
    expect(aligns).toEqual(['left']);
  });
});

describe('OverlayClock with the stats', () => {
  it('is unchanged with both rows off: no table, no card', () => {
    const m = tagged();
    const clock = new OverlayClock();
    const model = clock.at(m.cfg, m.events, Infinity, { delayMs: 0, offsetMs: 0, ...plain })!;
    expect(model.table).toBeNull();
    expect(model.card).toBeNull();
    expect({ ...model, table: null, card: null }).toEqual({ ...overlayModel(m.cfg, m.state, plain), table: null, card: null });
  });

  it('rebuilds when a tag arrives, when the options change, and when the card is due to go; otherwise it memoises', () => {
    const m = new Match(on(doublesConfig())).rallies('A');
    const o = { delayMs: 0, offsetMs: 0, ...plain, stats: { table: { team: 'A' as const, opp: true }, card: true } };
    const clock = new OverlayClock();
    const now = m.events[m.events.length - 1].at;
    const a = clock.at(m.cfg, m.events, now, o)!;
    expect(clock.at(m.cfg, m.events, now + 10, o)).toBe(a);
    m.push(tag('e2', 'winner', P('A', 0)));
    const b = clock.at(m.cfg, m.events, m.events[m.events.length - 1].at, o)!;
    expect(b).not.toBe(a);
    expect(b.table!.rows[0].W).toBe(1);
    expect(clock.at(m.cfg, m.events, m.events[m.events.length - 1].at, { ...o, stats: { table: { team: 'B', opp: true }, card: true } })!.table!.team).toBe('B');
    // the card: due at the end of the game, gone 20 s later with no new event
    m.scoreTo(21, 0);
    const end = m.state.phaseSince!;
    const during = clock.at(m.cfg, m.events, end + 1000, o)!;
    expect(during.card).not.toBeNull();
    expect(clock.at(m.cfg, m.events, end + 2000, o)).toBe(during);
    expect(clock.at(m.cfg, m.events, end + CARD_MS.game + 1, o)!.card).toBeNull();
  });
});

describe('drawStatsTable', () => {
  const table = (doubles: boolean, opp: number | null = 16): StatsTable => ({
    team: 'A',
    color: '#2bd4a6',
    doubles,
    opp,
    rows: [
      { name: 'NOK', W: 7, A: 3, F: 4, FE: 1, UE: 3 },
      { name: 'PAE', W: 0, A: 4, F: 3, FE: 3, UE: 1 },
    ].slice(0, doubles ? 2 : 1),
  });
  const draw = (t: StatsTable, u = 1) => {
    const size = statsTableSize(fakeCtx().ctx, t, u);
    const box = { x: 43, y: 900, ...size };
    const r = fakeCtx();
    drawStatsTable(r.ctx, t, box, u);
    return { box, ...r, texts: r.calls.filter((c) => c.op === 'fillText') };
  };

  it('draws the Thai headings once, the players, the counts, and the opponent line', () => {
    const { texts } = draw(table(true));
    const words = texts.map((t) => String(t.args[0]));
    for (const k of statColumns(true)) expect(words).toContain(STAT_WORDS[k].short);
    expect(words).toEqual(expect.arrayContaining(['NOK', 'PAE', '7', '3', '4', '16', OPP_LINE]));
    expect(words.filter((w) => w === STAT_WORDS.W.short)).toHaveLength(1);
  });

  it('singles has one player row and no ทำเกม column; the opponent line can be left out', () => {
    const { texts } = draw(table(false, null));
    const words = texts.map((t) => String(t.args[0]));
    expect(words).not.toContain(STAT_WORDS.A.short);
    expect(words).not.toContain('PAE');
    expect(words).not.toContain(OPP_LINE);
  });

  it('keeps everything inside its box, dims zeros, and uses the team colour for the marker', () => {
    const { box, calls, texts } = draw(table(true));
    for (const c of calls.filter((x) => x.op === 'fillRect' || x.op === 'fillText')) {
      const [x, y] = (c.op === 'fillRect' ? c.args : c.args.slice(1)) as number[];
      expect(x).toBeGreaterThanOrEqual(box.x);
      expect(x).toBeLessThanOrEqual(box.x + box.w);
      expect(y).toBeGreaterThanOrEqual(box.y);
      expect(y).toBeLessThanOrEqual(box.y + box.h);
    }
    expect(calls.some((c) => c.op === 'fill' && c.fill === '#2bd4a6')).toBe(true);
    expect(texts.find((t) => t.args[0] === '0')?.fill).toBe('rgba(255,255,255,0.4)');
    expect(texts.find((t) => t.args[0] === '7')?.fill).toBe('#ffffff');
  });

  it('has a fixed size for the match: counts reaching two digits do not change it; rows are at least 1.3 x the Thai font', () => {
    const a = table(true);
    const b = { ...a, rows: a.rows.map((r) => ({ ...r, W: 88, UE: 12 })) };
    expect(statsTableSize(fakeCtx().ctx, b, 1)).toEqual(statsTableSize(fakeCtx().ctx, a, 1));
    expect(28 / 22).toBeGreaterThanOrEqual(1.25);
    expect(22 / 18).toBeGreaterThanOrEqual(1.2);
  });

  it('scales with the panel size and 720p', () => {
    const t = table(true);
    const m = statsTableSize(fakeCtx().ctx, t, 1);
    const l = statsTableSize(fakeCtx().ctx, t, panelScale(1080, 'large'));
    const p720 = statsTableSize(fakeCtx().ctx, t, panelScale(720, 'medium'));
    expect(l.h).toBeGreaterThan(m.h);
    expect(p720.w / m.w).toBeCloseTo(2 / 3, 1);
  });
});

describe('table placement: never covers the score panel or the logo', () => {
  const LONG = 'A'.repeat(40); // far longer than any name fits: the names are squeezed, the boxes stay finite
  const names = [['NOK', 'PAE'], [LONG, LONG], ['ณัฐวุฒิ สมบัติ', 'พงศ์พัฒน์']] as const;
  const boxes = (l: ReturnType<typeof overlayLayout>) => [l.score, l.logo, l.table].filter(Boolean) as Array<{ x: number; y: number; w: number; h: number }>;
  const hit = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it('every panel corner x logo corner x logo size x place x size x frame: zero overlaps, inside the safe inset', () => {
    let n = 0;
    for (const H of [1080, 720]) {
      const W = Math.round((H * 16) / 9);
      const m = inset(H);
      for (const size of ['small', 'medium', 'large'] as LogoSize[]) {
        const u = panelScale(H, size);
        for (const [pa, pb] of names) {
          for (const doubles of [true, false]) {
            const cfg = makeConfig({
              doubles,
              teams: { A: { name: 'A', color: 0, players: [pa, pb], startRight: 0 }, B: { name: 'B', color: 1, players: [pa, pb], startRight: 0 } },
            });
            for (const games of [1, 2, 3]) {
              const model = {
                ...overlayModel(cfg, new Match(cfg).rallies('A').state, plain),
                games: Array.from({ length: games }, () => ({ left: 21, right: 18, winner: null, live: false })),
              } as OverlayModel;
              const score = panelSize(fakeCtx().ctx, model, u);
              const t: StatsTable = {
                team: 'A',
                color: '#fff',
                doubles,
                opp: 16,
                rows: (doubles ? [pa, pb] : [pa]).map((name) => ({ name: name.toUpperCase(), W: 88, A: 88, F: 88, FE: 88, UE: 88 })),
              };
              const tsize = statsTableSize(fakeCtx().ctx, t, u);
              for (const sc of CORNERS as readonly Corner[])
                for (const lc of CORNERS as readonly Corner[])
                  for (const ls of ['small', 'medium', 'large'] as LogoSize[])
                    for (const aspect of [1, 2, 4])
                      for (const place of ['auto', ...CORNERS] as TablePlace[]) {
                        const lay = overlayLayout(W, H, {
                          scoreCorner: sc,
                          score,
                          scoreMaxH: panelMaxHeight(u),
                          logo: { corner: lc, size: ls, aspect },
                          table: { place, ...tsize },
                        });
                        const bs = boxes(lay);
                        expect(bs).toHaveLength(3);
                        for (const b of bs) {
                          expect(b.x).toBeGreaterThanOrEqual(m);
                          expect(b.y).toBeGreaterThanOrEqual(m);
                          expect(b.x + b.w).toBeLessThanOrEqual(W - m);
                          expect(b.y + b.h).toBeLessThanOrEqual(H - m);
                        }
                        for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) if (hit(bs[i], bs[j])) throw new Error(`overlap ${JSON.stringify({ H, size, pa, doubles, games, sc, lc, ls, aspect, place, lay })}`);
                        n++;
                      }
            }
          }
        }
      }
    }
    expect(n).toBeGreaterThan(40_000);
  });

  it('auto picks the free corner: bottom-left by default, the vertical mirror of the panel otherwise', () => {
    const base = { score: { w: 423, h: 136 }, scoreMaxH: 190 };
    const lay = (o: Partial<Parameters<typeof overlayLayout>[2]>) => overlayLayout(1920, 1080, { scoreCorner: 'tl', logo: null, table: { place: 'auto', w: 405, h: 113 }, ...base, ...o });
    expect(lay({ logo: { corner: 'tr', size: 'medium', aspect: 2 } }).table).toEqual({ x: 43, y: 1080 - 43 - 113, w: 405, h: 113 });
    expect(lay({ scoreCorner: 'bl' }).table).toMatchObject({ x: 43, y: 43 });
    expect(lay({ scoreCorner: 'tr', logo: { corner: 'br', size: 'small', aspect: 1 } }).table).toMatchObject({ x: 43, y: 1080 - 43 - 113 }); // vertical mirror taken: the diagonal
  });

  it('a chosen corner stacks after the panel and the logo; the panel and the logo stay where they were without it', () => {
    const base = { scoreCorner: 'tl' as const, score: { w: 423, h: 136 }, scoreMaxH: 190, logo: { corner: 'tl' as const, size: 'medium' as const, aspect: 2 } };
    const without = overlayLayout(1920, 1080, base);
    const withTable = overlayLayout(1920, 1080, { ...base, table: { place: 'tl', w: 405, h: 113 } });
    expect(withTable.score).toEqual(without.score);
    expect(withTable.logo).toEqual(without.logo);
    expect(withTable.table!.y).toBe(without.logo!.y + without.logo!.h + Math.round(1080 * 0.015));
  });

  it('panel and logo render exactly as before when no table is asked for', () => {
    const m = new Match(on(doublesConfig())).rallies('AB');
    const model = overlayModel(m.cfg, m.state, plain);
    const a = fakeCtx();
    drawOverlay(a.ctx, model, { x: 43, y: 43, ...panelSize(a.ctx, model, 1) }, 1, DEFAULT_THEME);
    const withStats = new OverlayClock().at(m.cfg, m.events, Infinity, { delayMs: 0, offsetMs: 0, ...plain, stats: NO_STATS })!;
    const b = fakeCtx();
    drawOverlay(b.ctx, withStats, { x: 43, y: 43, ...panelSize(b.ctx, withStats, 1) }, 1, DEFAULT_THEME);
    expect(b.calls).toEqual(a.calls);
  });
});
