// The camera role's long-lived objects: one controller (canvas, worker, recorder) for the app's lifetime,
// and the two score sources it can follow in this version.
import { APP_BUILD } from '../../build';
import { LocalSource } from '../../link/local';
import { NoSource } from '../../link/none';
import type { PeerInfo } from '../../link/source';
import { store } from '../../match/live';
import { loadLogo } from '../../match/persist';
import { deviceId, loadCameraSettings, saveCameraSettings } from '../../match/prefs';
import { CameraController } from '../../recording/controller';
import { decodeLogo } from '../../recording/logo';

export const thisDevice = (): PeerInfo => ({ id: deviceId(), ua: navigator.userAgent, app: APP_BUILD });

let controller: CameraController | null = null;
let local: LocalSource | null = null;
const none = new NoSource();

export function cameraController(): CameraController {
  if (!controller) {
    const c = new CameraController(loadCameraSettings(), thisDevice());
    let saved = c.getSnapshot().settings;
    c.subscribe(() => {
      const s = c.getSnapshot().settings;
      if (s !== saved) saveCameraSettings((saved = s)); // R-SETUP-4 choices are kept per device
    });
    controller = c;
    loadLogo()
      .then((png) => png && decodeLogo(png))
      .then((logo) => logo && c.setLogo(logo))
      .catch(() => {}); // no logo stored, or it no longer decodes: run without one
  }
  return controller;
}

/** Same-phone source over the Phase 1 match store: "Demo score" in the camera menu. */
export function demoSource(): LocalSource {
  local ??= new LocalSource(store, thisDevice());
  return local;
}

export const notPaired = (): NoSource => none;
