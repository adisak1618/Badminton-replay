// The scoreboard's side of the paired link (D14): the camera holds the match. On every open the camera sends
// the whole of it and this phone shows that, dropping whatever it showed before; a camera holding none adopts
// this phone's match (`sync`). Taps and menu actions go to the camera as inputs and its events come back to
// every scoreboard. Also the camera's `rec` reports for the chip (R-DISP-9), how many other scoreboards are
// linked, and remote REC (D11, R-PAIR-6) as idempotent `cmd`s retried with the same id until the camera acks.
// Nothing here can block scoring (R-PAIR-3): the store shows a tap at once and sends it when it can.
import { randomId } from '../engine';
import type { RecCommand, RecReport } from '../link/source';
import type { MatchStore } from '../match/store';
import { SyncAssembler, syncParts } from '../protocol/sync';
import type { LinkPort } from './port';

/** Open this long without the camera's whole match (a reopen it did not see as one): ask for it. */
export const RESYNC_AFTER_MS = 1500;

/** Resend an unacknowledged command this often while the link is open, and give up after CMD_GIVE_UP_MS. */
export const CMD_RETRY_MS = 3000;
export const CMD_GIVE_UP_MS = 30_000;

export interface PendingCommand extends RecCommand {
  sentAt: number;
  lastSentAt: number;
  ack: { ok: boolean; error?: string } | null;
}

export interface ScoreboardLinkSnapshot {
  /** The camera's last report and when it arrived (scoreboard clock). */
  rec: (RecReport & { at: number }) | null;
  cmd: PendingCommand | null;
  /** The camera's whole match has arrived since the link last opened: what is shown is the camera's. */
  synced: boolean;
  /** When the camera last sent its match or an event: "reconnecting · 12 s" counts from here. */
  syncedAt: number | null;
  /** Other scoreboards linked to the same camera right now. */
  others: number;
  /** When a tap of this phone was found already counted from the other scoreboard (the cue). */
  duplicateAt: number | null;
}

const EMPTY: ScoreboardLinkSnapshot = { rec: null, cmd: null, synced: false, syncedAt: null, others: 0, duplicateAt: null };

export class ScoreboardLink {
  private snap: ScoreboardLinkSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private assembler = new SyncAssembler();
  private paired: boolean;
  private openedAt = 0;

  constructor(
    private readonly port: LinkPort,
    private readonly store: MatchStore,
    private readonly now: () => number = Date.now,
  ) {
    this.paired = port.getSnapshot().state !== 'unpaired';
    port.onOpen = () => {
      this.assembler = new SyncAssembler();
      this.openedAt = this.now();
      this.set({ synced: false }); // the camera sends its whole match on every open
      const c = this.snap.cmd;
      if (c && !c.ack) this.sendCmd(c);
    };
    port.onMessage = (m) => {
      switch (m.t) {
        case 'state': {
          const log = this.assembler.add(m);
          if (log === undefined) return;
          if (log) store.adopt(log);
          else {
            const mine = store.offer();
            if (mine) for (const part of syncParts(mine)) if (!port.sendRaw(part)) return;
          }
          this.set({ synced: true, syncedAt: this.now() });
          for (const p of store.pending()) port.send({ t: 'input', matchId: p.matchId, input: p.input });
          return;
        }
        case 'event':
          if (!this.snap.synced) return;
          if (store.confirm(m.matchId, m.event)) this.set({ syncedAt: this.now() });
          else port.send({ t: 'resync' });
          return;
        case 'result':
          store.settle(m.id, m.result);
          if (m.result === 'duplicate') this.set({ duplicateAt: this.now() });
          return;
        case 'peers':
          this.set({ others: Math.max(0, m.count - 1) });
          return;
        case 'rec': {
          const { v: _v, t: _t, ...r } = m;
          this.set({ rec: { ...r, at: this.now() } });
          return;
        }
        case 'ack': {
          const c = this.snap.cmd;
          if (c && c.id === m.id && !c.ack) this.set({ cmd: { ...c, ack: { ok: m.ok, error: m.error } } });
          return;
        }
      }
    };
    store.setSink({
      send: (p) => {
        if (this.snap.synced && port.isOpen()) port.send({ t: 'input', matchId: p.matchId, input: p.input });
      },
      toCamera: (at) => at + (port.clockEstimate()?.offsetMs ?? 0), // camera minus scoreboard
    });
    store.onDuplicate = () => this.set({ duplicateAt: this.now() });
    port.subscribe(() => this.follow());
    store.subscribe(() => this.follow());
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): ScoreboardLinkSnapshot => this.snap;
  private set(patch: Partial<ScoreboardLinkSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  /**
   * Follow the link: down means the camera's copy is no longer live; unpaired (either phone unpaired, the
   * pairing expired) means nothing of the camera stays on this phone and the match is this phone's own again.
   */
  private follow(): void {
    const s = this.port.getSnapshot().state;
    const paired = s !== 'unpaired';
    if (this.paired && !paired) this.clear();
    this.paired = paired;
    if (!paired && this.store.paired) this.store.local();
    if (s !== 'paired' && this.snap.synced) this.set({ synced: false, others: 0 });
  }

  /** Forget everything the camera said (unpaired). */
  clear(): void {
    this.assembler = new SyncAssembler();
    this.set(EMPTY);
  }

  /** Start or stop the recording on the camera (D11). A repeat while one is unanswered resends that one. */
  command(action: RecCommand['action']): PendingCommand {
    const c = this.snap.cmd;
    if (c && c.action === action && !c.ack && this.now() - c.sentAt < CMD_GIVE_UP_MS) {
      this.sendCmd(c);
      return c;
    }
    const next: PendingCommand = { id: randomId(), action, sentAt: this.now(), lastSentAt: 0, ack: null };
    this.set({ cmd: next });
    this.sendCmd(next);
    return next;
  }

  private sendCmd(c: PendingCommand): void {
    // Record the send first: the ack may arrive before send() returns.
    if (!this.port.isOpen()) return;
    this.set({ cmd: { ...c, lastSentAt: this.now() } });
    this.port.send({ t: 'cmd', id: c.id, action: c.action });
  }

  /** Called every second: ask again for a match that did not come, retry an unacknowledged command, or give up on it. */
  tick(): void {
    if (this.port.isOpen() && !this.snap.synced && this.now() - this.openedAt >= RESYNC_AFTER_MS) {
      this.openedAt = this.now();
      this.port.send({ t: 'resync' });
    }
    const c = this.snap.cmd;
    if (!c || c.ack) return;
    const now = this.now();
    if (now - c.sentAt >= CMD_GIVE_UP_MS) this.set({ cmd: { ...c, ack: { ok: false, error: 'The camera phone did not answer.' } } });
    else if (this.port.isOpen() && now - c.lastSentAt >= CMD_RETRY_MS) this.sendCmd(c);
  }
}
