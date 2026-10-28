# badminton-scoreboard

A browser-only app for filming casual badminton matches with a live scoreboard.

Two iPhones pair through a tiny helper and then talk directly over the local
network: one at the back corner of the court records video with the score
composited into every frame and keeps it in its own storage (OPFS); the other
sits at the net post as a large tappable scoreboard that applies badminton
scoring rules, including who serves from where in doubles, and speaks the
score. Every point is logged with its time on the recording, so the finished
clip is on the phone when the match ends and the overlay can still be
re-rendered later if wanted.

Status: phase 1 (single-phone scoreboard) and the camera half of phase 2
(live-composited recording, segments, export) implemented; the camera can
follow this phone's own match through "Demo score" in its menu until pairing
(the rest of phase 2, docs/roadmap.md) lands. Hosting target: Vercel (static
PWA plus one signaling function).

## Development

`pnpm install`, then `pnpm dev` (dev server), `pnpm test` (Vitest: engine,
touch guards, phrases, persistence, overlay, score source, recording worker,
segments, export bundle), `pnpm build` (static PWA in `dist/`).
`pnpm icons` regenerates the PNG icons from `public/favicon.svg`.

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
