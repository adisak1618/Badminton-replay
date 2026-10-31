// Tags in the video made after the match (D16, research report §3F): live, a tag counts from the moment it was saved
// (statsOverlay), so a point tagged after the match, while watching the video, would only reach the stats when the
// match is over. For the render every tag and tag.clear counts from its point's tap plus a moment, as if the popup had
// been answered at once; the newest choice per point still wins, because the log's order is kept.
import type { MatchEvent } from '../engine';

/** A late choice shows this long after its point's tap. */
export const RETRO_TAG_MS = 3000;

export function retroTags(events: readonly MatchEvent[]): MatchEvent[] {
  const pointAt = new Map<string, number>();
  for (const e of events) if (e.type === 'point') pointAt.set(e.id, e.at);
  const moved = events.map((e) => {
    if (e.type !== 'tag' && e.type !== 'tag.clear') return e;
    const p = pointAt.get(e.point);
    return p == null || e.at <= p + RETRO_TAG_MS ? e : { ...e, at: p + RETRO_TAG_MS };
  });
  // Time order for the overlay's cutoff; equal times keep the log's order, so a later change still wins.
  return moved.map((e, i) => ({ e, i })).sort((a, b) => a.e.at - b.e.at || a.i - b.i).map((x) => x.e);
}
