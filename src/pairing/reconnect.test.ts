// The reconnect state machine's timings (technical-design.md §4.5, R-PAIR-8, R-DISP-9).
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_TIMEOUT_MS,
  DOWN_AFTER_MS,
  LOST_AFTER_MS,
  POLL_FAST_MS,
  POLL_IDLE_MS,
  POLL_SLOW_MS,
  RESTART_AFTER_MS,
  chipState,
  nextAttempt,
  pollEvery,
  pongsMissed,
  type Attempt,
  type Down,
} from './reconnect';

const T = 1_000_000;

describe('reconnect policy', () => {
  it('three missed pongs mark the link down (amber), 30 s turns it red, no helper is offline', () => {
    expect(pongsMissed(T + 6000, T)).toBe(false);
    expect(pongsMissed(T + DOWN_AFTER_MS + 1, T)).toBe(true);
    const down: Down = { since: T, cause: 'pongs' };
    expect(chipState(T + 6500, null, false)).toBe('paired');
    expect(chipState(T + 6500, down, false)).toBe('reconnecting');
    expect(chipState(T + LOST_AFTER_MS - 1, down, false)).toBe('reconnecting');
    expect(chipState(T + LOST_AFTER_MS, down, false)).toBe('lost');
    expect(chipState(T + 1000, down, true)).toBe('offline');
  });

  it('missed pongs: wait, then an ICE restart 10 s after the last pong', () => {
    const down: Down = { since: T, cause: 'pongs' };
    expect(nextAttempt(T + 6500, down, null, true)).toBe('wait');
    expect(nextAttempt(T + RESTART_AFTER_MS, down, null, true)).toBe('restart');
    expect(nextAttempt(T + RESTART_AFTER_MS, down, null, false)).toBe('fresh'); // the connection is unusable
  });

  it('ICE failed restarts at once; a closed channel or a peer that left goes straight to a fresh connection', () => {
    expect(nextAttempt(T, { since: T, cause: 'ice-failed' }, null, true)).toBe('restart');
    expect(nextAttempt(T, { since: T, cause: 'closed' }, null, true)).toBe('fresh');
  });

  it('an attempt waits for its answer however long the scoreboard is away, then 10 s for the link', () => {
    const down: Down = { since: T, cause: 'pongs' };
    const waiting: Attempt = { kind: 'restart', gen: 2, startedAt: T + 10_000, answeredAt: null };
    expect(nextAttempt(T + 600_000, down, waiting, true)).toBe('wait');
    const answered: Attempt = { ...waiting, answeredAt: T + 12_000 };
    expect(nextAttempt(T + 12_000 + ATTEMPT_TIMEOUT_MS - 1, down, answered, true)).toBe('wait');
    expect(nextAttempt(T + 12_000 + ATTEMPT_TIMEOUT_MS, down, answered, true)).toBe('fresh');
    const fresh: Attempt = { kind: 'fresh', gen: 3, startedAt: T + 22_000, answeredAt: T + 23_000 };
    expect(nextAttempt(T + 23_000 + ATTEMPT_TIMEOUT_MS, down, fresh, true)).toBe('fresh'); // and again, until it works
  });

  it('polls every 2 s for the first minute down, then 5 s; 5 s while offline; 15 s while the link is up', () => {
    const down: Down = { since: T, cause: 'pongs' };
    expect(pollEvery(T + 1000, down, false)).toBe(POLL_FAST_MS);
    expect(pollEvery(T + 59_999, down, false)).toBe(POLL_FAST_MS);
    expect(pollEvery(T + 60_000, down, false)).toBe(POLL_SLOW_MS);
    expect(pollEvery(T + 1000, down, true)).toBe(POLL_SLOW_MS);
    expect(pollEvery(T, null, false)).toBe(POLL_IDLE_MS);
  });

  it('the airplane-mode acceptance budget: back within 15 s of the network returning', () => {
    // Worst case after the network returns: the camera's pending attempt is picked up by the scoreboard's
    // next poll (<= 5 s once past the first minute), then the camera's next answer poll (<= 5 s), then the
    // connection itself (a LAN connect takes well under a second).
    expect(POLL_SLOW_MS + POLL_SLOW_MS + 1000).toBeLessThanOrEqual(15_000);
  });
});
