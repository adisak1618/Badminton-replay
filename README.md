# badminton-scoreboard

A browser-only app for filming casual badminton matches with a live scoreboard.

Two iPhones pair through a tiny helper and then talk directly over the local
network (or through a relay when they share none): one at the back corner of
the court records video with the score composited into every frame and keeps
it in its own storage (OPFS); the other sits at the net post as a large tappable scoreboard that applies badminton
scoring rules, including who serves from where in doubles, and speaks the
score. Every point is logged with its time on the recording, so the finished
clip is on the phone when the match ends and the overlay can still be
re-rendered later if wanted.

Status: phase 1 (single-phone scoreboard) and phase 2 built, its acceptance on
the iPhones pending (docs/roadmap.md): live-composited
recording, segments and export on the camera phone, and pairing (QR or typed
code through the signaling helper, WebRTC data channel on the local network,
automatic reconnect, remote REC from the scoreboard). Phones on different
networks (e.g. both on mobile data) connect through a TURN relay once a
Cloudflare TURN key is set (docs/deploy.md §3); one Wi-Fi still connects
directly. The camera can still follow its own phone's match through "Demo
score" in its menu. Hosting:
Vercel (static PWA plus one signaling function), see
[docs/deploy.md](docs/deploy.md).

## Development

`pnpm install`, then `pnpm dev` (dev server), `pnpm test` (Vitest: engine,
touch guards, phrases, persistence, overlay, score source, recording worker,
segments, export bundle, protocol, signaling helper, reconnect policy, the
paired roles), `pnpm build` (static PWA in `dist/`).
`pnpm icons` regenerates the PNG icons from `public/favicon.svg`.

Pairing without Vercel: `pnpm build && pnpm serve:local` serves `dist/` and the
signaling helper (in-memory store) on one origin at `127.0.0.1:8787`; publish
it to the phones with `tailscale serve --bg --https=<port> http://127.0.0.1:8787`.
`pnpm dev` proxies `/api` to that server. `pnpm e2e` (needs Google Chrome and
ffmpeg) pairs two headless Chrome browsers through it and exercises sync,
remote REC, outages, reloads, the version check and, with a coturn in Docker,
the TURN relay (`E2E_RELAY=0` skips that without Docker).

## Docs

- [docs/requirements.md](docs/requirements.md): recorded decisions, goals,
  scenario, functional and non-functional requirements with ids, out of scope.
- [docs/ux-design.md](docs/ux-design.md): screens and wireframes for both
  roles, flows, touch handling, feedback, design rationale.
- [docs/mockup/index.html](docs/mockup/index.html): rough tappable UI, one
  self-contained file; open it in Safari in landscape.
- [docs/technical-design.md](docs/technical-design.md): architecture, stack,
  signaling helper and protocol, score engine and event log, compositing and
  recording pipeline, export bundle, browser support matrix with sources,
  deployment, local development, testing, risks.
- [docs/roadmap.md](docs/roadmap.md): phased plan with a definition of done
  per phase, and the follow-ups kept out of v1.
- [docs/deploy.md](docs/deploy.md): putting the app and the helper on Vercel.
