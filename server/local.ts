// Local stand-in for the Vercel deployment: the built app from dist/ and the signaling helper (api/signal.ts,
// the very same handler) with the in-memory store, on one origin, so the whole two-phone flow runs on the
// tailnet without Vercel. Node runs this file directly (type stripping), no build step.
//
//   pnpm build && pnpm serve:local          # PORT=8787 by default, binds 127.0.0.1
//   tailscale serve --bg --https=8447 http://127.0.0.1:8787
//
// Same cache headers as vercel.json: the shell and the service worker are always revalidated, hashed
// assets are immutable.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { MemoryStore, createHandler, turnFromEnv } from '../api/signal.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', process.env.DIST ?? 'dist');
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

const store = new MemoryStore();
const turn = turnFromEnv(process.env);
const signal = createHandler(() => store, { turn: () => turn });

function cacheControl(rel: string): string {
  return rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate';
}

async function api(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', req.socket.remoteAddress ?? 'local');
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(`http://${req.headers.host ?? 'local'}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: 'half',
  } as RequestInit);
  const response = await signal(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
  console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${response.status}`);
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cacheControl(rel),
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
}

http
  .createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://local');
    if (pathname.startsWith('/api/signal')) {
      api(req, res).catch((err) => {
        console.error(err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    } else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, pathname);
    else res.writeHead(405).end();
  })
  .listen(PORT, HOST, () =>
    console.log(`app + signaling helper (memory store, relay ${turn ? `via ${turn.api}` : 'not configured'}) on http://${HOST}:${PORT}  serving ${ROOT}`),
  );
