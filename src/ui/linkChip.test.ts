// The scoreboard's link chip: after a short stall the camera can trail by seconds while the link still says ok
// (2026-10-31 audit, BUG-6: a 1-4 s stall left every tap 0.3-7.8 s late with "link ok" on both phones). A tap
// the camera has not confirmed SENDING_AFTER_MS after it was made shows "sending…".
import { describe, expect, it } from 'vitest';
import { chipText, SENDING_AFTER_MS } from './linkChip';

describe('the link chip', () => {
  const now = 1_800_000_000_000;

  it('says "sending…" while a tap has waited for the camera, and nothing once it is confirmed', () => {
    expect(chipText('paired', true, now - 5000, now, null)).toBeUndefined();
    expect(chipText('paired', true, now - 5000, now, now - 300)).toBeUndefined(); // a round trip on mobile data
    expect(chipText('paired', true, now - 5000, now, now - SENDING_AFTER_MS)).toBe('sending…');
    expect(chipText('paired', true, now - 5000, now, now - 6000)).toBe('sending…');
  });

  it('keeps "syncing…" and the down states as they were', () => {
    expect(chipText('paired', false, null, now, now - 6000)).toBe('syncing…');
    expect(chipText('reconnecting', false, now - 12_000, now, now - 6000)).toBe('reconnecting · 12 s');
    expect(chipText('lost', false, now - 40_000, now, null)).toBe('link lost · 40 s');
  });
});
