// This phone's links, created on first use and kept for the app's lifetime, like the match store and the
// camera controller: the scoreboard's one link to the camera, or the camera's slots for up to two
// scoreboards (D14). A page that comes back (screen on, back from the background, online again) checks its
// links at once (technical-design.md §4.5).
import { APP_BUILD } from '../build';
import { keepScreenOn } from '../device/wakeLock';
import { store } from '../match/live';
import { deviceId } from '../match/prefs';
import type { Role } from '../protocol/messages';
import { briefCapture } from './capture';
import { PairingDiag, loggedFetch } from './diag';
import { HelperClient } from './helper';
import { PeerLink } from './link';
import { loadPairing, loadShown, savePairing, saveShown } from './saved';
import { ScoreboardLink } from './scoreboard';
import { CameraPairing, SLOTS } from './slots';

let board: { link: PeerLink; board: ScoreboardLink } | null = null;
let camera: CameraPairing | null = null;
const diags: Partial<Record<Role, PairingDiag>> = {};

const ua = () => navigator.userAgent;

/** Screen on again, back from the background (bfcache), online again: check the links now. */
function onResume(fn: (why: string) => void): void {
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && fn('visible'));
  addEventListener('pageshow', (e) => fn((e as PageTransitionEvent).persisted ? 'pageshow (restored)' : 'pageshow'));
  addEventListener('online', () => fn('online'));
  document.addEventListener('resume', () => fn('resume'));
}

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
    onResume((why) => link.resume(why));
    // Paired, the screen stays on: a locked screen suspends the page and the link with it (D14).
    link.subscribe(() => keepScreenOn(link.paired, 'paired'));
    board = { link, board: b };
  }
  return board;
}

/** The camera's slots, one link per scoreboard; the log marks the second slot's lines. */
export function cameraPairing(): CameraPairing {
  if (!camera) {
    const diag = pairingDiag('camera');
    const helper = new HelperClient(undefined, loggedFetch(diag));
    const links = Array.from(
      { length: SLOTS },
      (_, i) =>
        new PeerLink({
          role: 'camera',
          helper,
          ensureCapture: briefCapture,
          log: (k, t) => diag.log(k, i ? `[scoreboard ${i + 1}] ${t}` : t),
          hello: () => ({ deviceId: deviceId(), app: APP_BUILD, ua: ua() }),
          saved: { load: () => loadPairing('camera', Date.now(), i), save: (p) => savePairing('camera', p, i) },
          shown: { load: () => loadShown('camera', i), save: (s) => saveShown('camera', s, i) },
        }),
    );
    const c = new CameraPairing(links);
    addEventListener('pagehide', () => c.leave());
    onResume((why) => c.resume(why));
    camera = c;
  }
  return camera;
}
