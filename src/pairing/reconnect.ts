// When the link is down, what to do next (technical-design.md §4.5, R-PAIR-8). Pure, so the timings are
// tested without a network:
// - both phones ping every 2 s; 3 missed pongs mark the link down and the chip "reconnecting" (amber), and
//   after 30 s down it turns red ("link lost") while the phones keep trying;
// - the camera (the offerer) restarts ICE through the helper's mailbox when ICE reports `failed` or after
//   10 s without pongs, and builds a fresh connection when the channel is gone or a restart did not bring
//   the link back;
// - the waiting side polls the helper every 2 s for the first minute, then every 5 s, and every 5 s while
//   the helper is unreachable ("offline"); the camera polls faster while a link is down (1 s for the first
//   two minutes) because a scoreboard coming back may have posted its own offer;
// - a phone whose page comes back (screen on, `pageshow`, `online`) probes the link with one ping: no pong
//   within PROBE_MS, or a connection that already says it failed, and the link counts as dead at once. iOS
//   suspends the page while the screen is locked, so a connection from before is not trusted: the scoreboard
//   answers the camera's waiting offer when it is a fresh one, else offers a fresh connection itself.
import type { LinkState } from '../link/source';

export const PING_EVERY_MS = 2000;
export const DOWN_AFTER_MS = 3 * PING_EVERY_MS + 500; // three missed pongs
export const RESTART_AFTER_MS = 10_000;
export const LOST_AFTER_MS = 30_000;
/** From an answer applied to the link alive again; past it the next attempt is a fresh connection. */
export const ATTEMPT_TIMEOUT_MS = 10_000;
export const POLL_FAST_MS = 2000;
export const POLL_SLOW_MS = 5000;
export const FAST_FOR_MS = 60_000;
/** While the link is up the scoreboard still looks for a new offer now and then, in case only the camera saw a drop. */
export const POLL_IDLE_MS = 15_000;
/** The camera while a link is down, for CAMERA_FAST_FOR_MS, then 2 s up to CAMERA_SLOW_AFTER_MS, then 5 s. */
export const POLL_DOWN_MS = 1000;
export const CAMERA_FAST_FOR_MS = 2 * 60_000;
export const CAMERA_SLOW_AFTER_MS = 10 * 60_000;
/** A phone that posted its own offer looks for the answer this often while the attempt is young. */
export const POLL_ANSWER_MS = 500;
/** On resume: the one ping's deadline. */
export const PROBE_MS = 1000;

/** Why the link is down: missed pongs, ICE `failed`, or the channel/connection is gone (or the peer left). */
export type DownCause = 'pongs' | 'ice-failed' | 'closed';

export interface Down {
  since: number;
  cause: DownCause;
}

export interface Attempt {
  kind: 'restart' | 'fresh';
  gen: number;
  startedAt: number;
  /** When the scoreboard's answer was applied; null while waiting for it. */
  answeredAt: number | null;
}

export type Next = 'wait' | 'restart' | 'fresh';

/**
 * The camera's next step while the link is down. `canRestart` is false when the connection or its channel is
 * no longer usable, so only a fresh connection can help.
 */
export function nextAttempt(now: number, down: Down, attempt: Attempt | null, canRestart: boolean): Next {
  if (attempt) {
    if (attempt.answeredAt == null) return 'wait'; // the scoreboard answers when it is back online
    return now - attempt.answeredAt >= ATTEMPT_TIMEOUT_MS ? 'fresh' : 'wait';
  }
  const restart: Next = canRestart ? 'restart' : 'fresh';
  if (down.cause === 'closed') return 'fresh';
  if (down.cause === 'ice-failed') return restart;
  return now - down.since >= RESTART_AFTER_MS ? restart : 'wait';
}

/** How often the side that is waiting on the helper polls it. */
export function pollEvery(now: number, down: Down | null, offline: boolean): number {
  if (offline) return POLL_SLOW_MS;
  if (!down) return POLL_IDLE_MS;
  return now - down.since < FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS;
}

/** The camera's cadence while a link is down: a returning scoreboard's own offer is picked up within a second. */
export function cameraPollEvery(now: number, down: Down | null, offline: boolean): number {
  if (offline) return POLL_SLOW_MS;
  if (!down) return POLL_IDLE_MS;
  const d = now - down.since;
  return d < CAMERA_FAST_FOR_MS ? POLL_DOWN_MS : d < CAMERA_SLOW_AFTER_MS ? POLL_FAST_MS : POLL_SLOW_MS;
}

/** A phone waiting for the answer to its own offer: every 500 ms while the attempt is young. */
export function answerPollEvery(now: number, startedAt: number, fallback: number): number {
  return now - startedAt < ATTEMPT_TIMEOUT_MS ? POLL_ANSWER_MS : fallback;
}

export interface ConnectionFacts {
  /** The data channel is open and the last check found the link alive. */
  channelOpen: boolean;
  connectionState: RTCPeerConnectionState | 'none';
  iceConnectionState: RTCIceConnectionState | 'none';
}

/**
 * The page is visible again (screen on, `pageshow`, `online`): 'probe' with one ping and a PROBE_MS deadline
 * when the connection still says it is up, else 'recover' at once.
 */
export function resumeAction(f: ConnectionFacts): 'probe' | 'recover' {
  if (!f.channelOpen) return 'recover';
  if (f.connectionState === 'none' || f.connectionState === 'failed' || f.connectionState === 'closed' || f.connectionState === 'disconnected') return 'recover';
  if (f.iceConnectionState === 'failed' || f.iceConnectionState === 'disconnected' || f.iceConnectionState === 'closed') return 'recover';
  return 'probe';
}

/**
 * A scoreboard recovering after a resume, given the camera's newest offer: a fresh one is answered (the
 * quickest way back); an ICE restart of the connection from before the screen locked is not trusted, the
 * scoreboard offers a fresh connection instead, as it does when there is no offer at all.
 */
export function resumeReply(offer: { fresh: boolean } | null): 'answer' | 'offer' {
  return offer?.fresh ? 'answer' : 'offer';
}

/** The pongs have stopped: the last one (or the channel opening) is older than three ping intervals. */
export function pongsMissed(now: number, lastPongAt: number): boolean {
  return now - lastPongAt > DOWN_AFTER_MS;
}

/** The chip (R-DISP-9): amber while reconnecting, red after 30 s or when the helper is unreachable. */
export function chipState(now: number, down: Down | null, offline: boolean): LinkState {
  if (!down) return 'paired';
  if (offline) return 'offline';
  return now - down.since >= LOST_AFTER_MS ? 'lost' : 'reconnecting';
}
