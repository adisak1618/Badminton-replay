# badminton-scoreboard

A browser-only app for filming casual badminton matches with a live scoreboard.

Two phones pair peer-to-peer over the local network: one at the back corner of
the court records video to its own storage (OPFS), the other sits at the net
post as a large tappable scoreboard that applies badminton scoring rules and
speaks the score. Every point is logged with its time on the recording so the
scoreboard can be burned into the video afterwards on a Mac, or live later.

Status: design phase. No application code yet; the captain reviews the docs
before implementation starts. Hosting target: Vercel (static PWA, no backend).

## Docs

- [docs/requirements.md](docs/requirements.md): decisions needed, goals,
  scenario, functional and non-functional requirements with ids, out of scope.
- [docs/ux-design.md](docs/ux-design.md): screens and wireframes for both
  roles, flows, touch handling, feedback, design rationale.
- [docs/technical-design.md](docs/technical-design.md): architecture, stack,
  pairing and protocol, score engine and event log, recording pipeline,
  burn-in options, export bundle, browser support matrix with sources,
  deployment, local development, testing, risks.
- [docs/roadmap.md](docs/roadmap.md): phased plan with a definition of done
  per phase, and the follow-ups kept out of v1.
