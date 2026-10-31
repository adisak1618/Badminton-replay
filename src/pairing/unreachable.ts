// Why a pairing that never opened could not open, from what this phone knows: its own relay state, the
// candidates each side offered (net.ts), and what the other phone said about itself in its description. A
// pairing gives up PAIR_GIVE_UP_MS after its first answer and says this, instead of offering new connections
// for ever behind a line about Wi-Fi (production, 2026-10-30: a scoreboard with no relay answered with mDNS
// candidates only, and neither phone said so).
import type { Desc } from './helper';
import type { RelayStatus } from './ice';
import type { NetCheck, NetVerdict } from './net';

/** From the first answer to giving up: long enough for the camera's second attempt (10 s after the answer). */
export const PAIR_GIVE_UP_MS = 18_000;

/**
 * - no-relay: the helper has no TURN key, and the phones do not share a network;
 * - no-relay-here: this phone has no relay candidate (no credentials, or its relay server never answered);
 * - no-relay-there: the other phone offered no relay candidate (an old build, or its relay failed);
 * - relay-blocked: both offered relay candidates and still no connection;
 * - same-network: the phones look like one network but cannot reach each other (client isolation).
 */
export type UnreachableReason = 'no-relay' | 'no-relay-here' | 'no-relay-there' | 'relay-blocked' | 'same-network';

export interface Unreachable {
  reason: UnreachableReason;
  /** no-relay-here: why this phone has no relay; no-relay-there: what the other phone said about its relay. */
  detail?: string;
  /** The other phone did not say its build in its description: a build from before 2026-10-31. */
  peerOld: boolean;
  verdict: NetVerdict | null;
  mine: string[];
  theirs: string[];
}

/** How a phone describes its relay in its descriptions: "ready", "not-configured", "failed: <why>" or "unknown". */
export function relayTag(r: RelayStatus): string {
  return r.state === 'failed' ? `failed: ${r.detail ?? 'error'}` : r.state;
}

export function unreachable(relay: RelayStatus, net: NetCheck | null, peer: Pick<Desc, 'app' | 'relay'> | null): Unreachable {
  const base = { peerOld: !peer?.app, verdict: net?.verdict ?? null, mine: net?.mine ?? [], theirs: net?.theirs ?? [] };
  if (net?.verdict === 'same' || net?.verdict === 'hotspot') return { ...base, reason: 'same-network' };
  const mine = (net?.relay.mine ?? 0) > 0;
  const theirs = (net?.relay.theirs ?? 0) > 0;
  if (!mine && !theirs && relay.state === 'not-configured') return { ...base, reason: 'no-relay' };
  if (!mine) {
    const detail = relay.state === 'failed' ? relay.detail : relay.state === 'ready' ? 'the relay server did not answer' : relay.state === 'not-configured' ? 'not set up' : 'not tried';
    return { ...base, reason: 'no-relay-here', detail };
  }
  if (!theirs) {
    const said = peer?.relay;
    const detail = !said ? undefined : said === 'ready' ? 'its relay server did not answer' : said.replace(/^failed: /, '').replace('not-configured', 'not set up');
    return { ...base, reason: 'no-relay-there', detail };
  }
  return { ...base, reason: 'relay-blocked' };
}
