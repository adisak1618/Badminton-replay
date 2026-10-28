// The ICE servers a phone's RTCPeerConnection uses, and which path the link ended up on. With TURN credentials
// from the helper (api/signal.ts) a phone offers its host candidates, a server-reflexive one from STUN and relay
// ones from TURN; ICE tries the pairs by priority, host first, so two phones on one Wi-Fi still connect
// directly and only phones that share no network (both on mobile data, 2026-10-28) go through the relay.
// Without credentials the list is empty, exactly the local-network-only link of D13 before.
import type { TurnServer } from '../../api/signal';
import type { NetCheck } from './net';
import { utc } from './diag';

export const STUN_URLS = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];

/** Gathering waits for every server (no trickle ICE): host candidates alone take well under a second. */
export const GATHER_LAN_MS = 2000;
/** STUN and TURN over UDP, TCP and TLS each need a round trip or two to the server; a blocked one times out. */
export const GATHER_RELAY_MS = 5000;
/** With a relay candidate in hand, this long without another one ends the gathering (link.ts gathered). */
export const GATHER_SETTLE_MS = 300;

/**
 * Fetch new credentials when the cached ones have less than this left. A relayed link whose credentials
 * expire is cut by the TURN server, so the camera restarts ICE with new ones before (link.ts).
 */
export const ICE_REFRESH_BEFORE_MS = 10 * 60_000;

type Transport = 'udp' | 'tcp' | 'tls';

function transportOf(url: string): { transport: Transport; port: number } | null {
  const m = /^(turns?):(?:\[[^\]]+\]|[^:?]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(url.trim());
  if (!m) return null;
  const tls = m[1].toLowerCase() === 'turns';
  const port = m[2] ? Number(m[2]) : tls ? 5349 : 3478;
  return { transport: tls ? 'tls' : m[3]?.toLowerCase() === 'tcp' ? 'tcp' : 'udp', port };
}

/** Per transport, the port tried first: TLS on 443 passes networks that allow only HTTPS. */
const PREFERRED: Record<Transport, number[]> = { udp: [3478], tcp: [3478, 80], tls: [443, 5349] };

/**
 * One TURN URL per transport (UDP, TCP, TLS), so a carrier network that blocks UDP still relays and gathering
 * does not wait on a dozen servers. Port 53 is dropped: browsers block it, and without trickle ICE its
 * timeout would hold up every gathering (Cloudflare's note in generate-credentials).
 */
export function pickTurnUrls(urls: string[]): string[] {
  const parsed = urls.map((url) => ({ url, t: transportOf(url) })).filter((u) => u.t && u.t.port !== 53);
  const out: string[] = [];
  for (const transport of ['udp', 'tcp', 'tls'] as const) {
    const of = parsed.filter((u) => u.t!.transport === transport);
    const rank = (port: number) => {
      const i = PREFERRED[transport].indexOf(port);
      return i < 0 ? PREFERRED[transport].length : i;
    };
    const best = of.sort((a, b) => rank(a.t!.port) - rank(b.t!.port))[0];
    if (best) out.push(best.url);
  }
  return out;
}

/** The RTCPeerConnection's iceServers: STUN and the picked TURN URLs with credentials, or none without TURN. */
export function assembleIceServers(turn: readonly TurnServer[] | null | undefined): RTCIceServer[] {
  const t = turn?.find((s) => s.username && s.credential && pickTurnUrls(s.urls).length);
  if (!t) return [];
  return [{ urls: [...STUN_URLS] }, { urls: pickTurnUrls(t.urls), username: t.username, credential: t.credential }];
}

/** The servers for the diagnostics: URLs only, never the username or the credential. */
export function describeIceServers(servers: readonly RTCIceServer[]): string {
  const urls = servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
  return urls.length ? urls.join(', ') : 'none (local network only)';
}

/**
 * Whether this phone can relay. `ready` once credentials arrived; `not-configured` when the helper has no
 * TURN key; `failed` when fetching them failed (with why); `unknown` before the first try.
 */
export interface RelayStatus {
  state: 'unknown' | 'not-configured' | 'failed' | 'ready';
  detail?: string;
  /** When the credentials stop working (ready only). */
  expiresAt?: number;
}

export const RELAY_UNKNOWN: RelayStatus = { state: 'unknown' };

/**
 * The diagnostics line for a relay status; the part before " · " is what the summary shows:
 * "ready until 14:03:12 UTC · stun:…", "not configured · …", "failed (helper: relay-failed: auth) · …".
 */
export function relayLine(r: RelayStatus, servers: readonly RTCIceServer[] = []): string {
  switch (r.state) {
    case 'ready':
      return `ready until ${utc(r.expiresAt ?? 0).slice(0, 8)} UTC · ${describeIceServers(servers)}`;
    case 'not-configured':
      return 'not configured · no TURN key on the helper, local network only';
    case 'failed':
      return `failed (${r.detail ?? 'error'}) · ${servers.length ? 'still using the earlier credentials' : 'local network only'}`;
    default:
      return 'not checked';
  }
}

/**
 * Why the relay cannot carry the link, for phones on different networks that are still not connected; null
 * would mean the relay should have worked. Read after the slow-connect delay, when a working relay would long
 * have connected, so "both offered relay candidates" still ends in a reason.
 */
export function relayReason(relay: RelayStatus, net: NetCheck | null): string {
  switch (relay.state) {
    case 'not-configured':
      return 'the internet relay is not set up';
    case 'failed':
      return `the internet relay could not be used (${relay.detail ?? 'error'})`;
    case 'unknown':
      return 'the internet relay was not tried';
  }
  if (!net?.relay.mine) return 'this phone could not reach the relay server';
  if (!net.relay.theirs) return 'the other phone could not use the relay';
  return 'the relay did not connect';
}

/** direct: host or server-reflexive on both ends (the local network, or a hole through NAT); relay: via TURN. */
export type PathType = 'direct' | 'relay' | 'none';

export interface SelectedPath {
  type: Exclude<PathType, 'none'>;
  /** "this phone host/udp ↔ other phone host" for the diagnostics. */
  detail: string;
}

type Stat = Record<string, unknown> & { id: string; type: string };

/** "203.0.113.5 50000" for each relay candidate in a description. */
export function relayAddresses(sdp: string | null): string[] {
  const out: string[] = [];
  for (const line of (sdp ?? '').split(/\r?\n/)) {
    if (!line.startsWith('a=candidate:')) continue;
    const f = line.split(' ');
    if (f[f.indexOf('typ') + 1] === 'relay') out.push(`${f[4]} ${f[5]}`);
  }
  return out;
}

/**
 * The candidate pair ICE selected, from getStats(); null while there is none. `remoteRelays` are the relay
 * addresses the other phone offered (relayAddresses): when the other phone relays, this one may only know that
 * address as peer-reflexive.
 */
export async function selectedPath(pc: RTCPeerConnection, remoteRelays: readonly string[] = []): Promise<SelectedPath | null> {
  if (typeof pc.getStats !== 'function') return null;
  const stats = new Map<string, Stat>();
  (await pc.getStats()).forEach((s: Stat) => stats.set(s.id, s));
  const all = [...stats.values()];
  const viaTransport = all.find((s) => s.type === 'transport' && typeof s.selectedCandidatePairId === 'string');
  const pair =
    (viaTransport && stats.get(viaTransport.selectedCandidatePairId as string)) ??
    all.find((s) => s.type === 'candidate-pair' && (s.selected === true || (s.nominated === true && s.state === 'succeeded')));
  if (!pair) return null;
  const local = stats.get(pair.localCandidateId as string);
  const remote = stats.get(pair.remoteCandidateId as string);
  if (!local || !remote) return null;
  return pathOf(local, remote, remoteRelays);
}

export function pathOf(local: Record<string, unknown>, remote: Record<string, unknown>, remoteRelays: readonly string[] = []): SelectedPath {
  const lt = String(local.candidateType ?? '?');
  let rt = String(remote.candidateType ?? '?');
  if (rt === 'prflx' && remoteRelays.includes(`${remote.address ?? remote.ip} ${remote.port}`)) rt = 'relay';
  const via = lt === 'relay' && local.relayProtocol ? `/${local.relayProtocol}` : local.protocol ? `/${local.protocol}` : '';
  return { type: lt === 'relay' || rt === 'relay' ? 'relay' : 'direct', detail: `this phone ${lt}${via} ↔ other phone ${rt}` };
}
