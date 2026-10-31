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

## D16: point replays and the post-match pass

The captain's picks are in requirements.md D16 and
data/badminton-replay-research/report.md section 11. Four slices, each its
own PR:

1. **Marks** (PR 12, merged): "☆ Replay" after a point and the rally list's
   stars, `replay` / `replay.clear` events, the 5 s window rule, each
   segment's first composited frame, `replays` in `match.json` (R-REP-1 to 4).
2. **Speed test on the captain's iPhone**: a page that renders a recorded
   clip full length on the phone, so the post-match pass is sized on the
   device before it is built.
3. **Post-match renderer on the camera phone** (PR 16, merged; WebCodecs through
   Mediabunny): one pass inserts every replay inline with the BWF card spin,
   the frozen panel with REPLAY ×0.5 and the real sound after the point, and
   burns the stats table and summary card from tags added after the match
   (counted back at their point's time); wake lock, resumable in segments,
   free-space check.
4. **Studio screen** (PR 17, merged): watch the clip, jump per point, tag
   in place, ★ any point, adjust each replay (start ±1 s, end ±1 s, ×0.5 /
   ×0.75 / ×1), render; keyboard shortcuts.
5. **Studio, design B** (this slice; the captain's pick of three, "เอาแบบ B"):
   watch full screen with the whole match laid over the video; focus on a
   point with a zoomed lane and draggable knobs on the replay's ends; the
   points list as a sheet; landscape only.

## Later (not scheduled)

- **Mac-side re-render tool** (R-BURN-2): paints a new overlay over the box
  recorded in `match.json`; can change the look, not reveal what was under
  the live overlay. Also a raw + composited dual recording if that ever
  matters.
- **Offline two-QR pairing** as a fallback for courts with no internet at
  all: the handshake is designed (technical-design.md §4.6) but adds a second
  scan and manual re-pairing after drops.
- Small live camera preview on the scoreboard phone (needs a media track on
  the channel; today it is data only).
- Third phone as a sideline remote through the same protocol.
- Automatic highlight cuts at point boundaries from the event log (the data
  is already in `match.json`).
- On-phone clip trimming / export of short highlights (D16's post-match pass
  uses WebCodecs through Mediabunny; ffmpeg.wasm was measured 2–5× slower and
  32 MB, data/badminton-replay-research/report.md §3F).
- Android support (Chrome 126+ has the APIs; untested, WebM/MP4 differences).
- Firefox support (Web Share with files and barcode detection are missing).
- IndexedDB fallback for recording (D10) if a supported browser turns out to
  lack OPFS.
