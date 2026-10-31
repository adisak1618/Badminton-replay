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
- **D14 One camera, one or two scoreboards; the camera holds the match.**
  Captain, 2026-10-29, after a real session with the production build:
  "ผมลองเอาไปใช้จริงแล้วพบว่า นักแบตที่ตีไม่ค่อยมีอารมณ์จะไปกด score board
  เท่าไหร่ แต่เพื่อนที่นั่งดูว่างและช่วยนับคะแนนให้ด้วยอยู่แล้ว ผมเลยคิดว่าเราจะให้
  ต่อมือถือเป็น scoreboard ได้ 3 เครื่องเลย คือ 1 เครื่องเป็นกล้อง และอีกสองเครื่อง
  เป็น score board ใช้งานได้เหมือนกันเลย จะต่อ score board 1 หรือ 2 เครื่องก็ได้
  และอยากให้ช่วยแก้เรื่องความเสถียรหน่อย คือเวลาปิดจอแล้วเปิดใหม่ กว่าจะ
  reconnect ติด เราสามารถทำให้ปิดจอแล้วยัง connect อยู่ได้มั๊ยถ้าเราใช้แอพแบบ
  add to home แล้ว และอีกเรื่องคือกล้องเวลาเรา un-pair แล้วสถานะใน score board
  ยังอยู่ เราควรทำให้มันเคลียได้มั๊ย หรือเวลามีเครื่องใหม่ reconnect เข้ามาอย่าง
  น้อยมันก็ควรจะ reset" (friends sitting out count the score, not the players;
  let one camera take one or two scoreboards that work the same; reconnect
  faster after the screen was off; clear the camera's state on the scoreboard
  when the camera unpairs). Consequence: the camera holds the one match log and
  each scoreboard sends inputs and shows what the camera sends (R-PAIR-10); the
  same rally tapped on both scoreboards within 1.5 s counts once (Firstmate's
  default, the captain may change it); protocol version 2. A locked screen
  suspends the page whether or not the app is on the Home Screen, so the link
  cannot stay up with the screen off: the scoreboard keeps its screen on while
  paired and reconnects within seconds when the screen comes back (R-DISP-8,
  R-PAIR-8). Unpairing clears the camera's state on every scoreboard (R-PAIR-11).
- **D15 Point reasons: why each point was won.** Captain, 2026-10-29: "อีก
  feature ที่อยากทำคือ เวลากดแต้มให้มี popup มาให้เลือกด้วยว่าแต้มนี้ ได้เพราะ
  อะไร เช่น ทีมเรา นาย A ตีลูก winner หรือฝ่ายตรงข้ามนาย C ตี error ... คนหน้า
  แต่งดี ก็ควรได้เครดิต ... และ feature นี้เราควรเลือกได้ว่าจะแสดง real-time หรือ
  แสดงตอนจบเกมส์เท่านั้น" (a popup after the point tap asking why it was won;
  the front player who set it up gets credit; real time or end of game). After
  the research board (data/badminton-point-reason-research): "ทุกอย่างโอเคแล้วนะ
  ยกเว้นอย่างเดียวคือตอนกดแล้วนับถอบหลัง 3 วิ คือไวเกิน เอาเป็น 10 วิ แล้วให้
  skip ได้ดีกว่า นอกนั้นโอเคหมดแล้ว อย่าลืมว่า feature นี้สามารถเลือกใน config
  ได้ว่าจะปิดหรือจะเปิด เพราะบางคนอยากใช้แค่นับแต้ม" (the recommended answers
  stand: who hit the last shot plus winner / forced / unforced, a mechanical
  assist, the two-step popup, end of game by default; the extras after a tap
  stay 10 s with Skip; the feature can be switched off). Consequence: a tag is
  its own event naming the point by id (technical-design.md §3.3), protocol
  version 3; first slice: popup, tag later, stats cards at game over and match
  over, `stats` in `match.json` (R-TAG). Live display and stats in the video
  are the next slice: a small Thai table that stays on screen (R-TAG-7),
  chosen on the round-2 design board (data/badminton-reasons-video-design-r2).
- **D16 Point replays, made after the match.** Captain, 2026-10-28: "feature
  reply หรือภาพช้า … เวลากดคะแนนแล้ว ให้กดเลือก แต้มนี้ให้มี reply เลย เราก็จะเอา
  video จากวินาทีที่กด request re-play สำหรับแต้มนี้ มา - 1วิ และเอาภาพก่อนหน้า
  10 วิก่อนมา slow 2 เท่า … ควร burn ลง video real-time เลยมั๊ยหรือควรทำทีหลัง"
  and, 2026-10-30, tagging points after the match while watching the video and
  burning the stats in afterwards, through one post-match video pass. On the
  research board (data/badminton-replay-research): "Q1=later; Q2=shared;
  Q3=phone-first; Q4=mediabunny; Q5=inline; Q6=tap5; Q7=card; Q8=frozen;
  Q9=pill; Q10=live-sound; Q11=REPLAY; Q12=leadin+blend+adjust+keys+inset;
  note: ระยะเวลาของ replay และจุดเริ่มจุดจบรวมถึง speed ขอปรับได้ในแต่ละ shot
  และกดเพิ่ม reply สำหรับแต้มอื่นที่ไม่ได้กด mark ไว้ก่อนได้" and "เริ่มทำงานได้
  เลย". Consequence: during play a point is only marked (R-REP-1 to 3); the
  replays and the late tags' stats are made after the match by one pass on the
  camera phone that inserts each replay inline (5 s ending 1 s before the
  point's score tap, half speed, BWF card-spin transition, score panel frozen
  with a REPLAY ×0.5 badge, the real sound after the point), every shot
  adjustable and any point markable later (R-REP-4, next slices).
- **D17 Score a saved video.** Captain, 2026-10-31: "รับ project AI tracker
  เข้ามาก่อนละกัน แต่ เรายังไม่มีไฟด์ match.json จริงๆเลย
  การจะได้ไฟด์นั้นต้องใช้แอพที่เราทำออกไปถ่าย แต่มันอาจจะทำให้การ พัฒนาแอพช้าเกินไป
  เราสามารถ ใช้ video ใน internet และทำ เครื่องมือให้คนกดคะแนนและสร้างไฟด์
  match.json ได้มะ หรือเราเพิ่ม feature นี้ไปในแอพปัจจุบันเลยดี
  คือผู้ใช้เลือกได้ว่าจะถ่ายแบบ live หรือ import file video
  มากดให้คะแนนและเหตุผลของการได้แต้ม" and "ทำโหมดให้คะแนนจากไฟล์วิดีโอเลย" (firstmate
  recommended the mode in this app over a separate tool). Consequence: a third
  way in on the role screen, VIDEO, scores a video file that already exists
  (a match from the internet, a clip on the Mac or in Photos) with the same
  scoreboard, rules, why-was-this-point-won popup (D15) and replay marks
  (D16), and exports the same `match.json` with every event placed on that
  file (R-VID). It is the ground truth for the AI tracker
  (projects/badminton-ai-tracker): the score events are its input and the D15
  tags its held-out answer key, so both come from the same app and format.
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
  Whoever wins the rally walks to the post and taps their half. Since D14 a
  friend sitting out usually holds it, and a second friend can hold a second
  scoreboard on the same match.

Conditions the design must survive: sweaty or wet fingers, players glancing
from 6 m away, gym lighting or outdoor glare, 60 to 90 minutes of play, one
phone's hotspot as the only network, weak mobile signal indoors, players who
have never seen the app. Nobody wants to read instructions mid-match.

### Device roles

| Role | Does | Must never |
|---|---|---|
| Scoreboard phone (one or two, D14) | Match setup, scoring, rules, announcements; unpaired it holds the score log itself, paired it sends its taps to the camera and shows the camera's log; shows link and REC state, starts and stops REC remotely (D11), can export its own log | Lose a point when the link drops |
| Camera phone | Holds the match log while paired (D14), composites the live overlay into the recording, writes to its own storage, timestamps every event on the recording timeline, exports the finished clip plus `match.json` | Need a touch during the match |

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
- **R-DISP-8 Screen stays on.** While a match is live, and while the
  scoreboard is paired or on the pairing screen, the screen never sleeps (Wake
  Lock, requested again on every return and every tap); when the lock is
  refused or unavailable (Low Power Mode, old iOS) one line says the screen may
  lock (D14). *Accept:* 10 minutes without touching, paired, the screen is
  still on; with Low Power Mode on, the hint shows.
- **R-DISP-9 Link status.** Both phones show the link state (paired,
  reconnecting, offline) and the camera's REC state in one small chip. While
  the link is down the scoreboard's chip counts the seconds since the camera
  last sent its state, and says "syncing" until the camera's match has
  arrived after a reconnect, so a stale score is never shown as live; it
  shows "+1 scoreboard" when another scoreboard is linked, and the camera
  shows how many are linked ("1/2", "2/2", D14). *Accept:* turn off Wi-Fi on
  one phone; both chips show "reconnecting" within 10 s and "paired" again
  within 15 s of Wi-Fi returning.

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
- **R-PAIR-4 Resync.** On connect or reconnect the scoreboard sends what it
  scored meanwhile and then shows the camera's whole match, the camera's log
  being the match (D14); a camera holding no match takes the scoreboard's. No
  point is lost or duplicated. *Accept:* disconnect, score five points,
  reconnect; the camera overlay shows the same score and `match.json` has five
  events.
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
  R-PAIR-3 applies. When a scoreboard's screen comes back on, its link is
  checked at once and rebuilt within about 3 s on one Wi-Fi (D14;
  technical-design.md §4.5). *Accept:* toggle airplane mode for 20 s on the
  camera phone; the link is back within 15 s of airplane mode ending. Lock the
  scoreboard's screen for a minute; the link is back within 5 s of unlocking.
- **R-PAIR-9 Helper holds nothing of value.** The helper stores only
  connection descriptors and a session secret, with short lifetimes (10 min
  for a room code, a few hours for a session); it never receives scores,
  names, or video. *Accept:* the function's store contains no key with match
  data after a match; keys expire on their own.
- **R-PAIR-10 One or two scoreboards (D14).** The camera links up to two
  scoreboards, each paired with its own code like the first, at any time,
  mid-match and while recording included. Both work the same: any tap, undo,
  correction, interval, game start, match setup or end goes to the camera,
  which applies it to its log and sends the result to both; undo undoes the
  newest event whichever scoreboard sent it. A point to the same side from the
  other scoreboard within 1.5 s (`DUPLICATE_WINDOW_MS`) is the same rally:
  counted once, "Already counted" on the second. *Accept:* two scoreboards
  score alternately and both show the camera's score; both tap the same rally
  and it counts once; one scoreboard alone works as before.
- **R-PAIR-11 Unpairing clears.** When either phone unpairs, the other one
  forgets the pairing within a second (or at its next look at the helper if
  the goodbye was lost): no camera REC state, no link chip, offer to pair
  again; the match stays on the scoreboard as its own. A camera that died
  without a goodbye leaves the scoreboard "link lost", and its menu offers
  "Leave". *Accept:* unpair on the camera; every scoreboard shows "Pair
  camera" within a second.

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

### Point reasons (R-TAG)

D15. Off records nothing and shows nothing: scoring only, as before D15.

- **R-TAG-1 Setting.** Match setup has "Point reasons: Off / End of game",
  default End of game, kept by "Same as last" and sent to the camera with the
  match. *Accept:* start with Off: no popup, no chip, no tag in the camera's
  log or in `match.json`.
- **R-TAG-2 Popup after a tap.** The point counts, flashes and is spoken at
  once; then the phone whose tap counted asks "Who hit the last shot?" with
  the four names (two in singles) grouped by side, serve and receive marked,
  and a "Serve fault" shortcut when the side that lost served. A name on the
  winning side saves a winner (1 tap); a name on the losing side asks forced
  or unforced (2 taps). The optional extras (shot; forced by; assist in
  doubles) stay 10 s with Skip; untagged, the popup closes after 4, 6 (default)
  or 10 s or never (per phone). A tap outside closes it and scores nothing;
  Undo stays on screen and takes back the point with its tag. *Accept:* a
  winner tagged in one tap, an error in two, within the next serve.
- **R-TAG-3 Two scoreboards.** The other scoreboard shows "Tap to tag" for 6 s
  instead of the popup; either may tag or change a point, the camera's order
  decides; "Ask why after each point" can be turned off per phone. *Accept:*
  a tag on one scoreboard shows on the other's card.
- **R-TAG-4 Tag later.** The top bar counts untagged points; the rally list
  (from that chip, the interval, game over, match over and the menu) tags,
  changes or clears any point, one by one if wanted. Nothing in it scores.
- **R-TAG-5 End of game.** Game over and match over show, per player, winners,
  errors they forced, assists, forced and unforced errors; per team, points
  from own winners, the other side's forced and unforced errors and untagged
  (adding up to the score); winners by shot; longest run, points won on serve
  and time. *Accept:* both scoreboards show the same card.
- **R-TAG-6 Export.** `match.json` carries the tags in `events` and a derived
  `stats` block, from the camera's bundle and from the scoreboard's own
  export (menu).

- **R-TAG-7 Stats in the video.** The camera's C1 has two independent rows,
  both Off by default (the video is then exactly as before) and both disabled
  when the scoreboard's "Point reasons" is Off. "Player stats: Off / team A /
  team B" burns a small Thai table for that team's players into every frame:
  winners (วินเนอร์), assists (สร้างโอกาส), opponents' errors they forced
  (บีบให้เสีย), forced errors (ถูกบีบเสีย), unforced errors (เสียเอง); singles
  has no assist column. The counts are those of the current game ("GAME n" in
  its header) and start from zero with each game; a count that just went up
  flashes. Under it, a switch (default on) adds one line "คะแนนจากคู่แข่งเสีย N":
  the other side's forced and unforced errors in one number, never per player.
  The table sits in a corner nobody owns (the score panel's vertical mirror,
  bottom-left by default) or in the corner the user picks; each corner stacks
  score panel, logo, table, so none covers another. "End-of-game summary: Off /
  On" shows a Thai card for both teams in the middle of the frame (the match
  totals after the match): "สรุปเกมที่ n" or "สรุปผลการแข่งขัน", the score, where
  each side's points came from head to head, every player's five counts, the
  longest run, points won on serve, the playing time and "บันทึกเหตุผล n จาก m
  คะแนน". The live table is hidden while the card shows. It waits for the operator to deal with the last point
  of the game or match (its tag saved, or "No tag" in the popup, which is saved
  as a `tag.clear`; a point left for tag later keeps it hidden), then stays in
  the video until the operator presses "ปิดสรุป" on the scoreboard's game or
  match over screen (a `summary.close` event, so a reconnect replays it). A game
  summary also ends by itself when the next game's first rally starts, a match
  summary when the recording stops, and undoing the last point hides it. Counts follow the overlay
  clock, so a tag counts from the moment it was saved and a point undone inside
  the overlay delay never counts. *Accept:* with both rows Off a recording is
  byte-for-byte what it was; with the summary on, it is not in the video while
  the game's last point is untagged, appears after its tag and is still there
  a minute later, and is gone after "ปิดสรุป"; with the table on, tag a winner and the winners
  count of that player goes up by one within a second of the tag, and the game
  after starts at zero; no combination of panel corner, logo corner and size
  overlaps the table.

### Point replays (R-REP)

D16. Marking never scores, never changes the live video, and works whether or
not the match asks why points were won.

- **R-REP-1 Mark after a point.** After each point "☆ Replay" marks it for a
  replay; another tap takes the mark back (★ Replay ✓). It sits beside "↶ Undo
  point" above the why-was-this-point-won popup; without the popup (point
  reasons off, "Ask why" off on this phone, the other scoreboard's point, or the
  popup closed) it shows on its own under the top bar for 8 s after the point,
  above the game-over and match-over cards. *Accept:* one tap marks the point
  just scored; the camera's log holds the mark within a second; the other
  scoreboard shows it.
- **R-REP-2 Mark later.** The rally list (menu, and everywhere it opened for
  D15) has a star on every row, with point reasons on or off: any point can be
  marked or unmarked at any time, also after the match. Undo takes back scoring,
  never a mark; an undone point loses its mark and a redo brings it back.
- **R-REP-3 Window.** A replay shows the 5 s that end 1 s before that point's
  score tap, at half speed: the point's own tap, so a mark made late shows the
  same moments. A window whose start was not set never reaches back into the
  rally before (it starts 1 s after that rally's tap at the earliest). A mark
  may carry its own start, end (from 30 s before to 5 s after the tap, at
  least 1 s long) and speed (×0.5, ×0.75, ×1): the newest mark of a point wins.
- **R-REP-4 In match.json.** `match.json` carries the marks in `events` and a
  derived `replays` list: each marked point's window on the log's clock and on
  the recording (segment, ms from its first frame). Each segment records the
  camera time of its first composited frame, the file's t = 0 (`firstFrameAt`),
  and event times on the recording count from it. *Accept:* a match with no
  mark exports exactly as before (no `replays`); the scoreboard's own export
  lists the marks without a place on a video.
- **R-REP-5 Later slices.** The post-match pass that inserts the replays and
  burns the stats of tags added after the match, and the Studio screen to tag
  while watching and adjust each shot, follow in their own PRs
  (data/badminton-replay-research/report.md section 11).

### Scoring a saved video (R-VID)

D17. A match scored from a video file is a match of one phone (no pairing, no
camera); everything else about scoring is the live match's.

- **R-VID-1 Way in.** The role screen's third card, VIDEO · "score a saved
  video", opens the system file picker from its own tap (Photo Library or
  Files on the iPhone, the file picker on a Mac); then the usual match setup,
  which names the file and has no pairing; then the board with the video.
  Picking it on a paired phone unpairs it first. *Accept:* a 400 MB 1080p mp4
  picked on the Mac in Chrome and on an iPhone in Safari reaches the setup
  screen naming the file.
- **R-VID-2 Player beside the board.** The video sits beside the board in
  landscape and above it in portrait, muted until its sound button is tapped,
  with play/pause (also a tap on the picture), a seek bar with the time and
  the duration and a tick per point in the winner's colour (★ for a replay
  mark), back and forward 5 s and 1 s, and speed 0.5×, 1×, 2×. The board is the
  live board at a smaller size; the interval, game-over and match-over
  overlays, the popup and the rally list cover the board only, so the player
  stays usable. Taps, gestures, the popup, tag later, the stats cards, the
  replay marks and undo/redo work exactly as live; nothing counts until the
  file is open. *Accept:* a game scored on the Mac and on an iPhone with the
  popup on, a replay marked and a point undone, the seek bar shows each point.
- **R-VID-3 Times on the file.** Each event's time is where the video stood
  when it was made, less the match's tap offset (0 by default; 0 to 2000 ms in
  100 ms steps in the menu, for the scorer's reaction; a change applies to the
  taps after it). The popup pauses the video and it plays on after the popup
  if it was playing (menu setting, on by default). The interval countdown, the
  match time in the top bar and the durations on the cards run on the video.
  *Accept:* a point tapped with the video at 5:00.2 is at 300 200 ms on the
  file in `match.json`; with a 300 ms offset one tapped at 6:40 is at 399 700.
- **R-VID-4 Keyboard.** On a computer: Space or K play/pause, ← / → 5 s,
  Shift+← / → 1 s, 1 / 2 / 3 speed, M sound, A point to the team on the left of
  the screen and B (or L) to the one on the right, U undo and Shift+U redo, R
  replay mark on the last point, T the popup for the last point, E swap ends,
  ? the list (also in the menu and under the player). The score keys do what a
  tap does and are ignored while a popup, list or sheet is open; the player
  keys always work. *Accept:* a game scored with the keyboard alone.
- **R-VID-5 Nothing lost on a reload.** The match is saved like a live one
  after every change, with the file's name, size, duration, size in pixels,
  frame rate, the tap offset and where the video was (every 3 s while
  playing, on pause and after a seek). After a reload or a crash the board
  comes back asking for the file again (iOS keeps no handle to a picked file)
  and seeks to where it was; a file with another name or size is pointed out
  with "Use it anyway" and "Pick another". *Accept:* reload mid-game, pick the
  file again: same score and position; pick another file: the warning shows.
- **R-VID-6 match.json.** The menu's "Export this match (match.json)" gives
  the recording's `match.json` (version 1) with the file as its one segment
  and `recording.source: 'imported'` (technical-design.md §8): every event's
  `tRec` and every replay's `rec` on the file. The video is never copied.
  *Accept:* every `tRec` matches the video time at the tap; a live match
  exports exactly as before.
- **R-VID-7 Later.** Pairing in this mode, the camera, rendering replays from
  the file, continuing from an existing `match.json`, Thai labels, trimming or
  re-encoding the video, keyboard picks inside the popup.

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
  Scoring a saved video (D17) also runs in Chrome or Safari on a Mac, which
  is where most videos to score are; the message says so.
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
- Multi-match tournaments, player profiles, statistics beyond point reasons
  (D15), history sync between phones, cloud backup.
- Android support.
