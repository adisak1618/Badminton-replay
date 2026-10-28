// The camera role's long-lived objects: one controller (canvas, worker, recorder) for the app's lifetime,
// and the two score sources it can follow in this version.
import { APP_BUILD } from '../../build';
import { LocalSource } from '../../link/local';
import { NoSource } from '../../link/none';
import type { PeerInfo } from '../../link/source';
import { store } from '../../match/live';
import { deviceId, loadCameraSettings } from '../../match/prefs';
import { CameraController } from '../../recording/controller';

export const thisDevice = (): PeerInfo => ({ id: deviceId(), ua: navigator.userAgent, app: APP_BUILD });

let controller: CameraController | null = null;
let local: LocalSource | null = null;
const none = new NoSource();

export function cameraController(): CameraController {
  controller ??= new CameraController(loadCameraSettings(), thisDevice());
  return controller;
}

/** Same-phone source over the Phase 1 match store: "Demo score" in the camera menu. */
export function demoSource(): LocalSource {
  local ??= new LocalSource(store, thisDevice());
  return local;
}

export const notPaired = (): NoSource => none;
