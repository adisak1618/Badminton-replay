// Camera frame + overlay, once per delivered camera frame (technical-design.md §6.2): a hidden <video> plays
// the camera stream, requestVideoFrameCallback draws it into the canvas and paints the overlay on top. The
// canvas is the visible preview and the source of captureStream, so the preview is exactly what is recorded.
import { DEFAULT_THEME, drawEndCard, drawLogo, drawOverlay, drawStatsTable, type Box, type DrawClock, type EndCard, type OverlayModel, type StatsTable } from '../overlay';

export interface OverlayFrame {
  /** `bandAbove`: the panel is in a bottom corner, so its badge goes above the rows. */
  score: { model: OverlayModel; box: Box; u: number; bandAbove: boolean } | null;
  logo: { image: CanvasImageSource; box: Box } | null;
  table: { model: StatsTable; box: Box; u: number } | null;
  card: { model: EndCard; box: Box } | null;
  /** The frame's scoreboard time and the motion set: everything that moves is a function of these (motion.ts). */
  clock: DrawClock;
}

export type OverlayFeed = (now: number) => OverlayFrame;

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

export class Compositor {
  readonly video: FrameVideo;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private handle: number | null = null;
  private generation = 0;
  private secStart = 0;
  private secFrames = 0;
  /** Frames drawn in the last full second. */
  fps = 0;
  /** Frames drawn and the longest gap between two of them since the last resetStats (R-REC-8 by eye). */
  drawn = 0;
  longestGapMs = 0;
  private lastFrame: number | null = null;

  constructor(private readonly overlay: OverlayFeed) {
    const v = document.createElement('video') as FrameVideo;
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('aria-hidden', 'true');
    // Kept in the DOM and nearly invisible: iOS stops decoding frames for a video that is not rendered at all.
    Object.assign(v.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none' });
    document.body.appendChild(v);
    this.video = v;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'preview-canvas';
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
  }

  /** The context the overlays are drawn with: anything sized to be drawn here is measured with this font setup. */
  get drawContext(): CanvasRenderingContext2D {
    return this.ctx;
  }

  setSize(w: number, h: number): void {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, w, h);
  }

  async attach(stream: MediaStream): Promise<void> {
    this.stop();
    this.video.srcObject = stream;
    await this.video.play().catch(() => {});
    this.start();
  }

  detach(): void {
    this.stop();
    this.video.srcObject = null;
  }

  resetStats(): void {
    this.drawn = 0;
    this.longestGapMs = 0;
    this.lastFrame = null;
  }

  private start(): void {
    const gen = ++this.generation;
    const v = this.video;
    const loop = (now: number) => {
      if (gen !== this.generation) return;
      this.draw(now);
      this.handle = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(loop) : requestAnimationFrame(loop);
    };
    this.handle = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(loop) : requestAnimationFrame(loop);
  }

  private stop(): void {
    this.generation++;
    if (this.handle == null) return;
    if (this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.handle);
    else cancelAnimationFrame(this.handle);
    this.handle = null;
  }

  private draw(now: number): void {
    const { video: v, ctx } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (vw && vh) {
      // Cover-fit: a source of another aspect (portrait after a rotation, A6) is cropped, never stretched.
      const sc = Math.max(W / vw, H / vh);
      const sw = W / sc;
      const sh = H / sc;
      ctx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, W, H);
    }
    const o = this.overlay(Date.now());
    if (o.logo) drawLogo(ctx, o.logo.image, o.logo.box);
    if (o.score) drawOverlay(ctx, o.score.model, o.score.box, o.score.u, DEFAULT_THEME, { ...o.clock, bandAbove: o.score.bandAbove });
    if (o.table) drawStatsTable(ctx, o.table.model, o.table.box, o.table.u, DEFAULT_THEME, o.clock);
    if (o.card) drawEndCard(ctx, o.card.model, o.card.box, DEFAULT_THEME, o.clock);

    this.drawn++;
    if (this.lastFrame != null) this.longestGapMs = Math.max(this.longestGapMs, now - this.lastFrame);
    this.lastFrame = now;
    this.secFrames++;
    if (now - this.secStart >= 1000) {
      this.fps = Math.round((this.secFrames * 1000) / (now - this.secStart));
      this.secStart = now;
      this.secFrames = 0;
    }
  }

  dispose(): void {
    this.detach();
    this.video.remove();
  }
}
