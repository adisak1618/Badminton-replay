// What the role layers (the camera's MatchHub, one port per scoreboard; ScoreboardLink on each scoreboard)
// need from the link. PeerLink provides it over WebRTC; tests connect the role layers with in-memory pairs.
import type { ClockEstimate } from '../link/source';
import type { Msg, encode } from '../protocol/messages';
import type { LinkSnapshot } from './link';

export interface LinkPort {
  send(body: Parameters<typeof encode>[0]): boolean;
  sendRaw(data: string): boolean;
  isOpen(): boolean;
  subscribe(fn: () => void): () => void;
  getSnapshot(): Pick<LinkSnapshot, 'state' | 'remote'>;
  clockEstimate(): ClockEstimate | null;
  onMessage: (m: Msg) => void;
  onOpen: () => void;
}
