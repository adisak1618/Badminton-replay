// Property tests over random event streams: undo/redo identity, seq continuity, invariants, and parity with
// the reference engine in docs/mockup/index.html (ux-design.md §6).
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { configFromSetup, DEFAULT_SETUP } from './config';
import { append, redoBody, undoBody } from './log';
import { reduce, voidSet } from './reducer';
import { parityCourt } from './rules';
import type { EventBody, MatchConfig, MatchEvent, MatchState, Team } from './types';

type Action =
  | { k: 'point'; team: Team }
  | { k: 'undo' }
  | { k: 'redo' }
  | { k: 'interval.end' }
  | { k: 'game.start'; serverIdx?: 0 | 1; receiverIdx?: 0 | 1 }
  | { k: 'courts.swap'; team: Team }
  | { k: 'sides.swap' }
  | { k: 'correct'; a: number; b: number; server: Team; serverIdx: 0 | 1 };

const team = fc.constantFrom<Team>('A', 'B');
const idx = fc.constantFrom<0 | 1>(0, 1);

const configArb = fc
  .record({
    points: fc.constantFrom(11 as const, 15 as const, 21 as const),
    format: fc.constantFrom('bestOf3' as const, 'fixed2' as const, 'fixed1' as const),
    doubles: fc.boolean(),
    interval: fc.boolean(),
    firstServer: team,
    rightA: idx,
    rightB: idx,
  })
  .map(
    (r): MatchConfig =>
      configFromSetup({
        ...DEFAULT_SETUP,
        points: r.points,
        format: r.format,
        doubles: r.doubles,
        interval: r.interval,
        firstServer: r.firstServer,
        teams: {
          A: { name: 'A', color: 0, players: ['a0', 'a1'], startRight: r.rightA },
          B: { name: 'B', color: 1, players: ['b0', 'b1'], startRight: r.rightB },
        },
      }),
  );

function actionArb(opts: { corrections: boolean; courtSwaps: boolean }): fc.Arbitrary<Action> {
  const arbs: Array<{ weight: number; arbitrary: fc.Arbitrary<Action> }> = [
    { weight: 40, arbitrary: team.map((t): Action => ({ k: 'point', team: t })) },
    { weight: 4, arbitrary: fc.constant<Action>({ k: 'undo' }) },
    { weight: 2, arbitrary: fc.constant<Action>({ k: 'redo' }) },
    { weight: 3, arbitrary: fc.constant<Action>({ k: 'interval.end' }) },
    {
      weight: 3,
      arbitrary: fc
        .record({ serverIdx: fc.option(idx, { nil: undefined }), receiverIdx: fc.option(idx, { nil: undefined }) })
        .map((r): Action => ({ k: 'game.start', ...r })),
    },
    { weight: 1, arbitrary: fc.constant<Action>({ k: 'sides.swap' }) },
  ];
  if (opts.courtSwaps) arbs.push({ weight: 1, arbitrary: team.map((t): Action => ({ k: 'courts.swap', team: t })) });
  if (opts.corrections)
    arbs.push({
      weight: 1,
      arbitrary: fc
        .record({ a: fc.nat(19), b: fc.nat(19), server: team, serverIdx: idx })
        .map((r): Action => ({ k: 'correct', ...r })),
    });
  return fc.oneof(...arbs);
}

/** Turn actions into a log the way the UI does: undo/redo only when available, game.start only in game over. */
function buildLog(cfg: MatchConfig, actions: Action[]): MatchEvent[] {
  let events: MatchEvent[] = [];
  let t = 1_000;
  const push = (b: EventBody) => {
    events = append(events, b, { at: (t += 500), by: 'prop', id: `p${events.length + 1}` });
  };
  push({ type: 'match.start', config: cfg });
  for (const a of actions) {
    let body: EventBody | null;
    switch (a.k) {
      case 'undo':
        body = undoBody(events);
        break;
      case 'redo':
        body = redoBody(events);
        break;
      case 'point':
        body = { type: 'point', team: a.team };
        break;
      case 'game.start':
        body = { type: 'game.start', game: 0, serverIdx: a.serverIdx, receiverIdx: a.receiverIdx };
        break;
      case 'courts.swap':
        body = { type: 'courts.swap', team: a.team };
        break;
      case 'correct':
        body = {
          type: 'correct',
          score: { A: a.a, B: a.b },
          server: a.server,
          serverIdx: cfg.doubles ? a.serverIdx : 0,
        };
        break;
      default:
        body = { type: a.k };
    }
    if (body) push(body);
  }
  return events;
}

const logArb = (opts = { corrections: true, courtSwaps: true }) =>
  configArb.chain((cfg) =>
    fc.oneof(
      fc.array(actionArb(opts), { maxLength: 40 }),
      fc.array(actionArb(opts), { minLength: 100, maxLength: 400, size: 'max' }),
    ).map((actions) => ({ cfg, events: buildLog(cfg, actions) })),
  );

const RUNS = { numRuns: 300 };

describe('properties of the reducer', () => {
  it('seq is dense and ids are unique', () => {
    fc.assert(
      fc.property(logArb(), ({ events }) => {
        events.forEach((e, i) => expect(e.seq).toBe(i + 1));
        expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
      }),
      RUNS,
    );
  });

  it('replay is deterministic', () => {
    fc.assert(
      fc.property(logArb(), ({ cfg, events }) => {
        expect(reduce(cfg, events)).toEqual(reduce(cfg, structuredClone(events)));
      }),
      RUNS,
    );
  });

  it('undo then redo is the identity on state', () => {
    fc.assert(
      fc.property(logArb(), ({ cfg, events }) => {
        const u = undoBody(events);
        fc.pre(u !== null);
        const at = { at: 9e12, by: 'prop' };
        const undone = append(events, u!, { ...at, id: 'u' });
        const redone = append(undone, redoBody(undone)!, { ...at, id: 'r' });
        expect(reduce(cfg, redone)).toEqual(reduce(cfg, events));
      }),
      RUNS,
    );
  });

  it('undo equals replaying the log without its target', () => {
    fc.assert(
      fc.property(logArb(), ({ cfg, events }) => {
        const u = undoBody(events);
        fc.pre(u !== null && u.type === 'undo');
        const target = (u as { target: number }).target;
        const undone = append(events, u!, { at: 9e12, by: 'prop', id: 'u' });
        expect(reduce(cfg, undone)).toEqual(reduce(cfg, events.filter((e) => e.seq !== target)));
      }),
      RUNS,
    );
  });

  it('every prefix keeps the invariants', () => {
    fc.assert(
      fc.property(logArb({ corrections: true, courtSwaps: false }), ({ cfg, events }) => {
        for (let i = 1; i <= events.length; i++) {
          const s = reduce(cfg, events.slice(0, i));
          for (const t of ['A', 'B'] as Team[]) {
            expect(s.score[t]).toBeLessThanOrEqual(cfg.cap);
            expect(s.games[t]).toBeLessThanOrEqual(cfg.format === 'bestOf3' ? 2 : cfg.format === 'fixed2' ? 2 : 1);
            if (cfg.doubles) expect([s.pos[t].right, s.pos[t].left].sort()).toEqual([0, 1]);
          }
          // In doubles, without a courts.swap, the server stands in the court matching its score.
          if (cfg.doubles) expect(s.pos[s.server][parityCourt(s.score[s.server])]).toBe(s.serverIdx);
          // `winner` is null at match over exactly for a 1-1 in fixed 2.
          if (s.phase === 'matchOver') {
            const draw = cfg.format === 'fixed2' && s.games.A === 1 && s.games.B === 1;
            expect(s.winner === null).toBe(draw);
          }
          if (s.matchPoint) expect(s.gamePoint).toBe(s.matchPoint);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('a voided event is never itself an undo or redo', () => {
    fc.assert(
      fc.property(logArb(), ({ events }) => {
        const bySeq = new Map(events.map((e) => [e.seq, e]));
        for (const v of voidSet(events)) expect(['undo', 'redo']).not.toContain(bySeq.get(v)!.type);
      }),
      RUNS,
    );
  });
});

// ---- Parity with the mockup engine (the Phase 1 reference) ----

interface MockEngine {
  reduce(cfg: unknown, events: unknown[]): MatchState;
}

function loadMockEngine(): MockEngine {
  const html = readFileSync(new URL('../../docs/mockup/index.html', import.meta.url), 'utf8');
  const src = /<script id="engine">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!src) throw new Error('engine script not found in docs/mockup/index.html');
  const mod: { exports?: MockEngine } = {};
  new Function('module', src)(mod);
  return mod.exports!;
}

const COMPARED = [
  'phase',
  'game',
  'score',
  'games',
  'completed',
  'server',
  'serverIdx',
  'pos',
  'leftTeam',
  'winner',
  'pendingSwap',
  'intervalKind',
] as const;

describe('parity with docs/mockup/index.html', () => {
  const mock = loadMockEngine();
  const pick = (s: MatchState) => Object.fromEntries(COMPARED.map((k) => [k, s[k]]));

  it('matches the mockup on random matches (points, undo/redo, intervals, game starts, swaps)', () => {
    // Left out of these streams on purpose, where this engine deliberately differs from the mockup:
    // `correct` (here it also moves the game number, and a correction after a game ended reopens that game
    // instead of playing past the format) and `match.end` (undoable here).
    fc.assert(
      fc.property(logArb({ corrections: false, courtSwaps: true }), ({ cfg, events }) => {
        for (const n of [Math.ceil(events.length / 2), events.length]) {
          const prefix = events.slice(0, n);
          const mine = reduce(cfg, prefix);
          const ref = mock.reduce(cfg, prefix);
          expect(pick(mine)).toEqual(pick(ref));
          // Flags agree except at cap-1 all, where both teams have game point and this engine shows the server's.
          if (!(mine.score.A === cfg.cap - 1 && mine.score.B === cfg.cap - 1)) {
            expect([mine.gamePoint, mine.matchPoint]).toEqual([ref.gamePoint, ref.matchPoint]);
          }
        }
      }),
      RUNS,
    );
  });
});
