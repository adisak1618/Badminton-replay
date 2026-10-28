// This phone's one link to the other phone, created on first use and kept for the app's lifetime, like the
// match store and the camera controller.
import { APP_BUILD } from '../build';
import { PeerSource } from '../link/peer';
import { store } from '../match/live';
import { deviceId } from '../match/prefs';
import { briefCapture } from './capture';
import { HelperClient } from './helper';
import { PeerLink } from './link';
import { ScoreboardLink } from './scoreboard';

let board: { link: PeerLink; board: ScoreboardLink } | null = null;
let camera: { link: PeerLink; source: PeerSource } | null = null;

const ua = () => navigator.userAgent;

export function scoreboardPairing(): { link: PeerLink; board: ScoreboardLink } {
  if (!board) {
    const link = new PeerLink({
      role: 'scoreboard',
      helper: new HelperClient(),
      ensureCapture: briefCapture,
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
    const link = new PeerLink({
      role: 'camera',
      helper: new HelperClient(),
      ensureCapture: briefCapture,
      hello: () => ({ deviceId: deviceId(), app: APP_BUILD, ua: ua() }),
    });
    addEventListener('pagehide', () => link.leave());
    camera = { link, source: new PeerSource(link) };
  }
  return camera;
}
