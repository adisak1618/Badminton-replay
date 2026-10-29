# Technical design

Architecture and implementation plan for the camera phone and its one or two
scoreboard phones. Requirement ids refer to [requirements.md](requirements.md);
the decisions D1 to D14
recorded there are assumed. Screens (S*, C*) refer to
[ux-design.md](ux-design.md).

Every browser-support claim in §9 was checked on 2026-10-27/28 against MDN's
browser-compat-data, WebKit's blog and bug tracker, or Chromium sources, and
cites the page. Claims that could not be verified are listed as assumptions to
test on the captain's iPhones in phase 0 of [roadmap.md](roadmap.md).

## 1. Architecture

```
                 Vercel
   static PWA shell + assets        api/signal (one function)
          |                                 |  <-> Redis (Marketplace, Upstash)
   first visit / updates          pairing + reconnect: offers/answers only
          |                                 |
   +------+---------------------------------+------+
   |                                               |
 Scoreboard phone (PWA)                   Camera phone (PWA)
   score engine, event log                  getUserMedia -> <video> -> canvas
   speech, UI                                 + overlay -> captureStream + mic
   IDB: live match                            -> MediaRecorder -> worker -> OPFS
   |                                          event mirror, export
   +--- WebRTC data channel (LAN, or TURN) ----+
             JSON messages, no media
```

- **One static web app, two roles.** The same bundle serves both phones; the
  role is chosen at launch (R-SETUP-1).
- **One function.** The signaling helper exchanges WebRTC descriptors between
  the phones and mints short-lived TURN credentials for them, nothing else
  (R-PAIR-9). Video, scores and names never leave
  the phones (N-PRIV-1).
- **The camera phone holds the match while paired (D14).** Up to two
  scoreboard phones link to it, each over its own data channel (a star; the
  scoreboards never talk to each other). Each scoreboard sends inputs; the
  camera applies them to its one log and sends every applied event to every
  scoreboard, which shows the camera's log. Only one phone writes the log, so
  there is still no merge problem. Unpaired, a scoreboard holds its own log
  as in Phase 1.
- **Camera phone owns the recording timeline** and the composited video. It
  stamps every event with a recording-relative time using a measured clock
  offset (§4.5) and draws the overlay into every frame (§6).

## 2. Tech stack

D3: **Vite + React + TypeScript + Tailwind v4 + vite-plugin-pwa, pnpm,
Vitest**, plus one Vercel function.

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript | Captain's default; the engine, protocol and helper benefit from shared types |
| Build | Vite | Static output, fast dev server, first-class PWA plugin |
| UI | React | A handful of screens with real state; the captain knows it |
| Styling | Tailwind v4 | Already used on story-platform; the UI is mostly layout and large type |
| PWA | vite-plugin-pwa (Workbox `generateSW`) | Manifest + precached shell; `registerType: 'prompt'` so an update never swaps code mid-match |
| State | React state + a pure `reduce(config, events)` | The engine is pure; keep the store thin |
| Helper | `api/signal.ts`, a single `fetch` handler on the Node runtime, `@upstash/redis` | Vercel builds one function per file under `api/` for non-framework projects and recommends one handler that routes by pathname (https://vercel.com/docs/functions/quickstart) |
| Tests | Vitest (engine, reducer, protocol, helper with an in-memory store); Playwright later | Pure functions carry the risk |
| QR | `qrcode` (generate), `zxing-wasm` (scan; `BarcodeDetector` is off by default on iOS, §9) | |
| WebRTC | Browser APIs directly | One peer, one data channel |
| Overlay | Canvas 2D drawing function in `src/overlay/` | Runs on the camera phone per frame; reusable on a Mac later (node-canvas) |
| Validation | Hand-written type guards for the ~9 message types and the helper's bodies | Smaller than a schema library |

Next.js was considered and rejected: no server rendering, one API route, no
multi-page routing. The function lives beside the Vite app without a framework.

Repository layout (for later, not created by this task):

```
api/signal.ts    the helper (routes /api/signal/*)
src/
  engine/        config, events, reducer, rules, positions (pure, tested)
  protocol/      message types, guards, clock offset
  pairing/       helper client, RTCPeerConnection, QR show/scan, reconnect
  recording/     getUserMedia, compositor, MediaRecorder, opfs worker, export
  overlay/       drawOverlay(ctx, state, box, theme), theme
  ui/            screens S0..S5, C1..C4
  speech/        phrases, speechSynthesis wrapper, click sounds
docs/            these docs, docs/mockup
```

## 3. Score engine

### 3.1 Match config

```ts
type Team = 'A' | 'B';
type Format = 'bestOf3' | 'fixed2' | 'fixed1';            // D12
interface MatchConfig {
  pointsToWin: 11 | 15 | 21;
  winBy: 2;
  cap: number;                    // 30 for 21; pointsToWin + 9 otherwise
  format: Format;
  intervalAt: number | null;      // 11, or null to disable
  intervalMs: { midGame: 60_000; betweenGames: 120_000 };
  doubles: boolean;
  teams: Record<Team, { name: string; color: string; players: string[] }>;  // 1 or 2 names
  firstServer: Team;
  startRight: Record<Team, 0 | 1>;   // doubles: index of the player who starts in the right court
  leftTeamAtStart: Team;             // left of the scoreboard screen (S1)
  reasons?: 'off' | 'endOfGame';     // D15 point reasons; absent (before D15) = off
}
```

### 3.2 Derived state

```ts
interface MatchState {
  phase: 'playing' | 'interval' | 'gameOver' | 'matchOver';
  game: number;                               // 1-based
  score: Record<Team, number>;
  games: Record<Team, number>;
  completed: Array<Record<Team, number>>;
  server: Team;
  serverIdx: number;                          // index into teams[server].players
  pos: Record<Team, { right: number; left: number }>;   // who stands in which service court
  leftTeam: Team;                             // which team is on the left of the scoreboard
  gamePoint: Team | null;
  matchPoint: Team | null;
  winner: Team | null;                        // null until decided; stays null for a fixed-2 draw
  intervalKind: 'midGame' | 'betweenGames' | null;
  pendingSwap: boolean;                       // ends change when the current interval closes
}
```

Derived helpers: `servingCourt(s)` is `right` when the server's score is even,
`left` when odd (Laws 10.1, 11.1); `receiverIdx(s)` is the receiving team's
player in the court of the same name (diagonal). `gamePoint` when a team is
one point from winning the game; `matchPoint` when that game would also decide
the match: in best of 3 when it would be the second game won, in fixed
formats only in the last game and only if it would give that team more games
than the other (a 1-1 is a draw, not a match point).

### 3.3 Events (append-only)

```ts
interface EventBase { seq: number; id: string; at: number; by: string }
// at = wall clock ms on the scoreboard phone; by = device id
type MatchEvent = EventBase & (
  | { type: 'match.start'; config: MatchConfig }
  | { type: 'point'; team: Team }
  | { type: 'undo'; target: number }      // seq of the event being voided
  | { type: 'redo'; target: number }      // seq of the undo being voided
  | { type: 'correct'; score: Record<Team, number>; games?: Record<Team, number>;
      server: Team; serverIdx?: number; leftTeam?: Team }
  | { type: 'sides.swap' }                // ends
  | { type: 'courts.swap'; team: Team }   // the two players of one team swap service courts
  | { type: 'server.set'; team: Team; idx?: number }
  | { type: 'interval.end' }              // user dismissed or countdown ended
  | { type: 'game.start'; game: number; serverIdx?: number; receiverIdx?: number }
  | { type: 'match.end'; reason: 'won' | 'abandoned' }
  // D15: why a point was won. `point` is the point event's id; the newest valid tag of a live point wins.
  | { type: 'tag'; point: string; how: 'winner' | 'forced' | 'unforced';
      hit: PlayerRef;          // who played the last shot: the side that won for a winner, else the side that lost
      forcedBy?: PlayerRef;    // forced error: the winning side's player who forced it
      assist?: PlayerRef;      // doubles: the partner of the finisher (or of forcedBy) who played the side's previous shot
      shot?: 'smash' | 'kill' | 'drop' | 'net' | 'drive' | 'clear' | 'serve' }
  | { type: 'tag.clear'; point: string }
);
// PlayerRef = { team: Team; idx: number }  (index into teams[team].players)
```

- `seq` is dense and increasing on the scoreboard phone; `id` is random so a
  resent event is deduplicated.
- **Tags (D15, `engine/tags.ts`).** A tag is an input like any other: the
  camera applies it, in any phase, when the match asks why (`reasons`), the
  point is a live counted one and the tag fits it (`validTag`: a winner by the
  side that won the rally, an error by the side that lost it, forced-by from
  the winning side, an assist only in doubles and only the partner); else
  `ignored`. Tags are not undoable: Undo keeps taking back the last scoring
  action and a newer tag (or `tag.clear`) changes one. A voided point drops
  its tags, a redo brings them back; the reducer passes over tags, so the
  score, the overlay and speech never see them. Naming the point by `id` (not
  `seq`) keeps it the same on every phone whoever orders the log.
- **Stats.** `matchStats(config, events)` is a pure fold: it replays the
  reducer once to learn each counted rally's game, server and receiver (a
  point made in game over is not a rally), takes the newest valid tag of
  each, and counts per game and for the match: per player W, forced, A, FE,
  UE; per team points from own winners, the other side's forced and unforced
  errors, and untagged; winners by shot; longest run, points won on serve
  and duration (no tag needed). The scoreboards' cards and `match.json`
  `stats` both come from it.
- **Undo as events.** `undo` voids its target; `redo` voids an `undo`. The
  reducer first computes the void set, then replays the remaining events in
  order. Undo targets the last non-voided *user* event (`point`, `correct`,
  `sides.swap`, `courts.swap`, `server.set`, `game.start`, `interval.end`).
  The log keeps the voided point, so the video timeline still shows when it
  was tapped and taken back.
- **Derivable state.** `reduce(config, events) -> MatchState` is pure. The UI
  never stores the score separately (R-SCORE-8).

### 3.4 Rules in the reducer

| On | Rule | Source |
|---|---|---|
| `point(team)` while `playing` or `interval` | `score[team]++`. Singles: `server = team`. Doubles, serving side scored: same `serverIdx`, the two players of `team` swap courts. Doubles, receiving side scored: `server = team`, nobody moves, `serverIdx` = the player of `team` in the court matching its score parity | Laws 7.3, 10.1, 11.2, 11.3 |
| after a point | game won when `score >= pointsToWin && lead >= winBy`, or `score == cap`; then `games[winner]++`, `completed.push`; match over when best of 3 reaches two games, or the last fixed game is done; `winner` = team with more games, else null (draw) | Laws 7.2, 7.4, 7.5; D12 |
| after a point, not game-winning | if `intervalAt` and the leading score just became `intervalAt` for the first time this game: `phase = interval`; `pendingSwap` when this is the third game of a best of 3 or a fixed-1 game | Laws 16.2.1, 8.1.3 |
| `interval.end` | `phase = playing`; apply `pendingSwap` to `leftTeam` | |
| `game.start(n, serverIdx?, receiverIdx?)` | reset `score`; `server` = winner of the previous game; swap `leftTeam`; doubles: the chosen server and receiver (defaults: current right-court players) are placed in their right courts | Laws 7.6, 8.1.1, 8.1.2, 11.1 |
| `correct` | overwrite `score`, `games`, `server`, `serverIdx`, optionally `leftTeam`; in doubles rotate the serving pair so the server stands in the parity court; recompute flags; `phase = playing` | R-SCORE-7 |
| `sides.swap`, `courts.swap`, `server.set` | as named; `courts.swap` changes positions only (the serving player stays the same person) | R-SCORE-7 |
| `match.end` | `phase = matchOver`, `winner` from games | |

The BWF Laws of Badminton are published in the BWF Statutes, section 4.1
(https://corporate.bwfbadminton.com/statutes/). The reducer is table-driven so
formats and point targets are config only. The plain-JS engine in
`docs/mockup/index.html` implements exactly this table and passed the
R-SCORE-3 sequence, deuce, cap, undo/redo across a game boundary, the
deciding-game ends change and the fixed-2 draw; it is the reference for the
phase 1 tests.

Invariants the tests enforce: replay is deterministic; `undo` then `redo` is
the identity on state; a `point` during `gameOver` or `matchOver` is ignored;
`seq` has no gaps; in doubles the server always stands in the parity court
unless a `courts.swap` says otherwise; `winner` is null exactly for a 1-1 in
fixed 2.

### 3.5 Persistence and sharing (D14)

- Unpaired, the scoreboard phone writes `{config, events}` to IndexedDB after
  every event. On launch an unfinished match is offered for resume
  (R-SCORE-9). It can export its log alone (R-EXP-1).
- Paired, the camera holds the match (`link/hub.ts`, kept in localStorage
  across a reload for up to 6 h, forgotten once no scoreboard is paired). A
  scoreboard tap becomes an **input** `{id, at, by, body}`: an event body
  whose `undo`/`redo` carry no target. The camera applies it
  (`engine/input.ts`): it gets the next `seq`, the input's id as its id (a
  resend is recognised), and its time on the camera's clock (`at` minus that
  link's measured offset, never earlier than the event before, so the log
  stays in time order); `undo`/`redo` target the newest event, whichever
  scoreboard sent it; inputs that make no sense in the phase (a point between
  games, a second `interval.end` when both countdowns end, a stale
  `game.start`) are `ignored`. A `match.start` input replaces the camera's
  match on every phone.
- **The same rally twice.** A point to the same side from a different
  scoreboard within `DUPLICATE_WINDOW_MS` = 1500 ms of a live point is
  `duplicate`: not applied, and the sender shows "Already counted". One rally
  plus the next serve takes longer, the same scoreboard tapping twice is never
  merged (undo exists), and the window is compared on the camera's clock, so
  it also catches a tap that arrives late after a drop. Firstmate's default;
  one constant.
- Each scoreboard shows the camera's log with its own unanswered inputs
  applied on top (`match/store.ts`), so a tap shows and is announced at once and
  scoring never waits for the link (R-PAIR-3); the camera's `event` confirms an
  input, its `result` drops one it did not apply. The scoreboard persists that
  view with its pending inputs, so a reload sends them later. Unpaired, what
  it shows becomes its own match again.
- On joining: a camera with a match gives it to the scoreboard, which drops
  whatever it showed (pending inputs for the camera's match are kept and
  sent); a camera without one adopts the scoreboard's (`sync`). The camera's
  `at` times are shown as they are on the scoreboards: both phones keep
  network time, so the difference is far below what a countdown shows.
- The camera also writes its log plus recording metadata (§6.6) to the
  match's OPFS directory while recording.

## 4. Pairing, signaling and reconnect

### 4.1 Shape (D2)

The helper is a mailbox for WebRTC session descriptions. The phones connect
to each other over the local network when they share one (host candidates);
when they do not, e.g. both on mobile data, through a TURN relay whose
credentials the helper mints (D13 as revised on 2026-10-28). The helper never
sees match data, and the relay only forwards the encrypted data channel.
Internet is needed on both phones whenever descriptors are exchanged: at
pairing and at each reconnect, and for as long as the link is relayed.

Options the captain chose between are summarised for the record: the offline
two-QR handshake (no server, two scans, manual re-pair after drops) is kept
as a later fallback in §4.6; third-party signaling (PeerJS cloud) was rejected
for the external dependency.

### 4.2 Helper API

One function, `api/signal.ts`, routes by pathname (a `vercel.json` rewrite
sends `/api/signal/:path*` to it). JSON bodies, no cookies, CORS not needed
(same origin).

| Method and path | Who | Body → response | Store effect |
|---|---|---|---|
| `POST /api/signal/rooms` | camera | `{offer}` → `{code, session, secret}` | `room:<code>` → session (TTL 600 s); `sess:<session>` → `{secret, offer:{gen:1,sdp,at}}` (TTL 6 h) |
| `GET /api/signal/rooms/:code` | scoreboard | → `{session, secret, offer}` | deletes `room:<code>` (one-shot) |
| `POST /api/signal/sessions/:session/answer` | scoreboard | `{secret, gen, answer}` → 204 | sets `answer:{gen,sdp,at}`, refreshes TTL |
| `GET /api/signal/sessions/:session/answer?gen=N` | camera | → `{answer}` or 204; secret in `X-Signal-Secret` | |
| `POST /api/signal/sessions/:session/offer` | both | `{secret, gen, offer, fresh, by}` → 204 | reconnect: new offer with `gen+1`; `by` is the phone that made it (D14: a scoreboard back from a locked screen offers too) |
| `GET /api/signal/sessions/:session/offer?gen=N` | (protocol 1) | → `{offer}` or 204 if none newer than N; secret in `X-Signal-Secret` | |
| `GET /api/signal/sessions/:session/poll?gen=N&role=R` | both | → `{offer}` when the other phone's offer is newer than N, else `{answer}` when the answer to this phone's own offer N is there, else 204; secret in `X-Signal-Secret` | |
| `POST /api/signal/sessions/:session/end` | both | `{secret}` → 204 | session marked `ended` (every later call: 410 `ended`), offer and answer deleted |
| `GET /api/signal/sessions/:session/ice` | both | → `{relay:'ok', iceServers, ttl}` or `{relay:'not-configured'}`; 503 `{error:'relay-failed', reason}`; secret in `X-Signal-Secret` | rate counter only |

The camera holds one session per scoreboard slot (`pairing/slots.ts`): a
second scoreboard pairs through a second room, so the helper needs nothing
new for it. Offers and answers are stored as `{gen, sdp, fresh, at, by}`; `fresh` marks a
description for a new `RTCPeerConnection` rather than an ICE restart of the
current one (the scoreboard sets it on an answer when it had to start over,
e.g. after a reload).

- **Room code:** six random digits, collision-checked, valid 10 minutes, deleted
  on first read. Shown as a QR of `https://<app>/#pair=482107` (the code only;
  the session secret comes back from `GET rooms/:code`) and as digits for
  typing (R-PAIR-1).
- **Session:** 128-bit random id plus a 128-bit secret generated by the helper
  and returned to the camera phone; every call on the session carries the secret. Lifetime 6 h, refreshed on each write,
  so a match never outlives its session (R-PAIR-9).
- **Polling, not push:** the waiting side polls every 2 s. A match produces a
  few hundred requests, which is nothing. Vercel function WebSockets exist in
  beta but close at the function's maximum duration and need external state
  anyway (https://vercel.com/guides/do-vercel-serverless-functions-support-websocket-connections).
- **Rate limit:** `GET rooms/:code` is limited to 20 per minute per IP with a
  Redis counter, so a six-digit code cannot be brute-forced within its
  lifetime. The remaining risk (someone guessing a live code) is accepted for a
  personal app; the secret in the QR path is never guessable.
- **TURN credentials:** `sessions/:session/ice` asks Cloudflare Realtime TURN
  for credentials valid `TURN_TTL_S` = 3600 s (`POST
  https://rtc.live.cloudflare.com/v1/turn/keys/<TURN_KEY_ID>/credentials/generate-ice-servers`
  with `Authorization: Bearer <TURN_KEY_API_TOKEN>` and `{"ttl":3600}`, which
  answers 201 with `iceServers`,
  https://developers.cloudflare.com/realtime/turn/generate-credentials/;
  credentials can live up to 48 h). Only the TURN entry is passed on; the key
  and its token stay in the function's environment. A rejected key is
  `reason: auth`, an API error `upstream`, no answer within 3 s
  `unreachable`. Without `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` the answer is
  `not-configured` and the phones stay on the local network. 30 requests per
  minute per IP; only for a live session with its secret, so the relay cannot
  be used by anyone who has not created or claimed a room.
- **Store:** a Redis database from the Vercel Marketplace (Upstash; Vercel KV
  was retired into it in December 2024, https://vercel.com/docs/redis). The
  integration injects the REST URL and token as project environment variables
  (names are shown in the project's Environment Variables after install) and
  `Redis.fromEnv()` from `@upstash/redis` reads them
  (https://upstash.com/docs/redis/howto/vercelintegration). All keys are
  written with `EX` so nothing lives past its TTL. Local development uses an
  in-memory `Map` behind the same interface when `SIGNAL_STORE=memory`.

### 4.3 Pairing sequence

```
Camera phone                                  Scoreboard phone
1  preview stream running (camera permission granted)
2  pc = new RTCPeerConnection({ iceServers: [] })      // no session yet, so no credentials
3  dc = pc.createDataChannel('match', { ordered: true })
4  createOffer; setLocalDescription; wait for gathering complete (<= 2 s)
5  POST rooms {offer} -> code, session, secret
6  GET sessions/:s/ice -> TURN credentials (or not-configured: skip to 9 with gen 1)
7  new pc with STUN + TURN; offer again, gathering <= 5 s
8  POST sessions/:s/offer {gen:2, fresh}      // the claim returns the latest offer
9  show QR + digits
                                              10 open camera (viewfinder); scan QR or type digits
                                              11 GET rooms/:code -> offer, session, secret
                                              12 GET sessions/:s/ice -> TURN credentials
                                              13 pc = new RTCPeerConnection({ iceServers })
                                              14 setRemoteDescription(offer); createAnswer; setLocalDescription;
                                                 wait for gathering complete
                                              15 POST sessions/:s/answer {gen, answer}
16 poll GET sessions/:s/answer?gen=N every 2 s -> setRemoteDescription(answer)
17 data channel 'open' on both sides -> hello, sync, rec state (§4.4)
```

**ICE servers** (`pairing/ice.ts`): with credentials, STUN
(`stun:stun.cloudflare.com:3478`, fallback `stun:stun.l.google.com:19302`)
and one TURN URL per transport: UDP 3478, TCP 3478 and TLS on 443, so a
carrier network that blocks UDP still relays (port 53 is dropped: browsers
block it and, without trickle ICE, its timeout would hold up every
gathering). Without credentials the list is empty, exactly the
local-network-only connection of before. ICE tries candidate pairs by
priority and host candidates rank highest, so two phones on one Wi-Fi still
connect directly; only phones that cannot reach each other end up on the
relay. Which pair carries the link is read from `getStats()` (the transport's
selected pair) and shown in the pairing diagnostics as `direct` or `relay`;
a peer-reflexive remote address that is one of the other phone's relay
candidates counts as relay.

**Why the camera permission matters.** WebKit withholds host ICE candidates
until the page has camera or microphone permission; without it only
server-reflexive and relay candidates are produced, which with no STUN/TURN
means none (WebKit, "A Closer Look Into WebRTC",
https://webkit.org/blog/7763/a-closer-look-into-webrtc/; WebKit bug 174500,
https://bugs.webkit.org/show_bug.cgi?id=174500). The camera phone has the
permission from its preview; the scoreboard phone gets it from the viewfinder
in S2, which stays open even when the code is typed. Whether WebKit keeps
exposing host candidates in a later gathering (reconnect) after that
viewfinder track was stopped is assumption A1; the fallback is to reopen a
camera track for the duration of the reconnect.

Without capture permission host candidates are published as mDNS names
(`<uuid>.local`) and resolved by the peer with multicast DNS on the same
network (Chrome M73+,
https://groups.google.com/g/discuss-webrtc/c/4Yggl6ZzqZk/m/nV24XkXXAQAJ;
WebKit bug 174500). With it, Safari on iPhone publishes one plain host
candidate, the address of its default route (seen in production on
2026-10-28). This works on a normal Wi-Fi and on a phone hotspot and fails on
networks with client isolation (A2), and between phones on mobile data: each
shows only its carrier address and there is no path between them. The
pairing screens compare the two descriptions' addresses and say so
(`pairing/net.ts`).

No trickle ICE: both sides wait for gathering to complete so one descriptor
carries everything. With no ICE servers, gathering on a LAN completes well
under a second (limit 2 s). With STUN and TURN each server needs its round
trips (limit 5 s); once a relay candidate is in, the gathering ends after
300 ms without another candidate rather than waiting for every server, and
without one (UDP blocked) it waits on for TCP or TLS.

When the phones are on different networks (`pairing/net.ts`) and the link is
still not open 15 s after the answer, both pairing screens say so together
with why the relay did not carry it: not set up, credentials could not be
fetched (with the helper's reason), this phone gathered no relay candidate,
the other phone offered none, or relay candidates on both sides that did not
connect; the diagnostics log the same line.

### 4.4 Message protocol (data channel)

One ordered, reliable channel per scoreboard. Every message is a JSON object
with `v` (protocol version) and `t` (type). Unknown `t` is ignored; an
unsupported `v` is answered with `bye` and surfaces R-PAIR-7. Version 2 (D14):
the camera holds the match; a phone on version 1 is told to update. Version 3
(D15): tag events. A version 2 phone would refuse every `state` carrying one,
so it is told to update too; from 3 on an event or input of a type the build
does not know is kept rather than refused (the reducer passes over it, the
camera answers such an input `ignored`), so a new event type needs no new
version.

```ts
type Role = 'scoreboard' | 'camera';
type Part = [index: number, count: number];
type Msg =
  | { v: 3; t: 'hello'; role: Role; deviceId: string; app: string; ua?: string; matchId?: string; lastSeq?: number }
  | { v: 3; t: 'ping'; id: number; t0: number }
  | { v: 3; t: 'pong'; id: number; t0: number; t1: number; t2: number }
  | { v: 3; t: 'state'; matchId: string | null; config?: MatchConfig; events?: MatchEvent[]; part?: Part }
                                            // camera -> scoreboard: the whole match, or none, on every open
  | { v: 3; t: 'event'; matchId: string; event: MatchEvent }   // camera -> scoreboards: one applied event
  | { v: 3; t: 'input'; matchId: string; input: Input }        // scoreboard -> camera
  | { v: 3; t: 'result'; id: string; result: 'applied' | 'duplicate' | 'ignored' }  // camera -> its sender
  | { v: 3; t: 'sync'; matchId: string; config: MatchConfig; events: MatchEvent[]; part?: Part }
                                            // scoreboard -> camera: its match, when the camera holds none
  | { v: 3; t: 'resync' }                   // scoreboard -> camera: send the whole state again
  | { v: 3; t: 'peers'; count: number }     // camera -> scoreboards: how many are linked
  | { v: 3; t: 'rec'; state: 'idle' | 'recording' | 'stopping' | 'error';   // camera -> scoreboards
      segment?: number; startedAt?: number; elapsedMs?: number; bytes?: number;
      minutesLeft?: number; error?: string }
  | { v: 3; t: 'cmd'; id: string; action: 'rec.start' | 'rec.stop' }        // scoreboard -> camera (D11)
  | { v: 3; t: 'ack'; id: string; ok: boolean; error?: string }             // camera -> the asker
  | { v: 3; t: 'bye'; reason?: 'version' | 'leaving' | 'unpaired' };
```

Examples:

```json
{"v":3,"t":"input","matchId":"m-1793099000000-3f1a","input":{"id":"k3f9","at":1793100000123,"by":"sb-7c2","body":{"type":"point","team":"A"}}}
{"v":3,"t":"event","matchId":"m-1793099000000-3f1a","event":{"seq":17,"id":"k3f9","at":1793100000101,"by":"sb-7c2","type":"point","team":"A"}}
{"v":3,"t":"result","id":"k3f9","result":"applied"}
{"v":3,"t":"rec","state":"recording","segment":1,"startedAt":1793099000456,"elapsedMs":754000,"bytes":565000000,"minutesLeft":26}
```

- **Versioning.** `v` is bumped only for incompatible changes; additive fields
  are allowed within a version. `hello.app` carries the build id so a stale
  service-worker cache on one phone is diagnosed as "update the app"
  (R-PAIR-7).
- **Full-state resync.** On every channel open the camera sends `state`
  with its entire match (a 3-game log is ~40 kB), or `matchId: null`. The
  scoreboard shows nothing as live ("syncing") until it has it, then resends
  its unanswered inputs (R-PAIR-4). The log only grows, so its length is its
  version: an `event` whose `seq` is not the next one makes the scoreboard ask
  for `resync`, as does an open with no `state` within 1.5 s.
- **Message size.** Every message stays under 16 kB; `state` and `sync` are
  split into `part` chunks. MDN notes browsers accept at least 256 kB but the SDP default
  `max-message-size` is 64 kB and large messages block the channel
  (https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels).
- **Liveness.** `ping` every 2 s from both phones; each judges the link by its
  own pongs. 3 missed pongs → chip "reconnecting" (6 s) and the reconnect
  procedure (§4.5 below); after 30 s the chip turns red ("link lost") while
  the phones keep trying. ICE `connectionState` is watched too. The camera's
  clock offset comes from its own pings (the formula below then gives
  scoreboard − camera, which it negates).
- **Commands** (`cmd`/`ack`) are idempotent and carry an id so a retry after a
  blip cannot start two recordings; the ack goes to the scoreboard that asked,
  the `rec` reports to all.

### 4.5 Reconnect and clock offset

Reconnect (R-PAIR-8): when ICE reports `failed`, or pongs are missing for
10 s, the camera phone creates a new offer with `iceRestart: true` on the same
`RTCPeerConnection` and posts it with `gen + 1`; the scoreboard phone, which
polls `offer?gen=N` every 2 s while the link is down, applies it, answers,
and the camera polls the answer. If the connection object is unusable a fresh
one is created. Backoff: 2 s for the first minute, then 5 s. When the helper
is unreachable the chip says "offline" and polling continues at 5 s until it
answers. Nothing is lost meanwhile (R-PAIR-3, R-PAIR-4).

**Screen off and on (D14).** iOS suspends the page when the screen locks,
whether it runs in a Safari tab or from the Home Screen, so the link cannot
stay up with the screen off; the scoreboard keeps its screen on while paired
(§5) and makes the way back fast. On `visibilitychange` to visible,
`pageshow` and `online` (`pairing/live.ts`) each link checks itself
(`resumeAction` in `pairing/reconnect.ts`): a channel that is not open or a
connection that says `failed`, `disconnected` or `closed` counts as gone at
once; otherwise one ping must be answered within `PROBE_MS` = 1 s. A gone
link is not trusted for an ICE restart (the page was suspended): the
scoreboard looks at the helper at once and answers the camera's offer if it
is a fresh one, or else posts a fresh offer of its own (`by: scoreboard`, the
generation above the camera's) and polls for the answer every 500 ms. The
camera, while a link is down, polls `poll` every second for its first two
minutes (2 s to 10 minutes, then 5 s), so it answers within about a second.
Either phone's offer supersedes the other's older one; a 409 means the other
was first, and its offer is taken. When the camera itself dropped, it
reconnects as before.

| Moment | Before (protocol 1) | Now |
|---|---|---|
| Screen on | nothing until a tick finds the pongs missing | probe: 0 to 1 s |
| Camera's offer | ICE restart 10 s after the drop, already waiting; answered in place | a fresh one is answered; a restart is replaced by the scoreboard's own fresh offer |
| Camera sees the answer | next poll: 2 s, 5 s once down over a minute | next poll: 1 s for two minutes |
| Restart that cannot work | 10 s attempt timeout, then a fresh offer, another round trip | not tried |

Measured on 2026-10-29 with two Chrome pages on one Mac (the scoreboard's timers
held and its connection from before left dead while "locked", as iOS leaves
it): link back 13.0 s after a 20 s lock and 19.5 s after 75 s on protocol 1;
0.8 s and 1.5 s now. On the captain's iPhones this is device test A15.

**Unpairing (R-PAIR-11).** `unpair()` sends `bye 'unpaired'`, closes the
connection only once the goodbye has left (it was closed at once before, and
on iPhone the goodbye was lost, so the scoreboard went on showing the camera
reconnecting with its REC state), and posts `end` to the helper, so a phone
whose goodbye was lost learns it at its next poll (410 `ended`). Either way the
other phone resets to unpaired and forgets the saved pairing; the scoreboard
drops the camera's REC state and peer count and keeps the match as its own;
the camera frees that slot.

TURN credentials are fetched per session and cached until 10 minutes before
they expire (the scoreboard renews 20 minutes before); every new connection
and ICE restart takes fresh ones once the cached ones are that old, through
`setConfiguration` for a restart. A relayed link would be cut by the relay
when its credentials expire, so the camera restarts ICE on an open relayed
link 10 minutes before; the scoreboard's answer to it carries new credentials
too. A failed fetch is retried after 30 s ("not configured" after 10
minutes); until then the phone gathers with the credentials it still has, or
with none.

Clock offset (R-PAIR-5): the camera phone maps scoreboard timestamps onto its
own clock with NTP-style round trips from the regular pings:

```
offset_i = ((t1 - t0) + (t2 - t3)) / 2      // t0,t3 scoreboard; t1,t2 camera
rtt_i    = (t3 - t0) - (t2 - t1)
offset   = median of the last 8 samples with rtt < 50 ms
```

On a LAN `rtt` is 2 to 20 ms, so the offset error is a few milliseconds.
Events received live are also stamped with the camera's receive time; events
that arrive by `sync` after a drop rely on the offset alone. Offset and sample
count go into `match.json`.

### 4.6 Later fallback: offline two-QR handshake

For courts without any internet: the camera shows its compacted offer as a
QR, the scoreboard scans it and shows its compacted answer, the camera scans
that. A data-channel-only description shrinks to 250 to 400 bytes (ICE
credentials, DTLS fingerprint, candidates, SCTP port) which is a QR of
version 10 to 13 at error-correction L. It costs a second scan and a manual
re-pair after every drop, which is why it is not v1. The data-channel protocol
is identical; only the transport of the descriptors differs.

## 5. Scoreboard phone specifics

- **Speech.** `speechSynthesis` with an English voice by default (D5); each
  utterance cancels the previous one so a fast rally never queues stale
  scores. The click sound is a pre-decoded Web Audio buffer; the
  `AudioContext` is created on the "Start match" tap (iOS autoplay rules).
- **Wake Lock** (`device/wakeLock.ts`, R-DISP-8): wanted for a live match,
  while paired and on the pairing screen (D14: a locked screen suspends the
  link); requested at once, again on every `visibilitychange` and every tap
  (WebKit may refuse a request without a user gesture). Refused (Low Power
  Mode) or unavailable (iOS before 16.4 in Safari, before 18.4 from the Home
  Screen, §9), one line says the screen may lock. Whether the lock holds in
  the captain's Home Screen app is device test A15.
- **Orientation.** iOS has no lock (§9); a CSS `orientation: portrait` media
  query swaps in the "rotate" screen (R-DISP-7).
- **Touch handling** per ux-design.md §3 with Pointer Events; `touch-action:
  none` on the zones so the browser never interprets the swipe.

## 6. Recording pipeline (camera phone)

### 6.1 Capture

```ts
const cam = await navigator.mediaDevices.getUserMedia({
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  audio: recordAudio ? { echoCancellation: false, noiseSuppression: false } : false,   // D7
});
```

The phone must already be in landscape when the stream starts; iOS captures
in the device orientation at that moment (A6).

### 6.2 Compositing (D9)

```
cam video track -> <video playsinline muted autoplay> (kept in the DOM, visually hidden)
   |  video.requestVideoFrameCallback(frame => {
   |     ctx.drawImage(video, 0, 0, W, H);           // W×H = 1920×1080 or 1280×720
   |     drawOverlay(ctx, stateAt(now - delayMs), box, theme);
   |     video.requestVideoFrameCallback(...);       // one draw per camera frame
   |  })
   v
canvas (the visible preview, CSS-scaled) --captureStream(30)--> composited video track
                                                     + cam audio track
                                                     -> new MediaStream([video, audio])
                                                     -> MediaRecorder -> worker -> OPFS (§6.4)
```

- One draw per delivered camera frame via `requestVideoFrameCallback` (Safari
  15.4+, §9), not `requestAnimationFrame`, so output frames track camera
  frames and the overlay is drawn exactly once per frame.
- `drawOverlay` is a pure Canvas 2D function (`src/overlay/`): a BWF TV style
  two-row panel (players' names, a shuttle for the server, one cell per game
  played, a status band for game point, interval and the like), sized S/M/L
  and only as wide as its content, in the corner chosen in C1 (top-left by
  default; mirroring swaps the rows), plus an optional logo in its own corner
  (top-right by default), stacked when both share one.
  The optional player stats table (R-TAG-7, `src/overlay/table.ts`) is the
  third tenant: each corner stacks panel, logo, table from the frame edge, the
  table takes the first corner nobody owns or the one picked in C1, and a box
  that would still touch another steps past it; the end-of-game card is drawn in
  the middle. Their numbers are `matchStats(cfg, events, cutoff)` for the
  current game, computed in `OverlayClock` only when the visible slice of the
  log changes. It
  cannot be HTML: a canvas cannot rasterise DOM, and SVG `foreignObject`
  taints canvases on WebKit. The same function can run in node-canvas for a
  later Mac re-render (R-BURN-2).
- `stateAt(t)` reduces only events with `at + offset <= t`, which implements
  the optional overlay delay (R-REC-4) with no frame buffering: the camera
  frame is live, the score shown is from `delayMs` ago. Unpaired, nothing is
  drawn.
- Single encode: only the canvas stream is encoded. The cost is the per-frame
  `drawImage` upload and the overlay draw, which is what A4/A13/A14 measure.
- Known history: WebKit's `canvas.captureStream` produced black or single
  frames on Safari 15.x (bugs 216832, 229611, §9). Those are old, but it is
  why phase 0 runs the full 60-minute pipeline before any app code exists.

### 6.3 MediaRecorder

Pick the first supported type with `isTypeSupported`:
`video/mp4;codecs=avc1.42E01E,mp4a.40.2`, then `video/mp4`.
`videoBitsPerSecond` 6 000 000 for 1080p, 3 500 000 for 720p (D8);
`start(1000)` for one-second chunks (R-REC-2).

Safari writes MP4 with H.264 and AAC and, since 18.4, fragmented MP4 with
`moov` first and a zero duration in the headers; QuickTime and Photos play
it, some players show no length until it is remuxed (§9). A later
`ffmpeg -c copy -movflags +faststart` fixes the duration; v1 does not require
it (A3 confirms Photos playback).

### 6.4 Writing to OPFS

```
main thread                                   recording worker
MediaRecorder.ondataavailable(blob)
  blob.arrayBuffer() -> postMessage(buf, [buf]) -->  handle.write(buf, { at: cursor })
                                                     cursor += buf.byteLength
                                                     every 5 s: handle.flush()
on stop:  postMessage('close')               -->  flush(); close(); reply with size
```

- The worker opens `matches/<matchId>/video-<n>.mp4` with
  `createSyncAccessHandle()`, the only OPFS write path on iOS before
  Safari 26 (`createWritable` arrived in Safari 26, §9); it keeps disk I/O
  off the thread that draws frames.
- Each `write` is one second of video (~750 kB at 6 Mbit/s) and happens as
  soon as the chunk arrives, so an app crash loses under a second (R-REC-2).
  `flush` every 5 s bounds what an OS-level crash could lose (A3).
- `QuotaExceededError` on write stops the recorder cleanly, closes the file,
  and reports `rec.state = 'error'` (R-REC-3). No IndexedDB fallback (D10).

### 6.5 Storage estimate, persistence, wake lock, interruptions

- `navigator.storage.estimate()` gives `usage` and `quota`; minutes left =
  `(quota - usage) / bytesPerMinute` (R-REC-3). Safari may under-report the
  quota and it is an upper bound, so the write path still handles
  `QuotaExceededError` (WebKit, "Updates to Storage Policy", §9).
- `navigator.storage.persist()` is called once at first launch and the result
  shown on C1; WebKit grants it by heuristics such as being an installed Home
  Screen app (§9).
- 1080p30 at 6 Mbit/s uses ~2.7 GB/hour; free space is the practical limit.
- `navigator.wakeLock.request('screen')` on REC start, re-requested on
  visibility change; installed iOS web apps need iOS 18.4+ (§9).
- iOS ends or mutes capture tracks when Safari is backgrounded for more than
  ~30 s, and a muted track cannot be unmuted from script (WebKit bugs 179363,
  204681); a phone call or screen lock does the same, and a hidden page also
  stops `requestVideoFrameCallback`. The recorder listens for `track.onended`,
  `track.onmute`, `visibilitychange` and `recorder.onerror`; on any of them it
  stops, closes the segment, and offers "Resume", which re-acquires the camera
  and opens segment `n+1` (R-REC-5). Segments are never stitched on the phone.
- The preview dims with CSS; the canvas keeps being drawn (A7).

### 6.6 Recording metadata (camera-local)

```ts
interface Segment {
  index: number; file: string; mimeType: string;
  width: number; height: number; fps: number;
  startedAt: number;          // camera wall clock at recorder 'start' event
  startLatencyMs: number;     // calibrated in phase 0 (A8), default 0
  endedAt: number | null; bytes: number;
  endReason: 'user' | 'interrupted' | 'quota' | 'error' | null;
  overlay: { box: Box;                          // area the score panel covered over the segment
             boxes: Array<{ at: number; box: Box }>; // its box from each camera time on (it follows content)
             corner: Corner; size: 'small' | 'medium' | 'large'; delayMs: number; mirrored: boolean; theme: string;
             logo: { box: Box; corner: Corner; size: 'small' | 'medium' | 'large' } | null };
  // Box = { x, y, w, h } in pixels; Corner = 'tl' | 'tr' | 'bl' | 'br'
}
```

Stored as `matches/<matchId>/recording.json`, updated on every segment change.

### 6.7 Export

- Build `match.json` (§8) from the mirrored log, `recording.json` and the
  clock offset; write it next to the video in OPFS.
- `navigator.canShare({ files })` then `navigator.share({ files, title })`
  from the tap handler; else `<a download>` per file via
  `URL.createObjectURL` (R-EXP-2). A `File` from `getFile()` is disk-backed;
  whether iOS's share sheet handles a 2 GB file from a web app and offers
  "Save Video" is assumption A5.
- Delete removes the OPFS directory and refreshes the usage figure (R-EXP-3).

## 7. Overlay and later re-render

- v1 burns the overlay live (§6.2). Consequences, stated plainly: a wrong tap
  is in the video from the tap to the undo unless the overlay delay covers it;
  the raw frames under the overlay box are gone; the look is fixed at
  recording time.
- `match.json` records the score box and corner, the logo box (if any),
  delay, mirroring and theme per segment, plus
  every event with recording-relative time and derived state (§8). A later Mac
  tool (R-BURN-2, roadmap.md Later) can therefore paint a new overlay in the
  same box with `drawOverlay` in node-canvas and one ffmpeg `overlay` pass, to
  change the look or fix a logged correction, but not to reveal what was under
  the live overlay. A raw + composited dual recording (two MediaRecorders)
  would allow that at double the encode and storage cost; also Later.

## 8. Export bundle

Flat files sharing one prefix, because the share sheet carries files, not a
directory: `match-<yyyymmdd-hhmm>-video-1.mp4` … `-video-n.mp4` and
`match-<yyyymmdd-hhmm>-match.json` (`recording.segments[].file` holds the
exported names). `match.json`:

```ts
interface MatchBundle {
  format: 'badminton-scoreboard/match'; version: 1;
  matchId: string; createdAt: number; app: string;
  config: MatchConfig;
  devices: { scoreboard: { id: string; ua: string }; camera?: { id: string; ua: string } };
  clock?: { offsetMs: number; samples: number; medianRttMs: number };   // camera − scoreboard; absent in a scoreboard-only export
  recording?: { segments: Segment[] };                                  // §6.6; absent in a scoreboard-only export
  events: Array<MatchEvent & {
    tRec: { segment: number; ms: number } | null;   // null if no segment was recording or no camera
    after: MatchState;                              // derived state after this event, positions included
    leftOnCamera: Team;                             // after.leftTeam, flipped if the segment is mirrored
  }>;
  result: { winner: Team | null; games: Record<Team, number>; completed: Array<Record<Team, number>> };
  stats?: MatchStats;   // D15, derived from the tags in `events` (§3.3); absent when the match did not ask
}
```

`after` and `leftOnCamera` are redundant with `events` + `config` (the log
stays the source of truth) but let a later renderer stay a renderer.
`tRec.ms = (event.at + clock.offsetMs) − segment.startedAt − segment.startLatencyMs`
(R-BURN-1).

## 9. Browser support matrix (iPhone, D1)

Minimum versions (N-BROWSER-1): **iOS 17** (Safari tab), **iOS 18.4**
(installed Home Screen app); iPhone 13 and newer all run the current iOS.
BCD = MDN browser-compat-data, checked 2026-10-27/28 at
https://github.com/mdn/browser-compat-data (files under `api/`).

| API | iOS Safari | Notes | Source |
|---|---|---|---|
| `getUserMedia` | 11 | In installed web apps: fixed in iOS 13.4 (bug 185448); a camera-in-standalone failure was reported on iOS 17.4.1 to 17.6.1 and said to be gone on iOS 18 (bug 273938, still open) | BCD `Navigator.json`; https://bugs.webkit.org/show_bug.cgi?id=185448; https://bugs.webkit.org/show_bug.cgi?id=273938 |
| `HTMLVideoElement.requestVideoFrameCallback` | 15.4 | One callback per delivered camera frame | BCD `HTMLVideoElement.json` |
| `HTMLCanvasElement.captureStream` | 11 | Black/single-frame output reported on Safari 15.x (bugs 216832, 229611); verify on current iOS (A14) | BCD `HTMLCanvasElement.json`; https://bugs.webkit.org/show_bug.cgi?id=216832; https://bugs.webkit.org/show_bug.cgi?id=229611 |
| `MediaRecorder` | 14 (Safari 14.1) | MP4 H.264 + AAC from the start; 18.4 adds fragmented MP4 (also WebM, HEVC, AV1); zero duration in headers | BCD `MediaRecorder.json`; https://webkit.org/blog/11353/mediarecorder-api/; https://webkit.org/blog/16574/webkit-features-in-safari-18-4/; https://blog.addpipe.com/duration-in-mp4-files-produced-by-chrome-safari/ |
| Capture ends when backgrounded | Tracks end/mute after ~30 s in background; cannot unmute from script | Segment resume (§6.5) | https://bugs.webkit.org/show_bug.cgi?id=179363; https://bugs.webkit.org/show_bug.cgi?id=204681 |
| OPFS `navigator.storage.getDirectory()` | 15.2 | | BCD `StorageManager.json` |
| `FileSystemFileHandle.createSyncAccessHandle()` | 15.2 | Dedicated workers only | BCD `FileSystemFileHandle.json`; https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle |
| `FileSystemFileHandle.createWritable()` | 26 | Not usable as the only path on iOS 17/18 | BCD `FileSystemFileHandle.json` |
| `navigator.storage.estimate()` | 17 | Safari may under-report quota | BCD `StorageManager.json`; https://webkit.org/blog/14403/updates-to-storage-policy/ |
| `navigator.storage.persist()` | 15.2 | Granted by heuristics, no prompt; installed Home Screen app counts | BCD; WebKit 14403; https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria |
| Origin quota | ~60 % of total disk (Safari 17+), 80 % overall; same for Home Screen apps; no prompt; LRU whole-origin eviction | Before Safari 17: 1 GiB then a prompt | WebKit 14403; MDN quotas page; https://web.dev/articles/storage-for-the-web |
| 7-day storage deletion (ITP) | Script-written storage deleted after 7 days of Safari use without interaction; Home Screen apps have their own counter and are not expected to lose data | Install to the Home Screen | https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ |
| WebRTC data channel | yes | Host candidates only after capture permission; mDNS `.local` candidates | https://webkit.org/blog/7763/a-closer-look-into-webrtc/; https://bugs.webkit.org/show_bug.cgi?id=174500 |
| Screen Wake Lock | 16.4 in Safari; **18.4 in Home Screen apps** | Released when the page is hidden | BCD `WakeLock.json`, `Navigator.json`; https://bugs.webkit.org/show_bug.cgi?id=254545 |
| Web Share with files | 14 | Needs a user gesture; check `canShare` first | BCD `Navigator.json`; https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share |
| Vibration | **no** | No haptics | BCD `Navigator.json` |
| `screen.orientation.lock()` | **no** | Rotate prompt instead | BCD `ScreenOrientation.json` |
| `BarcodeDetector` | 17, **behind a default-off preference** | Use `zxing-wasm` | BCD `BarcodeDetector.json` |
| `speechSynthesis` | 7 | Voice list differs per device | BCD `SpeechSynthesis.json` |
| `navigator.userActivation` | 16.4 | For share/audio gating | BCD `Navigator.json` |
| Home Screen install | Any site; iOS 26 opens it as a web app by default | | https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ |

Android Chrome 126+ has every API above (OPFS 109, Wake Lock 84, MP4
recording 126, Vibration 32, orientation lock 38, BarcodeDetector 83; BCD) and
is untested; see roadmap.md Later.

### Assumptions to test on the captain's iPhones (phase 0)

- **A1** After pairing through the helper, a later ICE gathering (reconnect)
  still yields host candidates once the scoreboard's viewfinder track has been
  stopped; if not, reopening a camera track during reconnect fixes it.
- **A2** Two phones connect over mDNS host candidates with no STUN on the
  same Wi-Fi and on a phone hotspot (host phone in either role); whether iOS
  shows a "Local Network" prompt and the connection survives it.
- **A3** Safari's 1-second MediaRecorder chunks, appended byte-for-byte, form
  a file that Photos plays and ffmpeg remuxes cleanly, on the actual iOS
  version.
- **A4** Sustained compositing: `requestVideoFrameCallback` → `drawImage` →
  overlay → `captureStream(30)` + mic → MediaRecorder for 60 minutes at
  1080p30 and at 720p30: average fps, longest gap, temperature, battery (plugged
  and unplugged), thermal throttling (R-REC-8).
- **A5** `navigator.share` with a 2 GB file from OPFS: completes, and the
  sheet offers "Save Video" and AirDrop.
- **A6** Capture orientation: stream started in landscape stays landscape;
  what happens if the phone is rotated after start.
- **A7** A CSS-dimmed canvas keeps being drawn and captured at full rate.
- **A8** Recorder start latency (`start()` to first encoded frame) measured
  with a clap, to fill `startLatencyMs`.
- **A9** `speechSynthesis`: audible with the silent switch on? Thai voice
  present? Loud enough at 3 m in a gym?
- **A10** Scoreboard phone battery after 60 minutes with the screen on.
- **A11** Installed Home Screen app on the actual iOS version: camera works
  in standalone mode (bug 273938), Wake Lock holds, `persist()` granted.
- **A12** `estimate().quota` values and how Safari reports them for an
  installed app.
- **A13** Audio/video drift between the canvas track and the microphone track
  after 60 minutes (clap at the end, inspected in a video editor).
- **A14** `canvas.captureStream` + MediaRecorder on current iOS produces a
  valid, continuous MP4 (no black or frozen frames) with and without timeslice.
- **A15** (D14) A paired scoreboard in the Home Screen app keeps its screen on
  for 10 minutes untouched (Wake Lock; BCD gives 18.4 for installed web apps,
  16.4 in Safari), and shows the hint in Low Power Mode. After the screen was
  locked for a minute, the link is back within 5 s of unlocking; the pairing
  diagnostics log the `resume` line and the time. Not yet run on the
  captain's iPhones.

## 10. Deployment on Vercel

- Framework preset: Vite; build `pnpm build`; output `dist/`
  (https://vercel.com/docs/project-configuration/vercel-json). Every
  deployment is HTTPS, which `getUserMedia`, OPFS and service workers require.
- `api/signal.ts` deploys as one function (§2). Install a Redis integration
  from the Marketplace on the project; redeploy after the environment
  variables appear. For the relay, `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` from
  a Cloudflare TURN key go into the project's environment (deploy.md §3).
- `vercel.json`: a rewrite from `/api/signal/:path*` to `/api/signal`; headers
  so the service worker and `index.html` are never cached
  (`Cache-Control: public, max-age=0, must-revalidate`) and Vite's hashed
  `assets/*` are `public, max-age=31536000, immutable` (syntax per the Vercel
  docs example: `headers[].source`, `headers[].headers[].{key,value}`).
- No COOP/COEP headers; nothing here needs cross-origin isolation.
- PWA: manifest with `display: standalone`, icons; Workbox precache of the
  shell; update flow `prompt` (never auto-reload while a match or recording is
  live).
- Preview deployments give an HTTPS URL per branch, with the function and the
  store, for phone testing without local setup.

## 11. Local development

- `vercel dev` runs the Vite dev server and the function together; with
  `SIGNAL_STORE=memory` the helper needs no Redis (§4.2). `vercel env pull`
  fetches the Marketplace variables when the real store is wanted.
- A LAN IP is not a secure context: camera, OPFS sync handles and the service
  worker refuse to run. **Recommended:** Tailscale Serve. The Mac Studio is
  already on a tailnet; `tailscale serve 3000` publishes
  `https://<mac>.<tailnet>.ts.net` with a valid certificate to every device on
  the tailnet (https://tailscale.com/kb/1312/serve; HTTPS certificates must be
  enabled on the tailnet). Both phones need the Tailscale app signed in. The
  WebRTC connection still runs over the LAN. **Alternative:** `mkcert` with its
  root certificate trusted on both phones.
- Two Chrome tabs on the Mac can pair with each other through the local helper
  for engine and protocol debugging; one phone plus desktop Chrome covers most
  of the rest. Phase 0 uses throwaway pages served the same way.

## 12. Testing strategy

- **Engine (Vitest):** table-driven rule tests for 11/15/21 points and the
  three formats: deuce, cap, interval trigger, side changes (deciding game and
  fixed-1 at 11, none in fixed 2), the fixed-2 draw and its absent match
  point, server after a game, the R-SCORE-3 doubles sequence, server/receiver
  choice at a game start, `courts.swap`, `correct` in doubles; property tests:
  replay determinism, undo/redo identity, invariants after random event
  streams. The mockup's engine is the first-cut reference.
- **Protocol and helper:** guards accept every example in §4.4 and reject
  malformed input; clock-offset maths with synthetic jitter; `sync` chunk
  reassembly; the helper against the in-memory store: room one-shot, TTLs,
  secret check, generation ordering, rate limit.
- **Recording worker:** unit test with a fake handle (append order, flush,
  quota error path).
- **Device checklist:** A1 to A14 in §9, then per phase the acceptance
  criteria in requirements.md, on the real phones. The 60-minute soak is part
  of phase 0 and again of phase 2's definition of done.
- **Playwright (later):** two Chromium contexts pairing through the local
  helper, exercising sync and reconnect.

## 13. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Canvas compositing drops frames or overheats the phone over an hour | medium | unusable recordings | Phase 0 runs the full pipeline first; 720p default if needed; power bank; D9 revisited only on a double fail |
| `canvas.captureStream` instability on the actual iOS (history of WebKit bugs) | low-medium | black or frozen video | A14 in phase 0; segment restart on detected stalls (frame counter watchdog) |
| Audio/video drift between canvas and mic tracks | medium | lip-sync off at the end | A13 measured; if present, record at 720p or restart segments hourly |
| LAN WebRTC fails (mDNS blocked, hotspot quirks, iOS local-network prompt, host candidates withheld on reconnect, phones on mobile data) | medium | no live overlay | A1/A2 first; keep the viewfinder track alive through pairing; the TURN relay (D13 as revised) carries the link when no direct path exists; each phone still works alone |
| No internet on the court | medium | no pairing, clean video without overlay | Stated in the UI; scoreboard exports its log; two-QR fallback under Later |
| Wrong tap burned into the video | high | visible mistake | One-tap undo, 800 ms refractory, overlay delay setting (R-REC-4) |
| Camera stops in installed iOS app (bug 273938) | low-medium | no recording | Run the camera role in a Safari tab on that iOS version; A11 |
| Storage evicted before export | low (persisted, installed) | lost match | `persist()`, install prompt, "export today" nudge, show usage |
| Room code guessed while live | very low | a stranger pairs | 10-minute one-shot codes, per-IP rate limit |
| Helper down or store misconfigured | low | cannot pair | Clear error with the reason; the phones still work alone |
| Phone overheats or dies mid-match | medium | lost video | Power bank advice, 720p option, measured in A4 |
| Audio too quiet in a gym | medium | feature unused | Short phrases; Bluetooth speaker works with no code change |
| Service worker serves a stale build on one phone | medium | version mismatch | `hello.app` check, update prompt (R-PAIR-7) |
