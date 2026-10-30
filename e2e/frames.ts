// Proof frames of the overlay for docs/video-stats/, drawn by the real overlay code in Chrome with the bundled font
// (src/overlay/proof-frames.ts): the panel in every state, the live table, the end-of-game card, three frames
// caught mid-animation, plus the font, determinism and table-header checks the PR quotes. The state crops go into
// one sheet. The checks run again in WebKit when Playwright's WebKit is installed (the camera phone is WebKit).
//
//   pnpm frames                 # needs Google Chrome; OUT=dir writes there instead of docs/video-stats
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright-core';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.env.OUT ?? path.join(ROOT, 'docs/video-stats'));
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

type Header = { ok: boolean; cases: Array<{ frame: string; size: string; table: string; headers: Array<{ key: string; col: number[]; ink: number[]; inside: boolean }> }> };
/** Print the table-header check and fail when a header's ink leaves its column. */
function headers(engine: string, h: Header): void {
  for (const c of h.cases)
    console.log(`${engine} header check ${c.frame} ${c.size} table ${c.table}: ${c.headers.map((x) => `${x.key} col ${x.col.join('-')} ink ${x.ink.join('-')}${x.inside ? '' : ' OUTSIDE'}`).join(' | ')}`);
  if (!h.ok) throw new Error(`${engine}: a table header leaves its column`);
}

const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const addr = server.httpServer!.address();
const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 5173}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/e2e/frames.html`);
  await page.waitForFunction(() => (window as unknown as { __done?: boolean }).__done === true, null, { timeout: 60_000 });
  if (errors.length) throw new Error(errors.join('\n'));
  const shots = (await page.evaluate(() => (window as unknown as { __frames: Array<{ name: string; url: string }> }).__frames)) as Array<{ name: string; url: string }>;
  const checks = (await page.evaluate(() => (window as unknown as { __checks: Record<string, unknown> }).__checks)) as Record<string, unknown>;
  fs.mkdirSync(OUT, { recursive: true });
  const states: Array<{ name: string; url: string }> = [];
  for (const s of shots) {
    if (s.name.startsWith('state-')) {
      states.push(s);
      continue;
    }
    const ext = s.url.startsWith('data:image/png') ? 'png' : 'jpg';
    fs.writeFileSync(path.join(OUT, `${s.name}.${ext}`), Buffer.from(s.url.split(',')[1], 'base64'));
    console.log(`${s.name}.${ext}`);
  }
  // The states side by side at 1:1, three to a row.
  const sheet = await page.evaluate(async (list) => {
    const imgs = await Promise.all(
      list.map(
        (s) =>
          new Promise<HTMLImageElement>((ok) => {
            const i = new Image();
            i.onload = () => ok(i);
            i.src = s.url;
          }),
      ),
    );
    const cw = Math.max(...imgs.map((i) => i.width));
    const ch = Math.max(...imgs.map((i) => i.height));
    const c = document.createElement('canvas');
    c.width = 3 * cw + 32;
    c.height = Math.ceil(imgs.length / 3) * (ch + 8) + 8;
    const g = c.getContext('2d')!;
    g.fillStyle = '#0b0d12';
    g.fillRect(0, 0, c.width, c.height);
    imgs.forEach((im, k) => g.drawImage(im, 8 + (k % 3) * (cw + 8), 8 + Math.floor(k / 3) * (ch + 8)));
    return c.toDataURL('image/png');
  }, states);
  fs.writeFileSync(path.join(OUT, 'panel-states-1080p.png'), Buffer.from(sheet.split(',')[1], 'base64'));
  console.log(`panel-states-1080p.png (${states.map((s) => s.name.slice(6)).join(', ')})`);
  console.log(JSON.stringify(checks));
  const bad = ['kanitLoaded', 'kanitDraws', 'sameFrameAfterOthers', 'sameFrameOnAnotherCanvas', 'midDiffersFromSettled', 'settledStable'].filter((k) => checks[k] !== true);
  if (bad.length) throw new Error(`checks failed: ${bad.join(', ')}`);
  headers('chrome', (await page.evaluate(() => (window as unknown as { __header: Header }).__header)) as Header);
  // The same checks in WebKit, the camera phone's engine (not iOS itself: this is WebKit on macOS).
  let wk = null;
  try {
    wk = await webkit.launch({ headless: true });
  } catch {
    console.log('webkit: not installed (node node_modules/playwright-core/cli.js install webkit), skipped');
  }
  if (wk) {
    try {
      const p = await wk.newPage({ viewport: { width: 800, height: 600 } });
      await p.goto(`${base}/e2e/frames.html?checks`);
      await p.waitForFunction(() => (window as unknown as { __done?: boolean }).__done === true, null, { timeout: 60_000 });
      const c = (await p.evaluate(() => (window as unknown as { __checks: Record<string, unknown> }).__checks)) as Record<string, unknown>;
      console.log(`webkit ${await p.evaluate(() => navigator.userAgent)}: ${JSON.stringify(c)}`);
      const badWk = ['kanitLoaded', 'kanitDraws', 'sameFrameAfterOthers', 'sameFrameOnAnotherCanvas', 'midDiffersFromSettled', 'settledStable'].filter((k) => c[k] !== true);
      if (badWk.length) throw new Error(`webkit checks failed: ${badWk.join(', ')}`);
      headers('webkit', (await p.evaluate(() => (window as unknown as { __header: Header }).__header)) as Header);
    } finally {
      await wk.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
