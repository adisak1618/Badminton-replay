// The data-channel protocol between the two phones (technical-design.md §4.4) and hand-written guards for
// everything that arrives. Unknown `t` is ignored; an unsupported `v` is answered with `bye` (R-PAIR-7).
import type { MatchConfig, MatchEvent } from '../engine';
import type { RecReport } from '../link/source';

export const PROTOCOL_VERSION = 1;
/** Every message stays under this (MDN: large messages block the channel; SDP default is 64 kB). */
export const MAX_MESSAGE_BYTES = 16_000;

export type Role = 'scoreboard' | 'camera';

export type Msg =
  | { v: 1; t: 'hello'; role: Role; deviceId: string; app: string; ua?: string; matchId?: string; lastSeq?: number }
  | { v: 1; t: 'ping'; id: number; t0: number }
  | { v: 1; t: 'pong'; id: number; t0: number; t1: number; t2: number }
  | { v: 1; t: 'event'; event: MatchEvent }
  | { v: 1; t: 'sync'; matchId: string; config: MatchConfig; events: MatchEvent[]; part?: [index: number, count: number] }
  | ({ v: 1; t: 'rec' } & RecReport)
  | { v: 1; t: 'cmd'; id: string; action: 'rec.start' | 'rec.stop' }
  | { v: 1; t: 'ack'; id: string; ok: boolean; error?: string }
  | { v: 1; t: 'bye'; reason?: 'version' | 'leaving' | 'unpaired' };

export type MsgOf<T extends Msg['t']> = Extract<Msg, { t: T }>;

/** What `parse` makes of one incoming frame. */
export type Parsed =
  | { kind: 'msg'; msg: Msg }
  | { kind: 'version'; v: unknown; app?: string } // another protocol version: R-PAIR-7
  | { kind: 'ignore' }; // malformed, or a type this version does not know

const EVENT_TYPES = new Set([
  'match.start',
  'point',
  'undo',
  'redo',
  'correct',
  'sides.swap',
  'courts.swap',
  'server.set',
  'interval.end',
  'game.start',
  'match.end',
]);

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isTeam = (x: unknown) => x === 'A' || x === 'B';
const optNum = (x: unknown) => x === undefined || isNum(x);
const optStr = (x: unknown) => x === undefined || isStr(x);
const isScore = (x: unknown) => isObj(x) && isNum(x.A) && isNum(x.B);

export function isMatchConfig(x: unknown): x is MatchConfig {
  if (!isObj(x) || !isObj(x.teams) || !isObj(x.intervalMs) || !isObj(x.startRight)) return false;
  const team = (t: unknown) => isObj(t) && isStr(t.name) && isStr(t.color) && Array.isArray(t.players) && t.players.every(isStr);
  return (
    (x.pointsToWin === 11 || x.pointsToWin === 15 || x.pointsToWin === 21) &&
    isNum(x.cap) &&
    (x.format === 'bestOf3' || x.format === 'fixed2' || x.format === 'fixed1') &&
    (x.intervalAt === null || isNum(x.intervalAt)) &&
    typeof x.doubles === 'boolean' &&
    team(x.teams.A) &&
    team(x.teams.B) &&
    isTeam(x.firstServer) &&
    isTeam(x.leftTeamAtStart)
  );
}

export function isMatchEvent(x: unknown): x is MatchEvent {
  if (!isObj(x) || !isNum(x.seq) || !isStr(x.id) || !isNum(x.at) || !isStr(x.by) || !EVENT_TYPES.has(x.type as string)) return false;
  switch (x.type) {
    case 'match.start':
      return isMatchConfig(x.config);
    case 'point':
    case 'courts.swap':
      return isTeam(x.team);
    case 'undo':
    case 'redo':
      return isNum(x.target);
    case 'correct':
      return isScore(x.score) && isTeam(x.server) && (x.games === undefined || isScore(x.games));
    case 'server.set':
      return isTeam(x.team) && optNum(x.idx);
    case 'game.start':
      return isNum(x.game) && optNum(x.serverIdx) && optNum(x.receiverIdx);
    case 'match.end':
      return x.reason === 'won' || x.reason === 'abandoned';
    default:
      return true; // sides.swap, interval.end
  }
}

const REC_STATES = new Set(['idle', 'recording', 'stopping', 'error']);

function guard(x: Obj): boolean {
  switch (x.t) {
    case 'hello':
      return (
        (x.role === 'scoreboard' || x.role === 'camera') &&
        isStr(x.deviceId) &&
        isStr(x.app) &&
        optStr(x.ua) &&
        optStr(x.matchId) &&
        optNum(x.lastSeq)
      );
    case 'ping':
      return isNum(x.id) && isNum(x.t0);
    case 'pong':
      return isNum(x.id) && isNum(x.t0) && isNum(x.t1) && isNum(x.t2);
    case 'event':
      return isMatchEvent(x.event);
    case 'sync':
      return (
        isStr(x.matchId) &&
        isMatchConfig(x.config) &&
        Array.isArray(x.events) &&
        x.events.every(isMatchEvent) &&
        (x.part === undefined ||
          (Array.isArray(x.part) && x.part.length === 2 && x.part.every((n) => Number.isInteger(n)) && x.part[0] >= 0 && x.part[0] < x.part[1]))
      );
    case 'rec':
      return (
        REC_STATES.has(x.state as string) &&
        optNum(x.segment) &&
        optNum(x.startedAt) &&
        optNum(x.elapsedMs) &&
        optNum(x.bytes) &&
        optNum(x.minutesLeft) &&
        optStr(x.error)
      );
    case 'cmd':
      return isStr(x.id) && (x.action === 'rec.start' || x.action === 'rec.stop');
    case 'ack':
      return isStr(x.id) && typeof x.ok === 'boolean' && optStr(x.error);
    case 'bye':
      return x.reason === undefined || x.reason === 'version' || x.reason === 'leaving' || x.reason === 'unpaired';
    default:
      return false;
  }
}

/** Decode one data-channel frame. */
export function parse(raw: unknown): Parsed {
  let x: unknown = raw;
  if (typeof raw === 'string') {
    try {
      x = JSON.parse(raw);
    } catch {
      return { kind: 'ignore' };
    }
  }
  if (!isObj(x)) return { kind: 'ignore' };
  if (x.v !== PROTOCOL_VERSION) return { kind: 'version', v: x.v, app: isStr(x.app) ? x.app : undefined };
  return guard(x) ? { kind: 'msg', msg: x as Msg } : { kind: 'ignore' };
}

type Body<M> = M extends Msg ? Omit<M, 'v'> : never;

/** Encode a message with the current protocol version. */
export function encode(body: Body<Msg>): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...body });
}
