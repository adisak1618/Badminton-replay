// Proof renders of the video made after the match (D16): the real renderer (src/render) in Chrome, and in WebKit when
// Playwright's WebKit is installed, on a clip made like the camera phone's recordings. Each render is checked with
// ffprobe (length = the clip plus every replay's pause, H.264 and AAC, the sound as long as the picture) and by
// looking at its frames (the card in the middle of the frame mid-transition, the REPLAY badge red, the panel drawn).
//
//   pnpm render-proof                   # needs Google Chrome and ffmpeg; OUT=dir keeps the outputs (default: a temp dir)
//   CLIP=/path/match.mp4 pnpm render-proof   # also renders that whole clip as an imported video and reports the speed
//   ONLY_FULL=1 CLIP=… [CLIP_MS=ms] [KEEP_PARTS=1]  # only that clip (cut to CLIP_MS), keeping the parts to look into a join
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, type Browser, type BrowserContext } from 'playwright-core';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.env.OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'render-proof-')));
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
fs.mkdirSync(OUT, { recursive: true });

type Result = { sourceMs: number; outMs: number; replays: Array<{ point: string; at: number; start: number; end: number; back: number }>; renderMs: number; realtime: number; bytes: number; points: number };

/** 90 s of moving picture with a tone, made the way Safari records: H.264 Baseline, a keyframe every 2 s, fragmented MP4. */
function makeClip(file: string): void {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=90',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=90',
    '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '4.0', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-b:v', '6M', '-maxrate', '6M', '-bufsize', '6M',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', file,
  ]);
}

const probe = (file: string) =>
  JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,duration,nb_frames:format=duration', '-of', 'json', file]).toString()) as {
    streams: Array<{ codec_type: string; codec_name: string; duration?: string; nb_frames?: string }>;
    format: { duration: string };
  };

/** The average RGB of a w×h box of the frame at `t` s (scaled to 1920x1080). */
function rgb(file: string, t: number, box: { x: number; y: number; w: number; h: number }): [number, number, number] {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=1920:1080,crop=${box.w}:${box.h}:${box.x}:${box.y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const n = raw.length / 3;
  const s = [0, 0, 0];
  for (let i = 0; i < raw.length; i += 3) for (let k = 0; k < 3; k++) s[k] += raw[i + k];
  return s.map((x) => Math.round(x / n)) as [number, number, number];
}

/** Where the file's top-level MP4 boxes end: the file's size, unless one was cut short or a write went missing. */
function boxesEnd(file: string): number {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const h = Buffer.alloc(16);
  let pos = 0;
  try {
    while (pos < size) {
      fs.readSync(fd, h, 0, 16, pos);
      const n = h.readUInt32BE(0);
      const len = n === 1 ? Number(h.readBigUInt64BE(8)) : n;
      if (len < 8) return pos;
      pos += len;
    }
  } finally {
    fs.closeSync(fd);
  }
  return pos;
}

function check(name: string, file: string, r: Result): string {
  const end = boxesEnd(file);
  if (end !== fs.statSync(file).size) throw new Error(`${name}: the MP4 boxes end at ${end}, the file is ${fs.statSync(file).size} bytes`);
  const p = probe(file);
  const v = p.streams.find((s) => s.codec_type === 'video');
  const a = p.streams.find((s) => s.codec_type === 'audio');
  const dur = Number(p.format.duration) * 1000;
  const fail: string[] = [];
  if (v?.codec_name !== 'h264') fail.push(`video ${v?.codec_name}`);
  if (a?.codec_name !== 'aac') fail.push(`audio ${a?.codec_name}`);
  if (Math.abs(dur - r.outMs) > 150) fail.push(`length ${Math.round(dur)} ms, the timeline says ${r.outMs}`);
  if (a?.duration && Math.abs(Number(a.duration) * 1000 - r.outMs) > 250) fail.push(`sound ${a.duration} s for ${r.outMs} ms`);
  // Every video frame on its own tick: a player drops frames that share a decode time.
  const dts = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=dts', '-of', 'csv=p=0', file], { maxBuffer: 64 << 20 }).toString().trim().split('\n').map(Number);
  const stuck = dts.filter((d, i) => i > 0 && d <= dts[i - 1]).length;
  if (stuck) fail.push(`${stuck} video frames do not move the decode time on`);
  const notes: string[] = [];
  for (const rp of r.replays) {
    // Mid card (face on, before the picture changes): the middle of the frame is the white card.
    const card = rgb(file, (rp.at + 400) / 1000, { x: 860, y: 740, w: 200, h: 60 });
    if (Math.min(...card) < 200) fail.push(`no white card at ${rp.at + 400} ms (${card})`);
    // Mid replay: the badge under the panel (top-left corner) is red.
    const badge = rgb(file, (rp.start + 3000) / 1000, { x: 60, y: 155, w: 200, h: 24 });
    if (!(badge[0] > 150 && badge[1] < 90 && badge[2] < 90)) fail.push(`no red REPLAY badge at ${rp.start + 3000} ms (${badge})`);
    notes.push(`card ${card.join('/')} badge ${badge.join('/')}`);
  }
  if (fail.length) throw new Error(`${name}: ${fail.join('; ')}`);
  return `${name}: ${(r.sourceMs / 1000).toFixed(1)} s clip + ${r.replays.length} replays -> ${(dur / 1000).toFixed(1)} s (timeline ${(r.outMs / 1000).toFixed(1)} s), ${v?.nb_frames ?? '?'} frames, ${(r.bytes / 1e6).toFixed(1)} MB, rendered in ${(r.renderMs / 1000).toFixed(1)} s = ${r.realtime}x real time; ${notes.join('; ')}`;
}

// No file watching: an edit while a long render runs must not reload the page under it.
const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false, watch: null, fs: { allow: [ROOT, OUT, ...(process.env.CLIP ? [path.dirname(process.env.CLIP)] : [])] } } });
await server.listen();
const addr = server.httpServer!.address();
const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 5173}`;
const clip = path.join(OUT, 'clip-safari-like.mp4');
makeClip(clip);

/** A page of the proof (e2e/render.html) whose files come back to OUT, and its render call. */
async function proofPage(engine: string, target: Pick<BrowserContext, 'newPage'>) {
  const page = await target.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const parts = new Map<string, Buffer[]>();
  await page.exposeFunction('saveChunk', (name: string, b64: string, last: boolean) => {
    const list = parts.get(name) ?? [];
    list.push(Buffer.from(b64, 'base64'));
    parts.set(name, list);
    if (last) fs.writeFileSync(path.join(OUT, `${engine}-${name}`), Buffer.concat(list));
  });
  await page.goto(`${base}/e2e/render.html`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout: 60_000 });
  const url = (f: string) => `/@fs${f}`;
  // Playwright's WebKit runs in an ephemeral session without OPFS (like Safari's private mode): its renders keep their
  // files in memory; Chrome uses OPFS as the phone does.
  const store = engine === 'webkit' ? 'memory' : 'opfs';
  const run = (c: object) => page.evaluate((x) => (window as unknown as { __render: (c: object) => Promise<Result> }).__render(x), { store, ...c }) as Promise<Result>;
  return { page, errors, run, url };
}

async function proof(engine: string, browser: Browser): Promise<void> {
  const { page, errors, run, url } = await proofPage(engine, browser);
  // 1. An imported video (nothing burned in): the whole overlay drawn, three replays, the stats from late tags.
  const imported = await run({ name: 'imported', clipUrl: url(clip), every: 9000, replayEvery: 3, imported: true });
  console.log(`${engine} ${check('imported', path.join(OUT, `${engine}-imported.mp4`), imported)}`);
  // 2. That render without replays is a clip with the overlay burned in, like a recording; replays over it then
  //    cover its panel with the frozen one.
  const burnedSrc = await run({ name: 'burned-src', clipUrl: url(clip), every: 9000, replayEvery: 3, imported: true, options: { replays: false } });
  console.log(`${engine} burned-src: ${burnedSrc.outMs} ms, no replays, ${(burnedSrc.renderMs / 1000).toFixed(1)} s`);
  const burned = await run({ name: 'burned', clipUrl: url(path.join(OUT, `${engine}-burned-src.mp4`)), every: 9000, replayEvery: 3, imported: false });
  console.log(`${engine} ${check('burned', path.join(OUT, `${engine}-burned.mp4`), burned)}`);
  if (errors.length) throw new Error(errors.join('\n'));
  await page.close();
}

/**
 * A whole match (CLIP) as an imported video, in Chrome with a profile on disk: a private window's OPFS lives in memory
 * and stops at about 2 GB, less than a 30 min render's parts and joined file side by side.
 */
async function fullClip(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-proof-profile-'));
  const ctx = await chromium.launchPersistentContext(dir, { executablePath: CHROME, headless: true });
  try {
    const { errors, run, url } = await proofPage('chrome', ctx);
    const engine = 'chrome';
    const full = await run({ name: 'full', clipUrl: url(process.env.CLIP!), every: 25_000, replayEvery: 6, imported: true, keepParts: !!process.env.KEEP_PARTS, ...(process.env.CLIP_MS ? { limitMs: Number(process.env.CLIP_MS) } : {}) });
    console.log(`${engine} full clip: ${(full.sourceMs / 60000).toFixed(1)} min, ${full.points} points, ${full.replays.length} replays -> ${(full.outMs / 60000).toFixed(1)} min in ${(full.renderMs / 60000).toFixed(1)} min = ${full.realtime}x real time, ${(full.bytes / 1e6).toFixed(0)} MB`);
    console.log(`${engine} ${check('full', path.join(OUT, `${engine}-full.mp4`), full)}`);
    if (errors.length) throw new Error(errors.join('\n'));
  } finally {
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The camera phone's screens: a recording stored in OPFS as the camera stores one (the proof's burned-in clip), then
 * Recordings → "Replays video" → "Make video" in the app itself, at a phone's landscape size, until "Share video".
 */
async function ui(browser: Browser): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/e2e/render.html`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout: 60_000 });
  await page.evaluate((x) => (window as unknown as { __seed: (c: object) => Promise<void> }).__seed(x), {
    id: 'ui-proof', name: 'ui', clipUrl: `/@fs${path.join(OUT, 'chrome-burned-src.mp4')}`, every: 9000, replayEvery: 3, imported: false,
  });
  await page.goto(`${base}/`);
  await page.getByRole('button', { name: /Recordings \(1\)/ }).click();
  await page.locator('[data-testid=replays-video]').click();
  await page.locator('[data-testid=render-sheet]').screenshot({ path: path.join(OUT, 'ui-1-sheet.png') });
  const t = Date.now();
  await page.locator('[data-testid=render-start]').click();
  await page.waitForSelector('[data-testid=render-progress]', { timeout: 30_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, 'ui-2-progress.png') });
  await page.waitForSelector('[data-testid=render-share]', { timeout: 600_000 });
  const took = Date.now() - t;
  await page.screenshot({ path: path.join(OUT, 'ui-3-done.png') });
  const made = await page.evaluate(async () => {
    const r = await navigator.storage.getDirectory();
    const d = await (await (await r.getDirectoryHandle('matches')).getDirectoryHandle('ui-proof')).getDirectoryHandle('render');
    const out: Record<string, number> = {};
    for await (const [n, h] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }).entries()) if (h.kind === 'file') out[n] = (await h.getFile()).size;
    return out;
  });
  if (errors.length) throw new Error(errors.join('\n'));
  const video = Object.keys(made).find((n) => n.endsWith('.mp4'));
  if (!video) throw new Error(`no video made: ${JSON.stringify(made)}`);
  console.log(`chrome ui: Recordings → Replays video → Make video → Share video in ${(took / 1000).toFixed(1)} s; made ${video} (${(made[video] / 1e6).toFixed(1)} MB) and ${Object.keys(made).filter((n) => !n.endsWith('.mp4')).join(', ')}`);
  await ctx.close();
}

try {
  if (!process.env.ONLY_FULL) {
    const chrome = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      await proof('chrome', chrome);
      await ui(chrome);
    } finally {
      await chrome.close();
    }
    let wk: Browser | null = null;
    try {
      wk = await webkit.launch({ headless: true });
    } catch {
      console.log('webkit: not installed (node node_modules/playwright-core/cli.js install webkit), skipped');
    }
    if (wk)
      try {
        await proof('webkit', wk);
      } finally {
        await wk.close();
      }
  }
  if (process.env.CLIP) await fullClip();
  console.log(`outputs in ${OUT}`);
} finally {
  await server.close();
}
