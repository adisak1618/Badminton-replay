// This phone's one link to the other phone, created on first use and kept for the app's lifetime, like the
// match store and the camera controller.
import { APP_BUILD } from '../build';
import { PeerSource } from '../link/peer';
import { store } from '../match/live';
import { deviceId } from '../match/prefs';
import type { Role } from '../protocol/messages';
import { briefCapture } from './capture';
import { PairingDiag, loggedFetch } from './diag';
import { HelperClient } from './helper';
import { PeerLink } from './link';
import { ScoreboardLink } from './scoreboard';

let board: { link: PeerLink; board: ScoreboardLink } | null = null;
let camera: { link: PeerLink; source: PeerSource } | null = null;
const diags: Partial<Record<Role, PairingDiag>> = {};

const ua = () => navigator.userAgent;

/** This phone's pairing log for a role (⋯ › Pairing diagnostics). */
export function pairingDiag(role: Role): PairingDiag {
  let d = diags[role];
  if (!d) {
    d = diags[role] = new PairingDiag(role);
    d.log('app', `started ${APP_BUILD}`);
    addEventListener('pagehide', () => d!.flush());
  }
  return d;
}

export function scoreboardPairing(): { link: PeerLink; board: ScoreboardLink } {
  if (!board) {
    const diag = pairingDiag('scoreboard');
    const link = new PeerLink({
      role: 'scoreboard',
      helper: new HelperClient(undefined, loggedFetch(diag)),
      ensureCapture: briefCapture,
      log: (k, t) => diag.log(k, t),
      hello: () => {
        const m = store.getSnapshot().match;
        return { deviceId: deviceId(), app: APP_BUILD, ua: ua(), matchId: m?.matchId, lastSeq: m?.events.at(-1)?.seq };
      },
    });
    const b = new ScoreboardLink(link, store);
    setInterval(() => b.tick(), 1000);
    addEventListener('pagehide', () => link.leave());
    board = { link, board: b };
  }
  return board;
}

export function cameraPairing(): { link: PeerLink; source: PeerSource } {
  if (!camera) {
    const diag = pairingDiag('camera');
    const link = new PeerLink({
      role: 'camera',
      helper: new HelperClient(undefined, loggedFetch(diag)),
      ensureCapture: briefCapture,
      log: (k, t) => diag.log(k, t),
      hello: () => ({ deviceId: deviceId(), app: APP_BUILD, ua: ua() }),
    });
    addEventListener('pagehide', () => link.leave());
    camera = { link, source: new PeerSource(link) };
  }
  return camera;
}
