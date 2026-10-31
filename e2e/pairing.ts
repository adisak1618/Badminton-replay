// Pairing test against the local helper (server/local.ts): a camera browser and scoreboard browsers, each with
// Chrome's fake camera, pair through the helper and talk over real WebRTC data channels. The scoreboard's fake
// camera plays the camera page's own QR code, so the scan path (zxing-wasm) is real.
//
//   pnpm build && pnpm e2e            # needs Google Chrome and ffmpeg; OUT=dir keeps screenshots and results
//   HELPER=https://badminton-replay.vercel.app pnpm e2e    # the pages' /api/signal calls go to that helper
//   E2E_RELAY=0 pnpm e2e         # without Docker: no local TURN relay, the relay step is skipped
//
// The local helper gets a TURN key whose API is a stand-in for Cloudflare's generate-ice-servers, handing out
// credentials for a coturn in Docker on this Mac (relay addresses on the container's own address: two relay
// candidates reach each other inside it, while the pages reach only the published TURN port). With HELPER the relay step is skipped: that helper has its own key,
// or none.
//
// Steps: no-internet message on both roles (R-PAIR-1); pairing by scanning the QR; sync of a live match and
// tap-to-camera latency; remote REC with ack (D11); a 20 s outage of the channel and the helper with points
// scored meanwhile (R-PAIR-4/8); a dropped connection rebuilt fresh; remote stop; reloads of either phone
// rejoining with no scan; the screen of the scoreboard off for 20 s and on again (link back in seconds, §4.5);
// the camera's page away 8 s with its connection alive, which only the scoreboard notices (linked again within
// 2 s, a tap on the camera within 1 s); a second scoreboard joining mid-match, both scoring, the same rally tapped on both counted once, the second
// one's screen off and on while the first scores, point reasons (D15: a winner tagged in one tap and an error
// in two on one scoreboard, the other's game-over card showing them, tagging later from the list there, a match
// with point reasons off recording no tag), the camera unpairing both (D14); a typed code; the QR's
// link opened by the iPhone camera app with the viewfinder still
// on that QR, claimed once; a version mismatch (R-PAIR-7); two phones on different networks told so, with the
// pairing diagnostics; with the relay, two phones on different networks connecting through TURN while a shared
// network still connects directly; the helper forgetting a session whose link is open (the link stays); a
// scoreboard whose relay credentials fail, both phones saying why within
// about 20 s and offering nothing more. Every ICE restart description must carry candidates. Exits non-zero on
// the first failure.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.env.OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-e2e-')));
const PORT = Number(process.env.PORT ?? 18_000 + Math.floor(Math.random() * 1000));
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HELPER = process.env.HELPER?.replace(/\/$/, '');
const VIEW = { width: 844, height: 390 };
const RELAY = !HELPER && process.env.E2E_RELAY !== '0';
const TURN_PORT = PORT + 1000;
const TURN_USER = 'e2e';
const TURN_PASS = 'e2e-pass';
const TURN_KEY = { id: 'e2e-key', token: 'e2e-token' };
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
// every outgoing data-channel message and window.__deaf every incoming one; window.__frozen holds the page's
// timers; a channel marked __dead carries nothing either way, ever again, and window.__pcs[i].__dead makes a
// connection say it failed: what an iPhone's connection is after its screen was locked; sessionStorage.__vnext makes this page
// speak the next protocol version (4), on the channel and in what it posts to the helper;
// sessionStorage.__ip replaces this page's candidates with one host candidate on that address, the way an iPhone
// on mobile data offers only its carrier address; sessionStorage.__relay does the same but keeps the relay
// candidates and makes the connection use only those (iceTransportPolicy 'relay'), since this Mac's own host
// candidates would otherwise connect the two pages directly; sessionStorage.__tcp also keeps only the TURN URLs
// over TCP, like a carrier network that blocks UDP.
const HOOKS = `
  (() => {
    // window.__frozen holds this page's timers, as iOS does while the screen is locked (CDP's freeze needs a
    // hidden page, which headless Chrome never has): intervals skip, timeouts wait for the thaw.
    const si = window.setInterval, st = window.setTimeout, ct = window.clearTimeout;
    const ids = new Map();
    let nextId = 1e6;
    window.setInterval = function (fn, ms, ...a) { return si(() => { if (!window.__frozen) fn(...a); }, ms); };
    window.setTimeout = function (fn, ms, ...a) {
      const id = nextId++;
      const run = () => {
        if (window.__frozen) return void ids.set(id, st(run, 50));
        ids.delete(id);
        if (typeof fn === 'function') fn(...a);
      };
      ids.set(id, st(run, ms));
      return id;
    };
    window.clearTimeout = function (id) {
      const real = ids.get(id);
      ids.delete(id);
      ct(real ?? id);
    };
    const send = RTCDataChannel.prototype.send;
    const newer = sessionStorage.getItem('__vnext') === '1'; // latched at load: a page being reloaded still says goodbye in v3
    const fetch0 = window.fetch;
    window.fetch = function (input, init) {
      if (newer && init && typeof init.body === 'string' && String(input).includes('/api/signal')) init = { ...init, body: init.body.replace('"v":3', '"v":4') };
      return fetch0.call(this, input, init);
    };
    window.__out = [];
    window.__dcs = new Set();
    RTCDataChannel.prototype.send = function (d) {
      window.__dcs.add(this);
      if (typeof d === 'string') { window.__out.push((window.__drop || this.__dead ? 'x:' : '') + d.slice(0, 40)); if (window.__out.length > 300) window.__out.shift(); }
      if (window.__drop || this.__dead) return;
      if (typeof d === 'string' && newer) d = d.replace('{"v":3,', '{"v":4,'); // a build one protocol version ahead
      return send.call(this, d);
    };
    const listen = RTCDataChannel.prototype.addEventListener;
    RTCDataChannel.prototype.addEventListener = function (type, fn, ...a) {
      if (type !== 'message') return listen.call(this, type, fn, ...a);
      window.__dcs.add(this);
      return listen.call(this, type, (e) => { if (!window.__deaf && !this.__dead) fn(e); }, ...a);
    };
    const PC = window.RTCPeerConnection;
    window.__pcs = [];
    const tcpOnly = (servers) =>
      servers.map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => /^turn:.*transport=tcp/.test(u)) })).filter((s) => s.urls.length);
    const relayOnly = (c) => {
      if (!sessionStorage.getItem('__relay')) return c;
      const tcp = sessionStorage.getItem('__tcp') === '1';
      return { ...c, iceTransportPolicy: 'relay', iceServers: tcp ? tcpOnly(c.iceServers ?? []) : c.iceServers };
    };
    window.RTCPeerConnection = class extends PC {
      constructor(c, ...a) { super(relayOnly(c ?? {}), ...a); window.__pcs.push(this); }
      get connectionState() { return this.__dead ? 'failed' : super.connectionState; }
      setConfiguration(c) { return super.setConfiguration(relayOnly(c)); }
      get localDescription() {
        const d = super.localDescription;
        const relay = sessionStorage.getItem('__relay');
        const ip = sessionStorage.getItem('__ip') ?? relay;
        if (!d || !ip) return d;
        const lines = d.sdp.split('\\r\\n').filter((l) => !l.startsWith('a=candidate:') || (relay && / typ relay /.test(l)));
        lines.splice(lines.findIndex((l) => l.startsWith('c=')) + 1, 0, 'a=candidate:1 1 udp 2113937151 ' + ip + ' 50000 typ host generation 0 network-cost 999');
        return { type: d.type, sdp: lines.join('\\r\\n') };
      }
    };
  })();
`;

/** Every description a page posted to the helper, with how many candidates it carried. */
const posted: Array<{ page: string; at: number; kind: string; gen: number; fresh: boolean; candidates: number }> = [];

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
  // A regex, not the '**/api/**' glob the outage steps route and unroute, so those leave this one in place.
  if (HELPER)
    await ctx.route(/\/api\/signal(\/|\?|$)/, async (r) => {
      const u = new URL(r.request().url());
      await r.fulfill({ response: await r.fetch({ url: HELPER + u.pathname + u.search }) });
    });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && log(`  [${name} console] ${m.text()}`));
  page.on('pageerror', (e) => log(`  [${name} pageerror] ${e.message}`));
  page.on('request', (r) => {
    if (!r.url().startsWith(BASE)) log(`  [${name}] request leaving the origin: ${r.url()}`);
    const m = /\/api\/signal\/sessions\/[0-9a-f]+\/(offer|answer)$/.exec(r.url());
    if (!m || r.method() !== 'POST') return;
    const b = JSON.parse(r.postData() ?? '{}');
    const sdp: string = b.offer ?? b.answer ?? '';
    posted.push({ page: name, at: Date.now(), kind: m[1], gen: b.gen, fresh: b.fresh === true, candidates: (sdp.match(/^a=candidate:/gm) ?? []).length });
  });
  return { ctx, page };
}

const button = (p: Page, name: string | RegExp) => p.getByRole('button', { name }).first();

/** The newest pairing-diagnostics line of a kind (diag.ts) once the saved log has one matching `want`. */
async function diagLatest(p: Page, role: 'camera' | 'scoreboard', kind: string, want: (line: string) => boolean = () => true): Promise<string> {
  return until(`diagnostics ${role} ${kind}`, async () => {
    const raw = await p.evaluate(([r, k]) => JSON.parse(localStorage.getItem(`bs.diag.${r}`) ?? '{}')?.latest?.[k] as string | undefined, [role, kind] as const);
    const line = raw?.replace(/^\[scoreboard \d\] /, ''); // the camera's second slot marks its lines
    return line && want(line) && line;
  }, 5000);
}

/** This page's helper has no TURN key: what the production helper said before the key was set. */
async function noRelay(p: Page): Promise<void> {
  await p.route(/\/api\/signal\/sessions\/[0-9a-f]+\/ice$/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"relay":"not-configured"}' }));
}

/** One point. The why-was-this-point-won popup it opens (D15) is closed with "Later" unless `keepPopup`. */
async function tap(p: Page, zone: 'left' | 'right', keepPopup = false): Promise<number> {
  const b = (await p.locator(`[data-zone=${zone}]`).boundingBox())!;
  await p.mouse.move(b.x + b.width / 2, b.y + b.height * 0.3);
  await p.mouse.down();
  await p.waitForTimeout(60);
  const at = Date.now();
  await p.mouse.up();
  await p.waitForTimeout(850); // R-DISP-6: one point per 800 ms; the popup rises after 350 ms
  if (!keepPopup && (await p.locator('[data-testid=tag-later]').count())) await p.locator('[data-testid=tag-later]').click();
  return at;
}

/** The camera's match log (MatchHub keeps it in localStorage, src/link/hub.ts). */
async function cameraLog(cam: Page): Promise<Array<{ type: string; by: string; point?: string }>> {
  return cam.evaluate(() => JSON.parse(localStorage.getItem('bs.hub') ?? 'null')?.log?.events ?? []);
}

/** Points the camera's log has a tag for (a chip appends a newer tag for the same point). */
const taggedPoints = async (cam: Page) => new Set((await cameraLog(cam)).filter((e) => e.type === 'tag').map((e) => e.point)).size;

/** Taps for the left team until the game is over, closing each popup. */
async function toGameOver(p: Page): Promise<void> {
  for (let i = 0; i < 40 && !(await p.locator('[aria-label="Game over"]').count()); i++) {
    if (await p.locator('[aria-label=Interval]').count()) {
      await p.locator('[aria-label=Interval]').click({ position: { x: 20, y: 20 } });
      await p.waitForTimeout(900);
    }
    await tap(p, 'left');
  }
  if (!(await p.locator('[aria-label="Game over"]').count())) throw new Error('no game over');
}

/**
 * The iPhone's screen locks: iOS suspends the page. Here its timers are held, its channel traffic stops both
 * ways, and the connection from before stays dead (it says so, and carries nothing) once the page runs again.
 */
async function screenOff(p: Page): Promise<void> {
  await p.evaluate(() => {
    const w = window as any;
    w.__frozen = true;
    w.__drop = true;
    w.__deaf = true;
    for (const pc of w.__pcs) pc.__dead = true;
    for (const dc of w.__dcs) dc.__dead = true;
  });
}

/** The screen comes back on: the page runs again and hears `visibilitychange`. Returns that moment. */
async function screenOn(p: Page): Promise<number> {
  const on = Date.now();
  await p.evaluate(() => {
    const w = window as any;
    w.__frozen = false;
    w.__drop = false;
    w.__deaf = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  return on;
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

/** Requests the stand-in for Cloudflare's TURN API got: the TTL asked for. */
const minted: Array<{ ttl: number }> = [];

/** POST /v1/turn/keys/<id>/credentials/generate-ice-servers with the key's bearer token, as Cloudflare answers it. */
function turnApi(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const ok = req.method === 'POST' && req.url === `/v1/turn/keys/${TURN_KEY.id}/credentials/generate-ice-servers`;
      if (!ok || req.headers.authorization !== `Bearer ${TURN_KEY.token}`) return void res.writeHead(401).end('{"error":"unauthorized"}');
      minted.push({ ttl: JSON.parse(body).ttl });
      res.writeHead(201, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          iceServers: [
            { urls: [`stun:127.0.0.1:${TURN_PORT}`] },
            { urls: [`turn:127.0.0.1:${TURN_PORT}?transport=udp`, `turn:127.0.0.1:${TURN_PORT}?transport=tcp`], username: TURN_USER, credential: TURN_PASS },
          ],
        }),
      );
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/turn/keys`, close: () => server.close() })));
}

const TURN_CONTAINER = `pairing-e2e-turn-${PORT}`;

/**
 * coturn on TURN_PORT (UDP and TCP), long-term credentials, relaying on the container's address. (Relaying on
 * its loopback with --allow-loopback-peers left the first connection of each pairing without a single check
 * delivered; the camera's second one, 10 s later, worked.)
 */
function startCoturn(): void {
  execFileSync('docker', [
    'run', '-d', '--rm', '--name', TURN_CONTAINER,
    '-p', `127.0.0.1:${TURN_PORT}:3478/udp`, '-p', `127.0.0.1:${TURN_PORT}:3478/tcp`,
    'coturn/coturn:4.7.0',
    '-n', '--log-file=stdout', '--fingerprint', '--lt-cred-mech', '--realm=e2e', `--user=${TURN_USER}:${TURN_PASS}`,
    '--listening-port=3478', '--min-port=49160', '--max-port=49200',
    '--no-tls', '--no-dtls', '--no-cli',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

async function main() {
  log(`output: ${OUT}`);
  let api: Awaited<ReturnType<typeof turnApi>> | null = null;
  const env: Record<string, string> = { ...(process.env as Record<string, string>), PORT: String(PORT) };
  if (RELAY) {
    startCoturn();
    api = await turnApi();
    Object.assign(env, { TURN_KEY_ID: TURN_KEY.id, TURN_KEY_API_TOKEN: TURN_KEY.token, TURN_API_URL: api.url });
    log(`relay: coturn ${TURN_CONTAINER} on 127.0.0.1:${TURN_PORT}, TURN API stand-in ${api.url}`);
  }
  const server = spawn(process.execPath, [path.join(ROOT, 'server/local.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const serverLog = fs.createWriteStream(path.join(OUT, 'server.log'));
  server.stdout.pipe(serverLog);
  server.stderr.pipe(serverLog);
  await until('the local server', async () => (await fetch(`${BASE}/`)).ok, 10_000);

  const camBrowser = await launch();
  const { ctx: camCtx, page: cam } = await newPage(camBrowser, 'camera');
  let sbBrowser: Browser | null = null;
  let sb3Browser = null as Browser | null;
  let sb2: Page | null = null;
  let sb3 = null as Page | null;
  let sbB = null as Page | null;
  let sbPage: Page | null = null;
  const netPages: Page[] = [];
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
    /** A fake camera playing the QR code the camera page shows now. */
    const qrCamera = async (name: string): Promise<string> => {
      await cam.locator('[data-testid=pair-qr]').screenshot({ path: path.join(OUT, `${name}.png`) });
      const y4m = path.join(OUT, `${name}.y4m`);
      execFileSync('ffmpeg', [
        '-loglevel', 'error', '-y', '-loop', '1', '-i', path.join(OUT, `${name}.png`), '-t', '2',
        '-vf', 'scale=480:480:flags=neighbor,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=gray,format=yuv420p', '-r', '15', y4m,
      ]);
      return y4m;
    };
    await step('camera shows a QR code and six digits (C2)', async () => {
      await button(cam, 'Try again').click();
      code = await until('code', async () => {
        const c = await text(cam, '[data-testid=pair-code]');
        return /^\d{6}$/.test(c) && c;
      });
      await until('QR svg', async () => (await cam.locator('[data-testid=pair-qr] svg').count()) > 0);
      await cam.screenshot({ path: path.join(OUT, '01-camera-c2.png') });
      return `code ${code}`;
    });

    // The scoreboard browser's fake camera shows that QR code.
    sbBrowser = await launch([`--use-file-for-fake-video-capture=${await qrCamera('qr')}`]);
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
      // D14: the camera now offers a fresh code for a second scoreboard.
      const second = await until('a code for scoreboard 2', async () => {
        const c = await text(cam, '[data-testid=pair-code]').catch(() => '');
        return /^\d{6}$/.test(c) && c !== code && c;
      }, 10_000);
      await cam.screenshot({ path: path.join(OUT, '03-camera-paired.png') });
      // One network (this Mac): with STUN and TURN configured too, ICE still picks the direct pair.
      const direct = (l: string) => l.startsWith('direct: ');
      const paths = [await diagLatest(cam, 'camera', 'path', direct), await diagLatest(sb, 'scoreboard', 'path', direct)];
      const relays = [await diagLatest(cam, 'camera', 'relay'), await diagLatest(sb, 'scoreboard', 'relay')];
      return `scan to paired on both: ${ms} ms; camera "${paths[0]}", scoreboard "${paths[1]}"; relay "${relays[0].split(' · ')[0]}" / "${relays[1].split(' · ')[0]}"; code for scoreboard 2: ${second}`;
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
      const since = Date.now();
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
      // ICE restarts went out with no candidate in production (2026-10-28): the gathering ended at once.
      const restarts = posted.filter((p) => p.at >= since && !p.fresh);
      const empty = restarts.filter((p) => p.candidates === 0);
      if (empty.length) throw new Error(`ICE restart descriptions without candidates: ${JSON.stringify(empty)}`);
      const restartNote = restarts.map((p) => `${p.page} ${p.kind} gen ${p.gen}: ${p.candidates} candidates`).join(', ') || 'none posted';
      return `chips amber after ${amber}; at 20 s ${during}; link back ${recovered} ms after the network returned; camera shows ${await score(sb)}; ICE restarts: ${restartNote}`;
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

    // §4.5: iOS suspends the page while the screen is locked and the connection does not survive it.
    await step('the scoreboard screen off for 20 s and on again: the link is back in seconds', async () => {
      // After the reload the board waits for a tap to continue the resumed match.
      const resumed = sb.getByRole('button', { name: 'Continue the match' });
      if (await resumed.count()) await resumed.click();
      await screenOff(sb);
      await cam.waitForTimeout(20_000);
      const camWhileOff = await chip(cam);
      const on = await screenOn(sb);
      const back = await until('both link ok', async () => (await chip(cam)) === 'link ok' && (await chip(sb)) === 'link ok' && Date.now() - on, 30_000, 50);
      await tap(sb, 'left');
      await until('camera has the tap', () => cameraShows(cam, sb), 5000);
      const resume = await sb.evaluate(() =>
        (JSON.parse(localStorage.getItem('bs.diag.scoreboard') ?? '{}').entries as Array<{ text: string }>)
          .map((e) => e.text)
          .filter((t) => t.startsWith('resume'))
          .at(-1),
      );
      if (back > 6000) throw new Error(`link back only after ${back} ms`);
      return `camera chip while off "${camWhileOff}"; link ok on both ${back} ms after the screen came on; scoreboard log "${resume?.slice(0, 90)}"`;
    });

    // 2026-10-30: the camera's page away for a few seconds with its connection alive (an app switch, or a stall on
    // mobile data) takes only the scoreboard down. The camera, still open, neither answered its hello nor offered,
    // and the scoreboard stayed on "link lost" for minutes while each tap reached the camera a ping round late.
    await step('the camera page away 8 s with its connection alive: the scoreboard is linked again within 2 s, a tap reaches the camera within 1 s', async () => {
      await cam.evaluate(() => Object.assign(window as any, { __frozen: true, __drop: true, __deaf: true }));
      const away = Date.now();
      const sbDown = await until('the scoreboard misses its pongs', async () => (await chip(sb)) !== 'link ok' && `${Date.now() - away} ms`, 12_000);
      await until('8 s away', async () => Date.now() - away >= 8000, 10_000);
      const back = Date.now();
      await cam.evaluate(() => {
        Object.assign(window as any, { __frozen: false, __drop: false, __deaf: false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const linked = await until('both link ok', async () => (await chip(cam)) === 'link ok' && (await chip(sb)) === 'link ok' && Date.now() - back, 10_000, 50);
      const n = (await cameraLog(cam)).length;
      const seen = until('camera has the tap', async () => (await cameraLog(cam)).length > n && Date.now(), 5000, 20);
      const at = await tap(sb, 'left');
      const ms = (await seen) - at;
      await until('camera shows the score', () => cameraShows(cam, sb), 2000);
      if (linked > 2000) throw new Error(`the scoreboard was linked again only after ${linked} ms`);
      if (ms > 1000) throw new Error(`the tap reached the camera after ${ms} ms`);
      return `scoreboard chip left link ok ${sbDown} into the 8 s; link ok on both ${linked} ms after the camera page came back; a tap on the camera after ${ms} ms`;
    });

    await step('a second scoreboard joins mid-match by its own code and takes the camera’s match (D14)', async () => {
      await cam.getByRole('button', { name: 'Menu' }).click();
      await cam.locator('[data-testid=menu-pair]').click();
      const c = await until('code', async () => {
        const t = await text(cam, '[data-testid=pair-code]');
        return /^\d{6}$/.test(t) && t;
      });
      sbB = (await newPage(camBrowser, 'scoreboard-b')).page;
      await sbB.goto(BASE);
      await button(sbB, /SCOREBOARD/).click();
      const start = Date.now();
      await sbB.locator('[data-testid=pair-chip]').click();
      await sbB.locator('input[data-testid=pair-code]').fill(c);
      await sbB.locator('[data-testid=pair-submit]').click();
      await until('paired', async () => (await sbB!.locator('[data-testid=pair-done]').count()) > 0, 30_000);
      await button(sbB, 'OK').click();
      await until('B shows the match', async () => (await score(sbB!)) === (await score(sb)), 5000);
      const ms = Date.now() - start;
      await until('camera 2/2', async () => (await text(cam, '[data-testid=boards]')) === '2/2', 5000);
      await until('A sees the other scoreboard', async () => (await text(sb, '[data-testid=others]')) === '+1 scoreboard', 5000);
      await sbB.screenshot({ path: path.join(OUT, '05b-scoreboard-b-joined.png') });
      await cam.screenshot({ path: path.join(OUT, '05c-camera-two-boards.png') });
      return `typed ${c}: ${ms} ms to the camera's ${await score(sbB)} on B; camera "2/2"; A shows "+1 scoreboard"`;
    });

    await step('both scoreboards score; every phone shows the same; the same rally tapped on both counts once', async () => {
      const b = sbB!;
      const [l0, r0] = (await score(sb)).split('-').map(Number);
      await tap(sb, 'left');
      await sb.waitForTimeout(1000); // over 1.5 s after A's tap: a new rally
      await tap(b, 'left');
      await tap(b, 'right');
      const want = `${l0 + 2}-${r0 + 1}`;
      await until('both show it', async () => (await score(sb)) === want && (await score(b)) === want && cameraShows(cam, sb), 5000);
      // Two friends tap the same rally a moment apart.
      await Promise.all([tap(sb, 'right'), b.waitForTimeout(300).then(() => tap(b, 'right'))]);
      const once = `${l0 + 2}-${r0 + 2}`;
      await until('counted once', async () => (await score(sb)) === once && (await score(b)) === once && cameraShows(cam, sb), 5000);
      const cue = (await b.locator('[data-testid=duplicate-cue]').count()) + (await sb.locator('[data-testid=duplicate-cue]').count());
      if (!cue) throw new Error('no "already counted" cue');
      await sb.waitForTimeout(2000);
      if ((await score(sb)) !== once || (await score(b)) !== once) throw new Error(`counted twice: ${await score(sb)} / ${await score(b)}`);
      return `A and B ${want} after three taps; a tap on each 300 ms apart: ${once}, the cue shown`;
    });

    await step('point reasons: A tags a winner in one tap and an error in two; B’s game-over card shows them (D15)', async () => {
      const b = sbB!;
      const before = await taggedPoints(cam);
      await tap(sb, 'left', true);
      await until('A’s popup', async () => (await sb.locator('[data-testid=tag-sheet]').count()) > 0, 3000);
      if (await b.locator('[data-testid=tag-sheet]').count()) throw new Error('the popup opened on B too');
      const offer = await until('B offers to tag', async () => (await b.locator('[data-testid=tag-offer]').count()) > 0, 3000);
      await sb.locator('[data-testid=tag-who-A0]').click(); // A won the rally: a winner in one tap
      await sb.locator('[data-testid=tag-shot-smash]').click();
      await sb.locator('[data-testid=tag-skip]').click();
      await tap(sb, 'right', true);
      await until('A’s popup again', async () => (await sb.locator('[data-testid=tag-sheet]').count()) > 0, 3000);
      await sb.screenshot({ path: path.join(OUT, '05e-scoreboard-tag-who.png') });
      await sb.locator('[data-testid=tag-who-A0]').click(); // A lost this one: forced or unforced
      await sb.locator('[data-testid=tag-unforced]').click();
      await sb.locator('[data-testid=tag-skip]').click();
      await until('the camera holds both tags', async () => (await taggedPoints(cam)) === before + 2, 5000);
      await toGameOver(sb);
      await until('B at game over with the card', async () => (await b.locator('[data-testid=stats-card]').count()) > 0, 5000);
      const cells = await b.locator('[data-testid=stats-A0] td').allTextContents(); // singles: Player, W, Forced, FE, UE
      if (cells.join('|') !== 'A|1|0|0|1') throw new Error(`B's card row for A: ${cells.join('|')}`);
      await b.screenshot({ path: path.join(OUT, '05f-scoreboard-b-game-over-card.png') });
      return `the popup on A only, B offered "${offer && 'Tap to tag'}"; winner (1 tap) and unforced error (2 taps) at the camera; B's card: A W 1, UE 1, "${await text(b, '[data-testid=stats-tagged]')}"`;
    });

    await step('tag later from the rally list on B; A’s card follows (D15)', async () => {
      const b = sbB!;
      const tagged = await text(sb, '[data-testid=stats-tagged]');
      await b.locator('[data-testid=stats-tag-points]').click();
      await until('the rally list', async () => (await b.locator('[data-testid=rally-list]').count()) > 0, 3000);
      const first = b.locator('[data-testid^=rally-][data-testid$=-A0]').first();
      await first.click(); // the first untagged rally: A won those, so A0 is a winner in this one tap
      await b.locator('[data-testid=tag-skip]').click();
      await b.locator('[data-testid=rally-list]').getByRole('button', { name: 'Close' }).click();
      const now = await until('A’s card counts one more', async () => {
        const t = await text(sb, '[data-testid=stats-tagged]');
        return t !== tagged && t;
      }, 5000);
      return `A's card "${tagged}" -> "${now}"`;
    });

    // The share of near-white pixels (the table's white rows; the fake camera's picture is green and its clock is at
    // the top) in the bottom-left corner of the camera's composited canvas, where the table goes by default.
    const whiteInCorner = () =>
      cam.evaluate(() => {
        const c = document.querySelector('canvas.preview-canvas') as HTMLCanvasElement;
        const f = c.height / 1080;
        const x = Math.round(60 * f);
        const w = Math.round(380 * f);
        const h = Math.round(80 * f);
        const y = c.height - Math.round(43 * f) - h - Math.round(4 * f);
        const d = c.getContext('2d')!.getImageData(x, y, w, h).data;
        let white = 0;
        for (let i = 0; i < d.length; i += 4) if (Math.min(d[i], d[i + 1], d[i + 2]) > 200) white++;
        return white / (d.length / 4);
      });

    await step('player stats in the video: Off by default, the table is burned into the camera frame when switched on (R-TAG-7)', async () => {
      const rows = cam.locator('[data-testid=stats-rows]');
      await until('the stats rows', async () => (await rows.count()) > 0, 5000);
      if ((await rows.locator('button[disabled]').count()) > 0) throw new Error('the rows are disabled with point reasons on');
      const off = await whiteInCorner();
      await rows.getByRole('button').nth(1).click(); // Player stats: Off, A, B
      await cam.waitForTimeout(800);
      const on = await whiteInCorner();
      if (!(on > 0.01 && off < 0.002)) throw new Error(`the table did not show in the bottom-left corner: white ${off.toFixed(4)} -> ${on.toFixed(4)}`);
      await cam.screenshot({ path: path.join(OUT, '05g-camera-player-stats-on.png') });
      await rows.getByRole('button').nth(0).click(); // back to Off
      await cam.waitForTimeout(800);
      const back = await whiteInCorner();
      if (back > 0.002) throw new Error(`switching the table off left its text in the frame: white ${back.toFixed(4)}`);
      return `bottom-left white-text share ${off.toFixed(4)} (Off) -> ${on.toFixed(4)} (table on) -> ${back.toFixed(4)} (Off again)`;
    });

    // Grey (the card's light body and its text) in the right 200 px of the summary card in the camera's composited
    // canvas, and none just outside its right edge: the card is CARD.w (1240) px wide at 1080p, centred.
    const cardInCamera = () =>
      cam.evaluate(() => {
        const c = document.querySelector('canvas.preview-canvas') as HTMLCanvasElement;
        const f = c.height / 1080;
        const right = Math.round((c.width + 1240 * f) / 2);
        const ctx = c.getContext('2d')!;
        const y0 = Math.round(c.height * 0.3);
        const band = Math.round(c.height * 0.4);
        const grey = (x: number, w: number) => {
          const d = ctx.getImageData(x, y0, w, band).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) {
            const mx = Math.max(d[i], d[i + 1], d[i + 2]);
            const mn = Math.min(d[i], d[i + 1], d[i + 2]);
            if (mn > 110 && mx - mn < 30) n++;
          }
          return n;
        };
        return { inside: grey(right - Math.round(200 * f), Math.round(190 * f)), outside: grey(right + Math.round(4 * f), Math.round(200 * f)), right };
      });

    await step('end-of-game summary in the video: waits for the last point, stays until the scoreboard closes it (R-TAG-7)', async () => {
      const b = sbB!;
      const rows = cam.locator('[data-testid=stats-rows]');
      await rows.getByRole('button').nth(4).click(); // End summary: Off, On (with the table Off the rows are Off A B Off On)
      await cam.waitForTimeout(800);
      const waiting = await cardInCamera();
      if (waiting.inside >= 20) throw new Error(`the summary is in the video while the last point is untagged: ${JSON.stringify(waiting)}`);
      const note = await text(sb, '[data-testid=summary-note]');
      if (!/รอแท็ก/.test(note)) throw new Error(`the scoreboard does not say the summary waits: "${note}"`);
      // Tag the last point of the game from the rally list on B (a winner in one tap on the side that won it).
      await b.locator('[data-testid=stats-tag-points]').click();
      await until('the rally list', async () => (await b.locator('[data-testid=rally-list]').count()) > 0, 3000);
      const n = await b.evaluate(() =>
        Math.max(...[...document.querySelectorAll('[data-testid]')].map((e) => /^rally-(\d+)$/.exec(e.getAttribute('data-testid') ?? '')?.[1]).filter(Boolean).map(Number)),
      );
      const row = await text(b, `[data-testid=rally-${n}]`);
      const [, a] = /(\d+)–(\d+)/.exec(row) ?? [];
      const winner = Number(a) >= 21 ? 'A' : 'B';
      await b.locator(`[data-testid=rally-${n}-${winner}0]`).click();
      await b.locator('[data-testid=tag-skip]').click();
      await b.locator('[data-testid=rally-list]').getByRole('button', { name: 'Close' }).click();
      await until('the summary in the video', async () => (await cardInCamera()).inside >= 20, 5000);
      await cam.screenshot({ path: path.join(OUT, '05h-camera-end-summary.png') });
      const shown = await cardInCamera();
      if (shown.outside > 0) throw new Error(`grey text outside the card's right edge: ${JSON.stringify(shown)}`);
      await cam.waitForTimeout(22_000); // longer than the old 20 s timer: it stays
      const still = await cardInCamera();
      if (still.inside < 20) throw new Error(`the summary went by itself: ${JSON.stringify(still)}`);
      await sb.locator('[data-testid=summary-close]').click();
      await until('the summary closed', async () => (await cardInCamera()).inside < 20, 5000);
      if (!(await sb.locator('[data-testid=summary-close]').isDisabled())) throw new Error('the close button is still enabled after closing');
      await rows.getByRole('button').nth(3).click(); // back to Off
      return `hidden while the last point was untagged (${waiting.inside} px); after its tag ${shown.inside} px, none past the edge; still there 22 s later (${still.inside} px); closed from the scoreboard`;
    });

    await step('point reasons off: a new match records no tag and opens no popup (D15)', async () => {
      const b = sbB!;
      await sb.getByRole('button', { name: 'Menu' }).click();
      await button(sb, 'New match').click();
      await button(sb, /Tap again/).click();
      await sb.locator('[aria-label="point reasons"]').getByRole('button', { name: 'Off' }).click();
      await button(sb, 'START MATCH').click();
      await until('B on the new match', async () => (await score(b)) === '0-0' && (await score(sb)) === '0-0', 5000);
      await tap(sb, 'left', true);
      await tap(b, 'right', true);
      await sb.waitForTimeout(600);
      for (const p of [sb, b]) {
        if (await p.locator('[data-testid=tag-sheet]').count()) throw new Error('a popup with point reasons off');
        if (await p.locator('[data-testid=untagged-chip]').count()) throw new Error('an untagged chip with point reasons off');
      }
      const tags = (await cameraLog(cam)).filter((e) => e.type === 'tag').length;
      if (tags) throw new Error(`${tags} tag events in the new match`);
      const hint = await until('the camera says why the stats rows are off', async () => (await cam.locator('[data-testid=stats-hint]').count()) > 0, 5000);
      if (!hint || (await cam.locator('[data-testid=stats-rows] button:not([disabled])').count()) > 0) throw new Error('the camera offers the stats rows with point reasons off');
      return `score ${await score(sb)} on both, no popup, no chip, no tag at the camera, the camera's stats rows disabled with a hint`;
    });

    await step('scoreboard B screen off for 20 s while A scores; B back in seconds with the camera’s state', async () => {
      const b = sbB!;
      await screenOff(b);
      const off = Date.now();
      await tap(sb, 'left');
      await tap(sb, 'left');
      await until('20 s', async () => Date.now() - off >= 20_000, 25_000, 250);
      const camBoards = await text(cam, '[data-testid=boards]');
      const on = await screenOn(b);
      const back = await until('B link ok with A’s score', async () => (await chip(b)) === 'link ok' && (await score(b)) === (await score(sb)) && Date.now() - on, 30_000, 50);
      await until('camera 2/2', async () => (await text(cam, '[data-testid=boards]')) === '2/2', 5000);
      await tap(b, 'right');
      await until('A sees B’s tap', async () => (await score(sb)) === (await score(b)) && cameraShows(cam, sb), 5000);
      if (back > 6000) throw new Error(`B back only after ${back} ms`);
      return `camera showed "${camBoards}" while B was off; B link ok with ${await score(b)} ${back} ms after its screen came on; B's next tap reached A`;
    });

    await step('the camera unpairs both: each scoreboard is unpaired within a second, nothing of the camera left (Part 3)', async () => {
      const b = sbB!;
      await cam.getByRole('button', { name: 'Menu' }).click();
      const start = Date.now();
      await button(cam, 'Unpair both scoreboards').click();
      const ms = await until('both unpaired', async () => (await sb.locator('[data-testid=pair-chip]').count()) > 0 && (await b.locator('[data-testid=pair-chip]').count()) > 0 && Date.now() - start, 5000, 50);
      for (const p of [sb, b]) {
        if (await p.locator('[data-testid=cam-rec]').count()) throw new Error('REC state still shown');
        if (await p.evaluate(() => localStorage.getItem('bs.pair.scoreboard'))) throw new Error('saved pairing kept');
      }
      const left = await score(sb);
      await tap(sb, 'left'); // each scores alone again (R-PAIR-3)
      if ((await score(sb)) === left) throw new Error('scoring stopped after unpairing');
      if ((await chip(cam)) !== 'not paired') throw new Error(`camera chip "${await chip(cam)}"`);
      await sb.screenshot({ path: path.join(OUT, '05d-scoreboard-unpaired.png') });
      return `${ms} ms from Unpair to "Pair camera" on both; no REC state, no saved pairing; A scores alone`;
    });

    await step('a new scoreboard pairs by typing the code (no viewfinder QR)', async () => {
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
      // The camera had no match after unpairing both: it takes the new scoreboard's (none) and stays empty.
      return `typed ${c}: ${Date.now() - start} ms to paired`;
    });

    // The captain's path on iPhone: the camera app reads the QR and opens its link, so S2 starts with that code
    // while its own viewfinder still sees the same QR. The one-shot code must be claimed once: a second claim
    // fails with "code not found" and used to end the pairing the first one had made.
    await step('the QR link opened by the camera app pairs, the viewfinder on the same QR claims nothing more', async () => {
      await cam.getByRole('button', { name: 'Menu' }).click();
      await button(cam, 'Unpair the scoreboard').click();
      await until('scoreboard 2 unpaired', async () => (await sb2!.locator('[data-testid=pair-chip]').count()) > 0, 5000);
      // C2 is still open with the code for the other slot (D14); otherwise open it.
      const open = await until('a code or Pair…', async () =>
        (await cam.locator('[data-testid=pair-code]').count()) ? 'code' : (await cam.locator('[data-testid=cam-pair]').count()) ? 'pair' : null,
      );
      if (open === 'pair') await cam.locator('[data-testid=cam-pair]').click();
      const c = await until('code', async () => {
        const t = await text(cam, '[data-testid=pair-code]');
        return /^\d{6}$/.test(t) && t;
      });
      await until('QR svg', async () => (await cam.locator('[data-testid=pair-qr] svg').count()) > 0);
      sb3Browser = await launch([`--use-file-for-fake-video-capture=${await qrCamera('qr-link')}`]);
      const linked = await newPage(sb3Browser, 'scoreboard-3');
      sb3 = linked.page;
      const claims: string[] = [];
      sb3.on('request', (r) => /\/api\/signal\/rooms\/\d+$/.test(r.url()) && claims.push(r.url().slice(-6)));
      const start = Date.now();
      await sb3.goto(`${BASE}/#pair=${c}`);
      await until('paired', async () => (await sb3!.locator('[data-testid=pair-done]').count()) > 0, 30_000);
      await until('camera link ok', async () => (await chip(cam)) === 'link ok');
      const ms = Date.now() - start;
      // Long enough for the scanner to have read the QR many times over (it looks every 300 ms).
      await sb3.waitForTimeout(5000);
      await sb3.screenshot({ path: path.join(OUT, '06-scoreboard-link-paired.png') });
      if ((await sb3.locator('[data-testid=pair-done]').count()) === 0)
        throw new Error(`no longer paired: "${await text(sb3, '[data-testid=pair-status]').catch(() => '')}"`);
      if (claims.length !== 1) throw new Error(`claimed ${claims.length} times: ${claims.join(', ')}`);
      if ((await chip(cam)) !== 'link ok') throw new Error(`camera chip "${await chip(cam)}"`);
      await button(sb3, 'OK').click();
      return `link #pair=${c}: ${ms} ms to paired, one claim, still paired 5 s later with the QR in view`;
    });

    // The camera pretends to be a newer build speaking protocol v4: the scoreboard is the one to update. Its
    // reloaded page says v4 in its new offer, so the scoreboard refuses it before any connection (the helper path,
    // which also reaches a build that could never open the channel) and the camera is told through the helper.
    await step('version mismatch tells which phone to update (R-PAIR-7)', async () => {
      const board = sb3!;
      await cam.evaluate(() => sessionStorage.setItem('__vnext', '1'));
      await cam.reload();
      await until('scoreboard mismatch chip', async () => (await chip(board)) === 'update app', 20_000);
      const title = (await board.locator('[data-testid=link-chip]').getAttribute('title')) ?? '';
      const camNote = await until('camera note', async () => text(cam, '[data-testid=pair-note]'), 10_000);
      await board.screenshot({ path: path.join(OUT, '07-scoreboard-mismatch.png') });
      await cam.screenshot({ path: path.join(OUT, '08-camera-mismatch.png') });
      if (title !== 'This phone runs an older version of the app. Update it (Update now, or close the app fully and open it again), then pair again.')
        throw new Error(`scoreboard says "${title}"`);
      if (camNote !== 'The other phone runs an older version of the app. Update it there (Update now in its menu, or close the app fully and open it again), then pair again.')
        throw new Error(`camera says "${camNote}"`);
      return `scoreboard chip "update app" / "${title}"; camera "${camNote}"`;
    });

    // What the captain's iPhones did on 2026-10-28: each on mobile data, so each offers only its carrier address.
    // The helper part works, the link can never open, and both screens must say why instead of "connecting".
    await step('phones on different networks: both screens say so with the two addresses; the diagnostics show it', async () => {
      const camNet = (await newPage(camBrowser, 'camera-net')).page;
      const sbNet = (await newPage(camBrowser, 'scoreboard-net')).page;
      netPages.push(camNet, sbNet);
      for (const p of [camNet, sbNet]) await noRelay(p);
      await camNet.goto(BASE);
      await camNet.evaluate(() => sessionStorage.setItem('__ip', '10.195.144.160'));
      await button(camNet, /CAMERA/).click();
      await until('camera live', async () => (await camNet.locator('[data-testid=rec-button]').isEnabled()) || null, 15_000);
      await camNet.locator('[data-testid=cam-pair]').click();
      const c = await until('code', async () => {
        const t = await text(camNet, '[data-testid=pair-code]');
        return /^\d{6}$/.test(t) && t;
      });
      await sbNet.goto(BASE);
      await sbNet.evaluate(() => sessionStorage.setItem('__ip', '10.131.171.124'));
      await button(sbNet, /SCOREBOARD/).click();
      await sbNet.locator('[data-testid=pair-chip]').click();
      const start = Date.now();
      await sbNet.locator('input[data-testid=pair-code]').fill(c);
      await sbNet.locator('[data-testid=pair-submit]').click();
      const want = 'different networks (this phone 10.131.171.124, the other 10.195.144.160), probably mobile data, and the internet relay is not set up';
      const sbSays = await until('scoreboard names the networks', async () => {
        const t = await text(sbNet, '[data-testid=pair-status]');
        return t.includes(want) && t;
      }, 30_000, 250);
      const ms = Date.now() - start;
      const camSays = await until('camera names the networks', async () => {
        const t = await text(camNet, '[data-testid=pair-status]');
        return t.includes('different networks (this phone 10.195.144.160, the other 10.131.171.124), probably mobile data, and the internet relay is not set up') && t;
      }, 20_000, 250);
      if ((await sbNet.locator('[data-testid=pair-done]').count()) > 0) throw new Error('paired across networks?');
      const chipText = await text(sbNet, '[data-testid=diag-chip]');
      for (const part of ['path none', 'relay: not configured', 'net different (this phone 10.131.171.124, other 10.195.144.160)'])
        if (!chipText.includes(part)) throw new Error(`diagnostics chip "${chipText}" lacks "${part}"`);
      await sbNet.locator('[data-testid=diag-chip]').click();
      const diagLog = await until('the slow connect in the log', async () => {
        const t = await text(sbNet, '[data-testid=diag-log]');
        return t.includes('after the answer: different networks') && t;
      }, 10_000, 250);
      for (const line of [
        `GET /rooms/${c} → 200`,
        'got offer gen 1 new connection: 10.195.144.160',
        'sent answer gen 1 new connection: 10.131.171.124',
        'relay  not configured',
        'after the answer: different networks and the internet relay is not set up',
      ])
        if (!diagLog.includes(line)) throw new Error(`the diagnostics log lacks "${line}"`);
      await sbNet.screenshot({ path: path.join(OUT, '09-scoreboard-different-networks-diag.png') });
      await sbNet.getByRole('dialog', { name: 'Pairing diagnostics' }).getByRole('button', { name: 'Close' }).click();
      await sbNet.screenshot({ path: path.join(OUT, '10-scoreboard-different-networks.png') });
      await camNet.screenshot({ path: path.join(OUT, '11-camera-different-networks.png') });
      return `typed ${c}; after ${ms} ms the scoreboard says "${sbSays}"; camera "${camSays}"; chip "${chipText}"`;
    });

    if (!RELAY) log(`  relay steps skipped: ${HELPER ? 'HELPER is set' : 'E2E_RELAY=0'}`);
    else {
      /** A camera and a scoreboard that offer only the carrier addresses of 2026-10-28 and relay candidates. */
      const relayPair = async (name: string, tcp: boolean) => {
        const camRelay = (await newPage(camBrowser, `camera-${name}`)).page;
        const sbRelay = (await newPage(camBrowser, `scoreboard-${name}`)).page;
        netPages.push(camRelay, sbRelay);
        const since = Date.now();
        for (const [p, ip] of [[camRelay, '10.195.144.160'], [sbRelay, '10.131.171.124']] as const) {
          await p.goto(BASE);
          await p.evaluate(([a, t]) => {
            sessionStorage.setItem('__relay', a);
            if (t) sessionStorage.setItem('__tcp', '1');
          }, [ip, tcp] as const);
        }
        await button(camRelay, /CAMERA/).click();
        await until('camera live', async () => (await camRelay.locator('[data-testid=rec-button]').isEnabled()) || null, 15_000);
        await camRelay.locator('[data-testid=cam-pair]').click();
        const c = await until('code', async () => {
          const t = await text(camRelay, '[data-testid=pair-code]');
          return /^\d{6}$/.test(t) && t;
        });
        await button(sbRelay, /SCOREBOARD/).click();
        await sbRelay.locator('[data-testid=pair-chip]').click();
        const start = Date.now();
        await sbRelay.locator('input[data-testid=pair-code]').fill(c);
        await sbRelay.locator('[data-testid=pair-submit]').click();
        await until('paired', async () => (await sbRelay.locator('[data-testid=pair-done]').count()) > 0, 30_000);
        await until('camera link ok', async () => (await chip(camRelay)) === 'link ok', 10_000);
        const ms = Date.now() - start;
        const relayPath = (l: string) => l.startsWith(`relay: this phone relay/${tcp ? 'tcp' : 'udp'} `);
        const paths = [await diagLatest(camRelay, 'camera', 'path', relayPath), await diagLatest(sbRelay, 'scoreboard', 'path', relayPath)];
        const sent = posted.filter((p) => p.at >= since && p.page.endsWith(`-${name}`));
        if (sent.some((p) => p.candidates < 2)) throw new Error(`descriptions without a relay candidate: ${JSON.stringify(sent)}`);
        const nets = [await diagLatest(camRelay, 'camera', 'net'), await diagLatest(sbRelay, 'scoreboard', 'net')];
        if (!nets.every((n) => n.startsWith('different'))) throw new Error(`net ${JSON.stringify(nets)}`);
        return { camRelay, sbRelay, c, ms, paths, sent };
      };

      // The fix for 2026-10-28: the same two carrier addresses, but the helper hands out TURN credentials, so
      // each phone also offers relay candidates and the link opens through the relay.
      await step('phones on different networks connect through the relay; the diagnostics say relay', async () => {
        const { camRelay, sbRelay, c, ms, paths, sent } = await relayPair('relay', false);
        const relays = [await diagLatest(camRelay, 'camera', 'relay'), await diagLatest(sbRelay, 'scoreboard', 'relay')];
        if (!relays.every((l) => l.startsWith('ready until ') && l.includes(`turn:127.0.0.1:${TURN_PORT}?transport=udp`) && !l.includes(TURN_PASS)))
          throw new Error(`relay lines ${JSON.stringify(relays)}`);
        if (!minted.length || minted.some((m) => m.ttl !== 3600)) throw new Error(`TURN API calls ${JSON.stringify(minted)}`);
        const chipText = await text(sbRelay, '[data-testid=diag-chip]').catch(() => '');
        await button(sbRelay, 'OK').click();
        await sbRelay.screenshot({ path: path.join(OUT, '12-scoreboard-relay.png') });
        await camRelay.screenshot({ path: path.join(OUT, '13-camera-relay.png') });
        // The relay carries the match too.
        await button(sbRelay, 'START MATCH').click();
        await until('board', async () => (await sbRelay.locator('[data-zone=left]').count()) > 0);
        await tap(sbRelay, 'left');
        await until('camera shows 1–0', () => cameraShows(camRelay, sbRelay), 5000);
        return `typed ${c}: ${ms} ms to paired; camera "${paths[0]}", scoreboard "${paths[1]}"; ${sent.length} descriptions, each with its relay candidate; ${minted.length} credential requests so far, TTL 3600 s; chip "${chipText}"; a point reached the camera`;
      });

      // A helper that forgot the session (its TTL passed, or a memory-store helper restarted) must not cut a link
      // that is open: it did, on both phones within 2 s, and the camera dropped its match (2026-10-31 audit, BUG-3).
      await step('the helper forgets the session while the link is open: the link stays, and a tap still reaches the camera', async () => {
        const [camRelay, sbRelay] = [netPages[2], netPages[3]];
        const gone = /\/api\/signal\/sessions\/[0-9a-f]+\/(poll|offer|answer|ice)/;
        const hits: string[] = [];
        for (const p of [camRelay, sbRelay])
          await p.route(gone, (r) => {
            hits.push(r.request().url());
            return r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"no-session"}' });
          });
        await sbRelay.waitForTimeout(20_000); // the scoreboard's idle poll comes every 15 s
        if (!hits.length) throw new Error('no helper call in 20 s: the 404 was never seen');
        const chips = [await chip(camRelay), await chip(sbRelay)];
        if (chips.some((c) => c !== 'link ok')) throw new Error(`chips ${JSON.stringify(chips)} after the helper forgot the session`);
        const before = (await cameraLog(camRelay)).length;
        await tap(sbRelay, 'right');
        await until('the camera has the point', async () => (await cameraLog(camRelay)).length > before && cameraShows(camRelay, sbRelay), 5000);
        const kept = await diagLatest(sbRelay, 'scoreboard', 'error', (l) => l.includes('the open link is kept'));
        for (const p of [camRelay, sbRelay]) await p.unroute(gone);
        return `${hits.length} helper calls answered 404; both chips "link ok"; a point reached the camera; scoreboard log "${kept}"`;
      });

      await step('with UDP to the relay blocked, TURN over TCP carries the link', async () => {
        const { c, ms, paths } = await relayPair('relay-tcp', true);
        return `typed ${c}: ${ms} ms to paired; camera "${paths[0]}", scoreboard "${paths[1]}"`;
      });

      // Production, 2026-10-30: the scoreboard had no relay (its credentials failed, or it ran a build from before
      // the relay) and answered with mDNS candidates only; the camera offered a new connection every 12 s for ever
      // and both screens advised one Wi-Fi. Both now say why within about 20 s of Pair, and stop.
      await step('a scoreboard whose relay credentials fail: both phones say why within about 20 s, and stop', async () => {
        const camF = (await newPage(camBrowser, 'camera-norelay')).page;
        const sbF = (await newPage(camBrowser, 'scoreboard-norelay')).page;
        netPages.push(camF, sbF);
        await sbF.route(/\/api\/signal\/sessions\/[0-9a-f]+\/ice$/, (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"store"}' }));
        await camF.goto(BASE);
        await camF.evaluate(() => sessionStorage.setItem('__relay', '10.195.183.85'));
        await sbF.goto(BASE);
        await sbF.evaluate(() => sessionStorage.setItem('__ip', '3f0c9a3e-1c2d-4c1e-9d10-7d0b8f3a0c11.local')); // Chrome on a Mac: mDNS only
        await button(camF, /CAMERA/).click();
        await until('camera live', async () => (await camF.locator('[data-testid=rec-button]').isEnabled()) || null, 15_000);
        await camF.locator('[data-testid=cam-pair]').click();
        const c = await until('code', async () => {
          const t = await text(camF, '[data-testid=pair-code]');
          return /^\d{6}$/.test(t) && t;
        });
        await button(sbF, /SCOREBOARD/).click();
        await sbF.locator('[data-testid=pair-chip]').click();
        await sbF.locator('input[data-testid=pair-code]').fill(c);
        const start = Date.now();
        await sbF.locator('[data-testid=pair-submit]').click();
        const why = async (p: Page) => {
          const t = await text(p, '[data-testid=pair-status]');
          return t.startsWith('Could not connect') && t;
        };
        const sbSays = await until('scoreboard says why', () => why(sbF), 30_000, 250);
        const ms = Date.now() - start;
        const camSays = await until('camera says why', () => why(camF), 10_000, 250);
        if (ms > 25_000) throw new Error(`the scoreboard said why only after ${ms} ms`);
        if (sbSays !== "Could not connect: this phone could not use the internet relay (helper: store). Check this phone's internet connection, then pair again.")
          throw new Error(`scoreboard says "${sbSays}"`);
        if (!camSays.includes('the scoreboard phone could not use the internet relay (helper: store)')) throw new Error(`camera says "${camSays}"`);
        const offers = () => posted.filter((p) => p.page === 'camera-norelay' && p.kind === 'offer').length;
        const n = offers();
        await camF.waitForTimeout(15_000);
        if (offers() !== n) throw new Error(`the camera kept offering: ${offers() - n} more offers after it gave up`);
        await sbF.screenshot({ path: path.join(OUT, '14-scoreboard-no-relay.png') });
        await camF.screenshot({ path: path.join(OUT, '15-camera-no-relay.png') });
        return `typed ${c}; after ${ms} ms the scoreboard says "${sbSays}"; the camera "${camSays}"; no offer in the 15 s after`;
      });
    }
  } catch (err) {
    for (const [name, p] of [
      ['camera', cam],
      ['scoreboard', sbPage],
      ['scoreboard-3', sb3],
      ['scoreboard-b', sbB],
      ['camera-net', netPages[0]],
      ['scoreboard-net', netPages[1]],
      ['camera-relay', netPages[2]],
      ['scoreboard-relay', netPages[3]],
      ['camera-relay-tcp', netPages[4]],
      ['scoreboard-relay-tcp', netPages[5]],
      ['camera-norelay', netPages[6]],
      ['scoreboard-norelay', netPages[7]],
    ] as const) {
      if (!p) continue;
      await p.screenshot({ path: path.join(OUT, `fail-${name}.png`) }).catch(() => {});
      const out = await p.evaluate(() => (window as any).__out.slice(-25)).catch(() => []);
      log(`  ${name} last sent: ${JSON.stringify(out)}`);
    }
    throw err;
  } finally {
    // Each page's pairing diagnostics, as Copy would give them.
    const pages = [['camera', cam], ['scoreboard', sbPage], ['scoreboard-2', sb2], ['scoreboard-3', sb3], ['scoreboard-b', sbB], ['camera-net', netPages[0]], ['scoreboard-net', netPages[1]], ['camera-relay', netPages[2]], ['scoreboard-relay', netPages[3]], ['camera-relay-tcp', netPages[4]], ['scoreboard-relay-tcp', netPages[5]], ['camera-norelay', netPages[6]], ['scoreboard-norelay', netPages[7]]] as const;
    for (const [name, p] of pages) {
      const logs = await p
        ?.evaluate(() => ['camera', 'scoreboard'].map((r) => localStorage.getItem(`bs.diag.${r}`)).filter(Boolean).map((j) => JSON.parse(j!).entries))
        .catch(() => null);
      if (logs) fs.writeFileSync(path.join(OUT, `diag-${name}.json`), JSON.stringify(logs, null, 2));
    }
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(OUT, 'posted-descriptions.json'), JSON.stringify(posted, null, 2));
    await camBrowser.close().catch(() => {});
    await sbBrowser?.close().catch(() => {});
    await sb3Browser?.close().catch(() => {});
    server.kill();
    api?.close();
    if (RELAY) {
      try {
        fs.writeFileSync(path.join(OUT, 'coturn.log'), execFileSync('docker', ['logs', TURN_CONTAINER], { stdio: ['ignore', 'pipe', 'pipe'] }));
      } catch {
        // gone already
      }
      try {
        execFileSync('docker', ['rm', '-f', TURN_CONTAINER], { stdio: 'ignore' });
      } catch {
        // gone already
      }
    }
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
