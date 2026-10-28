// What a session description says about the network its phone is on, and whether the two phones can plausibly
// reach each other directly. The host candidates tell the network (server-reflexive and relay ones are counted
// apart: they exist only with STUN/TURN, ice.ts); WebKit gives just the address of its default route
// (network-cost 999, no network-id). Two phones on mobile data show two unrelated carrier addresses and can
// never connect directly, only through a relay; that is what the production logs of 2026-10-28 showed (camera
// 10.195.144.160, scoreboard 10.131.171.124), behind a "connecting" that never ended.

export interface Candidates {
  /** Host candidates with a plain address (IPv4 or IPv6), in SDP order, without repeats. */
  ips: string[];
  /** Host candidates hidden behind an mDNS name (`….local`): WebKit without capture permission, Chrome. */
  mdns: number;
  srflx: number;
  relay: number;
}

export function candidatesOf(sdp: string): Candidates {
  const c: Candidates = { ips: [], mdns: 0, srflx: 0, relay: 0 };
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith('a=candidate:')) continue;
    const f = line.split(' ');
    const addr = f[4] ?? '';
    const type = f[f.indexOf('typ') + 1];
    if (type === 'srflx' || type === 'prflx') c.srflx++;
    else if (type === 'relay') c.relay++;
    else if (addr.endsWith('.local')) c.mdns++;
    else if (addr && !c.ips.includes(addr)) c.ips.push(addr);
  }
  return c;
}

/** "10.131.171.124", "10.131.171.124 + 1 mDNS", "1 mDNS", "none". */
export function describeCandidates(c: Candidates): string {
  const parts = [...c.ips];
  if (c.mdns) parts.push(`${c.mdns} mDNS`);
  if (c.srflx) parts.push(`${c.srflx} srflx`);
  if (c.relay) parts.push(`${c.relay} relay`);
  return parts.length ? parts.join(' + ') : 'none';
}

/**
 * - same: an address of each phone shares its first two octets: the same Wi-Fi, as far as can be told;
 * - hotspot: one phone is on an iPhone's Personal Hotspot (172.20.10.0/28), whose host shows its carrier address;
 * - different: neither, e.g. both on mobile data, or on two different Wi-Fi networks;
 * - unknown: a side has no plain IPv4 address (mDNS only, or nothing yet).
 */
export type NetVerdict = 'same' | 'hotspot' | 'different' | 'unknown';

export interface NetCheck {
  mine: string[];
  theirs: string[];
  verdict: NetVerdict;
  /** How many relay candidates each side offered: none without TURN, or when its relay is out of reach. */
  relay: { mine: number; theirs: number };
}

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function usableV4(ips: string[]): string[] {
  return ips.filter((ip) => V4.test(ip) && !ip.startsWith('127.') && !ip.startsWith('169.254.') && ip !== '0.0.0.0');
}

const net16 = (ip: string) => ip.split('.').slice(0, 2).join('.');
const onHotspot = (ip: string) => ip.startsWith('172.20.10.') && Number(ip.split('.')[3]) < 16;

export function netVerdict(mine: string[], theirs: string[]): NetVerdict {
  const a = usableV4(mine);
  const b = usableV4(theirs);
  if (!a.length || !b.length) return 'unknown';
  if (a.some((x) => b.some((y) => net16(x) === net16(y)))) return 'same';
  if ([...a, ...b].some(onHotspot)) return 'hotspot';
  return 'different';
}

export function netCheck(mineSdp: string | null, theirsSdp: string | null): NetCheck | null {
  if (!mineSdp || !theirsSdp) return null;
  const a = candidatesOf(mineSdp);
  const b = candidatesOf(theirsSdp);
  return { mine: a.ips, theirs: b.ips, verdict: netVerdict(a.ips, b.ips), relay: { mine: a.relay, theirs: b.relay } };
}
