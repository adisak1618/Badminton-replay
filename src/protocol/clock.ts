// NTP-style clock offset from ping/pong round trips (technical-design.md §4.5):
//   offset_i = ((t1 - t0) + (t2 - t3)) / 2     t0, t3 on the pinging phone; t1, t2 on the answering phone
//   rtt_i    = (t3 - t0) - (t2 - t1)
//   offset   = median of the last 8 samples with rtt < 50 ms
// `offset` is the answering phone's clock minus the pinging phone's.
import type { ClockEstimate } from '../link/source';

export const CLOCK_WINDOW = 8;
export const CLOCK_MAX_RTT_MS = 50;

export interface ClockSample {
  offset: number;
  rtt: number;
}

export function sample(t0: number, t1: number, t2: number, t3: number): ClockSample {
  return { offset: (t1 - t0 + (t2 - t3)) / 2, rtt: t3 - t0 - (t2 - t1) };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class ClockSampler {
  private kept: ClockSample[] = [];
  private total = 0;

  /** Add one round trip; samples with rtt >= 50 ms (or a negative one, a clock jump) are dropped. */
  add(t0: number, t1: number, t2: number, t3: number): boolean {
    const s = sample(t0, t1, t2, t3);
    if (!(s.rtt >= 0 && s.rtt < CLOCK_MAX_RTT_MS)) return false;
    this.kept.push(s);
    if (this.kept.length > CLOCK_WINDOW) this.kept.shift();
    this.total++;
    return true;
  }

  /**
   * The answering phone's clock minus the pinging phone's, or null before the first good sample. `samples` counts
   * every sample accepted so far (match.json), the median covers the last 8.
   */
  estimate(): ClockEstimate | null {
    if (!this.kept.length) return null;
    return {
      offsetMs: Math.round(median(this.kept.map((s) => s.offset))),
      samples: this.total,
      medianRttMs: Math.round(median(this.kept.map((s) => s.rtt))),
    };
  }
}
