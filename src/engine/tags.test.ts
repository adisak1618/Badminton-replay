// Point reasons (D15): tags, validation, the newest tag winning, undo and redo, the stats fold and its free
// extras, the camera's input rule, and the Off setting.
import { describe, expect, it } from 'vitest';
import { applyInput } from './input';
import { lastUndoable } from './reducer';
import { gameStats, matchStats, rallies, untagged, validTag } from './tags';
import { Match, doublesConfig, makeConfig } from './test-utils';
import type { MatchConfig, PlayerRef, TagBody } from './types';

const on = (cfg: MatchConfig): MatchConfig => ({ ...cfg, reasons: 'endOfGame' });
const P = (team: 'A' | 'B', idx: number): PlayerRef => ({ team, idx });
const tag = (point: string, how: TagBody['how'], hit: PlayerRef, more: Partial<TagBody> = {}): TagBody => ({ type: 'tag', point, how, hit, ...more });

describe('rallies with a cutoff (the video clock)', () => {
  it('counts only events up to the cutoff; a tag counts from when it was saved; undos still come from the whole log', () => {
    const m = new Match(on(doublesConfig())).rallies('AB');
    m.push(tag('e2', 'winner', P('A', 0)));
    const [p1, p2, tagAt] = [m.events[1].at, m.events[2].at, m.events[3].at];
    const at = (c: number) => rallies(m.cfg, m.events, c);
    expect(at(p1 - 1)).toHaveLength(0);
    expect(at(p1)).toHaveLength(1);
    expect(at(p2)).toHaveLength(2);
    expect(at(tagAt - 1)[0].tag).toBeNull();
    expect(at(tagAt)[0].tag).toMatchObject({ how: 'winner' });
    expect(rallies(m.cfg, m.events)).toEqual(at(Infinity));
    m.undo(); // the undo of the last point is later than the cutoff, but the point never counts
    expect(at(tagAt)).toHaveLength(1);
    expect(matchStats(m.cfg, m.events, tagAt).match.rallies).toBe(1);
  });

  it('gameStats is all zero for a game without a rally', () => {
    const m = new Match(on(doublesConfig())).rallies('A');
    const g = gameStats(matchStats(m.cfg, m.events), m.cfg, 2);
    expect(g).toMatchObject({ game: 2, rallies: 0, tagged: 0 });
    expect(g.players.A.map((p) => p.W)).toEqual([0, 0]);
    expect(gameStats(matchStats(m.cfg, m.events), m.cfg, 1).rallies).toBe(1);
  });
});

describe('rallies and tags', () => {
  it('each counted point is a rally with who served and received; the newest valid tag wins; clear removes it', () => {
    const m = new Match(on(doublesConfig())).rallies('AB'); // e2: A wins (Nok served to Bank), e3: B wins
    const [r1, r2] = rallies(m.cfg, m.events);
    expect(r1).toMatchObject({ n: 1, id: 'e2', team: 'A', game: 1, served: P('A', 0), received: P('B', 0), after: { A: 1, B: 0 }, tag: null });
    expect(r2).toMatchObject({ n: 2, id: 'e3', team: 'B', served: P('A', 0), received: P('B', 1) });
    m.push(tag('e2', 'winner', P('A', 1), { shot: 'smash' }));
    m.push(tag('e2', 'winner', P('A', 1), { shot: 'smash', assist: P('A', 0) })); // a chip appends a newer tag
    expect(rallies(m.cfg, m.events)[0].tag).toMatchObject({ how: 'winner', shot: 'smash', assist: P('A', 0) });
    m.push({ type: 'tag.clear', point: 'e2' });
    expect(rallies(m.cfg, m.events)[0].tag).toBeNull();
    expect(untagged(rallies(m.cfg, m.events)).map((r) => r.id)).toEqual(['e2', 'e3']);
  });

  it('an invalid tag is passed over and the previous one stays', () => {
    const m = new Match(on(doublesConfig())).rallies('A');
    m.push(tag('e2', 'forced', P('B', 0), { forcedBy: P('A', 1) }));
    m.push(tag('e2', 'winner', P('B', 0))); // B lost this rally: no winner for B
    expect(rallies(m.cfg, m.events)[0].tag).toMatchObject({ how: 'forced', hit: P('B', 0), forcedBy: P('A', 1) });
  });

  it('validation: winner by the scoring side, errors by the losing side, assist only the partner, in doubles', () => {
    const d = on(doublesConfig());
    const s = on(makeConfig());
    const r = { team: 'A' as const };
    expect(validTag(d, r, tag('p', 'winner', P('A', 1), { assist: P('A', 0), shot: 'kill' }))).toBe(true);
    expect(validTag(d, r, tag('p', 'winner', P('A', 1), { assist: P('A', 1) }))).toBe(false); // not their own assist
    expect(validTag(d, r, tag('p', 'winner', P('B', 0)))).toBe(false);
    expect(validTag(d, r, tag('p', 'winner', P('A', 0), { forcedBy: P('A', 1) }))).toBe(false);
    expect(validTag(d, r, tag('p', 'forced', P('B', 1), { forcedBy: P('A', 0), assist: P('A', 1) }))).toBe(true);
    expect(validTag(d, r, tag('p', 'forced', P('B', 1), { assist: P('A', 1) }))).toBe(false); // assist needs forced-by
    expect(validTag(d, r, tag('p', 'forced', P('B', 1), { forcedBy: P('B', 0) }))).toBe(false);
    expect(validTag(d, r, tag('p', 'unforced', P('B', 0), { shot: 'serve' }))).toBe(true);
    expect(validTag(d, r, tag('p', 'unforced', P('B', 0), { forcedBy: P('A', 0) }))).toBe(false);
    expect(validTag(d, r, tag('p', 'unforced', P('A', 0)))).toBe(false);
    expect(validTag(d, r, tag('p', 'winner', P('A', 2)))).toBe(false); // no third player
    expect(validTag(d, r, { ...tag('p', 'winner', P('A', 0)), shot: 'lob' as never })).toBe(false);
    expect(validTag(s, r, tag('p', 'winner', P('A', 0)))).toBe(true);
    expect(validTag(s, r, tag('p', 'winner', P('A', 1)))).toBe(false); // singles: one player a side
    expect(validTag(s, r, tag('p', 'forced', P('B', 0), { forcedBy: P('A', 0), assist: P('A', 0) }))).toBe(false);
  });

  it('a voided point drops its tag, a redo brings it back, and undo never targets a tag', () => {
    const m = new Match(on(doublesConfig())).rallies('AA');
    m.push(tag('e3', 'winner', P('A', 0), { shot: 'drop' }));
    expect(lastUndoable(m.events)?.id).toBe('e3'); // undo takes back the point, not its tag
    m.undo();
    expect(rallies(m.cfg, m.events).map((r) => r.id)).toEqual(['e2']);
    expect(matchStats(m.cfg, m.events).match.tagged).toBe(0);
    m.redo(); // redo is still possible: a tag is not a new scoring action
    expect(rallies(m.cfg, m.events)[1].tag).toMatchObject({ how: 'winner', shot: 'drop' });
  });

  it('a point made in game over is not a rally and cannot be tagged', () => {
    const m = new Match(on(makeConfig({ points: 11 }))).point('A', 11); // 11-0: game over
    m.point('A'); // ignored by the reducer
    expect(rallies(m.cfg, m.events)).toHaveLength(11);
    const last = m.events[m.events.length - 1];
    expect(applyInput(m.cfg, m.events, { id: 'x', at: 1, by: 's', body: tag(last.id, 'winner', P('A', 0)) }, 1).result).toBe('ignored');
  });
});

describe('matchStats', () => {
  it('per player, per team, by shot, per game and for the match; untagged points stay visible', () => {
    const m = new Match(on(doublesConfig({ points: 11 })));
    m.rallies('AABA'); // e2..e5
    m.push(tag('e2', 'winner', P('A', 1), { shot: 'smash', assist: P('A', 0) }));
    m.push(tag('e3', 'forced', P('B', 0), { forcedBy: P('A', 1), assist: P('A', 0), shot: 'drive' }));
    m.push(tag('e4', 'unforced', P('A', 0)));
    const st = matchStats(m.cfg, m.events);
    expect(st.games).toHaveLength(1);
    const g = st.games[0];
    expect(g).toMatchObject({ game: 1, rallies: 4, tagged: 3 });
    expect(g.players.A).toEqual([
      { W: 0, forced: 0, A: 2, FE: 0, UE: 1 },
      { W: 1, forced: 1, A: 0, FE: 0, UE: 0 },
    ]);
    expect(g.players.B[0]).toEqual({ W: 0, forced: 0, A: 0, FE: 1, UE: 0 });
    expect(g.teams.A).toEqual({ won: 3, winners: 1, oppForced: 1, oppUnforced: 0, untagged: 1 });
    expect(g.teams.B).toEqual({ won: 1, winners: 0, oppForced: 0, oppUnforced: 1, untagged: 0 });
    expect(g.winnersByShot.A).toEqual({ smash: 1 }); // the forced error's shot is the error, not a winner
    // The team line adds up to the score.
    for (const t of ['A', 'B'] as const) {
      const x = g.teams[t];
      expect(x.winners + x.oppForced + x.oppUnforced + x.untagged).toBe(x.won);
    }
  });

  it('the free extras: longest run within a game, points won on serve, duration; the match sums the games', () => {
    const m = new Match(on(makeConfig({ points: 11 })));
    m.point('A', 3).point('B', 2).point('A', 8); // 11-2: game 1, A's run of 8
    m.startGame();
    m.point('A', 2).point('B', 4); // game 2 so far: 2-4; A's run does not carry over
    const st = matchStats(m.cfg, m.events);
    expect(st.games.map((g) => g.game)).toEqual([1, 2]);
    expect(st.games[0].longestRun).toEqual({ A: 8, B: 2 });
    expect(st.games[1].longestRun).toEqual({ A: 2, B: 4 });
    expect(st.match.longestRun).toEqual({ A: 8, B: 4 });
    // Game 1: A served first and won 3 (on serve), B won 2 (the first on A's serve), A won the first back then 7 on serve.
    expect(st.games[0].wonOnServe).toEqual({ A: 10, B: 1 });
    expect(st.games[0].durationMs).toBe(12_000); // 13 rallies one second apart
    expect(st.match.rallies).toBe(19);
    expect(st.match.teams.A.won).toBe(13);
    expect(st.match.durationMs).toBe(st.games[0].durationMs + st.games[1].durationMs);
  });
});

describe('the camera’s rule for tag inputs (applyInput)', () => {
  const input = (body: TagBody | { type: 'tag.clear'; point: string }) => ({ id: `i-${Math.random()}`, at: 5, by: 'sb-2', body });

  it('applies a valid tag for a live point in any phase, ignores the rest', () => {
    const m = new Match(on(makeConfig({ points: 11 }))).point('A', 11); // game over: tagging later is still fine
    const ok = applyInput(m.cfg, m.events, input(tag('e12', 'winner', P('A', 0), { shot: 'smash' })), 5);
    expect(ok.result).toBe('applied');
    expect(ok.events[ok.events.length - 1]).toMatchObject({ type: 'tag', point: 'e12', by: 'sb-2' });
    expect(applyInput(m.cfg, m.events, input(tag('e12', 'winner', P('B', 0))), 5).result).toBe('ignored'); // invalid
    expect(applyInput(m.cfg, m.events, input(tag('nope', 'winner', P('A', 0))), 5).result).toBe('ignored'); // no such point
    expect(applyInput(m.cfg, m.events, input({ type: 'tag.clear', point: 'e12' }), 5).result).toBe('applied');
  });

  it('Off: a match that does not ask why records nothing (the captain: "บางคนอยากใช้แค่นับแต้ม")', () => {
    const off = new Match({ ...makeConfig(), reasons: 'off' }).rallies('A');
    const { reasons: _, ...before } = makeConfig();
    const absent = new Match(before).rallies('A'); // started before D15: no field, off as well
    for (const m of [off, absent]) {
      expect(applyInput(m.cfg, m.events, input(tag('e2', 'winner', P('A', 0))), 5).result).toBe('ignored');
      expect(applyInput(m.cfg, m.events, input({ type: 'tag.clear', point: 'e2' }), 5).result).toBe('ignored');
    }
  });

  it('an input of a type from a newer build is answered "ignored", not applied', () => {
    const m = new Match(makeConfig()).rallies('A');
    const r = applyInput(m.cfg, m.events, { id: 'x', at: 5, by: 's', body: { type: 'replay.marker' } as never }, 5);
    expect(r.result).toBe('ignored');
    expect(r.events).toBe(m.events);
  });
});
