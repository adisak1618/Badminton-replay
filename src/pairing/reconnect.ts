// When the link is down, what to do next (technical-design.md §4.5, R-PAIR-8). Pure, so the timings are
// tested without a network:
// - both phones ping every 2 s; 3 missed pongs mark the link down and the chip "reconnecting" (amber), and
//   after 30 s down it turns red ("link lost") while the phones keep trying;
// - the camera (the offerer) restarts ICE through the helper's mailbox when ICE reports `failed` or after
//   10 s without pongs, and builds a fresh connection when the channel is gone or a restart did not bring
//   the link back;
// - the waiting side polls the helper every 2 s for the first minute, then every 5 s, and every 5 s while
//   the helper is unreachable ("offline").
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
