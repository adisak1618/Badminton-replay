// Short sounds from pre-built Web Audio buffers (ux-design.md §4). The AudioContext is created and unlocked
// on a user gesture ("Start match", or the first tap after a resume) because iOS only plays audio after one.
import type { Chime } from './phrases';

let ctx: AudioContext | null = null;
const buffers = new Map<Chime, AudioBuffer>();

type Tone = { f: number; start: number; dur: number; gain: number };

const RECIPES: Record<Chime, Tone[]> = {
  click: [{ f: 2200, start: 0, dur: 0.035, gain: 0.9 }],
  interval: [
    { f: 660, start: 0, dur: 0.35, gain: 0.6 },
    { f: 880, start: 0.18, dur: 0.45, gain: 0.5 },
  ],
  game: [
    { f: 784, start: 0, dur: 0.25, gain: 0.6 },
    { f: 988, start: 0.15, dur: 0.25, gain: 0.6 },
    { f: 1319, start: 0.3, dur: 0.5, gain: 0.55 },
  ],
  ends: [
    { f: 988, start: 0, dur: 0.2, gain: 0.55 },
    { f: 740, start: 0.16, dur: 0.35, gain: 0.55 },
  ],
};

function render(c: AudioContext, tones: Tone[]): AudioBuffer {
  const rate = c.sampleRate;
  const len = Math.ceil(rate * Math.max(...tones.map((t) => t.start + t.dur)));
  const buf = c.createBuffer(1, len, rate);
  const data = buf.getChannelData(0);
  for (const t of tones) {
    const from = Math.floor(t.start * rate);
    const n = Math.floor(t.dur * rate);
    for (let i = 0; i < n && from + i < len; i++) {
      const x = i / rate;
      const env = Math.min(1, i / (0.004 * rate)) * Math.exp((-5 * x) / t.dur); // fast attack, exponential decay
      data[from + i] += t.gain * env * Math.sin(2 * Math.PI * t.f * x);
    }
  }
  return buf;
}

/** Create (or resume) the AudioContext and build the buffers. Call from a user gesture. */
export function unlockAudio(): void {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      for (const [name, tones] of Object.entries(RECIPES) as Array<[Chime, Tone[]]>) buffers.set(name, render(ctx, tones));
    }
    if (ctx.state !== 'running') void ctx.resume();
    // A silent one-sample buffer played inside the gesture finishes the unlock on iOS.
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    src.connect(ctx.destination);
    src.start();
  } catch {
    ctx = null;
  }
}

export const audioUnlocked = (): boolean => ctx !== null && ctx.state === 'running';

export function playChime(name: Chime): void {
  const buf = buffers.get(name);
  if (!ctx || !buf) return;
  if (ctx.state !== 'running') void ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}
