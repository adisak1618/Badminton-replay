// The camera's scoreboard slots (D14): one PeerLink per scoreboard, up to SLOTS, each with its own helper
// session, reconnect and relay exactly as a single link, all feeding the one MatchHub. While the pairing
// screen is open the camera offers a code for a free slot; a slot nobody claimed is withdrawn when it closes.
import { localHubStore, MatchHub, type HubStore } from '../link/hub';
import type { LinkSnapshot, PeerLink } from './link';

export const SLOTS = 2;

export interface SlotsSnapshot {
  slots: readonly LinkSnapshot[];
  /** Scoreboards paired (linked or reconnecting). */
  paired: number;
}

export class CameraPairing {
  readonly hub: MatchHub;
  private snap: SlotsSnapshot;
  private listeners = new Set<() => void>();

  constructor(
    readonly links: readonly PeerLink[],
    store: HubStore = localHubStore(),
  ) {
    this.hub = new MatchHub(links, store);
    this.snap = this.read();
    for (const l of links)
      l.subscribe(() => {
        this.snap = this.read();
        for (const fn of this.listeners) fn();
      });
  }

  private read(): SlotsSnapshot {
    const slots = this.links.map((l) => l.getSnapshot());
    return { slots, paired: this.links.filter((l) => l.paired && l.getSnapshot().everOpened).length };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): SlotsSnapshot => this.snap;

  /** Any slot paired or offering a code. */
  get active(): boolean {
    return this.links.some((l) => l.paired || !!l.getSnapshot().room);
  }

  /** Pick up saved pairings after a reload; a kept match without one is dropped. */
  rejoin(): boolean {
    let any = false;
    for (const l of this.links) any = l.rejoin() || any;
    if (!any) this.hub.forget();
    return any;
  }

  /** A slot with no scoreboard and no code on show, if there is one. */
  free(): PeerLink | null {
    return this.links.find((l) => !l.paired && !l.getSnapshot().room && !l.getSnapshot().busy) ?? null;
  }

  /** Show a code for the next free slot (also "Try again" and "New code"). */
  pairNext(): void {
    const showing = this.links.find((l) => !!l.getSnapshot().room && !l.getSnapshot().everOpened);
    void (showing ?? this.free())?.pair();
  }

  /** The pairing screen closed: withdraw codes nobody used. */
  cancelCodes(): void {
    for (const l of this.links) l.cancel();
  }

  unpair(i: number): void {
    this.links[i]?.unpair();
  }

  unpairAll(): void {
    for (const l of this.links) if (l.paired || l.getSnapshot().room) l.unpair();
    this.hub.forget();
  }

  resume(why: string): void {
    for (const l of this.links) l.resume(why);
  }

  leave(): void {
    for (const l of this.links) l.leave();
  }
}
