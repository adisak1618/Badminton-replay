// What the pairing screens say when something goes wrong (ux-design.md E1).
import { relayReason, type RelayStatus } from '../pairing/ice';
import type { Mismatch, PairError } from '../pairing/link';
import type { NetCheck } from '../pairing/net';

export { SLOW_CONNECT_MS } from '../pairing/link';

export const NO_INTERNET = 'No internet: cannot pair. Scoring and recording still work on each phone.';

export function pairErrorText(e: PairError): string {
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
    default:
      return `Pairing failed${e.detail ? ` (${e.detail})` : ''}. Try again.`;
  }
}

/** R-PAIR-7 */
export function mismatchText(m: Mismatch): string {
  return m.newer === 'other'
    ? 'Update the app on this phone (reload it), then pair again.'
    : 'Update the app on the other phone, then pair again.';
}

/** Shown on the pairing screens when the link stays in "connecting" SLOW_CONNECT_MS after the answer. */
export const SLOW_CONNECT_TEXT =
  'Still connecting. Both phones must be on the same Wi-Fi or hotspot, and that network must let devices see each other.';
export const SLOW_RELAY_TEXT =
  'Still connecting. If it does not connect, put both phones on the same Wi-Fi, or turn on Personal Hotspot on one phone and join its Wi-Fi from the other.';

/**
 * The slow-connect line. Phones on different networks connect through the relay when it works, so the line
 * names the two addresses together with why the relay did not carry the link (ice.ts relayReason).
 */
export function slowConnectText(net: NetCheck | null, relay: RelayStatus = { state: 'unknown' }): string {
  if (net?.verdict !== 'different') return relay.state === 'ready' ? SLOW_RELAY_TEXT : SLOW_CONNECT_TEXT;
  return (
    `Not connecting: the phones are on different networks (this phone ${net.mine[0]}, the other ${net.theirs[0]}), ` +
    `probably mobile data, and ${relayReason(relay, net)}. Put both on the same Wi-Fi, or turn on Personal Hotspot on one phone and join its Wi-Fi from the other, then pair again.`
  );
}
