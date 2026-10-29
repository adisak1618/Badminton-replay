// The player stats table and the end-of-game card in the video (D15, round 2 board): what the model carries, how it
// follows the log and the overlay clock, how it is drawn, and that it never overlaps the score panel or the logo.
import { describe, expect, it } from 'vitest';
import type { MatchConfig, PlayerRef, TagBody } from '../engine';
import { doublesConfig, makeConfig, Match } from '../engine/test-utils';
import { DEFAULT_THEME, drawOverlay, panelMaxHeight, panelSize } from './draw';
import { cardPlace, CORNERS, inset, overlayLayout, panelScale, type Corner, type LogoSize, type TablePlace } from './layout';
import { NO_STATS, OverlayClock, overlayModel, stateAt, statsOverlay, type OverlayModel } from './model';
import { MOTION } from './motion';
import { CARD, cardShown, cardTitle, drawEndCard, drawStatsTable, endCardSize, statColumns, statsTableSize, TABLE, type EndCard, type StatsTable } from './table';
import { fakeCtx, textSpan, words } from './test-ctx';
import { ERROR_COLUMNS, STAT_WORDS, WORDS } from './words';

const on = (cfg: MatchConfig): MatchConfig => ({ ...cfg, reasons: 'endOfGame' });
const P = (team: 'A' | 'B', idx: number): PlayerRef => ({ team, idx });
const tag = (point: string, how: TagBody['how'], hit: PlayerRef, more: Partial<TagBody> = {}): TagBody => ({ type: 'tag', point, how, hit, ...more });
const plain = { mirrored: false, stale: false };
const A_TABLE = { table: { team: 'A' as const, opp: true }, card: false };

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
  const lastId = (m: Match) => [...m.events].reverse().find((e) => e.type === 'point')!.id;
  /** Game 1 won 21-1 by A. The last point is tagged (a winner) unless `last` says otherwise; 'none' = still untagged. */
  const fullGame = (last: 'tag' | 'none' | 'clear' = 'tag') => {
    const m = new Match(on(doublesConfig())).rallies('A');
    m.push(tag('e2', 'winner', P('A', 0), { assist: P('A', 1) }));
    m.rallies('B'); // e4 (the tag above is e3)
    m.push(tag('e4', 'unforced', P('A', 1)));
    m.scoreTo(21, 1); // A wins game 1
    if (last === 'tag') m.push(tag(lastId(m), 'winner', P('A', 0)));
    if (last === 'clear') m.push({ type: 'tag.clear', point: lastId(m) });
    return m;
  };
  const raw = (m: Match, cutoff = Infinity) => statsOverlay(m.cfg, m.events, m.state, cutoff, { table: null, card: true }).card;
  /** The card as the video shows it with no motion: a closed one is gone at once. */
  const card = (m: Match, cutoff = Infinity) => {
    const c = raw(m, cutoff);
    return cardShown(c, cutoff, 'none') ? c : null;
  };

  it('waits for the last point of the game: hidden while it is untagged, shown once it is tagged or the operator chose no tag', () => {
    expect(fullGame('none').state.phase).toBe('gameOver');
    expect(card(fullGame('none'))).toBeNull();
    expect(card(fullGame('tag'))).not.toBeNull();
    expect(card(fullGame('clear'))).not.toBeNull();
  });

  it('a game that ends with every point already tagged shows the card at once, in the panel order, with totals that add up', () => {
    const m = new Match(on(doublesConfig())).rallies('A');
    for (let i = 0; i < 20; i++) m.point('A');
    m.events.filter((e) => e.type === 'point').forEach((e) => m.push(tag(e.id, 'winner', P('A', 0))));
    expect(m.state.phase).toBe('gameOver');
    const c = card(m)!;
    expect(c.kind).toBe('game');
    expect(c.seq).toBe(m.events.filter((e) => e.type === 'point').pop()!.seq);
    expect(c.teams.map((t) => t.team)).toEqual([m.state.leftTeam, m.state.leftTeam === 'A' ? 'B' : 'A']);
    for (const t of c.teams) expect(t.winners + t.oppForced + t.oppUnforced + t.untagged).toBe(t.points);
    expect(c.teams.find((t) => t.team === 'A')!.points).toBe(21);
    expect(c.teams.find((t) => t.team === 'A')!.untagged).toBe(0);
    expect(c.rallies).toBe(c.teams[0].points + c.teams[1].points);
  });

  it('stays however long it takes, until the operator closes it; a close before the last point does not count', () => {
    const m = fullGame('tag');
    const s = m.state;
    expect(card(m, s.phaseSince! + 10 * 60_000)).not.toBeNull(); // no timer
    expect(card(m, s.phaseSince! + 60 * 60_000)).not.toBeNull();
    m.push({ type: 'summary.close' });
    expect(card(m)).toBeNull();
    expect(card(m, m.events[m.events.length - 2].at)).not.toBeNull(); // before the close it was showing
    const early = new Match(on(doublesConfig())).rallies('A');
    early.push({ type: 'summary.close' }); // closed during play: nothing to close
    early.scoreTo(21, 1);
    early.push(tag(lastId(early), 'winner', P('A', 0)));
    expect(card(early)).not.toBeNull();
  });

  it('goes with the next game\'s first rally, never covering play; undoing the last point hides it again', () => {
    const m = fullGame('tag');
    m.startGame();
    expect(m.state.score).toEqual({ A: 0, B: 0 });
    expect(card(m)).not.toBeNull(); // the next game is started but not played
    m.point('B');
    expect(card(m)).toBeNull();
    m.undo();
    expect(card(m)).not.toBeNull();
    m.undo(); // the game start
    m.undo(); // the last point of game 1
    expect(m.state.phase).toBe('playing');
    expect(card(m)).toBeNull();
  });

  it('a closed game summary stays closed when the next game starts, and the next game gets its own', () => {
    const m = fullGame('tag');
    m.push({ type: 'summary.close' });
    m.startGame();
    expect(card(m)).toBeNull();
    m.scoreTo(5, 0);
    m.scoreTo(21, 0);
    expect(m.state.phase).toBe('matchOver');
    expect(card(m)).toBeNull(); // the last point of the match is untagged: waits
    m.push(tag(lastId(m), 'winner', P('A', 1)));
    expect(card(m)!.kind).toBe('match');
  });

  it('after the match it waits for the last point too, then shows the whole match until closed', () => {
    const m = fullGame('tag').startGame().scoreTo(21, 3);
    const s = m.state;
    expect(s.phase).toBe('matchOver');
    expect(card(m)).toBeNull();
    m.push({ type: 'tag.clear', point: lastId(m) });
    const c = card(m, s.phaseSince! + 60 * 60_000)!;
    expect(c.kind).toBe('match');
    expect(c.teams.find((t) => t.team === 'A')!.points).toBe(42);
    m.push({ type: 'summary.close' });
    expect(card(m)).toBeNull();
  });

  it('is not drawn while the setting is off', () => {
    const m = fullGame('tag');
    expect(statsOverlay(m.cfg, m.events, m.state, Infinity, { table: null, card: false }).card).toBeNull();
  });

  it('carries when it became due (the last tag) and when it was closed; a closed card fades out over cardOut, then is gone', () => {
    const m = fullGame('tag');
    const lastTag = m.events.at(-1)!;
    expect(raw(m)!).toMatchObject({ shownAt: lastTag.at, closedAt: null });
    m.push({ type: 'summary.close' });
    const closeAt = m.events.at(-1)!.at;
    const c = raw(m)!;
    expect(c.closedAt).toBe(closeAt);
    expect(cardShown(c, closeAt + MOTION.full.cardOut - 1, 'full')).toBe(true);
    expect(cardShown(c, closeAt + MOTION.full.cardOut, 'full')).toBe(false);
    expect(cardShown(c, closeAt, 'none')).toBe(false);
    // "No tag" resolves it too, and the card counts from that choice
    const n = fullGame('clear');
    expect(raw(n)!.shownAt).toBe(n.events.at(-1)!.at);
  });

  it('carries the game scores for the match card and the playing time in minutes', () => {
    const m = fullGame('tag').startGame().scoreTo(21, 3);
    m.push({ type: 'tag.clear', point: lastId(m) });
    const c = raw(m)!;
    const left = m.state.leftTeam;
    expect(c.games).toEqual(m.state.completed.map((g) => [g[left], g[left === 'A' ? 'B' : 'A']]));
    expect(c.minutes).toBe(Math.max(1, Math.round(((22 + 24 - 2) * 1000) / 60_000))); // the test log puts rallies 1 s apart
    expect(raw(fullGame('tag'))!.games).toEqual([[21, 1]]);
  });

  it('is worded in formal Thai with the BWF English name, and sized for the middle of the frame', () => {
    const m = fullGame();
    const c = raw(m)!;
    expect(cardTitle(c)).toBe('สรุปเกมที่ 1');
    const size = endCardSize(c, 1);
    expect(size.w).toBe(CARD.w);
    const { box } = cardPlace(1920, 1080, size, []);
    expect(box).toMatchObject({ x: (1920 - CARD.w) / 2, w: CARD.w });
    const r = fakeCtx();
    drawEndCard(r.ctx, c, box);
    const w = words(r.calls);
    for (const k of statColumns(true)) expect(w).toContain(STAT_WORDS[k]);
    for (const x of [WORDS.overview, WORDS.players, WORDS.total, WORDS.fromWinners, WORDS.fromForced, WORDS.fromUnforced, WORDS.untagged, WORDS.longestRun, WORDS.wonOnServe])
      expect(w).toContain(x);
    expect(w).toContain(WORDS.tagged(c.tagged, c.rallies));
    expect(w).toContain('GAME 1 SUMMARY');
    expect(w.some((x) => /แต้มมาจากอะไร|ติดแท็ก|ไม่ได้ระบุ/.test(x))).toBe(false); // the PR 10 words are gone
    expect(box.y + box.h).toBeLessThan(1080);
  });

  it('the match card shows games won, every game, WIN for the winner and the playing time', () => {
    const m = fullGame('tag').startGame().scoreTo(21, 3);
    m.push({ type: 'tag.clear', point: lastId(m) });
    const c = raw(m)!;
    const r = fakeCtx();
    drawEndCard(r.ctx, c, cardPlace(1920, 1080, endCardSize(c, 1), []).box);
    const w = words(r.calls);
    expect(w).toEqual(expect.arrayContaining([WORDS.cardMatch, 'MATCH SUMMARY', '2', '0', 'WIN', c.games.map(([a, b]) => `${a}–${b}`).join('   ')]));
    expect(w).toContain(`${WORDS.event(true)}  ·  ${WORDS.duration(c.minutes!)}`);
  });

  it('keeps every word inside the card, the tagged count inside the padding, whatever its width or the scale', () => {
    const m = fullGame();
    const base = raw(m)!;
    const wide: EndCard = { ...base, tagged: 123_456, rallies: 123_456, game: 12 };
    for (const c of [base, wide])
      for (const u of [0.5, 2 / 3, 1, 1.25]) {
        const size = endCardSize(c, u);
        const box = { x: 100, y: 50, ...size };
        const r = fakeCtx();
        drawEndCard(r.ctx, c, box);
        for (const t of r.calls.filter((x) => x.op === 'fillText')) {
          const [from, to] = textSpan(t);
          expect(from, String(t.args[0])).toBeGreaterThanOrEqual(box.x - 0.01);
          expect(to, String(t.args[0])).toBeLessThanOrEqual(box.x + box.w + 0.01);
        }
        const label = r.calls.find((t) => t.op === 'fillText' && String(t.args[0]).startsWith('บันทึกเหตุผล'))!;
        expect(textSpan(label)[1]).toBeLessThanOrEqual(box.x + box.w - CARD.pad * (box.w / CARD.w) + 0.01);
      }
  });

  it('never relies on textAlign right: right-aligned words are drawn left-aligned from a measured start', () => {
    const m = fullGame('tag').startGame().scoreTo(21, 3);
    m.push({ type: 'tag.clear', point: lastId(m) });
    const r = fakeCtx();
    drawEndCard(r.ctx, raw(m)!, cardPlace(1920, 1080, endCardSize(raw(m)!, 1), []).box);
    expect(r.calls.filter((x) => x.op === 'fillText').every((x) => x.align !== 'right')).toBe(true);
  });

  it('fades in and rises from when it became due; with no motion it is there at once', () => {
    const m = fullGame();
    const c = raw(m)!;
    const box = cardPlace(1920, 1080, endCardSize(c, 1), []).box;
    const alphaAt = (now: number, motion: 'full' | 'none') => {
      const r = fakeCtx();
      drawEndCard(r.ctx, c, box, DEFAULT_THEME, { now, motion });
      return r.calls.find((x) => x.op === 'fill')?.alpha ?? 0;
    };
    expect(alphaAt(c.shownAt, 'full')).toBe(0);
    expect(alphaAt(c.shownAt + MOTION.full.cardIn / 2, 'full')).toBeGreaterThan(0);
    expect(alphaAt(c.shownAt + MOTION.full.cardIn / 2, 'full')).toBeLessThan(1);
    expect(alphaAt(c.shownAt + MOTION.full.cardIn, 'full')).toBe(1);
    expect(alphaAt(c.shownAt, 'none')).toBe(1);
  });
});

describe('OverlayClock with the stats', () => {
  it('is unchanged with both rows off: no table, no card', () => {
    const m = tagged();
    const clock = new OverlayClock();
    const model = clock.at(m.cfg, m.events, Infinity, { delayMs: 0, offsetMs: 0, ...plain })!;
    expect(model.table).toBeNull();
    expect(model.card).toBeNull();
    expect({ ...model, table: null, card: null, anim: null }).toEqual({ ...overlayModel(m.cfg, m.state, plain), table: null, card: null, anim: null });
  });

  it('rebuilds when a tag arrives, when the options change, and when the summary is closed; otherwise it memoises', () => {
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
    // the card: waits for the last point's tag, then stays (no timer) until the operator closes it
    m.scoreTo(21, 0);
    const lastPoint = [...m.events].reverse().find((e) => e.type === 'point')!;
    const at = () => m.events[m.events.length - 1].at;
    expect(clock.at(m.cfg, m.events, at(), o)!.card).toBeNull();
    m.push(tag(lastPoint.id, 'winner', P('A', 0)));
    const during = clock.at(m.cfg, m.events, at(), o)!;
    expect(during.card).not.toBeNull();
    expect(clock.at(m.cfg, m.events, at() + 600_000, o)).toBe(during); // ten minutes on: still there, nothing rebuilt
    m.push({ type: 'summary.close' });
    const closed = clock.at(m.cfg, m.events, at(), o)!.card!;
    expect(closed.closedAt).toBe(at());
    expect(cardShown(closed, at() + MOTION.full.cardOut, 'full')).toBe(false);
  });
});

describe('drawStatsTable', () => {
  const table = (doubles: boolean, opp: number | null = 16, changed: Record<string, number> = {}): StatsTable => ({
    team: 'A',
    color: '#2bd4a6',
    doubles,
    game: 2,
    opp,
    changed,
    rows: [
      { name: 'NOK', W: 7, A: 3, F: 4, FE: 1, UE: 3 },
      { name: 'PAE', W: 0, A: 4, F: 3, FE: 3, UE: 1 },
    ].slice(0, doubles ? 2 : 1),
  });
  const draw = (t: StatsTable, u = 1, o = {}) => {
    const size = statsTableSize(fakeCtx().ctx, t, u);
    const box = { x: 43, y: 900, ...size };
    const r = fakeCtx();
    drawStatsTable(r.ctx, t, box, u, DEFAULT_THEME, o);
    return { box, ...r, texts: r.calls.filter((c) => c.op === 'fillText') };
  };

  it('draws the game in the red header, the Thai headings once, the players, the counts, and the opponent line', () => {
    const { texts, calls } = draw(table(true));
    const w = texts.map((t) => String(t.args[0]));
    expect(w[0]).toBe('GAME 2');
    for (const k of statColumns(true)) expect(w.filter((x) => x === STAT_WORDS[k])).toHaveLength(1);
    expect(w).toEqual(expect.arrayContaining(['NOK', 'PAE', '7', '3', '4', '16', WORDS.opp]));
    expect(calls.some((c) => c.op === 'fillRect' && c.fill === DEFAULT_THEME.table.head)).toBe(true);
    expect(calls.some((c) => c.op === 'fillRect' && c.fill === DEFAULT_THEME.table.headErr)).toBe(true);
  });

  it('singles has one player row and no สร้างโอกาส column; the opponent line can be left out', () => {
    const w = draw(table(false, null)).texts.map((t) => String(t.args[0]));
    expect(w).not.toContain(STAT_WORDS.A);
    expect(w).not.toContain('PAE');
    expect(w).not.toContain(WORDS.opp);
  });

  it('keeps everything inside its box, dims zeros, reds the points-lost counts, uses the team colour for the marker', () => {
    const { box, calls, texts } = draw(table(true));
    for (const c of calls.filter((x) => x.op === 'fillRect' || x.op === 'fillText')) {
      if (c.fill === DEFAULT_THEME.shadow) continue; // the hard shadow sits 2-3 units out
      const [x, y] = (c.op === 'fillRect' ? c.args : c.args.slice(1)) as number[];
      expect(x).toBeGreaterThanOrEqual(box.x);
      expect(x).toBeLessThanOrEqual(box.x + box.w);
      expect(y).toBeGreaterThanOrEqual(box.y);
      expect(y).toBeLessThanOrEqual(box.y + box.h);
    }
    const T = DEFAULT_THEME.table;
    expect(calls.some((c) => c.op === 'fill' && c.fill === '#2bd4a6')).toBe(true);
    expect(texts.find((t) => t.args[0] === '0')?.fill).toBe(T.zero);
    expect(texts.find((t) => t.args[0] === '7')?.fill).toBe(T.val);
    // NOK's UE (3) is a points-lost count; their A (3) is not
    const threes = texts.filter((t) => t.args[0] === '3').map((t) => t.fill);
    expect(threes).toContain(T.valErr);
    expect(threes).toContain(T.val);
    expect(ERROR_COLUMNS).toEqual(new Set(['FE', 'UE']));
  });

  it('has a fixed size for the match: counts reaching two digits do not change it; rows are at least 1.3 x their font', () => {
    const a = table(true);
    const b = { ...a, rows: a.rows.map((r) => ({ ...r, W: 88, UE: 12 })) };
    expect(statsTableSize(fakeCtx().ctx, b, 1)).toEqual(statsTableSize(fakeCtx().ctx, a, 1));
    expect(TABLE.row / TABLE.valFont).toBeGreaterThanOrEqual(1.3);
    expect(TABLE.head / TABLE.headFont).toBeGreaterThanOrEqual(1.3);
    expect(TABLE.opp / TABLE.oppFont).toBeGreaterThanOrEqual(1.3);
  });

  it('never lets a word cross the box when a wider font draws it than the one that sized it, and clips to the box', () => {
    for (const doubles of [true, false]) {
      const t = table(doubles);
      const sized = statsTableSize(fakeCtx(0.6).ctx, t, 1); // measured once, with a narrow font (the cached size)
      for (const em of [0.6, 0.75, 0.9, 1.2]) {
        const r = fakeCtx(em);
        const box = { x: 43, y: 900, ...sized };
        drawStatsTable(r.ctx, t, box, 1);
        expect(r.calls.some((c) => c.op === 'clip')).toBe(true);
        for (const c of r.calls.filter((x) => x.op === 'fillText')) {
          const [from, to] = textSpan(c, em);
          expect(from, `${c.args[0]} @${em}`).toBeGreaterThanOrEqual(box.x);
          expect(to, `${c.args[0]} @${em}`).toBeLessThanOrEqual(box.x + box.w + 0.01);
        }
        // the เสียเอง header is drawn once, inside the box (a wide font may shorten it with an ellipsis)
        expect(r.calls.filter((x) => x.op === 'fillText' && x.fill === DEFAULT_THEME.table.headFg && String(x.args[0]).startsWith(STAT_WORDS.UE.slice(0, 2)))).toHaveLength(1);
      }
    }
  });

  it('a count that just went up flashes and pops for the set\'s cell time, from the tag\'s time; with no motion it does not', () => {
    const at = 5_000_000;
    const t = table(true, 16, { '0:W': at });
    const flashes = (now: number, motion: 'full' | 'light' | 'none') => draw(t, 1, { now, motion }).calls.filter((c) => c.op === 'fillRect' && c.fill === DEFAULT_THEME.table.flash);
    expect(flashes(at + 100, 'full')).toHaveLength(1);
    expect(flashes(at + 100, 'full')[0].alpha).toBeGreaterThan(0.9);
    expect(flashes(at + MOTION.full.cell, 'full')).toHaveLength(0);
    expect(flashes(at + 100, 'light')).toHaveLength(1);
    expect(flashes(at + 100, 'none')).toHaveLength(0);
    const seven = (now: number) => draw(t, 1, { now, motion: 'full' }).texts.find((x) => x.args[0] === '7')!.font;
    expect(seven(at + 10)).not.toBe(seven(at + 5000)); // popped
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

describe('the table\'s flash: which counts a tag changed', () => {
  it('a tag marks the counts it changed with its time, for the chosen team; the opponent line too', () => {
    const m = tagged(); // e5: Nok winner (Pae assist), e6: Bank unforced, e7: Pae forced error forced by Bank
    const t = statsOverlay(m.cfg, m.events, m.state, Infinity, A_TABLE).table!;
    const at = (id: string) => m.events.find((e) => e.id === id)!.at;
    expect(t.changed).toEqual({ '0:W': at('e5'), '1:A': at('e5'), opp: at('e6'), '1:FE': at('e7') });
    const b = statsOverlay(m.cfg, m.events, m.state, Infinity, { table: { team: 'B', opp: true }, card: false }).table!;
    expect(b.changed).toEqual({ '0:UE': at('e6'), '0:F': at('e7'), opp: at('e7') }); // B's view of the same tags
  });

  it('counts only tags already visible at the cutoff, in the current game', () => {
    const m = tagged();
    const t5 = m.events.find((e) => e.id === 'e5')!.at;
    expect(statsOverlay(m.cfg, m.events, stateAt(m.cfg, m.events, t5), t5, A_TABLE).table!.changed).toEqual({ '0:W': t5, '1:A': t5 });
    m.scoreTo(21, 1).startGame().point('A');
    expect(statsOverlay(m.cfg, m.events, m.state, Infinity, A_TABLE).table!.changed).toEqual({});
  });
});

describe('table placement: never covers the score panel or the logo', () => {
  const LONG = 'A'.repeat(40); // far longer than any name fits: the names are squeezed, the boxes stay finite
  const names = [['NOK', 'PAE'], [LONG, LONG], ['ณัฐวุฒิ สมบัติ', 'พงศ์พัฒน์']] as const;
  const boxes = (l: ReturnType<typeof overlayLayout>) => [l.score, l.logo, l.table].filter(Boolean) as Array<{ x: number; y: number; w: number; h: number }>;
  const hit = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  /** A card of the right shape for the sizes: four players in doubles, two in singles. */
  const cardFor = (doubles: boolean): EndCard => {
    const team = (t: 'A' | 'B') => ({
      team: t,
      color: '#fff',
      label: 'X',
      rows: Array.from({ length: doubles ? 2 : 1 }, () => ({ name: 'X', W: 0, A: 0, F: 0, FE: 0, UE: 0 })),
      points: 0,
      winners: 0,
      oppForced: 0,
      oppUnforced: 0,
      untagged: 0,
      longestRun: 0,
      wonOnServe: 0,
    });
    return { kind: 'match', game: 0, seq: 1, tagged: 0, rallies: 0, doubles, teams: [team('A'), team('B')], games: [], minutes: null, shownAt: 0, closedAt: null };
  };

  it('every panel corner x logo corner x logo size x place x size x frame: zero overlaps, inside the safe inset; the card misses the panel and the logo', () => {
    let n = 0;
    let cards = 0;
    let minK = 1;
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
                game: games,
                opp: 16,
                changed: {},
                rows: (doubles ? [pa, pb] : [pa]).map((name) => ({ name: name.toUpperCase(), W: 88, A: 88, F: 88, FE: 88, UE: 88 })),
              };
              const tsize = statsTableSize(fakeCtx().ctx, t, u);
              const csize = endCardSize(cardFor(doubles), u);
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
                        if (place === 'auto') {
                          // The card hides the table; it must miss the panel and the logo, inside the frame.
                          const { box, k } = cardPlace(W, H, csize, [lay.score, lay.logo]);
                          if (hit(box, lay.score!) || hit(box, lay.logo!)) throw new Error(`card overlap ${JSON.stringify({ H, size, sc, lc, ls, aspect, box })}`);
                          expect(box.y).toBeGreaterThanOrEqual(m);
                          expect(box.y + box.h).toBeLessThanOrEqual(H - m);
                          minK = Math.min(minK, k);
                          cards++;
                        }
                        n++;
                      }
            }
          }
        }
      }
    }
    expect(n).toBeGreaterThan(40_000);
    expect(cards).toBeGreaterThan(8_000);
    expect(minK).toBeGreaterThan(0.75); // it gets smaller only with a large panel or logo, never tiny
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
