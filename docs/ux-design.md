# UX design

How the two iPhones are used on the court. Requirement ids refer to
[requirements.md](requirements.md); the decisions D1 to D13 recorded there are
assumed. A rough tappable version of the main screens is in
[mockup/index.html](mockup/index.html) (§6).

Both roles run in landscape. Dark background, big type, team colours. Every
screen is designed to be understood by a sweaty player who has never seen the
app, from 6 m away or with one glance at the net post.

## 1. Screen inventory

| Id | Role | Screen | Requirements |
|---|---|---|---|
| S0 | both | Role choice | R-SETUP-1 |
| S1 | scoreboard | Match setup | R-SETUP-2, R-SETUP-3 |
| S2 | scoreboard | Pairing: scan or type the code | R-PAIR-1 |
| S3 | scoreboard | Scoreboard | R-SCORE-*, R-DISP-* |
| S3a | scoreboard | Interval overlay | R-SCORE-4, R-SCORE-5 |
| S3b | scoreboard | Game over / change ends overlay | R-SCORE-2, R-SCORE-3, R-SCORE-5 |
| S3c | scoreboard | Match over overlay | R-SCORE-2 |
| S4 | scoreboard | Correction sheet | R-SCORE-7 |
| S5 | scoreboard | Menu | R-SCORE-7, R-PAIR-6 |
| C1 | camera | Camera setup | R-SETUP-4, R-REC-3, R-REC-4 |
| C2 | camera | Pairing: show the code | R-PAIR-1 |
| C3 | camera | Recording | R-REC-*, R-DISP-9 |
| C4 | camera | Recordings and export | R-REC-6, R-EXP-* |
| E1 | both | Error, offline and reconnect states | R-REC-5, R-DISP-9, R-PAIR-8, N-BROWSER-1 |

### S0 Role choice

```
+---------------------------------------------------------------+
|                    badminton-scoreboard                       |
|                                                               |
|   +-----------------------+     +-----------------------+     |
|   |      SCOREBOARD       |     |        CAMERA         |     |
|   |  at the net post      |     |  at the back corner   |     |
|   +-----------------------+     +-----------------------+     |
|                                                               |
|   Last time: Scoreboard                     Recordings (2) >  |
+---------------------------------------------------------------+
```

Two buttons, each half the screen. The previous role is highlighted. The
"Recordings" link opens C4 on any phone that holds recordings.

### S1 Match setup (scoreboard)

```
+---------------------------------------------------------------+
| <  Match setup                              [ Same as last ]  |
|   LEFT of this screen              RIGHT of this screen       |
|   Team     [ A         ]           Team     [ B         ]     |
|   Colour   (o)(o)(o)(o)            Colour   (o)(o)(o)(o)      |
|   Player 1 [ Nok       ]           Player 1 [ Bank      ]     |
|   Player 2 [ Pae       ]           Player 2 [ Tao       ]     |
|   Starts right court (P1*)(P2)     Starts right court (P1*)(P2)|
|                                                               |
|   Players (Singles)(Doubles*)   Points (11)(15)(21*)          |
|   Format (Best of 3*)(Fixed 2)(Fixed 1)   Interval at 11 (on*)|
|   First server (Left team*)(Right team)      [ START MATCH ]  |
+---------------------------------------------------------------+
```

- "Left" and "right" are literal: the side of this screen as it will sit on
  the post. No court geometry questions.
- Doubles adds two names per team and one question per team: who starts in
  the right service court (R-SETUP-2, D4). That is all the engine needs; the
  serving team's right-court player serves first, the other team's right-court
  player receives (R-SCORE-3).
- Formats per D12. A one-line hint explains fixed 2 ("two games always, 1-1 is
  a draw").
- "Same as last" fills everything from the previous match and starts. Fresh
  install: singles, A and B, first two palette colours, 21, best of 3,
  interval on, A serves (R-SETUP-3).
- Pairing is reachable from S1 and from the menu, so the scoreboard works
  alone (R-PAIR-3).

### S2 / C2 Pairing (one code, D2)

```
 Camera phone (C2)                      Scoreboard phone (S2)
+------------------------------+       +------------------------------+
| Pair with the scoreboard     |       | Pair with the camera         |
|                              |       |                              |
|        [ QR code ]           |  -->  |      [ viewfinder ]          |
|        4 8 2 1 0 7           |       |   or type the code           |
|                              |       |   [4][8][2][1][0][7]  (ok)   |
| waiting for the scoreboard.. |       |                              |
|                              |       | Paired, camera ready  (ok)   |
| Paired with "A vs B"  (ok)   |       | link: paired  REC: idle      |
+------------------------------+       +------------------------------+
```

- The camera phone publishes its connection offer through the helper and shows
  a QR code plus the six-digit room code. The scoreboard phone scans it, or
  the user types the digits if scanning is awkward (R-PAIR-1).
- The viewfinder stays open behind the keypad even when typing: on iPhone the
  camera permission is also what lets the browser offer local-network
  connection candidates (technical-design.md §4).
- Needs internet on both phones for about ten seconds; afterwards the phones
  talk directly over the Wi-Fi or hotspot. With no internet the screen says
  "No internet: cannot pair. Scoring and recording still work on each phone."
  (E1).
- Reconnection after a drop is automatic and silent (R-PAIR-8); no screen.

### S3 Scoreboard (main screen)

```
+---------------------------------------------------------------+
| ...   Game 2 - A 1-0 B                (*) REC 12:34   link ok |
|                               .                               |
|            A                  .              B                |
|                               .                               |
|          20  >                .             16                |
|                               .                               |
|      GAME POINT               .                               |
|   +---------------+           .        +---------------+      |
|   | L  Pae        |           .        | R  Bank       |      |
|   | R  Nok  >     |           .        | L  Tao   recv |      |
|   +---------------+           .        +---------------+      |
|                      ( <- Undo )                              |
+---------------------------------------------------------------+
   tap anywhere on the left half     tap anywhere on the right half
```

- Left half scores for the team currently on the left of the screen; right
  half for the other (R-DISP-1). The halves carry a dim team-colour tint; the
  digits are in full team colour (R-DISP-2).
- `>` is the shuttle (server) marker. Under the digits each half shows its
  team's two service courts as two cells with the player names: the serving
  player's cell carries the shuttle, the receiver's cell says "recv"
  (R-DISP-4, D4). The **bottom cell is the service court nearest the
  scoreboard phone**: for the team on the left of the screen that is their
  right court; for the team on the right it is their left court. This holds
  whichever post the phone sits on, as long as the screen faces along the net.
  Singles shows one line, "serves from right".
- "GAME POINT" / "MATCH POINT" sit under the digits of the team that has it
  (R-DISP-5).
- Top bar: menu (`...`), game number, games and format, camera REC state and
  elapsed time, link chip (R-DISP-9). It is 56 px tall and not part of the
  tap zones.
- Undo pill at bottom centre, 160 × 56 px, in a 72 px band that is not part
  of the tap zones (D6, R-SCORE-6). After an undo it reads "Redo" for 5 s.
- The bottom safe-area strip (iOS home indicator) is excluded from the zones.

### S3a Interval overlay

```
+---------------------------------------------------------------+
|                     INTERVAL   0:47                           |
|                     A  11 - 7  B                              |
|            (deciding game)  CHANGE ENDS                       |
|                                                               |
|            [ Resume ]        any tap resumes, nothing scored  |
+---------------------------------------------------------------+
```

Shown when the leading score first reaches 11 (R-SCORE-4). Any tap dismisses
it and nothing else; the next tap scores. In the third game of a best of 3 or
in a fixed-1 game the overlay also says "change ends" and the halves swap when
it closes (R-SCORE-5). It auto-dismisses when the countdown ends.

### S3b Game over / change ends

```
+---------------------------------------------------------------+
|               GAME 1 TO A    21 - 17                          |
|               games  A 1 - 0 B                                |
|               Change ends - A serves first - interval 1:52    |
|   Serves (A):   (Nok*)(Pae)      Receives (B):  (Bank*)(Tao)  |
|                                                               |
|   ( <- Undo last point )                 [ START GAME 2 ]     |
+---------------------------------------------------------------+
```

In doubles the winning team may pick who serves and the other team who
receives; both start in their right courts (Law 11, R-SCORE-3). Defaults are
the players currently in the right courts, so "Start game 2" alone is always
valid. The next game starts only on that tap (an explicit event, §5), after
which the halves are swapped (R-SCORE-5). Undo here reverts the game-winning
point.

### S3c Match over

```
+---------------------------------------------------------------+
|                    A WINS  2 - 1                              |
|            21-17   18-21   21-19      48 min                  |
|                                                               |
|   ( <- Undo )     [ Stop recording ]     [ New match ]        |
+---------------------------------------------------------------+
   fixed 2 at 1-1:   DRAW  1 - 1   ·   21-15  15-21  ·  points 36-36
```

"Stop recording" sends the remote stop to the camera phone (D11, R-PAIR-6).
"New match" returns to S1 with the same settings.

### S4 Correction sheet

```
+--------------------------------------------------+
| Correct score                           [Cancel] |
|   A  [ - ] 15 [ + ]    B  [ - ] 15 [ + ]         |
|   Games A [ - ] 1 [ + ]  B [ - ] 0 [ + ]         |
|   Server  (Nok)(Pae)(Bank)(Tao*)                 |
|   [ Swap ends ]  [ Swap courts: A ] [ Swap courts: B ] |
|                                         [ Apply ]|
+--------------------------------------------------+
```

Opened by long-pressing a half or from the menu (R-SCORE-7). "Swap courts"
fixes the app when the players are standing the other way round than the app
thinks (court drift, D4); it is immediate. Apply writes one `correct` event
with scores, games, serving team and player.

### S5 Menu (`...`)

Correct score · Swap ends · Start/stop recording (when paired) · Pair camera ·
Sound and voice · End match · New match. Each item is a full-height row, at
least 56 px.

### C1 Camera setup

```
+---------------------------------------------------------------+
| <  Camera                            link: paired - room 482107|
|  +---------------------------------------------------------+  |
|  |                                                         |  |
|  |     live preview = exactly what gets recorded           |  |
|  |   [ A 0 > | 0 B ]  G1 0-0                               |  |
|  +---------------------------------------------------------+  |
|  Quality (1080p*)(720p)  Audio (on*)  Mirror overlay (off*)   |
|  Overlay delay (0 s*)(2 s)(3 s)                               |
|  Storage: 38 min left at 1080p - persisted ok                 |
|          [ Pair with scoreboard ]              ((  REC  ))    |
+---------------------------------------------------------------+
```

- The preview is the composited canvas itself, so what the user sees is what
  is recorded, overlay included (R-REC-4). If the team shown on the left is
  actually on the right of the frame, flip "Mirror overlay" once.
- "Overlay delay" (R-REC-4): with 0 s a wrong tap shows in the video until the
  undo; with 2 or 3 s the score changes that much later in the video but a
  quick undo never reaches it. Default 0 s; phase 3 decides from real matches.
- "Storage: N min left" comes from the storage estimate at the chosen
  quality; below 10 min it turns amber (R-REC-3). "persisted" shows whether
  the browser granted persistent storage (N-STORE-1).
- REC is a 96 px round button. It is normally pressed from the scoreboard
  phone (D11).

### C3 Recording

```
+---------------------------------------------------------------+
| (*) REC 12:34 - 26 min left            link ok - A 18 - 16 B  |
|  +---------------------------------------------------------+  |
|  |                                                         |  |
|  |      composited preview (dims after 30 s, tap to wake)  |  |
|  |   [ A 18 > | 16 B ]  G2 1-0 GP                          |  |
|  +---------------------------------------------------------+  |
|  [ Dim screen ]                           ( hold to STOP )    |
+---------------------------------------------------------------+
```

- Nothing on this screen needs touching during the match. Stop needs a 1 s
  hold or the remote command (R-REC-7).
- The screen dims to 20 % after 30 s to save battery; the canvas keeps being
  drawn and recorded at full rate (assumption A7 in technical-design.md §9).
- The top bar shows the link chip and the last received score, so a glance
  from the court confirms the camera is still following.

### C4 Recordings and export

```
+---------------------------------------------------------------+
| Recordings                               storage 6.1 / 58 GB  |
|  Today 19:12   A vs B  2-1   48 min   2.1 GB  [Share] [Delete] |
|  Sun 10:05     A vs B  1-1   31 min   1.4 GB  [Share] [Delete] |
|                                                               |
|  Share sends the finished clip and match.json to Photos,      |
|  AirDrop or Files. Delete asks once.                          |
+---------------------------------------------------------------+
```

Share opens the system share sheet with the segment file(s) and `match.json`
(R-EXP-1, R-EXP-2). If the browser cannot share files, the row shows
"Download" instead. Delete is a two-step confirm (R-EXP-3). On the scoreboard
phone the same list offers the log alone.

### E1 Error, offline and reconnect states

| State | Where | What the user sees | Way out |
|---|---|---|---|
| Unsupported browser | S0 | Full-screen message: Safari on iPhone, iOS 17+ (18.4+ installed) (N-BROWSER-1) | Open Safari |
| Portrait | S3, C3 | "Rotate your phone" screen; state is kept (R-DISP-7) | Rotate |
| Camera permission denied | C1, S2 | Message with the Settings path | Grant, then retry |
| No OPFS / private browsing | C1 | "Recording needs normal browsing mode" (D10) | Leave private mode |
| No internet while pairing | S2, C2 | "No internet: cannot pair. Scoring and recording still work on each phone." Retry button (R-PAIR-1) | Turn on data or hotspot |
| Storage low | C1, C3 | Amber "N min left"; at zero: recording stops cleanly, file kept (R-REC-3) | Export and delete |
| Capture interrupted (call, lock, app switch) | C3 | "Recording stopped: camera interrupted. Segment 1 saved (12:34)." Button: "Resume (segment 2)" (R-REC-5) | One tap |
| Link lost, internet available | S3, C3 | Chip "reconnecting" after 6 s; scoreboard keeps scoring; camera keeps recording with the overlay frozen and marked "stale"; link returns by itself (R-PAIR-8), then the camera catches up (R-PAIR-4) | None needed |
| Link lost, no internet | S3, C3 | Chip "offline"; same behaviour; reconnects when internet returns | Restore internet |
| Version mismatch | S2, C2 | "Update the app on the other phone, then pair again" (R-PAIR-7) | Reload the other phone |
| Speech unavailable or muted | S3 | One-line banner "Turn off silent mode to hear the score" (assumption A9) | Flip the switch |

## 2. Flows

### First match, start to export

```mermaid
flowchart LR
  A[Open URL / installed app] --> B[S0 role]
  B -->|Scoreboard| C[S1 setup]
  B -->|Camera| D[C1 camera setup]
  C --> E[S2 scan or type code]
  D --> F[C2 show code]
  F -->|helper on Vercel| E
  C --> G[S3 scoreboard]
  E --> G
  E --> H[C3 recording]
  G -->|REC from net post| H
  G --> I[S3a interval] --> G
  G --> J[S3b game over] --> G
  G --> K[S3c match over]
  K -->|Stop recording| L[C4 export]
```

1. **Install (optional).** Open the Vercel URL in Safari, "Add to Home
   Screen". Needed for persistent storage and the screen staying on in the
   installed app on iOS 18.4+ (N-STORE-1, R-DISP-8, N-BROWSER-1).
2. **Roles.** Each phone picks its role (S0).
3. **Setup.** Scoreboard phone: names, players, colours, format, first server
   (S1). Camera phone: quality, audio, overlay delay, minutes left (C1).
4. **Pair.** Camera phone shows its code; scoreboard scans or types it
   (S2/C2). About 10 s with internet.
5. **Place the phones.** Camera on the tripod, scoreboard on the post. The
   camera preview shows the composited frame; flip "mirror" if wrong.
6. **Start.** "Start match" on the scoreboard, then REC from the scoreboard
   menu. The scoreboard speaks "Love all, play".
7. **Score.** Winner of each rally taps their half; flash, sound, spoken score
   (R-DISP-3). The overlay in the recording follows within 200 ms (R-PAIR-2).
8. **Interval at 11, change ends** (S3a). **Game over** (S3b): pick server and
   receiver if wanted, "Start game 2".
9. **Match over** (S3c): stop the recording from the scoreboard.
10. **Export** (C4): the finished clip to Photos, the bundle by AirDrop. Delete
    when done.

### Pairing and reconnect through the helper

```mermaid
sequenceDiagram
  participant Cam as Camera phone
  participant H as Helper (Vercel)
  participant Sb as Scoreboard phone
  Cam->>H: POST offer -> room code + session
  Cam->>Cam: show QR + code
  Sb->>Cam: scan QR (or type code)
  Sb->>H: GET room(code) -> offer, session
  Sb->>H: POST answer(session)
  Cam->>H: poll answer(session) every 2 s
  Cam-->>Sb: data channel opens over the LAN (hello, sync, rec state)
  loop every 2 s
    Sb-->>Cam: ping / pong (liveness, clock offset)
  end
  Note over Cam,Sb: link drops
  Cam->>H: POST new offer (session, gen+1)
  Sb->>H: poll offer(session) -> answer
  Cam-->>Sb: data channel opens again, full sync
```

### Scoring loop and rule prompts

```mermaid
stateDiagram-v2
  [*] --> Playing: Start match / Start game N
  Playing --> Playing: tap (point), undo, correct, swap courts
  Playing --> Interval: leading score reaches 11
  Interval --> Playing: any tap or countdown ends
  Playing --> GameOver: game won
  GameOver --> Playing: Start game N (ends swap, server/receiver chosen)
  GameOver --> MatchOver: match decided or last fixed game played
  GameOver --> Playing: undo
  MatchOver --> GameOver: undo
  MatchOver --> [*]: New match
```

### Disconnect and reconnect

1. Pongs stop arriving; after 6 s both chips show "reconnecting" (or
   "offline" when the helper is unreachable).
2. The scoreboard keeps scoring and logging (R-PAIR-3). The camera keeps
   recording; its overlay stays at the last known score and is marked "stale".
3. The phones re-exchange descriptors through the helper with no user action
   (R-PAIR-8). On reconnect the camera receives the full log and computes
   recording-relative times for the missed events from the clock offset
   (R-PAIR-4, R-PAIR-5). The video shows the stale score for the duration of
   the drop and jumps to the right one; nothing else changes.

### Camera interruption

1. The camera track ends (call, screen lock, app switch).
2. The current segment is finalised and listed; C3 shows the interruption
   message (E1).
3. "Resume" starts segment 2 of the same match. The export bundle lists both
   segments with their start times (technical-design.md §8).

## 3. Tap zones and touch handling

- Zones: the two halves of the screen, each 50 % wide minus a 24 px inset at
  the outer edge, from below the 56 px top bar to above the 72 px bottom band
  and the safe-area strip. Minimum zone area on an iPhone 13-sized screen is
  about 400 × 250 px, far above any touch-target guideline (R-DISP-1).
- A **point** is one pointer, down-to-up in 30 to 400 ms, moved less than
  24 px, with no other pointer active, and at least 800 ms after the previous
  point (R-DISP-6).
- A **long-press** (600 ms or more, little movement) on a half opens the
  correction sheet (S4).
- A **swipe down** (80 px or more within 500 ms, anywhere) is Undo (D6).
- Touches that start in the top bar or bottom band belong to those controls.
- Wet-finger reality: a wet screen produces phantom short touches and
  multi-touch. The 30 ms floor and the single-pointer rule drop most of them;
  the 800 ms refractory period makes the rest cost at most one undo. The
  overlay delay in C1 can keep even those out of the video.
- iOS: the system edge gestures (home indicator, back swipe from the left
  edge) cannot be disabled by a web app. The zones keep a 24 px inset from the
  left and right edges and the safe-area inset at the bottom. For a nervous
  match, iOS Guided Access locks the phone to the app; this is a tip in the
  setup screen, not a requirement.

## 4. Feedback

| Channel | On a point | Other moments |
|---|---|---|
| Visual | The scoring half flashes to full team colour for 250 ms; the digit scales up 15 % for 150 ms; the shuttle moves to the new server's cell | Interval, game and match overlays; ends-swap slide animation (500 ms) |
| Sound | Short click (Web Audio buffer, ready before the match) | "Game", "Interval", "Change ends" chimes |
| Voice (D5) | "Twelve, nine" (server's score first); "service over" is not spoken, the marker shows it | "Game point", "Match point", "Game 1 to A, 21-17", "Love all, play" |
| Haptic | None: iOS Safari has no Vibration API (technical-design.md §9) | None |

Audio on iOS only plays after a user gesture; the "Start match" tap unlocks
audio and speaks "Love all, play", so the user hears immediately whether the
volume and the silent switch are right. Voice and sounds have independent
toggles in the menu.

## 5. Design rationale and alternatives

Departures from the original starting point, and why.

- **Per-player serving without extra taps (D4).** The doubles positions are
  fully determined by the names, the starting courts, and the point sequence
  (Law 11): the serving pair swaps courts when it scores, nobody moves
  otherwise. So the tap stays "anywhere in your half"; the engine does the
  rest. Court drift in casual play is handled by "Swap courts" in S4 rather
  than by asking after every rally.
- **Undo is a button, with swipe as a shortcut (D6).** A swipe on a wet screen
  often registers as a tap, which would *score* instead of undo, the worst
  possible failure. The button sits in a band that cannot score.
- **Correction is long-press or menu, not "tap the digits".** The digits sit
  inside the tap zone; a tap there must score, otherwise players learn that
  "the middle does something else" and hesitate.
- **Explicit "Start game N".** The first tap after a change of ends is exactly
  when players tap the wrong half, the doubles server/receiver choice belongs
  there, and the recording needs a clean "game 2 started at" time.
- **The interval overlay swallows exactly one tap.** The ends change has to be
  announced in a way nobody can miss, and the overlay doubles as the countdown.
- **REC from the scoreboard phone (D11).** The camera stands in the far
  corner; walking there to start and stop is the single most annoying step in
  the scenario.
- **Live overlay with an optional delay (D9).** The captain wants the finished
  clip on the phone, so the overlay is burned in. The cost is that mistakes
  are permanent; the delay setting is the cheap mitigation and is left at 0 s
  until real matches show how often undo is needed.
- **One code instead of two scans (D2).** The helper makes pairing one scan
  and reconnection automatic. The price, internet on the court, is paid by
  the hotspot phone's data in the normal case; with no signal at all each
  phone still works on its own.
- **"Mirror overlay" toggle instead of asking where the camera stands.** The
  user sees the preview and flips a switch if it looks wrong.
- **No portrait layout.** iOS cannot lock orientation; a "rotate" screen is
  enough for a state that should never occur on the post.
- **Setup before pairing, pairing optional.** A failed pairing still leaves a
  working scoreboard (R-PAIR-3).
- **Spoken score instead of a bigger screen.** Speech lets the player walk
  back without reading. "Service over" is deliberately not spoken; the marker
  shows it, and short calls are heard better in a gym.

## 6. Rough UI mockup

`docs/mockup/index.html` is a single self-contained file (no build, no
dependencies, no network). Open it in Safari on the iPhone in landscape, or in
any desktop browser. It covers:

- S1 with singles/doubles, player names, starting courts, points, the three
  formats and first server.
- S3 with real tap zones driven by a small plain-JS score engine: points,
  per-player server and receiver in doubles, interval at 11 with the deciding
  game ends change, game and match point flags, undo button and swipe-down with
  redo, long-press for S4, the menu, and the S3a/S3b/S3c overlays including
  the fixed-2 draw and the doubles server/receiver pick.
- S4 with score and game steppers, serving player, swap ends, swap courts.
- C1 and C3 as static frames with the overlay drawn on a placeholder court,
  following the live score from S3.

It deliberately has no speech, camera, pairing, or polish; a thin bar at the
top switches screens. The engine in it mirrors technical-design.md §3 and is
the reference for the phase 1 tests.
