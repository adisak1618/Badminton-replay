// Screen Wake Lock (R-DISP-8): held while anything wants it — a live match, a paired scoreboard (D14: a
// locked screen suspends the page and with it the link), the pairing screen, a recording. Requested as soon
// as it is wanted, and again on every visibility change and every tap (the lock is released whenever the page
// is hidden, and WebKit may refuse it without a user gesture or in Low Power Mode). Its status is shown, so
// the user knows when the screen may lock after all.
export type WakeReason = 'match' | 'paired' | 'pairing' | 'recording';
/** held; refused (the request failed: Low Power Mode, no gesture yet); unavailable (no API: iOS before 16.4, or 18.4 in a Home Screen app); off (not wanted). */
export type WakeStatus = 'held' | 'refused' | 'unavailable' | 'off';

const wanted = new Set<WakeReason>();
let sentinel: WakeLockSentinel | null = null;
let pending = false;
let status: WakeStatus = 'off';
const listeners = new Set<() => void>();

function setStatus(s: WakeStatus): void {
  if (s === status) return;
  status = s;
  for (const fn of listeners) fn();
}

async function request(): Promise<void> {
  if (!wanted.size) return setStatus('off');
  if (!('wakeLock' in navigator)) return setStatus('unavailable');
  if (sentinel || pending || document.visibilityState !== 'visible') return;
  pending = true;
  try {
    const s = await navigator.wakeLock.request('screen');
    sentinel = s;
    s.addEventListener('release', () => {
      if (sentinel === s) sentinel = null;
      setStatus(wanted.size ? 'refused' : 'off'); // released by the system: retried on the next tap or return
      if (wanted.size && document.visibilityState === 'visible') void request();
    });
    setStatus(wanted.size ? 'held' : 'off');
    if (!wanted.size) void release();
  } catch {
    // Not allowed right now (no gesture yet, Low Power Mode); retried on the next visibility change or tap.
    setStatus('refused');
  } finally {
    pending = false;
  }
}

async function release(): Promise<void> {
  const s = sentinel;
  sentinel = null;
  setStatus('off');
  await s?.release().catch(() => {});
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => void request());
  // A tap is a user gesture: the moment a refused request is most likely to succeed.
  document.addEventListener('pointerdown', () => void request(), { capture: true, passive: true });
}

/** Want (or stop wanting) the screen on for one reason; the lock is held while any reason wants it. */
export function keepScreenOn(on: boolean, reason: WakeReason = 'match'): void {
  if (on) wanted.add(reason);
  else wanted.delete(reason);
  if (wanted.size) void request();
  else void release();
}

export const screenLockHeld = (): boolean => sentinel !== null;

export const wakeStatus = (): WakeStatus => status;

export function subscribeWake(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** One line for the user when the screen may lock after all (null when there is nothing to say). */
export function wakeHint(s: WakeStatus): string | null {
  if (s === 'refused') return 'The screen may lock (Low Power Mode?): tap the screen now and then, or turn Low Power Mode off.';
  if (s === 'unavailable') return 'This browser cannot keep the screen on: set Auto-Lock to Never while scoring.';
  return null;
}
