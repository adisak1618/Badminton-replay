// What the pairing screens say when something goes wrong (ux-design.md E1).
import type { Mismatch, PairError } from '../pairing/link';
import type { Unreachable } from '../pairing/unreachable';
import type { Role } from '../protocol/messages';

export { SLOW_CONNECT_MS } from '../pairing/link';

export const NO_INTERNET = 'No internet: cannot pair. Scoring and recording still work on each phone.';

export function pairErrorText(e: PairError, role: Role = 'scoreboard'): string {
  switch (e.kind) {
    case 'offline':
      return NO_INTERNET;
    case 'no-room':
      return 'That code was not found: it is wrong, already used, or more than 10 minutes old. Check the digits on the camera phone (it shows a new code by itself).';
    case 'no-session':
    case 'expired':
      return 'The pairing has expired. Pair again.';
    case 'rate-limited':
      return 'Too many tries. Wait a minute, then try again.';
    case 'helper':
      return `The pairing helper is not working (${e.detail ?? 'error'}). Each phone still works alone.`;
    case 'no-candidates':
      return 'This phone offered no local-network address. Allow camera access for this site (Settings › Apps › Safari › Camera), then pair again.';
    case 'unreachable':
      return e.why ? unreachableText(e.why, role) : 'Could not connect. Pair again.';
    case 'withdrawn':
      return role === 'scoreboard'
        ? 'The camera phone no longer offers this code (it showed a new one, or its pairing screen was closed). Type the code it shows now.'
        : 'The scoreboard phone ended the pairing. Show a new code and pair again.';
    default:
      return `Pairing failed${e.detail ? ` (${e.detail})` : ''}. Try again.`;
  }
}

/** R-PAIR-7. A reload does not update an app under its service worker: Update now does (App.tsx). */
export function mismatchText(m: Mismatch): string {
  return m.newer === 'other'
    ? 'This phone runs an older version of the app. Update it (Update now, or close the app fully and open it again), then pair again.'
    : 'The other phone runs an older version of the app. Update it there (Update now in its menu, or close the app fully and open it again), then pair again.';
}

/** Shown on the pairing screens while a first pairing has not opened SLOW_CONNECT_MS after the answer. */
export const SLOW_CONNECT_TEXT = 'Still connecting…';

/**
 * Why a first pairing could not open (unreachable.ts), from this phone's side. Phones on different networks are
 * named with their two addresses, as before; the reason names the phone to fix.
 */
export function unreachableText(u: Unreachable, role: Role): string {
  const other = role === 'camera' ? 'the scoreboard phone' : 'the camera phone';
  const nets =
    u.verdict === 'different' && u.mine[0] && u.theirs[0]
      ? `the phones are on different networks (this phone ${u.mine[0]}, the other ${u.theirs[0]}), probably mobile data, and `
      : '';
  switch (u.reason) {
    case 'no-relay':
      return `Could not connect: ${nets}the internet relay is not set up. Put both phones on the same Wi-Fi, or turn on Personal Hotspot on one phone and join its Wi-Fi from the other, then pair again.`;
    case 'no-relay-here':
      return `Could not connect: ${nets}this phone could not use the internet relay (${u.detail ?? 'error'}). Check this phone's internet connection, then pair again.`;
    case 'no-relay-there':
      return u.peerOld
        ? `Could not connect: ${nets}${other} cannot use the internet relay; it probably runs an older version of the app. On ${other}, close the app fully and open it again (tap Update now if it shows), then pair again.`
        : `Could not connect: ${nets}${other} could not use the internet relay (${u.detail ?? 'error'}). Check its internet connection, then pair again.`;
    case 'relay-blocked':
      return `Could not connect: ${nets}both phones reached the internet relay but not each other. Pair again; if it fails again, put both phones on the same Wi-Fi or hotspot.`;
    case 'same-network':
      return 'Could not connect: the phones seem to be on the same network but cannot reach each other (the Wi-Fi may keep devices apart). Turn on Personal Hotspot on one phone and join its Wi-Fi from the other, then pair again.';
  }
}
