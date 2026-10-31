// A whole post-match render (D16): every segment's timeline, cut into parts (PART_MS of output each, its own MP4) so an
// interrupted render resumes at the first part not finished, then the parts joined into one file per segment by copying
// their packets. Where the bytes go is a RenderStore: OPFS on the camera phone (store.ts), memory in tests.
import type { Motion } from '../overlay';
import type { MatchBundle } from '../recording/bundle';
import { FramePainter, type PaintOptions } from './paint';
import { bitrateFor, mediabunny, renderPart, type PartSink } from './pipeline';
import { burnedIn, parts, segmentTimeline, type SegmentTimeline } from './timeline';

export interface RenderOptions extends PaintOptions {
  replays: boolean;
  blend: boolean;
  motion?: Motion;
}

export const DEFAULT_RENDER: RenderOptions = { replays: true, blend: true };

export interface RenderStore {
  /** The saved job, if any. */
  readJob(): Promise<JobState | null>;
  writeJob(job: JobState): Promise<void>;
  /** Start a file of the render; bytes are appended in order. */
  open(name: string): Promise<PartSink & { close(): Promise<void> }>;
  read(name: string): Promise<Blob | null>;
  remove(name: string): Promise<void>;
  /** Free bytes, when the browser says. */
  free(): Promise<number | null>;
}

export interface JobState {
  version: 1;
  key: string;
  /** Per segment: its parts and which are done; `final` once joined. */
  segments: Array<{ index: number; outMs: number; parts: number; done: number[]; final: string | null }>;
}

export interface RenderProgress {
  /** Output ms rendered so far and in all, over every segment. */
  doneMs: number;
  totalMs: number;
  phase: 'render' | 'join';
  segment: number;
  part: number;
  parts: number;
}

export interface RenderedFile {
  segment: number;
  name: string;
  outMs: number;
}

export const partName = (segment: number, part: number): string => `s${segment}-p${part}.mp4`;
export const finalName = (segment: number): string => `video-${segment}-replays.mp4`;

/** A short stable hash: a render made from other marks, tags or options starts again rather than mixing parts. */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36);
}

export function jobKey(b: MatchBundle, sizes: Record<number, number>, o: RenderOptions): string {
  const marks = b.events.filter((e) => e.type === 'replay' || e.type === 'replay.clear' || e.type === 'tag' || e.type === 'tag.clear' || e.type === 'undo' || e.type === 'redo');
  return hash(JSON.stringify({ r: b.replays ?? [], m: marks.map((e) => [e.id, e.at]), s: sizes, o }));
}

/** Bytes the finished render needs on the phone at most: the parts and the joined file side by side. */
export function bytesNeeded(timelines: readonly SegmentTimeline[], heights: Record<number, number>): number {
  let total = 0;
  for (const t of timelines) total += ((t.outMs / 1000) * (bitrateFor(heights[t.segment] ?? 1080) + 128_000)) / 8;
  return Math.round(total * 2 * 1.1);
}

export class NotEnoughSpace extends Error {
  constructor(
    readonly needed: number,
    readonly free: number,
  ) {
    super(`needs ${Math.round(needed / 1e6)} MB, ${Math.round(free / 1e6)} MB free`);
  }
}

/**
 * Render the match: replays inserted (D16), the stats from tags as they are now, the overlay for an imported file.
 * Resumes a saved job with the same key. Returns one finished file per segment.
 */
export async function renderMatch(
  bundle: MatchBundle,
  files: ReadonlyMap<number, Blob>,
  store: RenderStore,
  o: RenderOptions,
  hooks: { onProgress?: (p: RenderProgress) => void; signal?: AbortSignal } = {},
): Promise<RenderedFile[]> {
  const M = await mediabunny();
  const segments = (bundle.recording?.segments ?? []).filter((s) => files.has(s.index));
  if (!segments.length) throw new Error('no video to render');
  // Each segment's real length comes from the file itself.
  const durations: Record<number, number> = {};
  const sizes: Record<number, number> = {};
  const heights: Record<number, number> = {};
  for (const s of segments) {
    const f = files.get(s.index)!;
    const input = new M.Input({ source: new M.BlobSource(f), formats: [M.MP4, M.QTFF] });
    durations[s.index] = Math.floor((await input.computeDuration()) * 1000);
    const v = await input.getPrimaryVideoTrack();
    heights[s.index] = v?.displayHeight ?? s.height;
    sizes[s.index] = f.size;
  }
  const timelines = segments.map((s) => segmentTimeline(bundle, s.index, durations[s.index], { replays: o.replays, motion: o.motion }));
  const key = jobKey(bundle, sizes, o);
  let job = await store.readJob();
  if (!job || job.key !== key) {
    if (job) for (const s of job.segments) for (let k = 0; k < s.parts; k++) await store.remove(partName(s.index, k));
    job = { version: 1, key, segments: timelines.map((t) => ({ index: t.segment, outMs: t.outMs, parts: parts(t).length, done: [], final: null })) };
    const free = await store.free();
    const needed = bytesNeeded(timelines, heights);
    if (free != null && free < needed) throw new NotEnoughSpace(needed, free);
    await store.writeJob(job);
  }
  const totalMs = timelines.reduce((a, t) => a + t.outMs, 0);
  let doneMs = 0;
  for (const t of timelines) {
    const seg = segments.find((s) => s.index === t.segment)!;
    const state = job.segments.find((s) => s.index === t.segment)!;
    const ps = parts(t);
    if (state.final) {
      doneMs += t.outMs;
      continue;
    }
    const painter = new FramePainter(bundle, { ...seg, width: seg.width || 1920, height: heights[seg.index] || seg.height || 1080 }, burnedIn(bundle, seg), o);
    for (const p of ps) {
      if (state.done.includes(p.index)) {
        doneMs += p.to - p.from;
        continue;
      }
      const name = partName(t.segment, p.index);
      const sink = await store.open(name);
      try {
        await renderPart(t, p, { file: files.get(t.segment)!, durationMs: t.sourceMs }, painter, sink, {
          blend: o.blend,
          signal: hooks.signal,
          onFrame: (ms) => hooks.onProgress?.({ doneMs: doneMs + (ms - p.from), totalMs, phase: 'render', segment: t.segment, part: p.index, parts: ps.length }),
        });
      } finally {
        await sink.close();
      }
      state.done.push(p.index);
      await store.writeJob(job);
      doneMs += p.to - p.from;
    }
    hooks.onProgress?.({ doneMs, totalMs, phase: 'join', segment: t.segment, part: ps.length, parts: ps.length });
    state.final = await join(t.segment, ps.map((p) => p.from / 1000), store);
    await store.writeJob(job);
  }
  return job.segments.map((s) => ({ segment: s.index, name: s.final!, outMs: s.outMs }));
}

/** The bytes of a decoder config's description, whether it is a buffer or a view into a larger one. */
const bytesOf = (d: AllowSharedBufferSource): Uint8Array =>
  d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array((d as ArrayBufferView).buffer, (d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteLength);

const sameBytes = (a: AllowSharedBufferSource | undefined, b: AllowSharedBufferSource | undefined): boolean => {
  if (!a || !b) return a === b;
  const x = bytesOf(a);
  const y = bytesOf(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

const hex = (d: AllowSharedBufferSource | undefined): string => (d ? [...bytesOf(d)].map((x) => x.toString(16).padStart(2, '0')).join('') : '-');

/** One file from the parts: their packets copied in order at each part's start (s), nothing encoded again. */
async function join(segment: number, starts: readonly number[], store: RenderStore): Promise<string> {
  const n = starts.length;
  if (n === 1) return partName(segment, 0);
  const M = await mediabunny();
  const name = finalName(segment);
  const sink = await store.open(name);
  let position = 0;
  const writable = new WritableStream<{ type: 'write'; data: Uint8Array; position: number }>({
    async write(c) {
      if (c.position !== position) throw new Error(`the MP4 writer jumped from ${position} to ${c.position}`);
      position += c.data.byteLength;
      await sink.write(c.data);
    },
  });
  const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'fragmented' }), target: new M.StreamTarget(writable) });
  const video = new M.EncodedVideoPacketSource('avc');
  const audio = new M.EncodedAudioPacketSource('aac');
  output.addVideoTrack(video, { frameRate: 30 });
  let hasAudio = false;
  let started = false;
  let videoConfig: VideoDecoderConfig | null = null;
  try {
    for (let k = 0; k < n; k++) {
      const blob = await store.read(partName(segment, k));
      if (!blob) throw new Error(`part ${k} of segment ${segment} is missing`);
      const input = new M.Input({ source: new M.BlobSource(blob), formats: [M.MP4] });
      const v = (await input.getPrimaryVideoTrack())!;
      const a = await input.getPrimaryAudioTrack();
      if (k === 0 && a) {
        output.addAudioTrack(audio);
        hasAudio = true;
      }
      if (!started) {
        await output.start();
        started = true;
      }
      const vc = await v.getDecoderConfig();
      if (!videoConfig) videoConfig = vc;
      else if (!sameBytes(vc?.description, videoConfig.description)) throw new Error(`the parts were encoded with different settings: ${hex(videoConfig.description)} vs ${hex(vc?.description)} (${videoConfig.codec} vs ${vc?.codec})`);
      const offset = starts[k];
      const ac = a && hasAudio ? await a.getDecoderConfig() : null;
      // Both tracks in time order, so the muxer never holds a whole part of one track while it waits for the other.
      const vs = new M.EncodedPacketSink(v).packets()[Symbol.asyncIterator]();
      const as = a && hasAudio ? new M.EncodedPacketSink(a).packets()[Symbol.asyncIterator]() : null;
      let nv = await vs.next();
      let na = as ? await as.next() : null;
      let firstV = k === 0;
      let firstA = k === 0;
      while (!nv.done || (na && !na.done)) {
        if (!nv.done && (!na || na.done || nv.value.timestamp <= na.value.timestamp)) {
          await video.add(nv.value.clone({ timestamp: nv.value.timestamp + offset }), firstV && vc ? { decoderConfig: vc } : undefined);
          firstV = false;
          nv = await vs.next();
        } else if (na && !na.done) {
          await audio.add(na.value.clone({ timestamp: na.value.timestamp + offset }), firstA && ac ? { decoderConfig: ac } : undefined);
          firstA = false;
          na = await as!.next();
        }
      }
    }
    await output.finalize();
  } finally {
    await sink.close();
  }
  for (let k = 0; k < n; k++) await store.remove(partName(segment, k));
  return name;
}
