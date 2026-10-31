// The service worker's registration, so a screen can ask for a newer build. The app updates under
// registerType 'prompt' (vite.config.ts): a new build waits until every page of the app is closed or Update now
// is tapped, and an open page only looked for one when it was loaded. Pairing a phone on an older build with one
// on today's can fail before the version check could run (2026-10-30), so the role and pairing screens and every
// return to the app look again (App.tsx).
let registration: ServiceWorkerRegistration | undefined;

export function setRegistration(r: ServiceWorkerRegistration | undefined): void {
  registration = r;
}

/** Look for a newer build now; when there is one, `needRefresh` turns true and Update now shows. */
export function checkForUpdate(): void {
  void registration?.update().catch(() => {});
}
