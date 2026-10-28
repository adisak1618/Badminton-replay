# Roadmap

Phases in delivery order, smallest useful slice first. Each phase has a
definition of done a tester can check. Ids refer to
[requirements.md](requirements.md) and [technical-design.md](technical-design.md).

Order: a short device spike (phase 0), the single-phone scoreboard (1),
pairing plus live-composited recording and export (2), then hardening on real
matches (3). The Mac-side re-render tool is under Later, per D9.

## Phase 0: device spike (2 to 3 evenings)

Throwaway HTML pages served over HTTPS (technical-design.md §11), run on the
actual iPhones (D1). No app code is kept.

Checks: assumptions A1 to A14 in technical-design.md §9. The ones the whole
design rests on, in priority order:

1. **Sustained canvas capture** (A4, A13, A14): camera → canvas → overlay →
   `captureStream` + microphone → MediaRecorder → OPFS for 60 minutes at
   1080p30 and at 720p30 on the actual iPhone: dropped frames (ffprobe frame
   count against wall time), gaps, audio/video drift at the end (clap),
   temperature, battery, and whether the file is playable and remuxable.
2. **LAN WebRTC** after pairing through a stub helper (A1, A2): same Wi-Fi and
   phone hotspot; host candidates after the scan's camera track is stopped;
   any iOS local-network prompt.
3. Installed-app behaviour on the actual iOS version (A11): camera in
   standalone mode, Wake Lock, `persist()`.
4. Share sheet with a 2 GB file (A5), speech on the silent switch (A9),
   recorder start latency (A8).

**Done when** a table in `docs/device-tests.md` records pass/fail per check
with numbers (fps, °C, % battery), and any "fail" has a chosen mitigation
written next to it. If 1 fails at both qualities, stop and revisit D9 before
phase 2. If 2 fails on every network tried, revisit D13 before phase 2.

## Phase 1: single-phone scoreboard

Scope: role screen S0, setup S1 (singles/doubles, players, starting courts,
formats), scoreboard S3 with overlays S3a to S3c, correction S4, menu S5,
speech and sounds, persistence, PWA install, Vercel deployment of the static
app. No camera, no pairing, no helper.

Requirements: R-SETUP-1 to 3, R-SCORE-1 to 9, R-DISP-1 to 8, N-BROWSER-1,
N-OFFLINE-1 (shell only), N-LAT-1.

**Done when**

- Engine tests pass for 11/15/21 points and all three formats: deuce, cap,
  the interval at 11, side changes incl. the deciding game and fixed-1 game at
  11 and none in fixed 2, the fixed-2 draw, server after a game, doubles
  positions through the R-SCORE-3 sequence, server/receiver choice at a game
  start, swap courts, undo across a game boundary, replay determinism.
- A full doubles best-of-3 match is scored on the phone at the net post by
  people who have not seen the app, with no help, and the final score and
  server match the players' own count.
- Kill and relaunch mid-game restores the state (R-SCORE-9).
- The app installs to the Home Screen from the Vercel URL and runs offline on
  the next launch.
- Spoken score and flash are confirmed audible and visible from the far
  service line.

## Phase 2: pairing, live-composited recording, export

Scope: the signaling helper (function + Redis), pairing S2/C2 with QR and
typed code, automatic reconnect, data-channel protocol with sync and clock
offset, camera screens C1/C3/C4, the compositing pipeline, OPFS recording
worker, segments and interruption handling, storage estimate, wake lock,
share/download export, remote REC (D11), overlay delay setting.

Requirements: R-SETUP-4, R-DISP-9, R-PAIR-1 to 9, R-REC-1 to 8, R-EXP-1 to 3,
R-BURN-1, N-STORE-1, N-POWER-1, N-PRIV-1, N-RES-1.

**Done when**

- Pairing succeeds on a phone hotspot with mobile data on, in under 30 s,
  three times in a row; with data off the "no internet" message appears.
- A 60-minute soak at 1080p30 with pairing active: the composited recording
  meets R-REC-8 (fps, gaps, drift), the link survives or every drop is
  recovered automatically with no lost event, and the phone's temperature and
  battery are recorded (or 720p is documented as the required default).
- Airplane mode for 20 s on the camera phone: the link is back within 15 s of
  airplane mode ending and `match.json` has every event with sane `tRec`
  values (R-PAIR-4, R-PAIR-5, R-PAIR-8).
- A forced interruption (phone call) yields two playable segments.
- The finished clip saves to Photos from the share sheet and the bundle lands
  on the Mac Studio via AirDrop; the clip plays in QuickTime with the score
  visible and `match.json` replays to the final score.
- The helper's store holds only expiring room and session keys (R-PAIR-9).

## Phase 3: real-match hardening

Scope: use the app for at least three real matches, then fix what they show.
Expected items: overlay look and placement, the overlay delay default, speech
phrasing, touch guard thresholds, reconnect timing, thermal behaviour, Guided
Access tip, export ergonomics.

**Done when** three real matches have been recorded end to end with the
finished clips kept, each finding is either fixed or filed under Later, and
the overlay delay default is decided from the undo counts in the logs.

## Later (not scheduled)

- **Mac-side re-render tool** (R-BURN-2): paints a new overlay over the box
  recorded in `match.json`; can change the look, not reveal what was under
  the live overlay. Also a raw + composited dual recording if that ever
  matters.
- **Offline two-QR pairing** as a fallback for courts with no internet at
  all: the handshake is designed (technical-design.md §4.6) but adds a second
  scan and manual re-pairing after drops.
- **STUN fallback** (D13) if the phase-0 LAN tests fail on some networks.
- Small live camera preview on the scoreboard phone (needs a media track on
  the channel; today it is data only).
- Third phone as a sideline remote through the same protocol.
- Automatic highlight cuts at point boundaries from the event log (the data
  is already in `match.json`).
- On-phone clip trimming / export of short highlights (ffmpeg.wasm or
  MediaRecorder re-encode).
- Android support (Chrome 126+ has the APIs; untested, WebM/MP4 differences).
- Firefox support (Web Share with files and barcode detection are missing).
- IndexedDB fallback for recording (D10) if a supported browser turns out to
  lack OPFS.
