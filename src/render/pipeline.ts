// Rendering one part of a segment's output timeline (timeline.ts) on the phone with WebCodecs through Mediabunny
// (research report §3F: the only library that ran in both Chrome and WebKit, audio copied untouched): decode the
// recording, draw each output frame on a canvas with the overlay (paint.ts), encode H.264, and copy the recording's
// AAC packets under it. Mediabunny is loaded only when a render starts, never on the scoreboard or while recording.
import { NO_REPLAY, replayFrame, replayMarks, type ReplayFrame, type ReplayPlan } from '../overlay';
import type { FramePainter } from './paint';
import { piecesIn, type Piece, type SegmentTimeline } from './timeline';

type MB = typeof import('./mb');
let mb: Promise<MB> | null = null;
/** Mediabunny (the parts in mb.ts), loaded on first use. */
export const mediabunny = (): Promise<MB> => (mb ??= import('./mb'));

/** Where a part's bytes go: appended in order (the fragmented MP4 output only appends). */
export interface PartSink {
  write(data: Uint8Array): Promise<void>;
}

export interface PartSource {
  file: Blob;
  durationMs: number;
}

const FRAME_MS = 1000 / 30;

/**
 * The output frames of output ms [from, to): every frame sits on the 30 fps grid (frame k at k / 30 s), so no two share
 * a tick of the file's 1/30 s timescale where a replay hands back to live (or a part starts mid-piece).
 */
function* gridFrames(from: number, to: number): Generator<number> {
  for (let k = Math.ceil(from / FRAME_MS - 1e-6); k * FRAME_MS < to - 1e-6; k++) yield k * FRAME_MS;
}

/** Bits per second for the output: the recording's own quality (D8). */
export const bitrateFor = (height: number): number => (height <= 720 ? 3_500_000 : 6_000_000);

/** The replay graphics at output ms `t`: the replay whose card or picture is on screen, if any. */
export function chromeAt(plans: readonly ReplayPlan[], t: number): { plan: ReplayPlan; f: ReplayFrame } | null {
  for (const plan of plans) {
    if (t < plan.at || t >= replayMarks(plan).done) continue;
    return { plan, f: replayFrame(plan, t) };
  }
  return null;
}

/** Recorded frames around a moving source time, two at a time, for the blended slow motion. */
class FrameCursor {
  private it: AsyncIterator<InstanceType<MB['VideoSample']>> | null = null;
  a: InstanceType<MB['VideoSample']> | null = null;
  b: InstanceType<MB['VideoSample']> | null = null;
  private done = false;
  constructor(private readonly sink: InstanceType<MB['VideoSampleSink']>) {}

  async start(fromS: number, toS: number): Promise<void> {
    this.close();
    this.it = this.sink.samples(fromS, toS + 0.5)[Symbol.asyncIterator]();
    this.done = false;
    this.a = await this.next();
    this.b = await this.next();
  }

  private async next() {
    if (this.done || !this.it) return null;
    const r = await this.it.next();
    if (r.done) this.done = true;
    return r.done ? null : r.value;
  }

  /** Move so that a.timestamp <= s < b.timestamp (or b is the last frame). */
  async seek(s: number): Promise<void> {
    while (this.b && this.b.timestamp <= s) {
      this.a?.close();
      this.a = this.b;
      this.b = await this.next();
    }
  }

  close(): void {
    this.a?.close();
    this.b?.close();
    this.a = this.b = null;
    void this.it?.return?.();
    this.it = null;
  }
}

export interface PartResult {
  frames: number;
  outMs: number;
  audioPackets: number;
}

/**
 * Render output ms [from, to) of `tl` into `sink` as one standalone fragmented MP4 (timestamps from 0). `blend` draws
 * the half-way frames of the slow motion as a mix of their two neighbours (research board Q12).
 */
export async function renderPart(
  tl: SegmentTimeline,
  part: { from: number; to: number },
  source: PartSource,
  painter: FramePainter,
  sink: PartSink,
  o: { blend: boolean; signal?: AbortSignal; onFrame?: (outMs: number) => void },
): Promise<PartResult> {
  const M = await mediabunny();
  const input = new M.Input({ source: new M.BlobSource(source.file), formats: [M.MP4, M.QTFF] });
  const vTrack = await input.getPrimaryVideoTrack();
  if (!vTrack) throw new Error('the recording has no video track');
  const aTrack = await input.getPrimaryAudioTrack();
  const { W, H } = painter;
  const canvas = new OffscreenCanvas(W, H);
  const g = canvas.getContext('2d', { alpha: false })!;
  const frozen = new OffscreenCanvas(W, H);
  const fg = frozen.getContext('2d', { alpha: false })!;
  let frozenAt: number | null = null;

  let position = 0;
  const writable = new WritableStream<{ type: 'write'; data: Uint8Array; position: number }>({
    async write(c) {
      if (c.position !== position) throw new Error(`the MP4 writer jumped from ${position} to ${c.position}`);
      position += c.data.byteLength;
      await sink.write(c.data);
    },
  });
  const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'fragmented' }), target: new M.StreamTarget(writable) });
  const video = new M.CanvasSource(canvas, { codec: 'avc', bitrate: bitrateFor(H), keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: 30 });
  const audio = aTrack ? new M.EncodedAudioPacketSource((await aTrack.getCodec()) ?? 'aac') : null;
  if (audio) output.addAudioTrack(audio);
  await output.start();

  const pieces = piecesIn(tl, part.from, part.to);
  // The sound: each piece's recording packets moved to its output time (a replay plays what followed the pause).
  const sound: Array<{ t: number; p: InstanceType<MB['EncodedPacket']> }> = [];
  if (aTrack) {
    const as = new M.EncodedPacketSink(aTrack);
    for (const pc of pieces) {
      const src = pc.kind === 'live' ? pc.src : pc.pauseAt + (pc.out - (tl.pieces.find((x) => x.kind === 'replay' && x.plan === pc.plan)?.out ?? pc.out));
      let p = await as.getPacket(src / 1000);
      while (p && p.timestamp * 1000 < src + pc.len) {
        const t = pc.out + (p.timestamp * 1000 - src);
        if (t >= pc.out) sound.push({ t, p });
        p = await as.getNextPacket(p);
      }
    }
  }
  let soundAt = 0;
  let firstAudio = true;
  const audioConfig = aTrack ? await aTrack.getDecoderConfig() : null;
  const flushSound = async (upTo: number) => {
    while (audio && soundAt < sound.length && sound[soundAt].t <= upTo) {
      const { t, p } = sound[soundAt++];
      await audio.add(p.clone({ timestamp: (t - part.from) / 1000 }), firstAudio && audioConfig ? { decoderConfig: audioConfig } : undefined);
      firstAudio = false;
    }
  };

  const liveSink = new M.VideoSampleSink(vTrack);
  const replaySink = new M.VideoSampleSink(vTrack);
  const cursor = new FrameCursor(replaySink);
  const liveCursor = new FrameCursor(liveSink);
  let frames = 0;
  const emit = async (t: number, dur: number) => {
    await video.add((t - part.from) / 1000, dur / 1000);
    frames++;
    await flushSound(t);
    o.onFrame?.(t);
    if (o.signal?.aborted) throw new DOMException('render cancelled', 'AbortError');
  };
  const drawLive = (s: InstanceType<MB['VideoSample']>) => s.draw(g as unknown as CanvasRenderingContext2D, 0, 0, W, H);

  try {
    for (const pc of pieces as Piece[]) {
      if (pc.kind === 'live') {
        // Each grid frame shows the latest recorded frame at its moment (a recording's own timing is close to 30 fps).
        await liveCursor.start(pc.src / 1000, (pc.src + pc.len) / 1000);
        for (const t of gridFrames(pc.out, pc.out + pc.len)) {
          const src = pc.src + (t - pc.out);
          await liveCursor.seek(src / 1000 + 0.0005);
          const s = liveCursor.a;
          if (!s) break;
          drawLive(s);
          // The latest live picture, before anything is drawn on it: a replay that pauses here shows it.
          fg.drawImage(canvas, 0, 0);
          frozenAt = src;
          const c = chromeAt(tl.plans, t);
          painter.paint(g, src, c?.f ?? NO_REPLAY, c?.plan ?? null, null);
          await emit(t, FRAME_MS);
        }
        liveCursor.close();
      } else {
        // The paused live picture: the last frame before the pause (decoded again when the part starts here).
        if (frozenAt == null || Math.abs(frozenAt - pc.pauseAt) > 100) {
          const s = await liveSink.getSample(Math.max(0, pc.pauseAt - FRAME_MS) / 1000);
          if (s) {
            s.draw(fg as unknown as CanvasRenderingContext2D, 0, 0, W, H);
            s.close();
          }
          frozenAt = pc.pauseAt;
        }
        await cursor.start(pc.plan.from / 1000, pc.plan.to / 1000);
        for (const t of gridFrames(pc.out, pc.out + pc.len)) {
          const f = replayFrame(pc.plan, t);
          if (f.mix < 1) g.drawImage(frozen, 0, 0);
          if (f.mix > 0) {
            await cursor.seek(f.src / 1000);
            const { a, b } = cursor;
            if (a) {
              g.globalAlpha = f.mix;
              a.draw(g as unknown as CanvasRenderingContext2D, 0, 0, W, H);
              if (o.blend && b && b.timestamp > a.timestamp) {
                const w = (f.src / 1000 - a.timestamp) / (b.timestamp - a.timestamp);
                if (w > 0.02) {
                  g.globalAlpha = f.mix * Math.min(1, w);
                  b.draw(g as unknown as CanvasRenderingContext2D, 0, 0, W, H);
                }
              }
              g.globalAlpha = 1;
            }
          }
          painter.paint(g, pc.pauseAt, f.on ? f : { ...f, on: true }, pc.plan, pc.pauseAt);
          await emit(t, FRAME_MS);
        }
        cursor.close();
      }
    }
    await flushSound(Infinity);
    await output.finalize();
  } catch (err) {
    cursor.close();
    liveCursor.close();
    await output.cancel().catch(() => {});
    throw err;
  }
  return { frames, outMs: part.to - part.from, audioPackets: soundAt };
}
