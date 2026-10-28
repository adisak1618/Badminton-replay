// The data-channel protocol between the camera and each scoreboard (technical-design.md §4.4) and hand-written
// guards for everything that arrives. Unknown `t` is ignored; an unsupported `v` is answered with `bye`
// (R-PAIR-7). Version 2 (D14): the camera holds the match; scoreboards send inputs and render what it sends.
// Version 3 (D15): tag events. From 3 on an event or input of a type this build does not know is kept (the
// reducer passes over it, the camera answers such an input 'ignored'), so a new event type needs no new version.
import { EVENT_TYPES, SHOTS, type Input, type InputResult, type MatchConfig, type MatchEvent } from '../engine';
import type { RecReport } from '../link/source';

export const PROTOCOL_VERSION = 3;
/** Every message stays under this (MDN: large messages block the channel; SDP default is 64 kB). */
export const MAX_MESSAGE_BYTES = 16_000;

export type Role = 'scoreboard' | 'camera';

type Part = [index: number, count: number];

export type Msg =
  | { v: 3; t: 'hello'; role: Role; deviceId: string; app: string; ua?: string; matchId?: string; lastSeq?: number }
  | { v: 3; t: 'ping'; id: number; t0: number }
  | { v: 3; t: 'pong'; id: number; t0: number; t1: number; t2: number }
  // scoreboard -> camera: its live match, offered when the camera holds none (the camera adopts it)
  | { v: 3; t: 'sync'; matchId: string; config: MatchConfig; events: MatchEvent[]; part?: Part }
  // camera -> scoreboard: the whole match it holds, or none (matchId null), on every open and on request
  | { v: 3; t: 'state'; matchId: string | null; config?: MatchConfig; events?: MatchEvent[]; part?: Part }
  // camera -> scoreboard: one event the camera applied, in order (its seq is the log's length)
  | { v: 3; t: 'event'; matchId: string; event: MatchEvent }
  // scoreboard -> camera: a tap or a menu action, for the camera to apply
  | { v: 3; t: 'input'; matchId: string; input: Input }
  // camera -> the scoreboard that sent the input: what became of it
  | { v: 3; t: 'result'; id: string; result: InputResult }
  // scoreboard -> camera: its copy has a gap, send the whole state again
  | { v: 3; t: 'resync' }
  // camera -> scoreboard: how many scoreboards are linked right now
  | { v: 3; t: 'peers'; count: number }
  | ({ v: 3; t: 'rec' } & RecReport)
  | { v: 3; t: 'cmd'; id: string; action: 'rec.start' | 'rec.stop' }
  | { v: 3; t: 'ack'; id: string; ok: boolean; error?: string }
  | { v: 3; t: 'bye'; reason?: 'version' | 'leaving' | 'unpaired' };

export type MsgOf<T extends Msg['t']> = Extract<Msg, { t: T }>;

/** What `parse` makes of one incoming frame. */
export type Parsed =
  | { kind: 'msg'; msg: Msg }
  | { kind: 'version'; v: unknown; app?: string } // another protocol version: R-PAIR-7
  | { kind: 'ignore' }; // malformed, or a type this version does not know

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isTeam = (x: unknown) => x === 'A' || x === 'B';
const optNum = (x: unknown) => x === undefined || isNum(x);
const optStr = (x: unknown) => x === undefined || isStr(x);
const isScore = (x: unknown) => isObj(x) && isNum(x.A) && isNum(x.B);
const isRef = (x: unknown) => isObj(x) && isTeam(x.team) && Number.isInteger(x.idx);
const optRef = (x: unknown) => x === undefined || isRef(x);
const HOWS = new Set(['winner', 'forced', 'unforced']);

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
  if (!isObj(x) || !isNum(x.seq) || !isStr(x.id) || !isNum(x.at) || !isStr(x.by)) return false;
  return isBody(x, true);
}

/** An input: undo and redo carry no target (the camera picks it). */
export function isInput(x: unknown): x is Input {
  return isObj(x) && isStr(x.id) && isNum(x.at) && isStr(x.by) && isObj(x.body) && isBody(x.body, false);
}

function isBody(x: Obj, targeted: boolean): boolean {
  if (!isStr(x.type)) return false;
  if (!EVENT_TYPES.has(x.type)) return true; // a newer build's type: kept, passed over (see the header)
  switch (x.type) {
    case 'match.start':
      return isMatchConfig(x.config);
    case 'point':
    case 'courts.swap':
      return isTeam(x.team);
    case 'undo':
    case 'redo':
      return targeted ? isNum(x.target) : x.target === undefined;
    case 'correct':
      return isScore(x.score) && isTeam(x.server) && (x.games === undefined || isScore(x.games));
    case 'server.set':
      return isTeam(x.team) && optNum(x.idx);
    case 'game.start':
      return isNum(x.game) && optNum(x.serverIdx) && optNum(x.receiverIdx);
    case 'match.end':
      return x.reason === 'won' || x.reason === 'abandoned';
    case 'tag':
      return (
        isStr(x.point) &&
        HOWS.has(x.how as string) &&
        isRef(x.hit) &&
        optRef(x.forcedBy) &&
        optRef(x.assist) &&
        (x.shot === undefined || (SHOTS as readonly unknown[]).includes(x.shot))
      );
    case 'tag.clear':
      return isStr(x.point);
    default:
      return true; // sides.swap, interval.end
  }
}

const REC_STATES = new Set(['idle', 'recording', 'stopping', 'error']);
const RESULTS = new Set(['applied', 'duplicate', 'ignored']);

const isPart = (p: unknown) =>
  p === undefined || (Array.isArray(p) && p.length === 2 && p.every((n) => Number.isInteger(n)) && p[0] >= 0 && p[0] < p[1]);

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
      return isStr(x.matchId) && isMatchEvent(x.event);
    case 'sync':
      return isStr(x.matchId) && isMatchConfig(x.config) && Array.isArray(x.events) && x.events.every(isMatchEvent) && isPart(x.part);
    case 'state':
      if (x.matchId === null) return x.config === undefined && x.events === undefined && x.part === undefined;
      return isStr(x.matchId) && isMatchConfig(x.config) && Array.isArray(x.events) && x.events.every(isMatchEvent) && isPart(x.part);
    case 'input':
      return isStr(x.matchId) && isInput(x.input);
    case 'result':
      return isStr(x.id) && RESULTS.has(x.result as string);
    case 'resync':
      return true;
    case 'peers':
      return Number.isInteger(x.count) && (x.count as number) >= 0;
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
