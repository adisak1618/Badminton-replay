# Requirements

Design-phase requirements for a browser-only badminton scoreboard that records
the match on a second phone and timestamps every point so the score can be
burned into the video later. Companion docs: [ux-design.md](ux-design.md),
[technical-design.md](technical-design.md), [roadmap.md](roadmap.md).

Requirement ids (`R-AREA-n`, `N-AREA-n`) are referenced from the other docs.
Open choices live only in the section below.

## Decisions needed

Each bullet is a choice the captain must make before implementation. The
recommended default is marked. Everything else in the docs assumes the default.

- **D1 Phones.** Which two phones and OS versions will be used? The docs assume
  two iPhones on iOS 18.4+ (Wake Lock works in installed web apps from 18.4,
  see N-BROWSER-1). If one phone is Android, Chrome 126+ is assumed. The phone
  models decide codec, storage and the device-test list in the roadmap.
- **D2 Pairing.** (a) *Recommended:* offline handshake, two QR scans, no server
  at all. (b) Hosted signaling helper on Vercel (serverless function + a tiny
  store): one scan and automatic reconnection, but needs internet on both
  phones and adds infrastructure. (c) Third-party signaling (PeerJS cloud):
  least code, external dependency. Comparison in technical-design.md §4.
- **D3 Stack.** (a) *Recommended:* Vite + React + TypeScript + Tailwind v4 +
  vite-plugin-pwa, pnpm, Vitest. (b) Next.js as on story-platform: familiar
  but overkill here (no server rendering, no routes to speak of). Rationale in
  technical-design.md §2.
- **D4 Server indicator depth.** (a) *Recommended:* which team serves plus the
  service court (right when the server's score is even, left when odd). (b)
  Also which player serves in doubles. (b) needs the players' court positions,
  which means extra taps, and breaks "tap anywhere in your zone".
- **D5 Spoken score.** (a) *Recommended:* on by default, English umpire style
  ("twelve, nine", server's score first) because English voices are always
  installed. (b) Thai voice. (c) No speech, sound effect only. Language is a
  setting either way; this decides the default.
- **D6 Undo gesture.** (a) *Recommended:* a visible Undo button in the centre
  band plus swipe-down as a shortcut. (b) Swipe-down only (the starting point).
  Swipes on a wet screen are unreliable and undiscoverable; see ux-design.md §5.
- **D7 Audio in the recording.** (a) *Recommended:* record the microphone
  (court sound, and the spoken score lands in the video). (b) Video only.
- **D8 Default recording quality.** (a) *Recommended:* 1080p30 at about
  6 Mbit/s H.264, roughly 2.7 GB per hour. (b) 720p30 at about 3 Mbit/s,
  roughly 1.4 GB per hour. Both are selectable; this is the default.
- **D9 Burn-in path for v1.** (a) *Recommended:* on the Mac Studio, an HTML
  scoreboard rendered to one PNG per score state and composited with ffmpeg.
  (b) ffmpeg `drawtext` only, no HTML rendering, plainer look. (c) On the
  phone with ffmpeg.wasm (short clips only). (d) Live canvas compositing while
  recording. Trade-offs in technical-design.md §7.
- **D10 Storage fallback.** (a) *Recommended:* OPFS only; refuse to record in
  browsers without it (private browsing, old Firefox) with a clear message.
  (b) Also implement an IndexedDB chunk fallback. With the minimum versions in
  N-BROWSER-1 every supported browser has OPFS, so (b) only serves private
  browsing and costs a second write path to test.
- **D11 Remote REC control.** (a) *Recommended:* the scoreboard phone can start
  and stop recording on the camera phone, because the camera stands in the far
  corner and the players stand at the net. (b) REC only on the camera phone.
- **D12 Match formats in v1.** (a) *Recommended:* points to win 11/15/21, win
  by 2 with a cap, best of 1 or 3, interval on/off. Default 21, cap 30, best
  of 3. (b) BWF 21 × best of 3 only.
- **D13 STUN fallback.** (a) *Recommended:* none in v1; the two phones connect
  over the local network only. (b) Add a public STUN server so the phones can
  also connect through the mobile network when the LAN blocks peer traffic.
  Decide after the phase-0 device test in roadmap.md.

## Goals

- Film a casual badminton match with one phone and show a large, tappable
  scoreboard on a second phone at the net post.
- Apply badminton scoring rules so nobody has to remember the score, the
  server, or when to change ends.
- Log every point with a timestamp on the recording's timeline so the score
  can be burned into the video afterwards (or live, later).
- Run entirely in the browser as an installable web app, hosted on Vercel,
  with no backend that ever sees video or scores.

## Non-goals

- Replacing a tournament scoring system, umpire workflows, or BWF-grade
  service-fault judgement.
- Streaming the match anywhere. Everything stays on the two phones until the
  user exports it.
- Automatic point detection from the video. A human taps.
- Editing the video on the phone (trimming, highlights). See roadmap.md.

## Usage scenario

Two players (or two pairs) on a court. The captain brings two phones:

- **Camera phone** on a small tripod at the back corner of the court, in
  landscape, framing the whole court. Started once, then untouched. May be
  plugged into a power bank.
- **Scoreboard phone** propped on the net post in landscape, screen facing
  along the net so each side of the court sees "its" half of the screen.
  Whoever wins the rally walks to the post and taps their half.

Conditions the design must survive: sweaty or wet fingers, players glancing
from 6 m away, gym lighting or outdoor glare, 60 to 90 minutes of play, no
Wi-Fi except possibly one phone's hotspot, no mobile signal indoors, players
who have never seen the app. Nobody wants to read instructions mid-match.

### Device roles

| Role | Does | Must never |
|---|---|---|
| Scoreboard phone | Match setup, scoring, rules, announcements, source of truth for the score log, shows camera/link status, can start/stop REC remotely (D11) | Lose a point when the link drops |
| Camera phone | Records to its own storage, shows the live score on its preview, timestamps every received event on the recording timeline, exports the bundle | Need a touch during the match |

Either phone can take either role; the role is chosen at launch (R-SETUP-1).

## Functional requirements

Each requirement has an acceptance criterion a tester can check on real phones.

### Match setup (R-SETUP)

- **R-SETUP-1 Role choice.** First screen offers Scoreboard or Camera; the
  choice is remembered and offered as the default next launch. *Accept:* launch
  twice; the second launch pre-selects the previous role.
- **R-SETUP-2 Match configuration.** Team names, team colours (from a fixed
  palette with enough contrast on the dark background), format per D12, who
  serves first, which team starts on the left of the scoreboard screen.
  *Accept:* every setting is reflected on the scoreboard and in `match.json`.
- **R-SETUP-3 One-tap start.** A "same as last time" preset starts a match
  with the previous settings in one tap; names default to "A" and "B" on a
  fresh install. *Accept:* from launch to a scoring-ready scoreboard in at most
  three taps.
- **R-SETUP-4 Camera settings.** Quality (D8), audio on/off (D7), overlay
  mirror toggle (R-REC-4), and the remaining recordable minutes shown before
  REC (R-REC-3). *Accept:* changing quality changes the minutes estimate.

### Scoring and rules (R-SCORE)

Rules follow the BWF Laws of Badminton, Laws 7 (scoring), 8 (change of ends),
10 and 11 (service courts) and 16.2 (intervals), as published in the BWF Statutes
(https://corporate.bwfbadminton.com/statutes/).

- **R-SCORE-1 Rally point.** A tap on a team's zone gives that team one point
  and makes it the server. A game is won at the configured points with a
  two-point lead, or at the cap (21 / 30 by default). *Accept:* 20-20 needs
  22-20; 29-29 ends at 30-29.
- **R-SCORE-2 Games and match.** Best of N games; the game winner serves first
  in the next game; the match ends when a team has won the majority. *Accept:*
  a 2-0 match ends after game 2; a 1-1 match goes to game 3.
- **R-SCORE-3 Server and service court.** The serving team and the service
  court (right when the server's score is even, left when odd) are derived and
  shown (D4). *Accept:* after 3-2 with A serving, A serves from the left court.
- **R-SCORE-4 Intervals.** When the leading score first reaches 11 in a game,
  and between games, the scoreboard shows a dismissable interval prompt with a
  countdown (60 s / 120 s). The prompt never swallows more than one tap, and
  it never changes the score. *Accept:* at 11-7 the prompt appears; one tap
  dismisses it; the next tap scores.
- **R-SCORE-5 Side changes.** Ends change after every game and, in the
  deciding game, when the leading score reaches 11. The tap zones swap so each
  team keeps tapping the half nearest its end of the court. *Accept:* the
  colours swap sides exactly at those moments and nowhere else.
- **R-SCORE-6 Undo and redo.** Undo removes the last scoring action, any
  number of times, including across a game boundary. Redo restores the last
  undone action until a new point is scored. *Accept:* score 21-19 game won,
  undo, score is 20-19 in the same game.
- **R-SCORE-7 Correction.** The user can set both scores, the server, and the
  sides directly. *Accept:* set 15-15 with B serving mid-game; later points
  continue from there and the log records the correction.
- **R-SCORE-8 Event log.** Every action is an append-only event with a
  wall-clock timestamp; the full match state is derivable by replaying the log.
  *Accept:* replaying `match.json` reproduces the final score shown on screen.
- **R-SCORE-9 Resume.** The live match survives a reload, a crash, or a
  battery swap on the scoreboard phone. *Accept:* kill the tab mid-game,
  reopen, the same score and server are shown.

### Scoreboard display (R-DISP)

- **R-DISP-1 Two tap zones.** Landscape; the screen is split into two zones,
  each at least 40 % of the width and the full height minus a centre band for
  Undo/menu. Tapping anywhere in a zone scores for that team. *Accept:* taps
  at all four corners of each zone register as that team.
- **R-DISP-2 Legibility.** Score digits are at least 35 % of the screen
  height, drawn in the team colour on a dark background; the serving indicator
  and game count are readable from 6 m. *Accept:* read the score from the far
  service line on an iPhone-sized screen.
- **R-DISP-3 Feedback.** A point gives a colour flash within 100 ms, a short
  sound, the spoken score (D5), and a vibration where the platform supports it
  (Android only, N-BROWSER-1). *Accept:* with the screen out of sight the
  player can hear who scored and the new score.
- **R-DISP-4 Server indicator.** The serving team and service court are shown
  without text that needs reading at distance (shuttle icon on the serving
  half; court side as a small marker). *Accept:* visible change on service
  over.
- **R-DISP-5 Game state.** Games won, current game number, "game point" and
  "match point" flags. *Accept:* at 20-15 in game 1 "game point" shows on A.
- **R-DISP-6 Touch guards.** A point needs a single short touch (30 to 400 ms,
  little movement); multi-finger touches and touches shorter than 30 ms are
  ignored; a second point within 800 ms is ignored. *Accept:* a palm press or
  a double tap scores at most one point.
- **R-DISP-7 Orientation.** In portrait the scoreboard shows a "rotate the
  phone" screen instead of a cramped layout. On Android the installed app
  locks to landscape; iOS cannot lock orientation (N-BROWSER-1). *Accept:*
  rotate to portrait mid-match, score is preserved, rotating back restores it.
- **R-DISP-8 Screen stays on.** While a match is live the screen never sleeps
  (Wake Lock). *Accept:* 10 minutes without touching, the screen is still on.
- **R-DISP-9 Link status.** Both phones show the link state (paired, syncing,
  disconnected) and the camera's REC state in one small chip. *Accept:* turn
  off Wi-Fi on one phone; both chips turn to "disconnected" within 10 s.

### Pairing and sync (R-PAIR)

- **R-PAIR-1 Serverless pairing.** The two phones pair on the same Wi-Fi or a
  phone hotspot with no internet and no server (D2). *Accept:* airplane mode
  plus hotspot, pairing succeeds.
- **R-PAIR-2 Latency.** A point tapped on the scoreboard appears on the camera
  overlay within 200 ms on a LAN. *Accept:* film both screens with a third
  phone at 60 fps; fewer than 12 frames apart.
- **R-PAIR-3 Scoreboard works alone.** All scoring works with no camera phone
  paired or after the link drops; nothing blocks on the link. *Accept:* play a
  whole game unpaired.
- **R-PAIR-4 Resync.** On connect or reconnect the camera phone receives the
  full event log and ends up with exactly the scoreboard's state; no point is
  lost or duplicated. *Accept:* disconnect, score five points, reconnect;
  the camera overlay shows the same score and `match.json` has five events.
- **R-PAIR-5 Clock offset.** The clock offset between phones is measured over
  the link so each event gets a recording-relative time within ±150 ms of the
  moment the tap happened. *Accept:* clap in front of the camera while tapping;
  the burn-in change is within 5 frames of the clap at 30 fps.
- **R-PAIR-6 Remote REC.** The scoreboard phone can start and stop recording
  on the camera phone (D11). *Accept:* tap REC at the net; the camera phone
  starts within 1 s and reports its state back.
- **R-PAIR-7 Versioning.** Messages carry a protocol version; a mismatch shows
  "update the app on the other phone" instead of failing silently. *Accept:*
  pair an old build with a new one.

### Recording and storage (R-REC)

- **R-REC-1 Capture.** Rear camera, 1080p30 or 720p30 (D8), with audio per D7,
  H.264 in MP4 wherever the browser offers it, WebM otherwise. *Accept:* the
  exported file plays in QuickTime (MP4) or VLC (WebM) on the Mac.
- **R-REC-2 Continuous write.** Recorded data is written to the phone's origin
  private file system (OPFS) at least once per second while recording, so a
  crash loses at most a second. *Accept:* kill the app at 10 minutes; a file
  with roughly 10 minutes of playable video remains and is listed.
- **R-REC-3 Storage estimate.** Before REC the app shows the remaining
  recordable minutes at the chosen quality; it warns below 10 minutes and stops
  cleanly, keeping everything written, when the quota is hit. *Accept:* fill
  the phone; recording stops with a message and the file is intact.
- **R-REC-4 Live overlay.** The camera preview shows the live score in the same
  layout the burn-in will use, with a mirror toggle so left/right match the
  camera's view. *Accept:* the team on the left of the frame is shown on the
  left of the overlay after the toggle is set once.
- **R-REC-5 Wake lock and interruptions.** The screen stays on while
  recording. If the camera track ends (phone call, screen lock, app switch),
  the current segment is finalised, the user is told, and one tap starts a new
  segment of the same match. *Accept:* take a call; afterwards two segments
  exist and both play.
- **R-REC-6 Persistence.** Recordings and match logs stay on the phone across
  app restarts until deleted; a list shows them with size and duration.
  *Accept:* record, close the app, reopen a day later, the match is listed.
- **R-REC-7 Guarded stop.** Stopping needs a deliberate action (press and hold
  or confirm). *Accept:* a single tap on the preview does not stop recording.

### Export (R-EXP)

- **R-EXP-1 Bundle.** An export is the video segment(s) plus one `match.json`
  (schema in technical-design.md §8). *Accept:* the Mac-side tool consumes the
  bundle with no manual edits.
- **R-EXP-2 Share.** Export goes through the system share sheet (Photos,
  AirDrop, Files, Drive) and falls back to a download. *Accept:* on iPhone,
  AirDrop the bundle to the Mac Studio; on Android, share to Files.
- **R-EXP-3 Delete.** After export the user can delete the match from the
  phone and sees storage usage before and after. *Accept:* usage drops by the
  file size.

### Burn-in (R-BURN)

- **R-BURN-1 Self-contained log.** `match.json` carries everything burn-in
  needs: config, events with recording-relative times, the derived state after
  each event, segment start times, and which team was on the camera's left at
  every moment. *Accept:* the Mac tool never needs the phones again.
- **R-BURN-2 Mac tool.** A command on the Mac turns a bundle into an MP4 with
  the scoreboard composited (phase 3 in roadmap.md). *Accept:* the score in the
  output changes within 5 frames of the tap.
- **R-BURN-3 Live mode (later).** The camera phone can composite the overlay
  while recording for "share from the court" use (phase 4).

## Non-functional requirements

- **N-BROWSER-1 Supported browsers.** iPhone: Safari on iOS 17 or later when
  run as a Safari tab, iOS 18.4 or later when installed to the Home Screen
  (the Wake Lock API did not work in installed iOS web apps before 18.4, WebKit
  bug 254545, fixed 2025-03-31). Android: Chrome 126 or later (MP4 recording
  arrived in Chrome 126; OPFS and Wake Lock are older). Not supported in v1:
  Firefox (no file sharing in Web Share, no barcode detection), third-party
  browsers on iOS (WKWebView, separate limits), desktop. Unsupported browsers
  see a message naming the supported ones. Per-API evidence is tabulated in
  technical-design.md §9.
- **N-OFFLINE-1 Offline.** After the first visit the app loads and pairs with
  no internet (service worker caches the shell; pairing per D2). Only
  installation and updates need the network.
- **N-STORE-1 Storage.** Safari 17+ and Chrome allow an origin up to about 60 %
  of total disk, evict whole origins least-recently-used under pressure, and
  grant `navigator.storage.persist()` by heuristics (installed Home Screen app
  counts in WebKit). Safari deletes script-written storage after 7 days of
  Safari use without a visit, but installed Home Screen apps keep their own
  counter and are not expected to lose data. The app requests persistence,
  shows whether it was granted, and tells the user to export promptly.
  Sources in technical-design.md §9.
- **N-POWER-1 Battery and heat.** A 90-minute match with the screen on must be
  possible on battery for the scoreboard phone; the camera phone is expected
  to be plugged in at 1080p. Measured consumption is a phase-0 output.
- **N-PRIV-1 Privacy.** No video, audio, score, or name ever leaves the two
  phones except through an export the user triggers. No analytics, no
  accounts, no server-side storage. The only server is Vercel serving static
  files (and the optional signaling helper if D2(b) is chosen, which sees
  connection descriptors but never match data).
- **N-LAT-1 Responsiveness.** Tap to visual feedback under 100 ms; tap to the
  camera overlay under 200 ms (R-PAIR-2); undo under 100 ms.
- **N-RES-1 Resilience.** No single tap, reload, link drop, or OS interruption
  loses more than one second of video or any scoring event.

## Out of scope for v1

- Live burn-in on the phone (R-BURN-3), on-phone transcoding, highlights,
  automatic clip cutting at point boundaries.
- Per-player service tracking in doubles (D4(b)), service faults, lets,
  challenges, timeouts beyond the standard intervals.
- A third phone as a remote, or a live camera preview on the scoreboard phone.
- Multi-match tournaments, player profiles, statistics, history sync between
  phones, cloud backup.
- Any backend beyond static hosting (and the optional signaling helper).
