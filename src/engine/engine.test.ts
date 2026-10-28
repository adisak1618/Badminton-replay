import { describe, expect, it } from 'vitest';
import { receiverIdx, servingCourt, totalPoints } from './rules';
import { reduce } from './reducer';
import { doublesConfig, makeConfig, Match } from './test-utils';
import type { MatchState, Points, Team } from './types';

const who = (m: Match, s: MatchState = m.state) => {
  const p = (t: Team, i: number) => m.cfg.teams[t].players[i];
  const other: Team = s.server === 'A' ? 'B' : 'A';
  return { server: p(s.server, s.serverIdx), court: servingCourt(s), receiver: p(other, receiverIdx(s)) };
};

describe('game end: points, deuce and cap (R-SCORE-1)', () => {
  const cases: Array<{ points: Points; cap: number }> = [
    { points: 11, cap: 20 },
    { points: 15, cap: 24 },
    { points: 21, cap: 30 },
  ];
  for (const { points, cap } of cases) {
    describe(`${points} points`, () => {
      const cfg = makeConfig({ points });

      it(`has cap ${cap}`, () => expect(cfg.cap).toBe(cap));

      it(`is won at ${points}-0`, () => {
        const m = new Match(cfg).scoreTo(points - 1, 0);
        expect(m.state.phase).toBe('playing');
        m.point('A');
        expect(m.state.phase).toBe('gameOver');
        expect(m.state.completed).toEqual([{ A: points, B: 0 }]);
      });

      it(`needs two clear points from ${points - 1}-all`, () => {
        const m = new Match(cfg).scoreTo(points - 1, points - 1).point('A');
        expect(m.state.phase).not.toBe('gameOver'); // at 11 points, 11-10 is the interval
        expect(m.state.score).toEqual({ A: points, B: points - 1 });
        m.point('B').point('A');
        expect(m.state.phase).toBe('playing');
        m.point('A');
        expect(m.state.phase).toBe('gameOver');
        expect(m.state.completed).toEqual([{ A: points + 2, B: points }]);
      });

      it(`ends at the cap from ${cap - 1}-all`, () => {
        const m = new Match(cfg).scoreTo(cap - 1, cap - 1);
        expect(m.state.phase).toBe('playing');
        m.point('B');
        expect(m.state.phase).toBe('gameOver');
        expect(m.state.completed).toEqual([{ A: cap - 1, B: cap }]);
        expect(m.state.lastGameWinner).toBe('B');
      });
    });
  }

  it('20-20 needs 22-20; 29-29 ends at 30-29 (21 points)', () => {
    const cfg = makeConfig({ points: 21 });
    const a = new Match(cfg).scoreTo(20, 20).point('A');
    expect(a.state.phase).toBe('playing');
    a.point('A');
    expect(a.state.completed[0]).toEqual({ A: 22, B: 20 });
    const b = new Match(cfg).scoreTo(29, 29).point('A');
    expect(b.state.completed[0]).toEqual({ A: 30, B: 29 });
  });
});

describe('formats (R-SCORE-2, D12)', () => {
  for (const points of [11, 15, 21] as Points[]) {
    it(`best of 3 at ${points}: a 2-0 ends after game 2`, () => {
      const m = new Match(makeConfig({ points, format: 'bestOf3' })).game(points, 5);
      expect(m.state.phase).toBe('playing');
      expect(m.state.game).toBe(2);
      m.game(points, 7);
      expect(m.state.phase).toBe('matchOver');
      expect(m.state.winner).toBe('A');
      expect(m.state.games).toEqual({ A: 2, B: 0 });
    });

    it(`best of 3 at ${points}: a 1-1 goes to game 3`, () => {
      const m = new Match(makeConfig({ points, format: 'bestOf3' })).game(points, 3).game(4, points);
      expect(m.state.phase).toBe('playing');
      expect(m.state.game).toBe(3);
      m.game(2, points);
      expect(m.state.phase).toBe('matchOver');
      expect(m.state.winner).toBe('B');
      expect(m.state.games).toEqual({ A: 1, B: 2 });
    });

    it(`fixed 2 at ${points}: 2-0 is a win`, () => {
      const m = new Match(makeConfig({ points, format: 'fixed2' })).game(points, 1).game(points, 2);
      expect(m.state.phase).toBe('matchOver');
      expect(m.state.winner).toBe('A');
    });

    it(`fixed 1 at ${points}: one game`, () => {
      const m = new Match(makeConfig({ points, format: 'fixed1' })).game(3, points);
      expect(m.state.phase).toBe('matchOver');
      expect(m.state.winner).toBe('B');
      expect(m.state.completed).toHaveLength(1);
    });
  }

  it('fixed 2: 21-15, 15-21 is a draw 1-1, points 36-36, no winner', () => {
    const m = new Match(makeConfig({ format: 'fixed2' })).game(21, 15).game(15, 21);
    const s = m.state;
    expect(s.phase).toBe('matchOver');
    expect(s.winner).toBeNull();
    expect(s.games).toEqual({ A: 1, B: 1 });
    expect(s.completed).toEqual([
      { A: 21, B: 15 },
      { A: 15, B: 21 },
    ]);
    expect(totalPoints(s.completed)).toEqual({ A: 36, B: 36 });
  });

  it('a point after the match is over is ignored', () => {
    const m = new Match(makeConfig({ format: 'fixed1' })).game(21, 0);
    const before = m.state;
    m.point('B');
    expect(m.state).toEqual(before);
  });

  it('a point during game over is ignored', () => {
    const m = new Match(makeConfig()).game(21, 0, { start: false });
    const before = m.state;
    m.point('B').point('A');
    expect(m.state).toEqual(before);
  });
});

describe('game point and match point (R-DISP-5)', () => {
  it('20-15 in game 1 of best of 3 is game point for A, not match point', () => {
    const s = new Match(makeConfig()).scoreTo(20, 15).state;
    expect(s.gamePoint).toBe('A');
    expect(s.matchPoint).toBeNull();
  });

  it('best of 3 at 1-0: game point for the leader is match point', () => {
    const s = new Match(makeConfig()).game(21, 10).scoreTo(20, 15).state;
    expect(s.gamePoint).toBe('A');
    expect(s.matchPoint).toBe('A');
  });

  it('fixed 2 at 1-0: 20-15 for B is game point, not match point', () => {
    const s = new Match(makeConfig({ format: 'fixed2' })).game(21, 10).scoreTo(15, 20).state;
    expect(s.gamePoint).toBe('B');
    expect(s.matchPoint).toBeNull();
  });

  it('fixed 2 at 1-0: 20-15 for A is match point', () => {
    const s = new Match(makeConfig({ format: 'fixed2' })).game(21, 10).scoreTo(20, 15).state;
    expect(s.matchPoint).toBe('A');
  });

  it('fixed 1: game point is match point', () => {
    const s = new Match(makeConfig({ format: 'fixed1' })).scoreTo(14, 20).state;
    expect(s.matchPoint).toBe('B');
  });

  it('deuce at 20-20 has no flag; 29-29 flags the server', () => {
    const m = new Match(makeConfig()).scoreTo(20, 20);
    expect(m.state.gamePoint).toBeNull();
    m.scoreTo(29, 29);
    expect(m.state.gamePoint).toBe(m.state.server);
  });
});

describe('intervals (R-SCORE-4)', () => {
  it('appears when the leading score first reaches 11, never changes the score, and is dismissed once', () => {
    const m = new Match(makeConfig()).rallies('AAAAAAABBBBBBBAAAA'); // 11-7
    expect(m.state.score).toEqual({ A: 11, B: 7 });
    expect(m.state.phase).toBe('interval');
    expect(m.state.intervalKind).toBe('midGame');
    m.endInterval();
    expect(m.state.phase).toBe('playing');
    expect(m.state.score).toEqual({ A: 11, B: 7 });
    m.point('B');
    expect(m.state.score).toEqual({ A: 11, B: 8 });
    m.scoreTo(12, 11);
    expect(m.state.phase).toBe('playing'); // only the first time in a game
  });

  it('records its start time from the triggering point', () => {
    const m = new Match(makeConfig()).scoreTo(11, 3);
    expect(m.state.phaseSince).toBe(m.events[m.events.length - 1].at);
  });

  it('happens again in the next game', () => {
    const m = new Match(makeConfig()).game(21, 0).scoreTo(0, 10).point('B');
    expect(m.state.phase).toBe('interval');
  });

  it('a point during the interval ends it and scores', () => {
    const m = new Match(makeConfig()).scoreTo(11, 3).point('B');
    expect(m.state.phase).toBe('playing');
    expect(m.state.score).toEqual({ A: 11, B: 4 });
  });

  it('is off when disabled', () => {
    const m = new Match(makeConfig({ interval: false })).rallies('AAAAAAAAAAA');
    expect(m.state.phase).toBe('playing');
  });

  for (const points of [11, 15] as Points[]) {
    it(`at ${points} points it is still at 11`, () => {
      const m = new Match(makeConfig({ points })).scoreTo(10, 10).point('A');
      expect(m.state.phase).toBe('interval');
      expect(m.state.score).toEqual({ A: 11, B: 10 });
    });
  }

  it('between games the match waits in game over with the between-games interval', () => {
    const m = new Match(makeConfig()).game(21, 17, { start: false });
    expect(m.state.phase).toBe('gameOver');
    expect(m.state.intervalKind).toBe('betweenGames');
  });
});

describe('change of ends (R-SCORE-5)', () => {
  /** leftTeam after each event of a log, as [event type, leftTeam] where it changed. */
  function swaps(m: Match): string[] {
    const out: string[] = [];
    let prev = reduce(m.cfg, m.events.slice(0, 1)).leftTeam;
    for (let i = 2; i <= m.events.length; i++) {
      const s = reduce(m.cfg, m.events.slice(0, i));
      if (s.leftTeam !== prev) out.push(`${m.events[i - 1].type}@g${s.game} ${s.score.A}-${s.score.B}`);
      prev = s.leftTeam;
    }
    return out;
  }

  it('best of 3: after every game and at 11 in the third game, nowhere else', () => {
    const m = new Match(makeConfig()).game(21, 15).game(15, 21).game(21, 19);
    expect(swaps(m)).toEqual(['game.start@g2 0-0', 'game.start@g3 0-0', 'interval.end@g3 11-10']);
  });

  it('the deciding-game interval marks the pending swap and swaps when it closes', () => {
    const m = new Match(makeConfig()).game(21, 15).game(15, 21).scoreTo(11, 4);
    expect(m.state.phase).toBe('interval');
    expect(m.state.pendingSwap).toBe(true);
    const before = m.state.leftTeam;
    m.endInterval();
    expect(m.state.leftTeam).not.toBe(before);
    expect(m.state.pendingSwap).toBe(false);
  });

  it('the deciding-game swap also happens when a point ends the interval', () => {
    const m = new Match(makeConfig()).game(21, 15).game(15, 21).scoreTo(11, 4);
    const before = m.state.leftTeam;
    m.point('B');
    expect(m.state.leftTeam).not.toBe(before);
  });

  it('fixed 1: at 11 in the single game', () => {
    const m = new Match(makeConfig({ format: 'fixed1' })).game(21, 12);
    expect(swaps(m)).toEqual(['interval.end@g1 11-10']);
  });

  it('fixed 2: only between the games, never mid-game', () => {
    const m = new Match(makeConfig({ format: 'fixed2' })).game(21, 15).game(15, 21);
    expect(swaps(m)).toEqual(['game.start@g2 0-0']);
  });

  it('best of 3 ending 2-0 swaps once', () => {
    const m = new Match(makeConfig({ points: 11 })).game(11, 5).game(11, 9);
    expect(swaps(m)).toEqual(['game.start@g2 0-0']);
  });

  it('sides.swap swaps ends on demand', () => {
    const m = new Match(makeConfig()).push({ type: 'sides.swap' });
    expect(m.state.leftTeam).toBe('B');
  });
});

describe('server and service court', () => {
  it('singles: right when the server score is even, left when odd', () => {
    const m = new Match(makeConfig());
    expect(servingCourt(m.state)).toBe('right');
    m.point('A');
    expect([m.state.server, servingCourt(m.state)]).toEqual(['A', 'left']);
    m.point('B');
    expect([m.state.server, servingCourt(m.state)]).toEqual(['B', 'left']);
    m.point('B');
    expect([m.state.server, servingCourt(m.state)]).toEqual(['B', 'right']);
  });

  it('the first server is configurable', () => {
    expect(new Match(makeConfig({ firstServer: 'B' })).state.server).toBe('B');
  });

  it('the winner of a game serves first in the next game (singles)', () => {
    const m = new Match(makeConfig()).scoreTo(19, 21);
    expect(m.state.phase).toBe('gameOver');
    m.startGame();
    expect(m.state.server).toBe('B');
    expect(m.state.score).toEqual({ A: 0, B: 0 });
    m.scoreTo(21, 5);
    m.startGame();
    expect(m.state.server).toBe('A');
  });

  it('the winner of a game serves first in the next game (doubles), from the right court', () => {
    const m = new Match(doublesConfig()).scoreTo(14, 21).startGame();
    const s = m.state;
    expect(s.server).toBe('B');
    expect(servingCourt(s)).toBe('right');
    expect(s.pos.B.right).toBe(s.serverIdx);
  });
});

describe('doubles positions (R-SCORE-3, D4)', () => {
  it('follows the R-SCORE-3 sequence', () => {
    const m = new Match(doublesConfig());
    expect(who(m)).toEqual({ server: 'Nok', court: 'right', receiver: 'Bank' });
    m.point('A'); // 1-0: same server, other court
    expect(m.state.score).toEqual({ A: 1, B: 0 });
    expect(who(m)).toEqual({ server: 'Nok', court: 'left', receiver: 'Tao' });
    m.point('B'); // 1-1: service over, nobody moves, B's player in its left court serves
    expect(m.state.score).toEqual({ A: 1, B: 1 });
    expect(who(m)).toEqual({ server: 'Tao', court: 'left', receiver: 'Nok' });
    expect(m.state.pos.A).toEqual({ right: 1, left: 0 }); // Pae right, Nok left
    expect(m.state.pos.B).toEqual({ right: 0, left: 1 }); // Bank right, Tao left
  });

  it('continues past R-SCORE-3: serving side scores, server swaps; receiving side scores, nobody moves', () => {
    const m = new Match(doublesConfig()).rallies('AB');
    m.point('B'); // 1-2: Tao again, now from the right, to A's right-court player Pae
    expect(who(m)).toEqual({ server: 'Tao', court: 'right', receiver: 'Pae' });
    m.point('A'); // 2-2: A's player in its right court (even) serves: Pae
    expect(who(m)).toEqual({ server: 'Pae', court: 'right', receiver: 'Tao' });
    m.point('A'); // 3-2
    expect(who(m)).toEqual({ server: 'Pae', court: 'left', receiver: 'Bank' });
  });

  it('the server always stands in the parity court over a long game', () => {
    const m = new Match(doublesConfig()).rallies('ABBAABABBBAAABABABAB');
    for (let i = 1; i <= m.events.length; i++) {
      const s = reduce(m.cfg, m.events.slice(0, i));
      const parity = s.score[s.server] % 2 === 0 ? 'right' : 'left';
      expect(s.pos[s.server][parity]).toBe(s.serverIdx);
    }
  });

  it('the configured right-court starter serves first', () => {
    const cfg = doublesConfig();
    cfg.startRight = { A: 1, B: 1 };
    const m = new Match(cfg);
    expect(who(m)).toEqual({ server: 'Pae', court: 'right', receiver: 'Tao' });
  });

  it('server and receiver can be chosen at a game start', () => {
    const m = new Match(doublesConfig()).game(21, 15, { start: false });
    m.startGame(1, 1); // A won: Pae serves, Tao receives, both from their right courts
    expect(who(m)).toEqual({ server: 'Pae', court: 'right', receiver: 'Tao' });
    expect(m.state.pos.A).toEqual({ right: 1, left: 0 });
    expect(m.state.pos.B).toEqual({ right: 1, left: 0 });
  });

  it('the default at a game start is the players now in the right courts', () => {
    const m = new Match(doublesConfig()).game(21, 15, { start: false });
    const end = m.state;
    m.startGame();
    expect(m.state.serverIdx).toBe(end.pos.A.right);
    expect(receiverIdx(m.state)).toBe(end.pos.B.right);
  });

  it('swap courts moves the players of one team; the server stays the same person', () => {
    const m = new Match(doublesConfig()).push({ type: 'courts.swap', team: 'A' });
    expect(who(m)).toEqual({ server: 'Nok', court: 'left', receiver: 'Tao' });
    expect(m.state.pos.A).toEqual({ right: 1, left: 0 });
    m.push({ type: 'courts.swap', team: 'B' });
    expect(who(m)).toEqual({ server: 'Nok', court: 'left', receiver: 'Bank' });
    m.point('A'); // serving side scores: the pair swaps again, Nok serves on
    expect(who(m).server).toBe('Nok');
    expect(m.state.pos.A).toEqual({ right: 0, left: 1 });
  });

  it('swap courts on the receiving team changes the receiver', () => {
    const m = new Match(doublesConfig()).push({ type: 'courts.swap', team: 'B' });
    expect(who(m)).toEqual({ server: 'Nok', court: 'right', receiver: 'Tao' });
  });
});

describe('correction (R-SCORE-7)', () => {
  it('sets 15-15 with Tao serving mid-game; later points continue from there and the log records it', () => {
    const m = new Match(doublesConfig()).rallies('AABAB');
    m.push({ type: 'correct', score: { A: 15, B: 15 }, games: { A: 0, B: 0 }, server: 'B', serverIdx: 1 });
    expect(m.state.score).toEqual({ A: 15, B: 15 });
    expect(who(m)).toEqual({ server: 'Tao', court: 'left', receiver: m.cfg.teams.A.players[m.state.pos.A.left] });
    m.point('B');
    expect(m.state.score).toEqual({ A: 15, B: 16 });
    expect(who(m).server).toBe('Tao');
    expect(who(m).court).toBe('right');
    expect(m.events.filter((e) => e.type === 'correct')).toHaveLength(1);
  });

  it('sets games and the game number follows', () => {
    const m = new Match(makeConfig()).push({ type: 'correct', score: { A: 3, B: 2 }, games: { A: 1, B: 0 }, server: 'A' });
    expect(m.state.game).toBe(2);
    expect(m.state.games).toEqual({ A: 1, B: 0 });
    m.scoreTo(21, 2);
    expect(m.state.phase).toBe('matchOver');
    expect(m.state.winner).toBe('A');
  });

  it('marks the interval as done when the corrected score is past it', () => {
    const m = new Match(makeConfig()).push({ type: 'correct', score: { A: 12, B: 4 }, server: 'A' });
    m.point('B');
    expect(m.state.phase).toBe('playing');
  });

  it('server.set picks a server and keeps the parity court', () => {
    const m = new Match(doublesConfig()).rallies('AB').push({ type: 'server.set', team: 'A', idx: 1 });
    const s = m.state;
    expect(s.server).toBe('A');
    expect(s.serverIdx).toBe(1);
    expect(s.pos.A.left).toBe(1); // A has 1 point: left court
  });
});

describe('undo and redo (R-SCORE-6)', () => {
  it('21-19 game won, undo: 20-19 in the same game with the same positions', () => {
    const m = new Match(doublesConfig()).scoreTo(20, 19);
    const before = m.state;
    m.point('A');
    expect(m.state.phase).toBe('gameOver');
    m.undo();
    expect(m.state).toEqual(before);
  });

  it('undoes across a game boundary, any number of times', () => {
    const m = new Match(doublesConfig()).scoreTo(20, 19);
    const at2019 = m.state;
    m.point('A').startGame().point('B');
    expect(m.state.game).toBe(2);
    m.undo(); // the point in game 2
    m.undo(); // game.start
    expect(m.state.phase).toBe('gameOver');
    m.undo(); // the game-winning point
    expect(m.state).toEqual(at2019);
  });

  it('redo restores the last undone action until a new point is scored', () => {
    const m = new Match(makeConfig()).rallies('AAB');
    const at21 = m.state;
    m.undo().undo();
    expect(m.state.score).toEqual({ A: 1, B: 0 });
    m.redo();
    expect(m.state.score).toEqual({ A: 2, B: 0 });
    m.redo();
    expect(m.state).toEqual(at21);
    expect(() => m.redo()).toThrow();
    m.undo().point('A');
    expect(() => m.redo()).toThrow(); // a new point clears redo
    expect(m.state.score).toEqual({ A: 3, B: 0 });
  });

  it('undo, redo, undo again targets the same event', () => {
    const m = new Match(makeConfig()).rallies('AB');
    m.undo().redo().undo();
    expect(m.state.score).toEqual({ A: 1, B: 0 });
    const undos = m.events.filter((e) => e.type === 'undo');
    expect(undos.map((e) => e.type === 'undo' && e.target)).toEqual([3, 3]);
  });

  it('the voided point stays in the log', () => {
    const m = new Match(makeConfig()).point('A').undo();
    expect(m.events.map((e) => e.type)).toEqual(['match.start', 'point', 'undo']);
    expect(m.state.score).toEqual({ A: 0, B: 0 });
  });

  it('undo of the interval dismissal brings the interval back', () => {
    const m = new Match(makeConfig()).scoreTo(11, 2).endInterval().undo();
    expect(m.state.phase).toBe('interval');
  });

  it('End match can be undone', () => {
    const m = new Match(makeConfig()).rallies('AAB').push({ type: 'match.end', reason: 'abandoned' });
    expect(m.state.phase).toBe('matchOver');
    expect(m.state.winner).toBeNull();
    m.undo();
    expect(m.state.phase).toBe('playing');
    expect(m.state.score).toEqual({ A: 2, B: 1 });
  });

  it('has nothing to undo at the start', () => {
    expect(() => new Match(makeConfig()).undo()).toThrow();
  });
});

describe('replay (R-SCORE-8)', () => {
  it('is deterministic and survives a JSON round trip', () => {
    const m = new Match(doublesConfig({ format: 'bestOf3' })).game(21, 18).game(19, 21).scoreTo(11, 9).endInterval();
    m.push({ type: 'courts.swap', team: 'B' }).rallies('ABBA').undo().redo();
    const a = reduce(m.cfg, m.events);
    const b = reduce(m.cfg, m.events);
    expect(a).toEqual(b);
    const { cfg, events } = JSON.parse(JSON.stringify({ cfg: m.cfg, events: m.events }));
    expect(reduce(cfg, events)).toEqual(a);
  });

  it('seq is dense from 1', () => {
    const m = new Match(makeConfig()).rallies('ABAB').undo().redo();
    expect(m.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
