// The camera role's recording pipeline (technical-design.md §6): camera → compositor → captureStream + mic →
// MediaRecorder → worker → OPFS, driven by the segment state machine and by remote REC commands from the
// score source. Everything browser-specific lives here; the decisions are in session.ts, writer.ts and the
// overlay model, which are unit tested.
import { keepScreenOn } from '../device/wakeLock';
import { Mirror } from '../link/mirror';
import { NoSource } from '../link/none';
import type { PeerInfo, RecCommand, RecReport, ScoreSource } from '../link/source';
import {
  DEFAULT_THEME,
  OverlayClock,
  overlayLayout,
  panelMaxHeight,
  panelScale,
  panelSize,
  statsTableSize,
  type Layout,
  type OverlayModel,
  type StatsOptions,
  type StatsTable,
} from '../overlay';
import { Compositor } from './compositor';
import type { Logo } from './logo';
import {
  AUDIO_BITS_PER_SECOND,
  MIME_TYPES,
  QUALITIES,
  START_LATENCY_MS,
  TIMESLICE_MS,
  minutesLeft,
  type CameraSettings,
} from './config';
import { LOG_FILE, MATCHES_DIR, RECORDING_FILE, newMeta, recordingId, type RecordingMeta } from './meta';
import { current, initialSession, isActive, sessionReduce, type EndReason, type Session, type SessionAction } from './session';
import { findRecording, opfsSupported, requestPersistence, storageFigures, type StorageFigures } from './storage';
import { WriterClient } from './writerClient';

export type CameraState = 'off' | 'starting' | 'live' | 'denied' | 'error';

export interface CameraSnapshot {
  settings: CameraSettings;
  camera: CameraState;
  cameraError: string | null;
  opfs: 'checking' | 'ok' | 'unavailable';
  session: Session;
  recId: string | null;
  bytes: number;
  storage: StorageFigures;
  persistAsked: boolean;
  fps: number;
  /** The overlay logo's size, when one is set (the image itself stays in the controller). */
  logo: { width: number; height: number } | null;
}

export function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

const MESSAGES: Record<string, string> = {
  interrupted: 'Recording stopped: camera interrupted.',
  hidden: 'Recording stopped: the app was hidden.',
  recorder: 'Recording stopped: the recorder reported an error.',
  quota: 'Storage full: recording stopped. Everything recorded so far is kept.',
};

function cameraErrorText(err: unknown): { state: CameraState; text: string } {
  const name = (err as DOMException)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return {
      state: 'denied',
      text: 'Camera access was denied. Allow it in Settings › Apps › Safari › Camera (for the Home Screen app: Settings › Privacy & Security › Camera), then retry.',
    };
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return { state: 'error', text: 'No suitable camera was found.' };
  if (name === 'NotReadableError') return { state: 'error', text: 'The camera is in use by another app. Close it and retry.' };
  return { state: 'error', text: `The camera could not start (${name ?? String(err)}).` };
}

export class CameraController {
  readonly mirror = new Mirror();
  readonly compositor: Compositor;
  private source: ScoreSource = new NoSource();
  private detachSource: () => void;
  private overlayClock = new OverlayClock();
  private snap: CameraSnapshot;
  private listeners = new Set<() => void>();
  private worker: Worker | null = null;
  private writer: WriterClient | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private canvasTrack: MediaStreamTrack | null = null;
  private meta: RecordingMeta | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private finishing: Promise<void> | null = null;
  private handled = new Map<string, { ok: boolean; error?: string }>();
  /** The camera screen is showing: bring the preview back after the app returns from the background. */
  private wantCamera = false;
  private logTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStorageAt = 0;
  private startingRec = false;
  private logo: Logo | null = null;
  private measure = document.createElement('canvas').getContext('2d')!;
  private sized: { model: OverlayModel; u: number; size: { w: number; h: number } } | null = null;
  /** The match summary that was on screen while recording: it ends with the recording (R-TAG-7). */
  private matchCardRecorded: number | null = null;
  private tableSized: { table: StatsTable; u: number; fonts: number; size: { w: number; h: number } } | null = null;
  /** Bumped when the browser's fonts change, so the table is measured again with what will draw it. */
  private fontsEpoch = 0;

  constructor(
    settings: CameraSettings,
    private readonly device: PeerInfo,
  ) {
    this.snap = {
      settings,
      camera: 'off',
      cameraError: null,
      opfs: 'checking',
      session: initialSession,
      recId: null,
      bytes: 0,
      storage: { usage: null, quota: null, persisted: null },
      persistAsked: false,
      fps: 0,
      logo: null,
    };
    this.compositor = new Compositor((now) => {
      const m = this.mirror.getSnapshot();
      const s = this.snap.settings;
      const seg = current(this.snap.session);
      // While recording, the segment's own settings are what is burned in (they are locked in C3 anyway).
      const mirrored = seg ? seg.overlay.mirrored : s.mirrored;
      const delayMs = seg ? seg.overlay.delayMs : s.delayMs;
      const model = this.overlayClock.at(m.config, m.events, now, {
        delayMs,
        offsetMs: this.source.clock()?.offsetMs ?? 0,
        mirrored,
        stale: m.link !== 'paired',
        stats: this.statsOptions(),
      });
      const layout = this.layout(model);
      if (layout.score && this.snap.session.phase === 'recording') {
        const before = this.snap.session;
        this.dispatch({ type: 'panelBox', at: now, box: layout.score });
        if (this.snap.session !== before) this.saveMeta(); // a new game column or the band: rare
      }
      let card = model?.card ?? null;
      if (card?.kind === 'match') {
        if (isActive(this.snap.session.phase)) this.matchCardRecorded = card.seq;
        else if (this.matchCardRecorded === card.seq) card = null; // the recording stopped: the match card goes
      }
      return {
        score: model && layout.score && { model, box: layout.score, u: this.panelU() },
        logo: this.logo && layout.logo ? { image: this.logo.image, box: layout.logo } : null,
        table: model?.table && layout.table ? { model: model.table, box: layout.table, u: this.panelU() } : null,
        card: card ? { model: card, u: this.panelU() } : null,
      };
    });
    this.compositor.setSize(QUALITIES[settings.quality].width, QUALITIES[settings.quality].height);
    this.mirror.onCommand = (c) => void this.command(c);
    this.detachSource = this.mirror.attach(this.source);
    this.mirror.subscribe(() => this.onMirror());
    document.addEventListener('visibilitychange', this.onVisibility);
    document.fonts?.addEventListener?.('loadingdone', () => this.fontsEpoch++);
    setInterval(() => this.tick(), 1000);
    void this.checkOpfs();
    void this.refreshStorage();
  }

  // ---- store plumbing for React ----
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): CameraSnapshot => this.snap;
  private set(patch: Partial<CameraSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }
  private dispatch(a: SessionAction): void {
    const before = this.snap.session;
    const session = sessionReduce(before, a);
    if (session !== before) {
      this.set({ session });
      this.report();
    }
  }

  get scoreSource(): ScoreSource {
    return this.source;
  }

  /** Swap the score source: not paired, the same-phone demo, or the paired scoreboard. */
  setSource(src: ScoreSource): void {
    this.detachSource();
    this.source = src;
    this.detachSource = this.mirror.attach(src);
    this.report();
  }

  private panelU(): number {
    return panelScale(this.compositor.canvas.height, this.snap.settings.scoreSize);
  }

  /** The panel's size follows its content; measured once per change of the overlay model, not per frame. */
  private panelSizeFor(model: OverlayModel): { w: number; h: number } {
    const u = this.panelU();
    if (this.sized?.model !== model || this.sized.u !== u)
      this.sized = { model, u, size: panelSize(this.measure, model, u) };
    return this.sized.size;
  }

  /** What the camera asks the video to show about the point reasons: C1 "Player stats" and "End-of-game summary". */
  private statsOptions(): StatsOptions {
    const s = this.snap.settings;
    return { table: s.statsTeam === 'off' ? null : { team: s.statsTeam, opp: s.statsOpp }, card: s.endCard };
  }

  /**
   * The table's size follows its names and the Thai words in its font, so it is measured with the compositor's own
   * context (the one that draws it) and again when the scale, the table or the browser's fonts change.
   */
  private tableSizeFor(table: StatsTable): { w: number; h: number } {
    const u = this.panelU();
    if (this.tableSized?.table !== table || this.tableSized.u !== u || this.tableSized.fonts !== this.fontsEpoch)
      this.tableSized = { table, u, fonts: this.fontsEpoch, size: statsTableSize(this.compositor.drawContext, table, u) };
    return this.tableSized.size;
  }

  /** Where the score panel, the logo and the stats table go in the current frame (corners and sizes are C1 settings). */
  layout(model: OverlayModel | null = this.lastModel()): Layout {
    const { width, height } = this.compositor.canvas;
    const s = this.snap.settings;
    const logo = this.logo ? { corner: s.logoCorner, size: s.logoSize, aspect: this.logo.width / this.logo.height } : null;
    return overlayLayout(width, height, {
      scoreCorner: s.scoreCorner,
      score: model && this.panelSizeFor(model),
      scoreMaxH: panelMaxHeight(this.panelU()),
      logo,
      table: model?.table ? { place: s.statsPlace, ...this.tableSizeFor(model.table) } : null,
    });
  }

  private lastModel(): OverlayModel | null {
    const m = this.mirror.getSnapshot();
    const s = this.snap.settings;
    return this.overlayClock.at(m.config, m.events, Date.now(), {
      delayMs: s.delayMs,
      offsetMs: this.source.clock()?.offsetMs ?? 0,
      mirrored: s.mirrored,
      stale: m.link !== 'paired',
      stats: this.statsOptions(),
    });
  }

  /** Set or clear the overlay logo; like the other overlay settings it cannot change mid-recording. */
  setLogo(logo: Logo | null): boolean {
    if (isActive(this.snap.session.phase)) return false;
    this.logo = logo;
    this.set({ logo: logo && { width: logo.width, height: logo.height } });
    return true;
  }

  // ---- settings and camera ----
  setSettings(patch: Partial<CameraSettings>): void {
    if (isActive(this.snap.session.phase)) return; // locked while recording: the segment records what it used
    const prev = this.snap.settings;
    const settings = { ...prev, ...patch };
    this.set({ settings });
    if (settings.quality !== prev.quality) {
      const q = QUALITIES[settings.quality];
      this.compositor.setSize(q.width, q.height);
    }
    if ((settings.quality !== prev.quality || settings.audio !== prev.audio) && this.stream) void this.startCamera();
  }

  async startCamera(): Promise<void> {
    if (this.snap.camera === 'starting') return;
    this.wantCamera = true;
    this.releaseStream();
    this.set({ camera: 'starting', cameraError: null });
    const { quality, audio } = this.snap.settings;
    const q = QUALITIES[quality];
    let stream: MediaStream;
    try {
      // §6.1; the phone must already be in landscape (A6).
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.fps } },
        audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
      });
    } catch (err) {
      const e = cameraErrorText(err);
      this.set({ camera: e.state, cameraError: e.text });
      return;
    }
    if (!this.wantCamera) {
      // The user left the camera screen while the permission prompt was up.
      for (const t of stream.getTracks()) t.stop();
      return this.set({ camera: 'off' });
    }
    this.stream = stream;
    for (const t of stream.getTracks()) {
      t.addEventListener('ended', () => this.onTrackLost(stream));
      t.addEventListener('mute', () => this.onTrackLost(stream));
    }
    this.compositor.setSize(q.width, q.height);
    await this.compositor.attach(stream);
    this.set({ camera: 'live' });
    keepScreenOn(true); // the camera waits for a remote REC (D11), so it must not sleep in C1 either
    if (!this.snap.persistAsked) {
      this.set({ persistAsked: true });
      await requestPersistence();
      void this.refreshStorage(true);
    }
  }

  private releaseStream(): void {
    const s = this.stream;
    this.stream = null;
    this.compositor.detach();
    if (s) for (const t of s.getTracks()) t.stop();
  }

  stopCamera(): void {
    this.wantCamera = false;
    this.releaseStream();
    if (this.snap.camera !== 'denied' && this.snap.camera !== 'error') this.set({ camera: 'off' });
  }

  /** iOS ends or mutes capture on a call, a lock or an app switch (§6.5); a muted track cannot be unmuted. */
  private onTrackLost(stream: MediaStream): void {
    if (stream !== this.stream) return;
    if (isActive(this.snap.session.phase)) this.stopRec('interrupted', MESSAGES.interrupted);
    else {
      this.releaseStream();
      this.set({ camera: 'off' });
    }
  }

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      if (isActive(this.snap.session.phase)) this.stopRec('interrupted', MESSAGES.hidden);
    } else if (this.snap.camera === 'off' && this.snap.session.phase === 'idle' && this.wantCamera) {
      void this.startCamera(); // back from the background with nothing recording: bring the preview back
    }
  };

  // ---- OPFS ----
  private ensureWriter(): WriterClient {
    if (!this.writer) {
      this.worker = new Worker(new URL('./opfs.worker.ts', import.meta.url), { type: 'module' });
      this.writer = new WriterClient(this.worker);
      this.writer.onBytes = (bytes) => {
        if (isActive(this.snap.session.phase)) this.set({ bytes });
      };
      this.writer.onFailure = (r) =>
        r.error === 'QuotaExceededError'
          ? this.stopRec('quota', MESSAGES.quota)
          : this.stopRec('error', `Recording stopped: writing to storage failed (${r.error}). What was written is kept.`);
    }
    return this.writer;
  }

  private async checkOpfs(): Promise<void> {
    if (!opfsSupported() || typeof Worker === 'undefined') return this.set({ opfs: 'unavailable' });
    const r = await this.ensureWriter().put([MATCHES_DIR], '.probe', '');
    this.set({ opfs: r.ok ? 'ok' : 'unavailable' });
  }

  async refreshStorage(force = false): Promise<void> {
    if (!force && Date.now() - this.lastStorageAt < 5000) return;
    this.lastStorageAt = Date.now();
    this.set({ storage: await storageFigures() });
  }

  minutesLeft(): number | null {
    return minutesLeft(this.snap.storage, this.snap.settings.quality, this.snap.settings.audio);
  }

  private saveMeta(): void {
    const meta = this.meta;
    if (!meta || !this.writer) return;
    const m = this.mirror.getSnapshot();
    if (!meta.matchId && m.matchId) meta.matchId = m.matchId; // recorded unpaired, the match arrived later
    meta.segments = this.snap.session.segments;
    meta.updatedAt = Date.now();
    meta.clock = this.source.clock() ?? meta.clock;
    meta.scoreboard = this.source.peer() ?? meta.scoreboard;
    void this.writer.put([MATCHES_DIR, meta.id], RECORDING_FILE, JSON.stringify(meta));
  }

  private saveLog(): void {
    const meta = this.meta;
    const log = this.mirror.log();
    if (!meta || !log || !this.writer || meta.matchId !== log.matchId) return;
    void this.writer.put([MATCHES_DIR, meta.id], LOG_FILE, JSON.stringify(log));
  }

  /** The mirror changed: keep the recording's copy of the log current, at most every second (and on close). */
  private onMirror(): void {
    if (!this.meta) return;
    if (!this.meta.matchId && this.mirror.getSnapshot().matchId) this.saveMeta();
    if (this.logTimer) return;
    this.logTimer = setTimeout(() => {
      this.logTimer = null;
      this.saveLog();
    }, 1000);
  }

  // ---- recording ----
  /** Open (or continue) the record of the match the scoreboard is on. */
  private async bindRecording(): Promise<RecordingMeta> {
    const m = this.mirror.getSnapshot();
    const phase = this.snap.session.phase;
    // Resume after an interruption, or REC again for the same match: more segments of the same recording.
    if (this.meta && (m.matchId ? this.meta.matchId === m.matchId : phase === 'interrupted' || phase === 'full')) return this.meta;
    const now = Date.now();
    const id = recordingId(m.matchId, now);
    const found = m.matchId ? await findRecording(id, this.device).catch(() => null) : null;
    const meta = found?.meta ?? newMeta(id, m.matchId, this.device, now);
    this.dispatch({ type: 'load', segments: meta.segments });
    return meta;
  }

  async startRec(): Promise<void> {
    if (isActive(this.snap.session.phase) || this.startingRec) return;
    this.startingRec = true;
    try {
      await this.openSegment();
    } finally {
      this.startingRec = false;
    }
  }

  private async openSegment(): Promise<void> {
    if (this.snap.camera !== 'live') await this.startCamera();
    if (this.snap.camera !== 'live' || !this.stream) return this.dispatch({ type: 'failed', message: this.snap.cameraError ?? 'The camera is not running.' });
    if (this.snap.opfs === 'unavailable')
      return this.dispatch({ type: 'failed', message: 'Recording needs normal browsing mode (not Private Browsing).' });
    const mimeType = pickMimeType();
    if (!mimeType) return this.dispatch({ type: 'failed', message: 'This browser cannot record video.' });

    const meta = await this.bindRecording();
    this.meta = meta;
    const { settings } = this.snap;
    const q = QUALITIES[settings.quality];
    const { width, height } = this.compositor.canvas;
    const layout = this.layout();
    this.dispatch({
      type: 'start',
      at: Date.now(),
      draft: {
        ext: mimeType.includes('mp4') ? 'mp4' : 'webm',
        mimeType,
        width,
        height,
        fps: q.fps,
        startLatencyMs: START_LATENCY_MS,
        overlay: {
          box: layout.score ?? { x: 0, y: 0, w: 0, h: 0 },
          boxes: layout.score ? [{ at: Date.now(), box: layout.score }] : [],
          corner: settings.scoreCorner,
          size: settings.scoreSize,
          delayMs: settings.delayMs,
          mirrored: settings.mirrored,
          theme: DEFAULT_THEME.id,
          logo: layout.logo && { box: layout.logo, corner: settings.logoCorner, size: settings.logoSize },
          stats:
            settings.statsTeam === 'off' && !settings.endCard
              ? null
              : {
                  team: settings.statsTeam,
                  place: settings.statsPlace,
                  opp: settings.statsOpp,
                  box: layout.table,
                  card: settings.endCard,
                },
        },
      },
    });
    const seg = current(this.snap.session)!;
    this.set({ recId: meta.id, bytes: 0 });
    const writer = this.ensureWriter();
    const opened = await writer.open([MATCHES_DIR, meta.id], seg.file);
    if (!opened.ok) {
      this.set({ opfs: 'unavailable' });
      return this.dispatch({ type: 'failed', message: `Recording needs normal browsing mode: storage refused the file (${opened.error}).` });
    }
    if (this.snap.session.phase !== 'starting' || !this.stream) return; // stopped while the file was opening
    this.saveMeta();
    this.saveLog(); // the log is on disk from the first second, so even a crash leaves the score with the video

    let recorder: MediaRecorder;
    try {
      const track = this.compositor.canvas.captureStream(q.fps).getVideoTracks()[0];
      this.canvasTrack = track;
      const tracks = [track, ...(settings.audio ? this.stream.getAudioTracks() : [])];
      recorder = new MediaRecorder(new MediaStream(tracks), {
        mimeType,
        videoBitsPerSecond: q.videoBitsPerSecond,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      });
      track.addEventListener('ended', () => this.stopRec('interrupted', MESSAGES.interrupted));
    } catch (err) {
      this.canvasTrack?.stop();
      await writer.close();
      return this.dispatch({ type: 'failed', message: `The recorder could not start (${(err as Error).name ?? err}).` });
    }
    this.recorder = recorder;
    this.writeChain = Promise.resolve();
    this.finishing = null;
    recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const blob = e.data;
      // Keep chunk order: each blob is turned into bytes and posted only after the previous one.
      this.writeChain = this.writeChain.then(async () => {
        void writer.append(await blob.arrayBuffer());
      });
    };
    recorder.onstart = () => {
      this.dispatch({ type: 'started', at: Date.now() });
      this.compositor.resetStats();
      this.saveMeta();
    };
    recorder.onerror = () => this.stopRec('error', MESSAGES.recorder);
    recorder.onstop = () => void this.finishSegment();
    recorder.start(TIMESLICE_MS);
    keepScreenOn(true);
  }

  /** Ask the recorder to stop; the segment is closed once its last chunk is on disk. */
  stopRec(reason: EndReason, message?: string): void {
    const phase = this.snap.session.phase;
    if (phase !== 'starting' && phase !== 'recording') return;
    this.dispatch({ type: 'stop', reason, message });
    const r = this.recorder;
    try {
      if (r && r.state !== 'inactive') r.stop();
      else void this.finishSegment();
    } catch {
      void this.finishSegment();
    }
  }

  private finishSegment(): Promise<void> {
    this.finishing ??= (async () => {
      await this.writeChain;
      const closed = await this.ensureWriter().close();
      this.canvasTrack?.stop();
      this.canvasTrack = null;
      this.recorder = null;
      this.dispatch({ type: 'closed', at: Date.now(), bytes: closed.bytes });
      this.saveMeta();
      this.saveLog();
      // After an interruption the camera is re-acquired by Resume (R-REC-5).
      if (this.snap.session.phase === 'interrupted') this.stopCamera();
      void this.refreshStorage(true);
    })();
    return this.finishing;
  }

  /** "Resume (segment n+1)": one tap re-acquires the camera and opens the next segment of the same match. */
  async resume(): Promise<void> {
    await this.startCamera();
    await this.startRec();
  }

  dismiss(): void {
    this.dispatch({ type: 'dismiss' });
    if (this.snap.camera === 'off') void this.startCamera();
  }

  // ---- remote REC (D11) and the rec report ----
  async command(c: RecCommand): Promise<void> {
    const prev = this.handled.get(c.id);
    if (prev) return this.source.ack(c.id, prev.ok, prev.error); // a retry after a blip never starts twice
    let res: { ok: boolean; error?: string };
    if (c.action === 'rec.start') {
      if (!isActive(this.snap.session.phase)) await this.startRec();
      const s = this.snap.session;
      res = isActive(s.phase) ? { ok: true } : { ok: false, error: s.message ?? 'not recording' };
    } else {
      this.stopRec('user');
      res = { ok: true };
    }
    this.handled.set(c.id, res);
    this.source.ack(c.id, res.ok, res.error);
  }

  private report(): void {
    const s = this.snap.session;
    const seg = current(s);
    const state: RecReport['state'] =
      s.phase === 'starting' || s.phase === 'recording'
        ? 'recording'
        : s.phase === 'stopping'
          ? 'stopping'
          : s.phase === 'idle'
            ? 'idle'
            : 'error';
    const r: RecReport = { state, minutesLeft: this.minutesLeft() ?? undefined };
    if (seg) Object.assign(r, { segment: seg.index, startedAt: seg.startedAt, elapsedMs: Date.now() - seg.startedAt, bytes: this.snap.bytes });
    if (state === 'error' && s.message) r.error = s.message;
    this.source.report(r);
  }

  private tick(): void {
    const fps = this.snap.camera === 'live' ? this.compositor.fps : 0;
    if (fps !== this.snap.fps) this.set({ fps });
    if (isActive(this.snap.session.phase)) {
      this.report();
      void this.refreshStorage();
    }
  }

  get recording(): boolean {
    return isActive(this.snap.session.phase);
  }
}
