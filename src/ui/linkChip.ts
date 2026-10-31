// The words on the scoreboard's link chip (S3 top bar), kept apart from the component so they are tested alone.
import type { LinkState } from '../link/source';

/**
 * A tap the camera has not confirmed this long after it was made shows "sending…" on a link that says "link ok":
 * a stall shorter than the down threshold (6.5 s) leaves the camera seconds behind with nothing on screen
 * (2026-10-31 audit, BUG-6). A healthy link confirms a tap within a round trip (a few hundred ms on mobile data).
 */
export const SENDING_AFTER_MS = 1500;

/**
 * The chip's words: "syncing" until the camera's whole match has arrived after an open; "sending…" while a tap
 * of this phone has waited SENDING_AFTER_MS for the camera; and while the link is down the seconds since the
 * camera last sent anything, so a score shown then is never taken for a live one.
 */
export function chipText(state: LinkState, synced: boolean, syncedAt: number | null, now: number, oldestPendingAt: number | null = null): string | undefined {
  if (state === 'paired') return !synced ? 'syncing…' : oldestPendingAt != null && now - oldestPendingAt >= SENDING_AFTER_MS ? 'sending…' : undefined;
  if ((state === 'reconnecting' || state === 'lost' || state === 'offline') && syncedAt != null)
    return `${state === 'reconnecting' ? 'reconnecting' : state === 'lost' ? 'link lost' : 'offline'} · ${Math.max(0, Math.round((now - syncedAt) / 1000))} s`;
  return undefined;
}
