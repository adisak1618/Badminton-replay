// Screen Wake Lock while a match is live (R-DISP-8): requested on "Start match", re-requested when the page
// becomes visible again (the lock is released whenever the page is hidden).
let wanted = false;
let sentinel: WakeLockSentinel | null = null;

async function request(): Promise<void> {
  if (!wanted || sentinel || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    // Not allowed right now (no gesture yet, low battery mode); retried on the next visibility change or tap.
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => void request());
}

export function keepScreenOn(on: boolean): void {
  wanted = on;
  if (on) void request();
  else {
    void sentinel?.release();
    sentinel = null;
  }
}

export const screenLockHeld = (): boolean => sentinel !== null;
