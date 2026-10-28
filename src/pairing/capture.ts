// WebKit withholds host ICE candidates until the page has camera or microphone permission, and with no STUN
// (D13) host candidates are all there is (technical-design.md §4.3, WebKit bug 174500). The camera phone has
// its preview; the scoreboard has the S2 viewfinder. When neither is live (a typed code, or a reconnect after
// the viewfinder closed, assumption A1) a camera track is opened briefly around the gathering.

/** Live capture tracks this page holds on purpose (viewfinder, camera preview). */
const live = new Set<() => boolean>();

/** Register something that holds capture while `isLive()` says so; returns an unregister. */
export function registerCapture(isLive: () => boolean): () => void {
  live.add(isLive);
  return () => live.delete(isLive);
}

const capturing = () => [...live].some((f) => f());

/** Safari, and every browser on iOS (all WebKit). Chrome and Firefox on desktop/Android expose mDNS candidates anyway. */
export function isWebKit(ua = navigator.userAgent): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/AppleWebKit/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua));
}

async function cameraGranted(): Promise<boolean> {
  try {
    return (await navigator.permissions.query({ name: 'camera' as PermissionName })).state === 'granted';
  } catch {
    return false;
  }
}

/**
 * Hold a camera track while candidates are gathered, if this browser needs it and nothing else holds one.
 * When pairing it may ask for permission (the user is looking at the pairing screen); during a reconnect it
 * only reopens a camera that is already allowed, so a match is never interrupted by a prompt.
 */
export async function briefCapture(why: 'pair' | 'reconnect'): Promise<(() => void) | void> {
  if (!isWebKit() || capturing() || !navigator.mediaDevices?.getUserMedia) return;
  if (why === 'reconnect' && !(await cameraGranted())) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    return () => s.getTracks().forEach((t) => t.stop());
  } catch {
    // denied or unavailable: gather anyway; pairing reports it if no local address comes out
  }
}
