// What the camera role consumes from the scoreboard, whatever carries it. Shapes follow the data-channel
// protocol (technical-design.md §4.4): a full-state `sync`, incremental `event`s, `cmd` in, `rec` and `ack`
// out, plus the link state for the chip (R-DISP-9). The paired WebRTC channel (peer.ts) sits behind this
// interface like the others; the recording code only ever sees a ScoreSource.
import type { MatchConfig, MatchEvent } from '../engine';

/** `reconnecting` is amber (from 6 s without pongs); `lost` is red (30 s), still trying; `offline`: no helper. */
export type LinkState = 'unpaired' | 'connecting' | 'paired' | 'reconnecting' | 'lost' | 'offline';

export interface MatchLog {
  matchId: string;
  config: MatchConfig;
  events: MatchEvent[];
}

/** The camera's recording state as the scoreboard sees it (`rec` message). */
export interface RecReport {
  state: 'idle' | 'recording' | 'stopping' | 'error';
  segment?: number;
  startedAt?: number;
  elapsedMs?: number;
  bytes?: number;
  minutesLeft?: number;
  error?: string;
}

/** Remote REC (D11, R-PAIR-6); `id` makes a retried command idempotent. */
export interface RecCommand {
  id: string;
  action: 'rec.start' | 'rec.stop';
}

/** Camera clock minus scoreboard clock (technical-design.md §4.5). */
export interface ClockEstimate {
  offsetMs: number;
  samples: number;
  medianRttMs: number;
}

export interface PeerInfo {
  id: string;
  ua: string;
  app?: string;
}

export interface SourceListener {
  /** The whole log; replaces the camera's mirror (R-PAIR-4). Sent on every (re)connect. */
  sync(log: MatchLog): void;
  /** One new event, in order. */
  event(e: MatchEvent): void;
  command(c: RecCommand): void;
  link(state: LinkState): void;
}

export interface ScoreSource {
  readonly kind: 'local' | 'none' | 'peer';
  /** Start delivering to `l`: the current link state and, when a match is known, a sync. Returns a stop. */
  connect(l: SourceListener): () => void;
  link(): LinkState;
  /** Null when there is no scoreboard to measure against. */
  clock(): ClockEstimate | null;
  /** The scoreboard device, once known. */
  peer(): PeerInfo | null;
  report(r: RecReport): void;
  ack(id: string, ok: boolean, error?: string): void;
}
