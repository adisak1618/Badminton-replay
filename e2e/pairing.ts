// Two-browser pairing test against the local helper (server/local.ts): a camera browser and a scoreboard
// browser, each with Chrome's fake camera, pair through the helper and talk over a real WebRTC data channel.
// The scoreboard's fake camera plays the camera page's own QR code, so the scan path (zxing-wasm) is real.
//
//   pnpm build && pnpm e2e            # needs Google Chrome and ffmpeg; OUT=dir keeps screenshots and results
//
// Steps: no-internet message on both roles (R-PAIR-1); pairing by scanning the QR; sync of a live match and
// tap-to-camera latency; remote REC with ack (D11); a 20 s outage of the channel and the helper with points
// scored meanwhile (R-PAIR-4/8); a dropped connection rebuilt fresh; remote stop; reloads of either phone
// rejoining with no scan; a typed code; a version mismatch (R-PAIR-7). Exits non-zero on the first failure.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.env.OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-e2e-')));
const PORT = Number(process.env.PORT ?? 18_000 + Math.floor(Math.random() * 1000));
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEW = { width: 844, height: 390 };
fs.mkdirSync(OUT, { recursive: true });

const results: Array<{ step: string; ok: boolean; detail: string; ms: number }> = [];
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${s}`);

async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  const start = Date.now();
  log(`▶ ${name}`);
  try {
    const detail = (await fn()) ?? '';
    results.push({ step: name, ok: true, detail, ms: Date.now() - start });
    log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ step: name, ok: false, detail: String((err as Error).stack ?? err), ms: Date.now() - start });
    log(`✗ ${name}: ${(err as Error).message}`);
    throw err;
  }
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeout = 20_000, every = 100): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`timed out after ${timeout} ms waiting for ${what}${last ? ` (${String(last)})` : ''}`);
}

const text = async (p: Page, sel: string) => ((await p.locator(sel).first().textContent({ timeout: 500 })) ?? '').trim();
const chip = (p: Page) => text(p, '[data-testid=link-chip]');

// Test hooks live here, not in the app: every RTCPeerConnection is kept on window.__pcs; window.__drop swallows
// every outgoing data-channel message; sessionStorage.__v2 makes this page speak protocol version 2.
const HOOKS = `
  (() => {
    const send = RTCDataChannel.prototype.send;
    const v2 = sessionStorage.getItem('__v2') === '1'; // latched at load: a page being reloaded still says goodbye in v1
    window.__out = [];
    RTCDataChannel.prototype.send = function (d) {
      if (typeof d === 'string') { window.__out.push((window.__drop ? 'x:' : '') + d.slice(0, 40)); if (window.__out.length > 300) window.__out.shift(); }
      if (window.__drop) return;
      if (typeof d === 'string' && v2) d = d.replace('{"v":1,', '{"v":2,');
      return send.call(this, d);
    };
    const PC = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = class extends PC {
      constructor(...a) { super(...a); window.__pcs.push(this); }
    };
  })();
`;

async function launch(extra: string[] = []): Promise<Browser> {
  return chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', ...extra],
  });
}

async function newPage(b: Browser, name: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await b.newContext({ viewport: VIEW, permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(HOOKS);
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && log(`  [${name} console] ${m.text()}`));
  page.on('pageerror', (e) => log(`  [${name} pageerror] ${e.message}`));
  page.on('request', (r) => {
    if (!r.url().startsWith(BASE)) log(`  [${name}] request leaving the origin: ${r.url()}`);
  });
  return { ctx, page };
}

const button = (p: Page, name: string | RegExp) => p.getByRole('button', { name }).first();

async function tap(p: Page, zone: 'left' | 'right'): Promise<number> {
  const b = (await p.locator(`[data-zone=${zone}]`).boundingBox())!;
  await p.mouse.move(b.x + b.width / 2, b.y + b.height * 0.3);
  await p.mouse.down();
  await p.waitForTimeout(60);
  const at = Date.now();
  await p.mouse.up();
  await p.waitForTimeout(850); // R-DISP-6: one point per 800 ms
  return at;
}

const score = async (p: Page) => `${await text(p, '[data-testid=score-A]')}-${await text(p, '[data-testid=score-B]')}`;

/** The camera's "last score" line for a scoreboard showing A on the left. */
async function cameraShows(cam: Page, sb: Page): Promise<boolean> {
  const [a, b] = (await score(sb)).split('-');
  return (await text(cam, '[data-testid=last-score]')).includes(`${a} – ${b}`);
}

async function scoreboardEvents(sb: Page): Promise<Array<{ id: string; at: number; type: string }>> {
  return sb.evaluate(async () => {
    const req = <T,>(r: IDBRequest<T>) => new Promise<T>((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));
    const db = await req(indexedDB.open('badminton-scoreboard'));
    const tx = db.transaction(['meta', 'matches']);
    const id = await req(tx.objectStore('meta').get('current'));
    const m = (await req(tx.objectStore('matches').get(id as string))) as { events: Array<{ id: string; at: number; type: string }> };
    return m.events.map((e) => ({ id: e.id, at: e.at, type: e.type }));
  });
}

/** log.json and recording.json of the camera's recording of this match, from OPFS. */
async function cameraFiles(cam: Page, matchId: string): Promise<{ log: any; rec: any }> {
  return cam.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('matches')).getDirectoryHandle(id);
    const read = async (f: string) => JSON.parse(await (await (await dir.getFileHandle(f)).getFile()).text());
    return { log: await read('log.json'), rec: await read('recording.json') };
  }, matchId);
}

async function main() {
  log(`output: ${OUT}`);
  const server = spawn(process.execPath, [path.join(ROOT, 'server/local.ts')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const serverLog = fs.createWriteStream(path.join(OUT, 'server.log'));
  server.stdout.pipe(serverLog);
  server.stderr.pipe(serverLog);
  await until('the local server', async () => (await fetch(`${BASE}/`)).ok, 10_000);

  const camBrowser = await launch();
  const { ctx: camCtx, page: cam } = await newPage(camBrowser, 'camera');
  let sbBrowser: Browser | null = null;
  let sb2: Page | null = null;
  let sbPage: Page | null = null;
  try {
    await step('camera role opens with a live preview', async () => {
      await cam.goto(BASE);
      await button(cam, /CAMERA/).click();
      await until('camera live', async () => (await cam.locator('[data-testid=rec-button]').isEnabled()) || null, 15_000);
    });

    await step('camera: no internet shows the R-PAIR-1 message within 5 s', async () => {
      await camCtx.route('**/api/**', (r) => r.abort('internetdisconnected'));
      const start = Date.now();
      await cam.locator('[data-testid=cam-pair]').click();
      const msg = await until('no-internet text', async () => {
        const s = await text(cam, '[data-testid=pair-status]');
        return s.startsWith('No internet') && s;
      });
      const ms = Date.now() - start;
      if (ms > 5000) throw new Error(`took ${ms} ms`);
      await camCtx.unroute('**/api/**');
      return `${ms} ms: "${msg}"`;
    });

    let code = '';
    await step('camera shows a QR code and six digits (C2)', async () => {
      await button(cam, 'Try again').click();
      code = await until('code', async () => {
        const c = await text(cam, '[data-testid=pair-code]');
        return /^\d{6}$/.test(c) && c;
      });
      await until('QR svg', async () => (await cam.locator('[data-testid=pair-qr] svg').count()) > 0);
      await cam.locator('[data-testid=pair-qr]').screenshot({ path: path.join(OUT, 'qr.png') });
      await cam.screenshot({ path: path.join(OUT, '01-camera-c2.png') });
      return `code ${code}`;
    });

    // The scoreboard browser's fake camera shows that QR code.
    const y4m = path.join(OUT, 'qr.y4m');
    execFileSync('ffmpeg', [
      '-loglevel', 'error', '-y', '-loop', '1', '-i', path.join(OUT, 'qr.png'), '-t', '2',
      '-vf', 'scale=480:480:flags=neighbor,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=gray,format=yuv420p', '-r', '15', y4m,
    ]);
    sbBrowser = await launch([`--use-file-for-fake-video-capture=${y4m}`]);
    const { ctx: sbCtx, page: sb } = await newPage(sbBrowser, 'scoreboard');
    sbPage = sb;

    await step('scoreboard: no internet shows the R-PAIR-1 message within 5 s', async () => {
      await sb.goto(BASE);
      await button(sb, /SCOREBOARD/).click();
      await sbCtx.route('**/api/**', (r) => r.abort('internetdisconnected'));
      await sb.locator('[data-testid=pair-chip]').click();
      const start = Date.now();
      await sb.locator('[data-testid=pair-code]').fill('123456');
      await sb.locator('[data-testid=pair-submit]').click();
      await until('no-internet text', async () => (await text(sb, '[data-testid=pair-status]')).startsWith('No internet'));
      const ms = Date.now() - start;
      if (ms > 5000) throw new Error(`took ${ms} ms`);
      await sbCtx.unroute('**/api/**');
      await button(sb, 'Close').click();
      return `${ms} ms`;
    });

    await step('scoreboard scans the QR and pairs (R-PAIR-1)', async () => {
      const start = Date.now();
      await sb.locator('[data-testid=pair-chip]').click();
      await until('paired on the scoreboard', async () => (await sb.locator('[data-testid=pair-done]').count()) > 0, 30_000);
      await until('camera chip link ok', async () => (await chip(cam)) === 'link ok');
      const ms = Date.now() - start;
      await sb.screenshot({ path: path.join(OUT, '02-scoreboard-s2-paired.png') });
      await cam.screenshot({ path: path.join(OUT, '03-camera-paired.png') });
      return `scan to paired on both: ${ms} ms`;
    });

    let matchId = '';
    await step('a match started after pairing reaches the camera; live points follow', async () => {
      await button(sb, 'OK').click();
      await button(sb, 'START MATCH').click();
      await until('board', async () => (await sb.locator('[data-zone=left]').count()) > 0);
      for (const z of ['left', 'left', 'right'] as const) await tap(sb, z);
      await until('camera shows 2–1', () => cameraShows(cam, sb), 5000);
      matchId = await sb.evaluate(async () => {
        const req = <T,>(r: IDBRequest<T>) => new Promise<T>((res) => (r.onsuccess = () => res(r.result)));
        const db = await req(indexedDB.open('badminton-scoreboard'));
        return (await req(db.transaction('meta').objectStore('meta').get('current'))) as string;
      });
      return `score ${await score(sb)}, match ${matchId}, scoreboard chip "${await chip(sb)}"`;
    });

    await step('remote REC from the scoreboard menu, acked (D11, R-PAIR-6)', async () => {
      const start = Date.now();
      await sb.getByRole('button', { name: 'Menu' }).click();
      await sb.locator('[data-testid=menu-rec]').click();
      await until('ack', async () => (await text(sb, '[data-testid=menu-rec-answer]')) === 'Camera is recording ✓', 5000);
      const ack = Date.now() - start;
      await until('camera REC chip', async () => (await cam.locator('[data-testid=rec-chip]').count()) > 0);
      await button(sb, 'Close').click();
      await until('scoreboard shows REC', async () => (await text(sb, '[data-testid=cam-rec]')).startsWith('● REC'), 5000);
      await sb.screenshot({ path: path.join(OUT, '04-scoreboard-rec.png') });
      return `tap to ack ${ack} ms; scoreboard shows "${await text(sb, '[data-testid=cam-rec]')}"`;
    });

    await step('20 s outage of the channel and the helper, 5 points meanwhile; back with every event (R-PAIR-4/8)', async () => {
      for (const p of [cam, sb]) await p.evaluate(() => ((window as any).__drop = true));
      await camCtx.route('**/api/**', (r) => r.abort('internetdisconnected'));
      await sbCtx.route('**/api/**', (r) => r.abort('internetdisconnected'));
      const down = Date.now();
      const amber = await until('reconnecting chips', async () => {
        const [a, b] = [await chip(cam), await chip(sb)];
        return a !== 'link ok' && b !== 'link ok' && `${Date.now() - down} ms: camera "${a}", scoreboard "${b}"`;
      }, 12_000);
      for (const z of ['right', 'left', 'right', 'right', 'left'] as const) await tap(sb, z);
      await until('20 s', async () => Date.now() - down >= 20_000, 25_000, 250);
      const during = `camera "${await chip(cam)}", scoreboard "${await chip(sb)}", camera still shows "${await text(cam, '[data-testid=last-score]')}"`;
      await cam.screenshot({ path: path.join(OUT, '05-camera-outage.png') });
      for (const p of [cam, sb]) await p.evaluate(() => ((window as any).__drop = false));
      await camCtx.unroute('**/api/**');
      await sbCtx.unroute('**/api/**');
      const back = Date.now();
      await until('both link ok', async () => (await chip(cam)) === 'link ok' && (await chip(sb)) === 'link ok', 15_000);
      const recovered = Date.now() - back;
      await until('camera caught up', () => cameraShows(cam, sb), 5000);
      return `chips amber after ${amber}; at 20 s ${during}; link back ${recovered} ms after the network returned; camera shows ${await score(sb)}`;
    });

    await step('a dropped connection is rebuilt fresh with no user action', async () => {
      const pcsBefore: number = await sb.evaluate(() => (window as any).__pcs.length);
      const start = Date.now();
      await sb.evaluate(() => (window as any).__pcs.forEach((pc: RTCPeerConnection) => pc.close()));
      const noticed = await until('both chips leave link ok', async () => {
        const [a, b] = [await chip(cam), await chip(sb)];
        return a !== 'link ok' && b !== 'link ok' && `${Date.now() - start} ms (camera "${a}", scoreboard "${b}")`;
      }, 15_000, 50);
      await tap(sb, 'left');
      await until('a new connection, link ok on both', async () => {
        const n: number = await sb.evaluate(() => (window as any).__pcs.length);
        return n > pcsBefore && (await chip(cam)) === 'link ok' && (await chip(sb)) === 'link ok';
      }, 20_000);
      const ms = Date.now() - start;
      await until('camera caught up', () => cameraShows(cam, sb), 5000);
      return `both chips down after ${noticed}; back on a new RTCPeerConnection ${ms} ms after the close`;
    });

    await step('remote stop, acked; every scoreboard event is in the camera log, once', async () => {
      await sb.getByRole('button', { name: 'Menu' }).click();
      await sb.locator('[data-testid=menu-rec]').click();
      await until('stop ack', async () => (await text(sb, '[data-testid=menu-rec-answer]')) === 'Camera stopped recording ✓', 5000);
      await button(sb, 'Close').click();
      await until('camera stopped', async () => (await cam.locator('[data-testid=rec-button]').count()) > 0, 10_000);
      await cam.waitForTimeout(1500);
      const sbEvents = await scoreboardEvents(sb);
      const { log: camLog, rec } = await cameraFiles(cam, matchId);
      const ids = camLog.events.map((e: { id: string }) => e.id);
      if (new Set(ids).size !== ids.length) throw new Error('duplicate events in the camera log');
      const missing = sbEvents.filter((e) => !ids.includes(e.id));
      if (missing.length || ids.length !== sbEvents.length) throw new Error(`camera has ${ids.length}, scoreboard ${sbEvents.length}`);
      const live = sbEvents.filter((e) => e.type === 'point').map((e) => camLog.receivedAt[e.id] - e.at);
      const sorted = [...live].sort((a, b) => a - b);
      fs.writeFileSync(path.join(OUT, 'camera-log.json'), JSON.stringify(camLog, null, 2));
      fs.writeFileSync(path.join(OUT, 'camera-recording.json'), JSON.stringify(rec, null, 2));
      return `${ids.length} events, none missing or doubled; receive − tap per point (ms, same clock; includes the outage): ${sorted.join(', ')}; clock ${JSON.stringify(rec.clock ?? null)}`;
    });

    await step('scoreboard reload: resumes the match and rejoins with no scan', async () => {
      const start = Date.now();
      await sb.reload();
      await until('both link ok', async () => (await chip(cam).catch(() => '')) === 'link ok' && (await chip(sb).catch(() => '')) === 'link ok', 20_000);
      const ms = Date.now() - start;
      await until('camera in sync', () => cameraShows(cam, sb), 5000);
      return `${ms} ms from reload to link ok on both`;
    });

    await step('camera reload: rejoins with no scan', async () => {
      const start = Date.now();
      await cam.reload();
      await until('both link ok', async () => (await chip(cam).catch(() => '')) === 'link ok' && (await chip(sb).catch(() => '')) === 'link ok', 20_000);
      const ms = Date.now() - start;
      await until('camera in sync', () => cameraShows(cam, sb), 5000);
      return `${ms} ms from reload to link ok on both`;
    });

    await step('unpair; a second scoreboard pairs by typing the code (no viewfinder QR)', async () => {
      await cam.getByRole('button', { name: 'Menu' }).click();
      await button(cam, 'Unpair the scoreboard').click();
      await until('scoreboard unpaired', async () => (await sb.locator('[data-testid=pair-chip]').count()) > 0, 5000);
      await cam.locator('[data-testid=cam-pair]').click();
      const c = await until('code', async () => {
        const t = await text(cam, '[data-testid=pair-code]');
        return /^\d{6}$/.test(t) && t;
      });
      // This browser's fake camera is Chrome's test pattern, so only the typed code can pair.
      const typed = await newPage(camBrowser, 'scoreboard-2');
      sb2 = typed.page;
      await sb2.goto(BASE);
      await button(sb2, /SCOREBOARD/).click();
      const start = Date.now();
      await sb2.locator('[data-testid=pair-chip]').click();
      await sb2.locator('input[data-testid=pair-code]').fill(c);
      await sb2.locator('[data-testid=pair-submit]').click();
      await until('paired', async () => (await sb2!.locator('[data-testid=pair-done]').count()) > 0, 30_000);
      await until('camera link ok', async () => (await chip(cam)) === 'link ok');
      await button(sb2, 'OK').click();
      return `typed ${c}: ${Date.now() - start} ms to paired`;
    });

    // The camera pretends to be a newer build speaking protocol v2: the scoreboard is the one to update.
    await step('version mismatch tells which phone to update (R-PAIR-7)', async () => {
      const board = sb2!;
      await cam.evaluate(() => sessionStorage.setItem('__v2', '1'));
      await cam.reload();
      await until('scoreboard mismatch chip', async () => (await chip(board)) === 'update app', 20_000);
      const title = (await board.locator('[data-testid=link-chip]').getAttribute('title')) ?? '';
      const camNote = await until('camera note', async () => text(cam, '[data-testid=pair-note]'), 10_000);
      await board.screenshot({ path: path.join(OUT, '06-scoreboard-mismatch.png') });
      await cam.screenshot({ path: path.join(OUT, '07-camera-mismatch.png') });
      if (title !== 'Update the app on this phone (reload it), then pair again.') throw new Error(`scoreboard says "${title}"`);
      if (camNote !== 'Update the app on the other phone, then pair again.') throw new Error(`camera says "${camNote}"`);
      return `scoreboard chip "update app" / "${title}"; camera "${camNote}"`;
    });
  } catch (err) {
    for (const [name, p] of [['camera', cam], ['scoreboard', sbPage]] as const) {
      if (!p) continue;
      await p.screenshot({ path: path.join(OUT, `fail-${name}.png`) }).catch(() => {});
      const out = await p.evaluate(() => (window as any).__out.slice(-25)).catch(() => []);
      log(`  ${name} last sent: ${JSON.stringify(out)}`);
    }
    throw err;
  } finally {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    await camBrowser.close().catch(() => {});
    await sbBrowser?.close().catch(() => {});
    server.kill();
  }
}

main().then(
  () => {
    log(`all ${results.length} steps passed; results in ${OUT}`);
    process.exit(0);
  },
  (err) => {
    console.error(err);
    log(`FAILED; results in ${OUT}`);
    process.exit(1);
  },
);
