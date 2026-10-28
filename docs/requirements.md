# Requirements

Requirements for a browser-only badminton scoreboard that records the match on
a second phone with the score composited into the video while it is recorded.
Companion docs: [ux-design.md](ux-design.md),
[technical-design.md](technical-design.md), [roadmap.md](roadmap.md), and a
tappable rough UI at [mockup/index.html](mockup/index.html).

Requirement ids (`R-AREA-n`, `N-AREA-n`) are referenced from the other docs.

## Decisions

Answered by the captain on the review board on 2026-10-28. Each item states the
chosen option, the captain's words where given, and the consequence. The rest
of the docs assume these.

- **D1 Phones: iPhone 13 and newer, iOS.** Captain: "เน้นเป็น IOS iphone 13
  ขึ้นไป". Consequence: both roles target Safari on iOS; iOS 18.4 or later when
  installed to the Home Screen (Wake Lock, N-BROWSER-1), iOS 17 in a Safari tab;
  output is H.264 MP4 only. Android is not a v1 target; it may work and is
  listed under Later in roadmap.md.
- **D2 Pairing: (b) signaling helper on Vercel.** One scan (or a typed code) and
  automatic reconnection. Consequence: v1 has one serverless function and a
  Marketplace Redis store (technical-design.md §4); both phones need internet
  while pairing and reconnecting; the phones still talk to each other directly
  over the local network when they share one (otherwise through a TURN relay,
  D13), the helper only carries connection descriptors and relay credentials. With no
  internet on the court there is no pairing: the scoreboard scores alone and
  the camera records without the overlay (R-PAIR-1, R-PAIR-8). The offline
  two-QR handshake is documented as a later fallback, not v1 scope.
- **D3 Stack: (a) Vite + React + TypeScript + Tailwind v4 + vite-plugin-pwa,
  pnpm, Vitest.** The helper is one function under `api/` in the same repo.
- **D4 Server indicator: (b) which player serves in doubles.** Under the Laws
  of Badminton the positions are deterministic once the four players and their
  starting courts are known: players swap service courts only when their side
  scores while serving. Consequence: no extra tap per rally; setup asks for
  player names and who starts in the right court (R-SETUP-2); the scoreboard
  shows who serves from which court and who receives (R-SCORE-3, R-DISP-4); a
  correction control fixes the app when the court reality drifts (R-SCORE-7).
- **D5 Spoken score: (a) English umpire style by default**, Thai selectable.
- **D6 Undo: (a) visible button plus swipe-down.**
- **D7 Audio: (a) record the microphone.**
- **D8 Default quality: (a) 1080p30, about 6 Mbit/s, 720p30 selectable.**
- **D9 Burn-in: (d) live canvas compositing on the camera phone.** Captain: he
  wants the finished clip immediately after filming, no Mac step.
  Consequence: the overlay is drawn into every frame while recording and the
  exported file is the finished clip (R-REC-1, R-REC-4); a wrong tap is in the
  video until it is undone; no raw video is kept; `match.json` is still
  exported so a later re-render over the same overlay box stays possible
  (R-EXP-1, R-BURN-1); the Mac-side tool moves to Later; phase 0 must prove
  sustained canvas capture on the actual iPhone (R-REC-8, roadmap.md).
- **D10 Storage: (a) OPFS only**, no IndexedDB fallback.
- **D11 Remote REC: (a) the scoreboard phone starts and stops recording.**
- **D12 Formats: (a) 11/15/21 points; formats best of 3, fixed 2, fixed 1.**
  Captain: "อยากให้ support best of 3 และ fixed 2 sets และ fixed 1 sets".
  Definitions in R-SCORE-2: best of 3 is first to two games; fixed 2 always
  plays two games, 2-0 is a win and 1-1 is a draw reported with the game
  scores and total points; fixed 1 is a single game. Ends change at 11 in a
  one-game match and in the third game, never mid-game in fixed 2.
- **D13 STUN: (a) none in v1**, revised on 2026-10-28 after the first
  production test, where both iPhones were on mobile data and could never
  connect: the link now also offers STUN and a TURN relay (Cloudflare Realtime
  TURN; the helper mints credentials valid for an hour, technical-design.md
  §4.2). The direct local-network path is still chosen whenever both phones
  share a network; without a TURN key on the helper the data path is local
  network only, as before.
- The captain also asked to see a rough UI before implementation starts:
  [mockup/index.html](mockup/index.html), described in ux-design.md §6.

## Goals

- Film a casual badminton match with one phone and show a large, tappable
  scoreboard on a second phone at the net post.
- Apply badminton scoring rules so nobody has to remember the score, who
  serves from where, or when to change ends.
- Composite the score into the video while recording, so the finished clip is
  on the phone the moment the match ends.
- Log every point with a timestamp on the recording so the overlay could be
  re-rendered later if wanted.
- Run as an installable web app hosted on Vercel; no server ever sees video or
  scores.

## Non-goals

- Replacing a tournament scoring system, umpire workflows, or BWF-grade
  service-fault judgement.
- Streaming the match anywhere. Video stays on the camera phone until the user
  exports it.
- Automatic point detection from the video. A human taps.
- Editing the video on the phone (trimming, highlights). See roadmap.md.

## Usage scenario

Two players (singles) or two pairs (doubles) on a court. The captain brings two
iPhones:

- **Camera phone** on a small tripod at the back corner of the court, in
  landscape, framing the whole court, plugged into a power bank. Started once
  from the net post, then untouched.
- **Scoreboard phone** propped on the net post in landscape, screen facing
  along the net so each side of the court sees "its" half of the screen.
  Whoever wins the rally walks to the post and taps their half.

Conditions the design must survive: sweaty or wet fingers, players glancing
from 6 m away, gym lighting or outdoor glare, 60 to 90 minutes of play, one
phone's hotspot as the only network, weak mobile signal indoors, players who
have never seen the app. Nobody wants to read instructions mid-match.

### Device roles

| Role | Does | Must never |
|---|---|---|
| Scoreboard phone | Match setup, scoring, rules, announcements, source of truth for the score log, shows link and REC state, starts and stops REC remotely (D11), can export its own log | Lose a point when the link drops |
| Camera phone | Composites the live overlay into the recording, writes to its own storage, timestamps every received event on the recording timeline, exports the finished clip plus `match.json` | Need a touch during the match |

Either phone can take either role; the role is chosen at launch (R-SETUP-1).

## Functional requirements

Each requirement has an acceptance criterion a tester can check on real phones.

### Match setup (R-SETUP)

- **R-SETUP-1 Role choice.** First screen offers Scoreboard or Camera; the
  choice is remembered and offered as the default next launch. *Accept:* launch
  twice; the second launch pre-selects the previous role.
- **R-SETUP-2 Match configuration.** Team names and colours (fixed palette with
  enough contrast on the dark background); singles or doubles; in doubles the
  two player names per team and which of them starts in the right service
  court (D4); points to win and format (D12); which team serves first; which
  team starts on the left of the scoreboard screen. *Accept:* every setting is
  reflected on the scoreboard and in `match.json`; at 0-0 the chosen right-court
  player of the serving team is shown as server and the right-court player of
  the other team as receiver.
- **R-SETUP-3 One-tap start.** A "same as last time" preset starts a match
  with the previous settings in one tap; a fresh install defaults to singles,
  "A" and "B", 21 points, best of 3. *Accept:* from launch to a scoring-ready
  scoreboard in at most three taps.
- **R-SETUP-4 Camera settings.** Quality (D8), audio on/off (D7), overlay
  mirror toggle (R-REC-4), and the remaining recordable minutes shown before
  REC (R-REC-3). *Accept:* changing quality changes the minutes estimate.

### Scoring and rules (R-SCORE)

Rules follow the BWF Laws of Badminton, Laws 7 (scoring), 8 (change of ends),
10 and 11 (singles and doubles service) and 16.2 (intervals), as published in
the BWF Statutes (https://corporate.bwfbadminton.com/statutes/).

- **R-SCORE-1 Rally point.** A tap on a team's zone gives that team one point
  and makes it the serving side. A game is won at the configured points with a
  two-point lead, or at the cap (21 / 30 by default; 11 / 20 and 15 / 24 for
  the short formats). *Accept:* 20-20 needs 22-20; 29-29 ends at 30-29.
- **R-SCORE-2 Formats (D12).** *Best of 3:* the match ends when a team has won
  two games. *Fixed 2:* exactly two games are played; 2-0 is a win; 1-1 is a
  draw, reported as "1-1" with both game scores and the total points, no
  tie-break. *Fixed 1:* one game. In every format the winner of a game serves
  first in the next game. *Accept:* in fixed 2 a 21-15, 15-21 match ends with
  "draw 1-1, points 36-36" and no winner; in best of 3 a 2-0 ends after game 2.
- **R-SCORE-3 Server, service court, receiver (D4).** *Singles:* the server
  serves from the right court when their score is even, left when odd. *Doubles:*
  at the start of a game the serving team's right-court player serves and the
  receiving team's right-court player receives; when the serving side wins a
  rally the same player serves again from the other court (the two serving
  players swap courts); when the receiving side wins it becomes the serving
  side, nobody moves, and its player standing in the court matching its score
  (right when even, left when odd) serves. The receiver is always the player
  diagonally opposite. *Accept:* A (Nok right, Pae left) vs B (Bank right, Tao
  left), A serves at 0-0: Nok serves from the right to Bank. A wins: 1-0, Nok
  serves from the left to Tao. B wins: 1-1, Tao (B's left court) serves to Nok.
- **R-SCORE-4 Intervals.** When the leading score first reaches 11 in a game,
  and between games, the scoreboard shows a dismissable interval prompt with a
  countdown (60 s / 120 s). The prompt never swallows more than one tap, and
  it never changes the score. *Accept:* at 11-7 the prompt appears; one tap
  dismisses it; the next tap scores.
- **R-SCORE-5 Side changes.** Ends change after every game, and when the
  leading score reaches 11 in the third game of a best of 3 or in the single
  game of fixed 1 (Law 8.1.3); never mid-game in fixed 2. The tap zones swap so
  each team keeps tapping the half nearest its end. *Accept:* the colours swap
  sides exactly at those moments and nowhere else.
- **R-SCORE-6 Undo and redo.** Undo removes the last scoring action, any
  number of times, including across a game boundary. Redo restores the last
  undone action until a new point is scored. *Accept:* score 21-19 game won,
  undo, score is 20-19 in the same game with the same positions.
- **R-SCORE-7 Correction.** The user can set both scores, games, the serving
  team and player, swap ends, and swap the two players' courts within a team
  when the court reality has drifted from the app. *Accept:* set 15-15 with
  Tao serving mid-game; later points continue from there and the log records
  the correction.
- **R-SCORE-8 Event log.** Every action is an append-only event with a
  wall-clock timestamp; the full match state, including positions, is
  derivable by replaying the log. *Accept:* replaying `match.json` reproduces
  the final score and positions shown on screen.
- **R-SCORE-9 Resume.** The live match survives a reload, a crash, or a
  battery swap on the scoreboard phone. *Accept:* kill the app mid-game,
  reopen, the same score, server and positions are shown.

### Scoreboard display (R-DISP)

- **R-DISP-1 Two tap zones.** Landscape; the screen is split into two zones,
  each at least 40 % of the width and the full height minus a centre band for
  Undo/menu. Tapping anywhere in a zone scores for that team. *Accept:* taps
  at all four corners of each zone register as that team.
- **R-DISP-2 Legibility.** Score digits are at least 35 % of the screen
  height, drawn in the team colour on a dark background; the serving marker
  and game count are readable from 6 m. *Accept:* read the score from the far
  service line on an iPhone-sized screen.
- **R-DISP-3 Feedback.** A point gives a colour flash within 100 ms, a short
  sound, and the spoken score (D5). No haptics: iOS Safari has no Vibration API
  (N-BROWSER-1). *Accept:* with the screen out of sight the player can hear who
  scored and the new score.
- **R-DISP-4 Server indicator.** Each half shows its team's two service courts
  as two cells with the player names, the serving player marked with a shuttle
  and the receiver marked, the cell nearest the scoreboard phone at the bottom
  (ux-design.md S3). Singles shows "serves from right/left". *Accept:* after
  the R-SCORE-3 sequence the cells show Tao with the shuttle and Nok as
  receiver.
- **R-DISP-5 Game state.** Games won, current game number, format, "game
  point" and "match point" flags (no match point can exist for a game that
  would end in a 1-1 draw). *Accept:* at 20-15 in game 1 "game point" shows on
  A; in fixed 2 at 1-0, 20-15 for B shows "game point", not "match point".
- **R-DISP-6 Touch guards.** A point needs a single short touch (30 to 400 ms,
  little movement); multi-finger touches and touches shorter than 30 ms are
  ignored; a second point within 800 ms is ignored. *Accept:* a palm press or
  a double tap scores at most one point.
- **R-DISP-7 Orientation.** In portrait the scoreboard shows a "rotate the
  phone" screen instead of a cramped layout; iOS cannot lock orientation.
  *Accept:* rotate to portrait mid-match, score is preserved, rotating back
  restores it.
- **R-DISP-8 Screen stays on.** While a match is live the screen never sleeps
  (Wake Lock). *Accept:* 10 minutes without touching, the screen is still on.
- **R-DISP-9 Link status.** Both phones show the link state (paired,
  reconnecting, offline) and the camera's REC state in one small chip.
  *Accept:* turn off Wi-Fi on one phone; both chips show "reconnecting" within
  10 s and "paired" again within 15 s of Wi-Fi returning.

### Pairing and sync (R-PAIR)

- **R-PAIR-1 Pairing through the helper (D2).** The camera phone shows a QR
  code and a six-digit room code; the scoreboard phone scans or types it; the
  phones then connect directly over the same Wi-Fi or hotspot, or through the
  TURN relay when they share no network (D13). Both phones need internet during
  pairing; a direct connection itself needs no internet, a relayed one does. With no
  internet the app says so and both roles keep working alone. *Accept:* on a
  phone hotspot with mobile data on, pairing completes in under 30 s; with
  mobile data off the screen says "no internet, cannot pair" within 5 s.
- **R-PAIR-2 Latency.** A point tapped on the scoreboard appears in the camera
  overlay within 200 ms. *Accept:* film both screens with a third phone at
  60 fps; fewer than 12 frames apart.
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
  the overlay change in the video is within 5 frames of the clap at 30 fps.
- **R-PAIR-6 Remote REC (D11).** The scoreboard phone starts and stops
  recording on the camera phone. *Accept:* tap REC at the net; the camera phone
  starts within 1 s and reports its state back.
- **R-PAIR-7 Versioning.** Messages carry a protocol version; a mismatch shows
  "update the app on the other phone" instead of failing silently. *Accept:*
  pair an old build with a new one.
- **R-PAIR-8 Automatic reconnect.** After a link drop the phones reconnect
  through the helper with no user action, within 15 s of the network being
  back, for the whole match. Without internet the chip shows "offline" and
  R-PAIR-3 applies. *Accept:* toggle airplane mode for 20 s on the camera
  phone; the link is back within 15 s of airplane mode ending.
- **R-PAIR-9 Helper holds nothing of value.** The helper stores only
  connection descriptors and a session secret, with short lifetimes (10 min
  for a room code, a few hours for a session); it never receives scores,
  names, or video. *Accept:* the function's store contains no key with match
  data after a match; keys expire on their own.

### Recording (R-REC)

- **R-REC-1 Capture and composite (D9).** Rear camera at 1080p30 or 720p30
  (D8) with the microphone (D7); every frame is composited with the live
  scoreboard overlay and encoded as H.264 in MP4. The exported file is the
  finished clip. *Accept:* the exported file plays in QuickTime with the score
  visible and changing at each point.
- **R-REC-2 Continuous write.** Recorded data is written to the phone's origin
  private file system (OPFS) at least once per second while recording, so a
  crash loses at most a second. *Accept:* kill the app at 10 minutes; a file
  with roughly 10 minutes of playable video remains and is listed.
- **R-REC-3 Storage estimate.** Before REC the app shows the remaining
  recordable minutes at the chosen quality; it warns below 10 minutes and stops
  cleanly, keeping everything written, when the quota is hit. *Accept:* fill
  the phone; recording stops with a message and the file is intact.
- **R-REC-4 Live overlay is the recording.** The camera preview shows exactly
  the composited frame being recorded, with a mirror toggle so left/right match
  the camera's view. A wrong tap is visible in the video from the tap until
  the undo; an optional overlay delay (0 to 3 s, default 0) lets quick undos
  never reach the video at the cost of the score changing that much later.
  Unpaired, no overlay is drawn. *Accept:* tap, undo after 2 s with delay 0:
  the video shows the wrong score for 2 s; with delay 3 s it never shows it.
- **R-REC-5 Wake lock and interruptions.** The screen stays on while
  recording. If the camera track ends (phone call, screen lock, app switch),
  the current segment is finalised, the user is told, and one tap starts a new
  segment of the same match. *Accept:* take a call; afterwards two segments
  exist and both play.
- **R-REC-6 Persistence.** Recordings and match logs stay on the phone across
  app restarts until deleted; a list shows them with size and duration.
  *Accept:* record, close the app, reopen a day later, the match is listed.
- **R-REC-7 Guarded stop.** Stopping needs a deliberate action (press and hold
  or confirm, or the remote command). *Accept:* a single tap on the preview
  does not stop recording.
- **R-REC-8 Sustained capture.** Over 60 minutes at the chosen quality the
  composited recording averages at least 29 fps with no gap over 100 ms, audio
  and video drift under 100 ms at the end, and the phone does not throttle to
  the point of dropping below that. *Accept:* ffprobe frame count on the
  exported file and a clap at minute 60 inspected in a video editor.

### Export (R-EXP)

- **R-EXP-1 Bundle.** An export is the composited video segment(s) plus one
  `match.json` (schema in technical-design.md §8). The scoreboard phone can
  export its own `match.json` without recording times, for an unpaired match.
  *Accept:* a later re-render tool could consume the bundle with no manual
  edits; the scoreboard's standalone export replays to the final score.
- **R-EXP-2 Share.** Export goes through the system share sheet (Photos,
  AirDrop, Files) and falls back to a download. *Accept:* save the clip to
  Photos and AirDrop the bundle to the Mac Studio.
- **R-EXP-3 Delete.** After export the user can delete the match from the
  phone and sees storage usage before and after. *Accept:* usage drops by the
  file size.

### Re-render (R-BURN)

- **R-BURN-1 Self-contained log.** `match.json` carries everything a later
  re-render needs: config with players, events with recording-relative times,
  the derived state after each event (including positions), segment start
  times, which team was on the camera's left at every moment, and the pixel
  box the live overlay occupied. *Accept:* the bundle is complete without the
  phones.
- **R-BURN-2 Later: Mac re-render.** A Mac-side tool that paints a new
  overlay over the same box is kept under Later in roadmap.md; it can change
  the look but cannot reveal what was behind the live overlay.

## Non-functional requirements

- **N-BROWSER-1 Supported browsers (D1).** iPhone 13 or newer. Safari on
  iOS 17 or later when run as a Safari tab; iOS 18.4 or later when installed
  to the Home Screen (the Wake Lock API did not work in installed iOS web apps
  before 18.4, WebKit bug 254545, fixed 2025-03-31). Not supported in v1:
  Android (untested; see roadmap.md Later), Firefox, third-party browsers on
  iOS, desktop. Unsupported browsers see a message naming the supported ones.
  Per-API evidence is tabulated in technical-design.md §9.
- **N-OFFLINE-1 Offline.** After the first visit the app loads with no
  internet (service worker caches the shell) and each role works alone.
  Pairing and reconnecting need internet on both phones (D2); the data path
  between the phones does not.
- **N-STORE-1 Storage.** Safari 17+ allows an origin up to about 60 % of total
  disk, evicts whole origins least-recently-used under pressure, and grants
  `navigator.storage.persist()` by heuristics (installed Home Screen app counts
  in WebKit). Safari deletes script-written storage after 7 days of Safari use
  without a visit, but installed Home Screen apps keep their own counter and
  are not expected to lose data. The app requests persistence, shows whether
  it was granted, and tells the user to export promptly. Sources in
  technical-design.md §9.
- **N-POWER-1 Battery and heat.** A 90-minute match with the screen on must be
  possible on battery for the scoreboard phone. The camera phone composites
  every frame and is expected to be plugged in; its consumption and
  temperature at 1080p30 and 720p30 are phase-0 outputs (R-REC-8).
- **N-PRIV-1 Privacy.** No video, audio, score, or name ever leaves the two
  phones except through an export the user triggers. No analytics, no
  accounts. Vercel serves static files and the signaling helper, which sees
  connection descriptors (local hostnames, certificate fingerprints) for
  minutes and nothing else (R-PAIR-9).
- **N-LAT-1 Responsiveness.** Tap to visual feedback under 100 ms; tap to the
  camera overlay under 200 ms (R-PAIR-2); undo under 100 ms.
- **N-RES-1 Resilience.** No single tap, reload, link drop, or OS interruption
  loses more than one second of video or any scoring event.

## Out of scope for v1

- Mac-side re-render tool (R-BURN-2), on-phone transcoding, highlights,
  automatic clip cutting at point boundaries.
- Keeping a raw (overlay-free) recording next to the composited one.
- Offline pairing without internet (two-QR handshake).
- Service faults, lets, challenges, timeouts beyond the standard intervals.
- A third phone as a remote, or a live camera preview on the scoreboard phone.
- Multi-match tournaments, player profiles, statistics, history sync between
  phones, cloud backup.
- Android support.
