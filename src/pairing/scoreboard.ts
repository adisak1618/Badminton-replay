// The scoreboard's side of the paired link: the whole log as `sync` on every open (R-PAIR-4), then each new
// event as it is logged; the camera's `rec` reports for the chip (R-DISP-9); and remote REC (D11, R-PAIR-6)
// as idempotent `cmd`s retried with the same id until the camera acks. Nothing here can block scoring
// (R-PAIR-3): the store never waits for the link.
import { randomId, type MatchEvent } from '../engine';
import type { RecCommand, RecReport } from '../link/source';
import type { MatchStore } from '../match/store';
import { syncParts } from '../protocol/sync';
import type { LinkPort } from './port';

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
}

export class ScoreboardLink {
  private snap: ScoreboardLinkSnapshot = { rec: null, cmd: null };
  private listeners = new Set<() => void>();
  private sent: { matchId: string | null; events: readonly MatchEvent[] } = { matchId: null, events: [] };

  constructor(
    private readonly port: LinkPort,
    private readonly store: MatchStore,
    private readonly now: () => number = Date.now,
  ) {
    port.onOpen = () => {
      this.sent = { matchId: null, events: [] }; // the camera gets the whole log again
      this.pump();
      const c = this.snap.cmd;
      if (c && !c.ack) this.sendCmd(c);
    };
    port.onMessage = (m) => {
      if (m.t === 'rec') {
        const { v: _v, t: _t, ...r } = m;
        this.set({ rec: { ...r, at: this.now() } });
      } else if (m.t === 'ack') {
        const c = this.snap.cmd;
        if (c && c.id === m.id && !c.ack) this.set({ cmd: { ...c, ack: { ok: m.ok, error: m.error } } });
      }
    };
    store.subscribe(() => this.pump());
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

  /** Forget what the camera last said (on unpair). */
  clear(): void {
    this.set({ rec: null, cmd: null });
  }

  /** Send what changed in the store: a new match or a rewritten log is a sync, otherwise the new events. */
  private pump(): void {
    if (!this.port.isOpen()) return;
    const m = this.store.getSnapshot().match;
    if (!m) return;
    const prev = this.sent;
    const extends_ =
      prev.matchId === m.matchId &&
      m.events.length >= prev.events.length &&
      prev.events.every((e, i) => m.events[i].id === e.id);
    if (!extends_) {
      for (const part of syncParts({ matchId: m.matchId, config: m.config, events: m.events })) if (!this.port.sendRaw(part)) return;
    } else {
      for (const event of m.events.slice(prev.events.length)) if (!this.port.send({ t: 'event', event })) return;
    }
    this.sent = { matchId: m.matchId, events: m.events };
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

  /** Called every second: retry an unacknowledged command, or give up on it. */
  tick(): void {
    const c = this.snap.cmd;
    if (!c || c.ack) return;
    const now = this.now();
    if (now - c.sentAt >= CMD_GIVE_UP_MS) this.set({ cmd: { ...c, ack: { ok: false, error: 'The camera phone did not answer.' } } });
    else if (this.port.isOpen() && now - c.lastSentAt >= CMD_RETRY_MS) this.sendCmd(c);
  }
}
