export function bytes(n: number | null | undefined): string {
  if (n == null) return '?';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(0, Math.round(n / 1e3))} kB`;
}

/** "Today 19:12", "Sun 10:05", or "12 Oct 10:05" for a recording's start. */
export function when(at: number, now = Date.now()): string {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = new Date(now);
  if (d.toDateString() === day.toDateString()) return `Today ${hm}`;
  if (now - at < 6 * 86_400_000) return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${hm}`;
}
