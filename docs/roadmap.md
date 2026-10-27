# Roadmap

Phases in delivery order, smallest useful slice first. Each phase has a
definition of done a tester can check. Ids refer to
[requirements.md](requirements.md) and [technical-design.md](technical-design.md).

The brief's expected order (scoreboard, pairing + recording, Mac burn-in, live
burn-in) is kept, with one addition: a short phase 0 that tests the browser
assumptions the whole design rests on before any real code is written.

## Phase 0: device spike (1 to 2 evenings)

Throwaway HTML pages served over HTTPS (technical-design.md §11), run on the
actual phones from D1. No app code is kept.

Checks: assumptions A1 to A12 in technical-design.md §9.

**Done when** a table in `docs/device-tests.md` records pass/fail per phone
for each assumption, D1 and D13 are answered from the results, and any
"fail" has a chosen mitigation written next to it. If A1 and A2 both fail on
every network tried, stop and revisit D2 before phase 2.

## Phase 1: single-phone scoreboard

Scope: role screen S0, setup S1, scoreboard S3 with overlays S3a to S3c,
correction S4, menu S5, speech and sounds, persistence, PWA install, Vercel
deployment. No camera, no pairing.

Requirements: R-SETUP-1 to 3, R-SCORE-1 to 9, R-DISP-1 to 8, N-BROWSER-1,
N-OFFLINE-1 (shell only), N-LAT-1.

**Done when**

- Engine tests pass for 11/15/21-point formats, including deuce, cap, the
  interval at 11, side changes, server after a game, undo across a game
  boundary, and replay determinism.
- A full best-of-3 match is scored on the phone at the net post by someone
  who has not seen the app, with no help, and the final score matches the
  players' count.
- Kill and relaunch mid-game restores the state (R-SCORE-9).
- The app installs to the Home Screen from the Vercel URL and runs offline on
  the next launch.
- Spoken score and flash are confirmed audible/visible from the far service
  line.

## Phase 2: pairing, recording, export

Scope: pairing S2/C2 with QR, data-channel protocol with sync and clock
offset, camera screens C1/C3/C4, OPFS recording worker, segments and
interruption handling, storage estimate, wake lock, share/download export,
remote REC (D11).

Requirements: R-SETUP-4, R-DISP-9, R-PAIR-1 to 7, R-REC-1 to 7, R-EXP-1 to 3,
R-BURN-1, N-STORE-1, N-POWER-1, N-PRIV-1, N-RES-1.

**Done when**

- Pairing succeeds on a phone hotspot with mobile data off, in under 30 s,
  three times in a row.
- A 60-minute soak: recording runs, pings run, the link stays up (or every
  drop is recovered by re-pair with no lost event), the phone stays under
  thermal throttling or the 720p setting is documented as required.
- Disconnect, score five points, reconnect: the camera's `match.json` has the
  five events with sane `tRec` values (R-PAIR-4, R-PAIR-5).
- A forced interruption (phone call) yields two playable segments.
- The exported bundle lands on the Mac Studio via AirDrop (or Files on
  Android) and plays after `ffmpeg -c copy -movflags +faststart`.
- `match.json` validates against the §8 shape and replays to the final score.

## Phase 3: Mac-side burn-in tool

Scope: `tools/burnin` (TypeScript, runs with the Node already used by the
captain's other projects): remux, state extraction, HTML overlay template
rendered by Puppeteer, overlay movie via concat, composite with
`h264_videotoolbox`. The same HTML template is reused by the camera preview.

Requirements: R-BURN-2.

**Done when**

- One command turns a phase-2 bundle into an MP4 with the scoreboard
  composited; score changes land within 5 frames of the tap (checked against
  the clap test from A8).
- A WebM bundle from Android goes through the same command.
- A match with two segments produces two outputs without manual steps.
- The output imports into DaVinci Resolve as an ordinary H.264 clip.

## Phase 4: live burn-in and extras

Only after phases 1 to 3 have been used for real matches.

- **Live burn-in on the camera phone** (path A, R-BURN-3): canvas compositing
  with the shared HTML overlay, as an opt-in "share from the court" mode.
  Done when a 30-minute live-composited recording plays correctly and the
  phone's temperature stays acceptable.
- **Hosted signaling helper** (D2(b)) if phase 2's soak shows frequent link
  drops: Vercel function + store, one-scan pairing, automatic reconnect, with
  the two-QR path kept as the offline fallback.
- **STUN fallback** (D13(b)) if A1/A2 showed LAN-only failures on some
  networks.

## Later (not scheduled)

Follow-ups noticed while designing, kept out of v1 on purpose:

- Tappable HTML mockup of S3 for trying tap-zone sizes and colours before
  phase 1 (useful if the captain wants to feel the layout first; the ASCII
  wireframes are the current substitute).
- Small live camera preview on the scoreboard phone (needs a media track on
  the channel; today it is data only).
- Third phone as a sideline remote through the same protocol.
- Automatic highlight cuts at point boundaries from the event log (the data
  is already in `match.json`).
- Per-player service tracking for doubles (D4(b)).
- On-phone clip export with ffmpeg.wasm (path B) for short highlights.
- Transparent overlay export (ProRes 4444) for use directly in DaVinci Resolve
  instead of a composited MP4.
- Direct transfer of the bundle to the Mac over the LAN instead of AirDrop.
- Firefox support (Web Share with files and barcode detection are missing).
- IndexedDB fallback for recording (D10(b)) if a supported browser turns out
  to lack OPFS.
