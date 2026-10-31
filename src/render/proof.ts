// Proof renders for `pnpm render-proof` (e2e/render.ts): a match logged over a real clip, rendered in the browser by
// the real renderer into OPFS, then handed to node for ffprobe and pixel checks. Not part of the app: e2e/render.html
// imports it through the dev server.
import { append, configFromSetup, DEFAULT_SETUP, reduce, type EventBody, type MatchConfig, type MatchEvent, type Team } from '../engine';
import { OverlayClock, overlayLayout, panelMaxHeight, panelScale, panelSize, type Box } from '../overlay';
import { buildBundle, type MatchBundle } from '../recording/bundle';
import { newMeta } from '../recording/meta';
import type { Segment } from '../recording/session';
import { DEFAULT_RENDER, renderMatch, type JobState, type RenderOptions, type RenderStore } from './job';
import { mediabunny } from './pipeline';
import { OpfsRenderStore } from './store';
import { segmentTimeline } from './timeline';

declare global {
  interface Window {
    __render: (o: ProofCase) => Promise<ProofResult>;
    __seed: (o: ProofCase & { id: string }) => Promise<void>;
    __ready: boolean;
    saveChunk: (name: string, b64: string, last: boolean) => Promise<void>;
  }
}

export interface ProofCase {
  name: string;
  clipUrl: string;
  /** A rally every this many ms; every `replayEvery`-th point gets a replay. */
  every: number;
  replayEvery: number;
  imported: boolean;
  options?: Partial<RenderOptions>;
  /** Stop after this much of the clip (ms); the whole clip when absent. */
  limitMs?: number;
  /** Where the render keeps its files: OPFS as on the phone, or memory (Playwright's WebKit has no OPFS: ephemeral). */
  store?: 'opfs' | 'memory';
  /** Keep the parts after the join and hand them to node too (looking into a broken join). */
  keepParts?: boolean;
}

/** The render's files in memory, for an engine without OPFS. */
class MemoryStore implements RenderStore {
  private files = new Map<string, Uint8Array[]>();
  private job: JobState | null = null;
  async readJob() {
    return this.job;
  }
  async writeJob(j: JobState) {
    this.job = JSON.parse(JSON.stringify(j)) as JobState;
  }
  async open(name: string) {
    const list: Uint8Array[] = [];
    this.files.set(name, list);
    return { write: async (d: Uint8Array) => void list.push(d.slice()), close: async () => {} };
  }
  async read(name: string) {
    const l = this.files.get(name);
    return l ? new Blob(l as BlobPart[], { type: 'video/mp4' }) : null;
  }
  async remove(name: string) {
    this.files.delete(name);
  }
  async free() {
    return null;
  }
  async clear() {
    this.files.clear();
    this.job = null;
  }
  dispose() {}
}

export interface ProofResult {
  sourceMs: number;
  outMs: number;
  replays: Array<{ point: string; at: number; start: number; end: number; back: number }>;
  renderMs: number;
  realtime: number;
  bytes: number;
  points: number;
}

/** A doubles match logged against the clip: points every `every` ms from 4 s in, tags typed afterwards. */
function matchOver(clipMs: number, c: ProofCase, t0: number): MatchEvent[] {
  const cfg = configFromSetup({
    ...DEFAULT_SETUP,
    doubles: true,
    reasons: 'endOfGame',
    teams: { A: { name: 'A', color: 0, players: ['Golf', 'Nan'], startRight: 0 }, B: { name: 'B', color: 1, players: ['Jom', 'Sax'], startRight: 0 } },
  });
  let ev: MatchEvent[] = [];
  const push = (body: EventBody, at: number) => (ev = append(ev, body, { at, by: 'proof', id: `e${ev.length + 1}` }));
  push({ type: 'match.start', config: cfg }, t0);
  let n = 0;
  for (let t = 4000; t < clipMs - 3000; t += c.every) {
    const s = reduce(cfg, ev);
    if (s.phase === 'matchOver') break;
    if (s.phase === 'interval') push({ type: 'interval.end' }, t0 + t - 1000);
    if (s.phase === 'gameOver') {
      push({ type: 'game.start', game: s.game + 1 }, t0 + t - 1000);
      continue;
    }
    push({ type: 'point', team: (n % 3 === 1 ? 'B' : 'A') as Team }, t0 + t);
    n++;
  }
  const points = ev.filter((e) => e.type === 'point');
  const late = t0 + clipMs + 60_000;
  points.forEach((p, i) => {
    if ((i + 1) % c.replayEvery === 0) push({ type: 'replay', point: p.id }, late + i);
  });
  points.forEach((p, i) => {
    const won = (p as { team: Team }).team;
    const hit = i % 3 ? { team: won, idx: i % 2 } : { team: (won === 'A' ? 'B' : 'A') as Team, idx: i % 2 };
    push({ type: 'tag', point: p.id, how: i % 3 ? 'winner' : 'unforced', hit }, late + 1000 + i);
  });
  return ev;
}

/** The match logged over the clip and the recording that holds it, as the camera would store and export them. */
async function scenario(c: ProofCase, clip: Blob) {
  const M = await mediabunny();
  const input = new M.Input({ source: new M.BlobSource(clip), formats: [M.MP4, M.QTFF] });
  const fullMs = Math.floor((await input.computeDuration()) * 1000);
  const v = (await input.getPrimaryVideoTrack())!;
  const clipMs = Math.min(fullMs, c.limitMs ?? fullMs);
  const t0 = 1_800_000_000_000;
  const events = matchOver(clipMs, c, t0);
  // A recording keeps the box its panel took from each moment on: the same layout the camera computes (controller.ts).
  const cfgOf = (events[0] as unknown as { config: MatchConfig }).config;
  const u = panelScale(v.displayHeight, 'medium');
  const ctx = new OffscreenCanvas(8, 8).getContext('2d') as unknown as CanvasRenderingContext2D;
  const boxes: Array<{ at: number; box: Box }> = [];
  const clock = new OverlayClock();
  for (let t = 0; t < clipMs; t += 500) {
    const m = clock.at(cfgOf, events, t0 + t, { delayMs: 0, offsetMs: 0, mirrored: false, stale: false });
    const box = m && overlayLayout(v.displayWidth, v.displayHeight, { scoreCorner: 'tl', score: panelSize(ctx, m, u), scoreMaxH: panelMaxHeight(u), logo: null }).score;
    const last = boxes[boxes.length - 1]?.box;
    if (box && (!last || last.w !== box.w || last.h !== box.h || last.x !== box.x || last.y !== box.y)) boxes.push({ at: t0 + t, box });
  }
  const covered = boxes.reduce<Box>((a, b) => ({ x: Math.min(a.x, b.box.x), y: Math.min(a.y, b.box.y), w: Math.max(a.x + a.w, b.box.x + b.box.w) - Math.min(a.x, b.box.x), h: Math.max(a.y + a.h, b.box.y + b.box.h) - Math.min(a.y, b.box.y) }), boxes[0]?.box ?? { x: 0, y: 0, w: 0, h: 0 });
  const seg: Segment = {
    index: 1,
    file: 'video-1.mp4',
    mimeType: 'video/mp4',
    width: v.displayWidth,
    height: v.displayHeight,
    fps: 30,
    startedAt: t0,
    firstFrameAt: t0,
    startLatencyMs: 0,
    endedAt: t0 + fullMs,
    bytes: clip.size,
    endReason: 'user',
    overlay: c.imported
      ? { box: { x: 0, y: 0, w: 0, h: 0 }, boxes: [], corner: 'tl', size: 'medium', delayMs: 0, mirrored: false, theme: '', motion: 'full', logo: null, stats: null }
      : {
          box: covered,
          boxes,
          corner: 'tl',
          size: 'medium',
          delayMs: 0,
          mirrored: false,
          theme: 'bwf-championship-v1',
          motion: 'full',
          logo: null,
          stats: { team: 'A', place: 'auto', opp: true, box: null, card: true },
        },
  };
  const meta = { ...newMeta('proof', 'proof', { id: 'cam', ua: 'proof' }, t0), segments: [seg], clock: { offsetMs: 0, samples: 0, medianRttMs: 0 } };
  const bundle: MatchBundle = buildBundle({ meta, log: { matchId: 'proof', config: (events[0] as unknown as { config: MatchConfig }).config, events, receivedAt: {} }, app: 'proof', now: t0 });
  if (c.imported) (bundle.recording as { source?: string }).source = 'imported';
  return { fullMs, events, seg, meta, bundle, cfg: cfgOf };
}

async function run(c: ProofCase): Promise<ProofResult> {
  await Promise.all([500, 600, 700, 800].map((w) => document.fonts.load(`${w} 30px Kanit`, 'กขค ABC 012')));
  const clip = await (await fetch(c.clipUrl)).blob();
  const { fullMs, bundle, events } = await scenario(c, clip);
  const options: RenderOptions = { ...DEFAULT_RENDER, table: { team: 'A', opp: true }, card: true, ...c.options };
  const tl = segmentTimeline(bundle, 1, fullMs, { replays: options.replays, motion: options.motion });
  const store = c.store === 'memory' ? new MemoryStore() : new OpfsRenderStore(`proof-${c.name}`);
  await store.clear();
  const file = c.limitMs && c.limitMs < fullMs ? await trimmed(clip, c.limitMs) : clip;
  const t = performance.now();
  const kept: string[] = [];
  const keeping: RenderStore = c.keepParts
    ? { readJob: () => store.readJob(), writeJob: (j) => store.writeJob(j), open: (n) => store.open(n), read: (n) => store.read(n), free: () => store.free(), remove: async (n) => void kept.push(n) }
    : store;
  const out = await renderMatch(bundle, new Map([[1, file]]), keeping, options);
  const renderMs = performance.now() - t;
  const blob = (await store.read(out[0].name))!;
  await hand(`${c.name}.mp4`, blob);
  for (const n of kept) await hand(`${c.name}-${n}`, (await store.read(n))!);
  await store.clear();
  store.dispose();
  const srcMs = Math.min(fullMs, c.limitMs ?? fullMs);
  const tl2 = c.limitMs ? segmentTimeline(bundle, 1, srcMs, { replays: options.replays, motion: options.motion }) : tl;
  return {
    sourceMs: srcMs,
    outMs: tl2.outMs,
    replays: tl2.pieces.flatMap((p) => (p.kind === 'replay' ? [{ point: p.point, at: p.plan.at, start: p.out, end: p.out + p.len - 250, back: p.out + p.len }] : [])),
    renderMs: Math.round(renderMs),
    realtime: Math.round((tl2.outMs / renderMs) * 10) / 10,
    bytes: blob.size,
    points: events.filter((e) => e.type === 'point').length,
  };
}

/** A file handed to node in pieces. */
async function hand(name: string, blob: Blob): Promise<void> {
  const step = 8 << 20;
  for (let i = 0; i < blob.size; i += step) {
    const b = new Uint8Array(await blob.slice(i, i + step).arrayBuffer());
    let s = '';
    for (let j = 0; j < b.length; j += 0x8000) s += String.fromCharCode(...b.subarray(j, j + 0x8000));
    await window.saveChunk(name, btoa(s), i + step >= blob.size);
  }
}

/** The first `ms` of a clip, copied packet for packet (a long clip cut short for a quick proof). */
async function trimmed(clip: Blob, ms: number): Promise<Blob> {
  const M = await import('mediabunny');
  const input = new M.Input({ source: new M.BlobSource(clip), formats: [M.MP4, M.QTFF] });
  const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new M.BufferTarget() });
  const conv = await M.Conversion.init({ input, output, trim: { start: 0, end: ms / 1000 } });
  await conv.execute();
  return new Blob([output.target.buffer!], { type: 'video/mp4' });
}


/** Store the recording in OPFS as the camera does (matches/<id>/), so the app's Recordings screen lists it (Chrome). */
async function seed(c: ProofCase & { id: string }): Promise<void> {
  const clip = await (await fetch(c.clipUrl)).blob();
  const { events, meta, cfg } = await scenario(c, clip);
  const root = await navigator.storage.getDirectory();
  const dir = await (await root.getDirectoryHandle('matches', { create: true })).getDirectoryHandle(c.id, { create: true });
  const put = async (name: string, data: Blob | string) => {
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(data);
    await w.close();
  };
  await put('video-1.mp4', clip);
  await put('recording.json', JSON.stringify({ ...meta, id: c.id, matchId: c.id }));
  await put('log.json', JSON.stringify({ matchId: c.id, config: cfg, events, receivedAt: {} }));
}

window.__render = run;
window.__seed = seed;
window.__ready = true;
