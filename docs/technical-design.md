# Technical design

Architecture and implementation plan for the two-phone scoreboard. Requirement
ids refer to [requirements.md](requirements.md); open choices (D1 to D13) live
only there and this doc assumes the recommended defaults. Screens (S*, C*)
refer to [ux-design.md](ux-design.md).

Every browser-support claim in §9 was checked on 2026-10-27 against MDN's
browser-compat-data, WebKit's blog and bug tracker, or Chromium sources, and
cites the page. Claims that could not be verified are listed as assumptions to
test on the captain's phones in phase 0 of [roadmap.md](roadmap.md).

## 1. Architecture

```
            Vercel (static files only, HTTPS)
                       |
          first visit / updates only
                       |
   +-------------------+-------------------+
   |                                       |
 Scoreboard phone (PWA)             Camera phone (PWA)
   score engine, event log            getUserMedia + MediaRecorder
   speech, UI                         worker -> OPFS (video file)
   localStorage/IDB: live match       event mirror, overlay, export
   |                                       |
   +----- WebRTC data channel (LAN) -------+
           JSON messages, no media
```

- **One static web app, two roles.** The same bundle serves both phones; the
  role is chosen at launch (R-SETUP-1). No server-side code in v1.
- **No backend.** Vercel serves the shell and assets. Video, scores and names
  never leave the phones (N-PRIV-1). The only case that would add a backend is
  D2(b), a signaling helper, and even then it only relays connection
  descriptors.
- **Scoreboard phone is the source of truth** for the match (config + event
  log). The camera phone mirrors it and adds recording metadata. There is no
  merge problem because only one side writes score events.
- **Camera phone owns the recording timeline.** It stamps every event with a
  recording-relative time using a measured clock offset (§4.5).

## 2. Tech stack

Recommendation (D3): **Vite + React + TypeScript + Tailwind v4 +
vite-plugin-pwa, pnpm, Vitest.** Minimal, familiar, no server runtime.

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript | Captain's default; the engine and protocol benefit from types |
| Build | Vite | Static output, fast dev server with `--host` for phone testing, first-class PWA plugin |
| UI | React | Four screens with real state (setup forms, overlays, link state); the captain knows it. Preact would save ~35 kB and is a drop-in if bundle size ever matters |
| Styling | Tailwind v4 | Already used on story-platform; the UI is mostly layout and large type |
| PWA | vite-plugin-pwa (Workbox `generateSW`) | Manifest + service worker with precached shell; `registerType: 'prompt'` so an update never swaps code mid-match |
| State | React state + a pure `reduce(events)` function; `zustand` only if prop-drilling hurts | The engine is pure; keep the store thin |
| Tests | Vitest (engine, reducer, protocol), Playwright later for the two-browser protocol test | Pure functions carry the risk; UI tests can wait |
| QR | `qrcode` (generate), `BarcodeDetector` where present with `zxing-wasm` fallback (scan) | iOS Safari ships `BarcodeDetector` behind a default-off preference (§9), so a JS decoder is mandatory |
| WebRTC | Browser APIs directly, no wrapper | One peer, one data channel; a library would hide the signaling choices in §4 |
| Validation | Hand-written type guards for the ~9 message types | Smaller than a schema library and easy to read |

Next.js (the story-platform stack) was considered and rejected: there is no
server rendering, no API route (unless D2(b)), and no multi-page routing. Its
build pipeline and runtime add nothing here and complicate the PWA setup.
If D2(b) is chosen later, a single Vercel serverless function can live in
`api/` next to the Vite app without switching frameworks.

Repository layout (for later, not created by this task):

```
src/
  engine/      match config, events, reducer, rules  (pure, tested)
  protocol/    message types, guards, sdp compaction, clock offset
  pairing/     RTCPeerConnection setup, QR show/scan
  recording/   getUserMedia, MediaRecorder, opfs worker, export
  ui/          screens S0..S5, C1..C4, shared components
  speech/      phrases, speechSynthesis wrapper, click sounds
tools/
  burnin/      Mac-side renderer (phase 3)
docs/
```

## 3. Score engine

### 3.1 Match config

```ts
type Team = 'A' | 'B';
interface MatchConfig {
  pointsToWin: 11 | 15 | 21;      // D12
  winBy: 2;
  cap: number;                    // 30 for 21-point games; pointsToWin + 9 otherwise
  gamesToWin: 1 | 2;              // best of 1 or 3
  intervalAt: number | null;      // 11, or null to disable (D12)
  intervalMs: { midGame: 60_000; betweenGames: 120_000 };
  teams: Record<Team, { name: string; color: string }>;
  firstServer: Team;
  leftTeamAtStart: Team;          // left of the scoreboard screen (S1)
}
```

### 3.2 Derived state

```ts
interface MatchState {
  phase: 'playing' | 'interval' | 'gameOver' | 'matchOver';
  game: number;                          // 1-based
  score: Record<Team, number>;           // current game
  games: Record<Team, number>;           // games won
  completed: Array<Record<Team, number>>;
  server: Team;
  serviceCourt: 'right' | 'left';        // right when server's score is even (Laws 10.1, 11.1)
  leftTeam: Team;                        // which team is on the left of the scoreboard
  gamePoint: Team | null;
  matchPoint: Team | null;
  intervalKind: 'midGame' | 'betweenGames' | null;
  intervalEndsAt: number | null;         // wall clock, for the countdown
}
```

Derived flags: `gamePoint` when a team is one point from winning the game
under the win-by-2/cap rule; `matchPoint` when that game would also win the
match.

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
      server: Team; leftTeam?: Team }
  | { type: 'sides.swap' }
  | { type: 'server.set'; team: Team }
  | { type: 'interval.end' }              // user dismissed or countdown ended
  | { type: 'game.start'; game: number }  // explicit, see ux-design.md §5
  | { type: 'match.end'; reason: 'won' | 'abandoned' }
);
```

- `seq` is dense and increasing on the scoreboard phone; `id` is random so a
  resent event is deduplicated.
- **Undo as events.** `undo` voids its target; `redo` voids an `undo`. The
  reducer first computes the void set (an `undo` that is itself voided voids
  nothing), then replays the remaining events in order. Undo targets the last
  non-voided *user* event (`point`, `correct`, `sides.swap`, `server.set`,
  `game.start`). This keeps the log honest for burn-in: the voided point still
  shows when it was tapped and when it was taken back.
- **Derivable state.** `reduce(config, events) -> MatchState` is pure. The UI
  never stores the score separately (R-SCORE-8).

### 3.4 Rules in the reducer

| On | Rule | Source |
|---|---|---|
| `point(team)` while `playing` or `interval` | `score[team]++`; `server = team`; `serviceCourt` from the server's score parity | Laws 7.3, 10.1, 11.1 |
| after a point | game won when `score >= pointsToWin && lead >= winBy`, or `score == cap`; then `games[winner]++`, `completed.push`, `phase = gameOver` or `matchOver` | Laws 7.2, 7.4, 7.5 |
| after a point, not game-winning | if `intervalAt` and the leading score just became `intervalAt` for the first time this game: `phase = interval`, `intervalKind = midGame`; in the deciding game also swap `leftTeam` when the interval ends | Laws 16.2.1, 8.1.3 |
| `interval.end` | `phase = playing`; apply the pending deciding-game side swap | |
| `game.start(n)` | reset `score`; `server` = winner of the previous game; swap `leftTeam`; `phase = playing` | Laws 7.6, 8.1.1, 8.1.2 |
| `correct` | overwrite `score`, `games`, `server`, optionally `leftTeam`; recompute flags and phase | R-SCORE-7 |
| `sides.swap`, `server.set` | as named | |
| `match.end` | `phase = matchOver` | |

The BWF Laws of Badminton are published in the BWF Statutes, section 4.1
(https://corporate.bwfbadminton.com/statutes/). The reducer is table-driven so
the 11/15-point variants only change `pointsToWin` and `cap`.

Invariants the tests enforce: replay is deterministic; `undo` then `redo` is
the identity on state; a `point` during `gameOver` or `matchOver` is rejected
(the UI never emits it); `seq` has no gaps; the serving court always matches
the server's score parity unless a `correct` said otherwise.

### 3.5 Persistence and sharing

- The scoreboard phone writes `{config, events}` to IndexedDB after every
  event (localStorage would do, but a 3-game log is ~40 kB and IDB keeps it
  off the main thread). On launch, an unfinished match is offered for resume
  (R-SCORE-9).
- The camera phone keeps a mirror `{config, events}` plus its own recording
  metadata (§6.6) in the match's OPFS directory.
- Sharing is one-directional: every new event is sent as an `event` message;
  on (re)connect the scoreboard sends a `sync` with the whole log (§4.4).

## 4. Pairing and signaling

### 4.1 Options compared

| | (a) Offline two-QR handshake | (b) Signaling helper on Vercel | (c) Third-party signaling (PeerJS cloud) |
|---|---|---|---|
| Infrastructure | None | Serverless function + a store with TTL (Upstash Redis via the Vercel Marketplace, or Vercel Blob); secrets; polling because function WebSockets are beta and close at the function's max duration ([Vercel guide](https://vercel.com/guides/do-vercel-serverless-functions-support-websocket-connections)) | None to run, but an external service and its uptime |
| Needs internet on the court | No | Yes, both phones, at pairing and every reconnect | Yes |
| Scans | 2 (offer, answer) | 1 (room code) | 1 (peer id) |
| Reconnect after link drop | Re-scan (2 scans) | Automatic | Automatic |
| Privacy | Nothing leaves the LAN | Connection descriptors (local hostnames, fingerprints) pass through the helper | Same, through a third party |
| Code | QR show + scan on both roles, SDP compaction (§4.3) | QR show + scan, API client, function, store | PeerJS client |
| Failure modes | QR too dense to scan; mDNS blocked on the Wi-Fi | Offline court; store misconfigured; cold starts | Service down or rate-limited |

**Recommendation for v1: (a).** It is the only option that works on a court
without internet, it needs no account, secret or store, and the extra cost is
one more scan per session. QR show and scan are needed in every option
anyway. If the phase-2 soak test shows the link dropping more than once per
match on real courts, add (b) as an *optional* path in phase 4; nothing in the
protocol changes, only how the descriptors travel.

### 4.2 Handshake (two QR)

```
Camera phone                                  Scoreboard phone
1  getUserMedia (already granted for preview)
2  pc = new RTCPeerConnection({ iceServers: [] })   // D13: none
3  dc = pc.createDataChannel('match', { ordered: true })
4  offer = createOffer; setLocalDescription
5  wait for iceGatheringState == 'complete' (<= 2 s timeout)
6  show QR1 = compact(localDescription)
                                              7  open camera, scan QR1 (needs getUserMedia)
                                              8  pc = new RTCPeerConnection({ iceServers: [] })
                                              9  setRemoteDescription(expand(QR1)); createAnswer; setLocalDescription
                                              10 wait for gathering complete; show QR2 = compact(answer)
11 scan QR2; setRemoteDescription(expand(QR2))
12 datachannel 'open' on both sides -> hello exchange (§4.4)
```

Why the order matters: **WebKit withholds host ICE candidates until the page
has camera or microphone permission.** Without that permission only
server-reflexive and relay candidates are produced, which on a LAN with no
STUN/TURN means no candidates at all (WebKit, "A Closer Look Into WebRTC",
https://webkit.org/blog/7763/a-closer-look-into-webrtc/; WebKit bug 174500
"WebRTC data channel only applications require capture permissions for direct
connections", https://bugs.webkit.org/show_bug.cgi?id=174500). Both phones
use the camera to scan, so both hold the permission before they gather. The
camera phone must create its offer *after* its preview stream is running.

Browsers publish host candidates as mDNS names (`<uuid>.local`) rather than
raw IPs (Chrome M73+ experiment, https://groups.google.com/g/discuss-webrtc/c/4Yggl6ZzqZk/m/nV24XkXXAQAJ;
WebKit's implementation in bug 174500). The peer resolves them with multicast
DNS on the same network. This works on a normal home or club Wi-Fi and on a
phone hotspot, and fails on networks with client isolation. Phase 0 tests
exactly this on the captain's phones (§9 assumptions A1, A2).

No trickle ICE: both sides wait for gathering to complete so one QR carries
everything. With no STUN servers configured, gathering on a LAN completes in
well under a second; the 2 s timeout then shows whatever was gathered.

### 4.3 SDP compaction

A data-channel-only SDP from Safari or Chrome is 600 to 1 200 bytes, mostly
boilerplate. QR capacity at version 40 is 2 953 bytes binary, but anything past
about version 15 (~500 bytes) scans unreliably from another phone's screen.
`compact()` keeps only what the peer needs and `expand()` rebuilds a valid SDP:

```
{ v:1, r:'o'|'a', u:<ice-ufrag>, p:<ice-pwd>, f:<dtls fingerprint sha-256 hex>,
  s:'actpass'|'active'|'passive', c:[ '<ip-or-mdns> <port> udp <priority>', ... ],
  m:<sctp-port>, x:<max-message-size> }
```

Encoded as a compact JSON string, base64url, typically 250 to 400 bytes (QR
version 10 to 13, error-correction level L). Same idea as the `sdpmin` npm
package; writing it by hand is ~80 lines and avoids a dependency with an
opaque format. A unit test round-trips real SDPs captured from both phones in
phase 0.

### 4.4 Message protocol (data channel)

One ordered, reliable channel. Every message is a JSON object with `v` (protocol
version, integer) and `t` (type). Unknown `t` is ignored; a `v` the receiver
does not implement is answered with `bye` and surfaces R-PAIR-7.

```ts
type Role = 'scoreboard' | 'camera';
type Msg =
  | { v: 1; t: 'hello'; role: Role; deviceId: string; app: string;   // app = build id
      matchId?: string; lastSeq?: number }
  | { v: 1; t: 'ping'; id: number; t0: number }                      // sender's clock
  | { v: 1; t: 'pong'; id: number; t0: number; t1: number; t2: number }
  | { v: 1; t: 'event'; event: MatchEvent }                           // scoreboard -> camera
  | { v: 1; t: 'sync'; matchId: string; config: MatchConfig;         // scoreboard -> camera
      events: MatchEvent[]; part?: [index: number, count: number] }
  | { v: 1; t: 'rec'; state: 'idle' | 'recording' | 'stopping' | 'error';   // camera -> scoreboard
      segment?: number; startedAt?: number; elapsedMs?: number;
      bytes?: number; minutesLeft?: number; error?: string }
  | { v: 1; t: 'cmd'; id: string; action: 'rec.start' | 'rec.stop' } // scoreboard -> camera (D11)
  | { v: 1; t: 'ack'; id: string; ok: boolean; error?: string }
  | { v: 1; t: 'bye' };
```

Examples:

```json
{"v":1,"t":"event","event":{"seq":17,"id":"k3f9","at":1793100000123,"by":"sb-7c2","type":"point","team":"A"}}
{"v":1,"t":"rec","state":"recording","segment":1,"startedAt":1793099000456,"elapsedMs":754000,"bytes":565000000,"minutesLeft":26}
```

Rules:

- **Versioning.** `v` is bumped only for incompatible changes; additive
  fields are allowed within a version. `hello.app` carries the build id so a
  stale service-worker cache on one phone is diagnosed as "update the app"
  (R-PAIR-7).
- **Full-state resync.** On every channel open the scoreboard sends `sync`
  with the entire log, regardless of `lastSeq` (a 3-game log is ~40 kB; not
  worth a delta protocol). The camera replaces its mirror wholesale. Events
  are deduplicated by `id`, so a `sync` arriving after live `event`s is
  harmless (R-PAIR-4).
- **Message size.** Keep every message under 16 kB; `sync` is split into
  `part` chunks of ≤ 16 kB. MDN notes browsers accept at least 256 kB but the
  SDP default `max-message-size` is 64 kB and large messages block the channel
  (https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels).
- **Liveness.** `ping` every 2 s from the scoreboard; 3 missed pongs → "link
  lost" (6 s), 30 s → red. ICE `connectionState` changes are shown too.
  Reconnection without re-signaling is left to ICE itself (it recovers from
  short blips); an IP change needs a new handshake, which with (a) means
  re-scan (ux-design.md E1).
- **Commands** (`cmd`/`ack`) are idempotent and carry an id so a retry after a
  blip cannot start two recordings.

### 4.5 Clock offset

Phones' wall clocks can differ by seconds. The camera phone maps scoreboard
timestamps onto its own clock with NTP-style round trips:

```
offset_i = ((t1 - t0) + (t2 - t3)) / 2      // t0,t3 scoreboard; t1,t2 camera
rtt_i    = (t3 - t0) - (t2 - t1)
offset   = median of the last 8 samples with rtt < 50 ms
```

Samples come from the regular pings. On a LAN `rtt` is 2 to 20 ms, so the
offset error is a few milliseconds, well inside R-PAIR-5. Events received live
are also stamped with the camera's receive time as a cross-check; events that
arrive by `sync` after a disconnect rely on the offset alone. The offset and
sample count are stored in `match.json` so the Mac tool can see how trustworthy
the times are.

## 5. Scoreboard phone specifics

- **Speech.** `speechSynthesis` with an English voice by default (D5); phrases
  are short, each utterance cancels the previous one so a fast rally never
  queues stale scores. iOS and Android both ship speech synthesis (§9). The
  click sound is a pre-decoded Web Audio buffer; the `AudioContext` is created
  on the "Start match" tap (iOS autoplay rules).
- **Wake Lock** requested on "Start match", re-requested on `visibilitychange`
  (the lock is released whenever the page is hidden).
- **Orientation.** `screen.orientation.lock('landscape')` in the installed
  app on Android; iOS has no lock (§9), so a CSS `orientation: portrait` media
  query swaps in the "rotate" screen (R-DISP-7).
- **Touch handling** per ux-design.md §3 with Pointer Events; `touch-action:
  none` on the zones so the browser never interprets the swipe.

## 6. Recording pipeline (camera phone)

### 6.1 Capture

```ts
const stream = await navigator.mediaDevices.getUserMedia({
  video: { facingMode: { ideal: 'environment' },
           width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  audio: recordAudio ? { echoCancellation: false, noiseSuppression: false } : false, // D7
});
```

The phone must already be in landscape when the stream starts; iOS captures
in the device orientation at that moment (assumption A6, phase 0).

### 6.2 MediaRecorder

Pick the first supported type, in this order, with `isTypeSupported`:

1. `video/mp4;codecs=avc1.42E01E,mp4a.40.2` (H.264 + AAC)
2. `video/mp4`
3. `video/webm;codecs=h264,opus` (Chrome, keeps H.264 for the Mac)
4. `video/webm;codecs=vp9,opus`, then `video/webm`

`videoBitsPerSecond` 6 000 000 for 1080p, 3 500 000 for 720p (D8);
`start(1000)` for one-second chunks (R-REC-2).

What the browsers actually produce (§9 for sources): Safari writes MP4 with
H.264 and AAC and, since 18.4, fragmented MP4; Chrome writes WebM by default
and MP4 since Chrome 126 with H.264 where the platform has an encoder
(Android is listed). Both produce *fragmented* MP4 with `moov` first and a
zero duration in the headers, so players show no length and no seek bar until
the file is remuxed. The Mac tool (§7) always remuxes with
`ffmpeg -c copy -movflags +faststart`, which also writes the duration. Whether
a given Android phone offers MP4 with AAC is assumption A4.

### 6.3 Writing to OPFS

```
main thread                                   recording worker
MediaRecorder.ondataavailable(blob)
  blob.arrayBuffer() -> postMessage(buf, [buf]) -->  handle.write(buf, { at: cursor })
                                                     cursor += buf.byteLength
                                                     every 5 s: handle.flush()
on stop:  postMessage('close')               -->  flush(); close(); reply with size
```

- The worker opens `matches/<matchId>/video-<n>.<ext>` with
  `createSyncAccessHandle()`. This is the only OPFS write path on iOS before
  Safari 26 (`createWritable` arrived in Safari 26, §9) and it keeps disk I/O
  off the UI thread. On Safari 26+ and Chrome it is still the simplest path,
  so there is one code path everywhere.
- Each `write` is one second of video (~750 kB at 6 Mbit/s) and happens as
  soon as the chunk arrives, so an app or tab crash loses under a second
  (R-REC-2). `flush` every 5 s bounds what an OS-level crash could lose while
  limiting fsync churn; phase 0 measures the real loss (A3).
- A `QuotaExceededError` on write stops the recorder cleanly, closes the file,
  and reports `rec.state = 'error'` with the reason (R-REC-3).
- **IndexedDB fallback: recommend not building it (D10).** Every supported
  browser has OPFS; the fallback would only serve private browsing, where
  storage is wiped anyway.

### 6.4 Storage estimate and persistence

- `navigator.storage.estimate()` gives `usage` and `quota`; minutes left =
  `(quota - usage) / bytesPerMinute`, shown on C1/C3 (R-REC-3). Safari may
  report a reduced quota to limit fingerprinting, and the quota is an upper
  bound, not a promise, so the write path must still handle
  `QuotaExceededError` (WebKit, "Updates to Storage Policy").
- `navigator.storage.persist()` is called once at first launch and the result
  shown on C1. WebKit grants it by heuristics such as being an installed Home
  Screen app; Chrome decides from engagement, no prompt (§9). Persisted
  origins are skipped by LRU eviction.
- Expect 1080p30 at 6 Mbit/s to use ~2.7 GB/hour. Free space, not the quota
  (60 % of *total* disk), is the practical limit: 40 GB free is about 14 hours.

### 6.5 Wake lock, backgrounding, interruptions

- `navigator.wakeLock.request('screen')` on REC start; re-request when the
  page becomes visible again. Installed iOS web apps need iOS 18.4+ for this
  (§9); on older iOS run the camera role in a Safari tab.
- iOS ends or mutes capture tracks when Safari is backgrounded for more than
  ~30 s, and a muted track cannot be unmuted from script (WebKit bugs 179363,
  204681). A phone call or a screen lock has the same effect. The recorder
  listens for `track.onended`, `track.onmute` and `recorder.onerror`; on any
  of them it stops the recorder, closes the segment, and offers "Resume" which
  calls `getUserMedia` again and opens segment `n+1` (R-REC-5). Segments are
  never stitched on the phone.
- The preview `<video>` is dimmed with CSS; the track keeps delivering frames.
  Whether iOS keeps delivering full-rate frames to a mostly black screen is
  assumption A7.
- Recommend Do Not Disturb and a power bank in the C1 tips. Thermal
  throttling at 1080p30 for 90 minutes is measured in phase 0 (N-POWER-1).

### 6.6 Recording metadata (camera-local)

```ts
interface Segment {
  index: number; file: string; mimeType: string;
  width: number; height: number; fps: number;
  startedAt: number;          // camera wall clock at recorder 'start' event
  startLatencyMs: number;     // calibrated in phase 0 (clap test), default 0
  endedAt: number | null; bytes: number;
  endReason: 'user' | 'interrupted' | 'quota' | 'error' | null;
}
```

Stored as `matches/<matchId>/recording.json` and updated on every segment
change.

### 6.7 Export

- Build `match.json` (§8) from the mirrored log, `recording.json` and the
  clock offset; write it next to the video in OPFS.
- `const files = [await videoHandle.getFile(), matchJsonFile]`; if
  `navigator.canShare({ files })` then `navigator.share({ files, title })`
  from the tap handler (transient activation is required), else an
  `<a download>` per file using `URL.createObjectURL` (R-EXP-2).
- A `File` from `getFile()` is disk-backed, so sharing a multi-GB video should
  not load it into memory; whether iOS's share sheet handles a 2 GB file from
  a web app, and offers "Save Video", is assumption A5.
- Delete removes the OPFS directory and refreshes the usage figure (R-EXP-3).

## 7. Burn-in options

| Path | Where | Cost | Quality | Use when |
|---|---|---|---|---|
| **A. Live canvas** | camera phone, while recording: draw frames + overlay on a canvas, `canvas.captureStream()` into MediaRecorder | continuous GPU/CPU work for the whole match; heat, battery; a second encode | re-encoded from a canvas, worse than the raw track; overlay animations easy | "share from the court" without a Mac (phase 4, R-BURN-3) |
| **B. On-phone ffmpeg.wasm** | camera phone, after the match | software x264 at ~0.1 to 0.3× real time; needs the whole file in wasm memory (practical limit ~1 to 2 GB); multi-threading needs COOP/COEP headers on Vercel | fine | clips under a few minutes (later, if ever) |
| **C. Mac-side (recommended, D9)** | Mac Studio: ffmpeg (installed), HTML overlay rendered by Puppeteer (the gods-eye-view exporter) | one HTML page, one script; hardware H.264 via `h264_videotoolbox` runs faster than real time | full quality; any design the HTML can draw | the default for every match |

### 7.1 Mac-side pipeline (v1)

1. **Remux** every segment: `ffmpeg -i video-1.mp4 -c copy -movflags +faststart seg-1.mp4`
   (fixes the missing duration; WebM input from Android gets `-c:v copy` into
   MKV or a transcode to H.264 here).
2. **States → frames.** Walk `match.json` events and emit one overlay state
   per change (score, server, game, interval, side mapping), with its
   recording-relative start time. A 3-game match has 100 to 150 states.
3. **Render** each state once with the HTML scoreboard template to a
   transparent PNG at the video's resolution (Puppeteer screenshot with
   `omitBackground`). ~150 screenshots take well under a minute.
4. **Overlay track.** Write a concat list with per-image durations and build
   one transparent overlay movie: `ffmpeg -f concat -safe 0 -i states.txt
   -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le overlay.mov`. One image per state, exact durations, no
   per-frame rendering.
5. **Composite:** `ffmpeg -i seg-1.mp4 -i overlay.mov -filter_complex overlay
   -c:v h264_videotoolbox -b:v 12M -c:a copy out-1.mp4`.
6. Multiple segments produce multiple outputs; concatenation is a user choice.

Why not `drawtext` only (D9(b)): it works and has zero rendering
dependencies, but a scoreboard that looks like a broadcast one needs shapes,
colours and a font, which is what the HTML template is for. Why not a
per-frame overlay render: the overlay changes ~150 times per match, not 30
times per second.

The same HTML template is used by the camera-phone preview (R-REC-4) and,
later, by path A, so the look is defined once.

## 8. Export bundle

Directory `match-<id>/` containing `video-1.<mp4|webm>` … `video-n` and
`match.json`:

```ts
interface MatchBundle {
  format: 'badminton-scoreboard/match'; version: 1;
  matchId: string; createdAt: number; app: string;
  config: MatchConfig;
  devices: { scoreboard: { id: string; ua: string }; camera: { id: string; ua: string } };
  clock: { offsetMs: number; samples: number; medianRttMs: number };   // camera − scoreboard
  recording: { mirrored: boolean; segments: Segment[] };               // §6.6; mirrored per R-REC-4
  events: Array<MatchEvent & {
    tRec: { segment: number; ms: number } | null;   // null if no segment was recording
    after: MatchState;                              // derived state after this event
    leftOnCamera: Team;                             // after.leftTeam, flipped if mirrored
  }>;
  result: { winner: Team | null; games: Record<Team, number>; completed: Array<Record<Team, number>> };
}
```

`after` and `leftOnCamera` are redundant with `events` + `config` (the log
stays the source of truth) but let the Mac tool stay a renderer with no copy
of the rules. `tRec.ms = (event.at + clock.offsetMs) − segment.startedAt −
segment.startLatencyMs` (R-BURN-1).

## 9. Browser support matrix

Minimum versions (N-BROWSER-1): **iOS 17** (Safari tab) / **iOS 18.4**
(installed app), **Android Chrome 126**. BCD = MDN browser-compat-data,
checked 2026-10-27 at https://github.com/mdn/browser-compat-data (files under
`api/`).

| API | iOS Safari | Android Chrome | Notes | Source |
|---|---|---|---|---|
| OPFS `navigator.storage.getDirectory()` | 15.2 | 109 | | BCD `StorageManager.json` |
| `FileSystemFileHandle.createSyncAccessHandle()` | 15.2 | 109 | Dedicated workers only; `mode` option Chrome 121+, not Safari | BCD `FileSystemFileHandle.json`; https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle |
| `FileSystemFileHandle.createWritable()` | 26 | 109 | Not usable as the only path on iOS 17/18 | BCD `FileSystemFileHandle.json` |
| `navigator.storage.estimate()` | 17 | 61 | Safari may under-report quota | BCD `StorageManager.json`; https://webkit.org/blog/14403/updates-to-storage-policy/ |
| `navigator.storage.persist()` | 15.2 | 55 | Granted by heuristics, no prompt; WebKit counts Home Screen apps | BCD; WebKit 14403; https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria |
| Origin quota | ~60 % of total disk (Safari 17+), 80 % overall; same for Home Screen apps; no prompt; LRU whole-origin eviction | ~60 % per origin, 80 % overall, LRU eviction of best-effort origins | Before Safari 17: 1 GiB then a prompt | WebKit 14403; MDN quotas page; https://web.dev/articles/storage-for-the-web |
| 7-day storage deletion (ITP) | Script-written storage deleted after 7 days of Safari use without interaction; Home Screen apps have their own counter and are not expected to lose data | n/a | Install to the Home Screen | https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ |
| `MediaRecorder` | 14.1 (iOS 14) | 47 | | BCD `MediaRecorder.json` |
| MediaRecorder containers | MP4 H.264 + AAC from the start; 18.4 adds WebM (VP8/VP9 + Opus), fragmented MP4, HEVC, AV1 | WebM (VP8/VP9/AV1/H.264 + Opus); MP4 since 126 (VP9/AV1/H.264/H.265 + Opus/AAC); H.26x platform encoding on Windows, macOS, Android | Both emit fragmented MP4 with zero duration; remux on the Mac | https://webkit.org/blog/11353/mediarecorder-api/; https://webkit.org/blog/16574/webkit-features-in-safari-18-4/; https://chromium.googlesource.com/chromium/src/media/+/refs/heads/main/muxers/README.md; https://groups.google.com/a/chromium.org/g/blink-dev/c/YJ1QijNiHeM; https://blog.addpipe.com/duration-in-mp4-files-produced-by-chrome-safari/ |
| `getUserMedia` | 11 | 47 | In installed iOS web apps: fixed in iOS 13.4 (bug 185448) but a camera-in-standalone failure was reported on iOS 17.4.1 to 17.6.1 and said to be gone on iOS 18 (bug 273938, still open) | BCD `Navigator.json`; https://bugs.webkit.org/show_bug.cgi?id=185448; https://bugs.webkit.org/show_bug.cgi?id=273938 |
| Capture ends when backgrounded | Tracks end/mute after ~30 s in background; cannot unmute from script | Similar on screen lock | Segment resume (§6.5) | https://bugs.webkit.org/show_bug.cgi?id=179363; https://bugs.webkit.org/show_bug.cgi?id=204681 |
| WebRTC data channel | yes | yes | Host candidates only after capture permission (WebKit); mDNS `.local` candidates | https://webkit.org/blog/7763/a-closer-look-into-webrtc/; https://bugs.webkit.org/show_bug.cgi?id=174500 |
| Screen Wake Lock | 16.4 in Safari; **18.4 in Home Screen apps** | 84 | Released when the page is hidden | BCD `WakeLock.json`, `Navigator.json`; https://bugs.webkit.org/show_bug.cgi?id=254545 |
| Web Share with files | 14 (`canShare`/`share` files) | 76 | Needs a user gesture; check `canShare` first | BCD `Navigator.json`; https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share |
| Vibration | **no** | 32 | Haptics only on Android | BCD `Navigator.json` |
| `screen.orientation.lock()` | **no** | 38 | Android: installed/fullscreen only | BCD `ScreenOrientation.json` |
| `BarcodeDetector` | 17, **behind a default-off preference** | 83 | Use `zxing-wasm` on iOS | BCD `BarcodeDetector.json` |
| `speechSynthesis` | 7 | 33 | Voice list differs per device | BCD `SpeechSynthesis.json` |
| `navigator.userActivation` | 16.4 | 72 | For share/audio gating | BCD `Navigator.json` |
| Home Screen install | Any site, iOS 26 opens it as a web app by default | Chrome install prompt via manifest | | https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ |

### Assumptions to test on the captain's phones (phase 0)

- **A1** Two phones on the same Wi-Fi connect over mDNS host candidates with
  no STUN server, in Safari and Chrome, after both have camera permission.
- **A2** The same works on a phone hotspot (one phone hosting, one joining),
  with the host phone in either role. Also: does iOS show a "Local Network"
  permission prompt, and does the connection survive it?
- **A3** Safari's 1-second MediaRecorder chunks, appended byte-for-byte,
  form a file that ffmpeg remuxes cleanly, on the actual iOS version. The
  addpipe test and WebKit's 18.4 notes say fragmented MP4; confirm on-device.
- **A4** Which `isTypeSupported` strings the Android phone accepts, and whether
  its MP4 includes AAC audio.
- **A5** `navigator.share` with a 2 GB file from OPFS on iOS: completes, and
  the sheet offers "Save Video" and AirDrop.
- **A6** Capture orientation: stream started in landscape stays landscape;
  what happens if the phone is rotated after start.
- **A7** A dimmed preview does not reduce the captured frame rate.
- **A8** Recorder start latency (`start()` to first encoded frame) measured
  with a clap, to fill `startLatencyMs`.
- **A9** `speechSynthesis` on iOS: audible with the silent switch on? Thai
  voice present? Loud enough at 3 m in a gym?
- **A10** Battery and temperature after 60 minutes: scoreboard phone with
  screen on; camera phone at 1080p30 unplugged and plugged.
- **A11** Installed Home Screen app on the actual iOS version: camera works
  in standalone mode (bug 273938), Wake Lock holds, `persist()` granted.
- **A12** `estimate().quota` values on both phones, and how Safari reports it
  for an installed app.

## 10. Deployment on Vercel

- Framework preset: Vite; build `pnpm build`; output `dist/` (set
  `outputDirectory` only if the preset misses it;
  https://vercel.com/docs/project-configuration/vercel-json). Every
  deployment is HTTPS, which `getUserMedia`, OPFS and service workers require.
- `vercel.json` headers: the service worker and `index.html` must not be
  cached (`Cache-Control: public, max-age=0, must-revalidate`); Vite's hashed
  `assets/*` get `public, max-age=31536000, immutable`. Syntax per the Vercel
  docs example (`headers[].source`, `headers[].headers[].{key,value}`).
- No COOP/COEP headers in v1; they are only needed if ffmpeg.wasm threads
  (path B) are ever added, and they would break nothing else here.
- PWA: manifest with `display: standalone`, `orientation: landscape`
  (honoured by Android, ignored by iOS), icons; Workbox precache of the shell;
  update flow `prompt` (never auto-reload while a match or recording is live).
- Preview deployments give an HTTPS URL per branch for phone testing without
  any local setup; that is the default way to test a build on both phones.

## 11. Local development

- `pnpm dev --host` serves on the LAN, but a LAN IP is not a secure context:
  camera, OPFS sync handles and the service worker refuse to run.
- **Recommended:** Tailscale Serve. The Mac Studio is already on a tailnet;
  `tailscale serve 5173` publishes `https://<mac>.<tailnet>.ts.net` with a
  valid certificate to every device on the tailnet
  (https://tailscale.com/kb/1312/serve; HTTPS certificates must be enabled on
  the tailnet). Both phones need the Tailscale app signed in. WebRTC still
  connects over the LAN (host candidates) regardless of how the page was
  loaded.
- **Alternative:** `mkcert` with its root certificate installed and trusted on
  both phones, plus Vite's `server.https`. More fiddly on iOS (profile install,
  then "Certificate Trust Settings").
- Two-phone protocol work without two phones: desktop Chrome can take the
  scoreboard role against one phone, and two Chrome tabs can pair with each
  other for engine/protocol debugging.
- Phase 0 uses a throwaway HTML page served the same way.

## 12. Testing strategy

- **Engine (Vitest):** table-driven rule tests (deuce, cap, interval trigger,
  side changes incl. deciding game at 11, server after game, game/match point
  flags) for 11/15/21-point formats; property tests: replay determinism,
  undo/redo identity, no state outside invariants after random event streams.
- **Protocol:** guards accept every example in §4.4 and reject malformed
  input; SDP compaction round-trips captured SDPs; clock-offset maths with
  synthetic jitter; `sync` chunk reassembly.
- **Recording worker:** unit test with a fake handle (append order, flush,
  quota error path).
- **Device checklist:** the A1 to A12 list in §9, then per phase the
  acceptance criteria in requirements.md, run on the real phones. A 60-minute
  soak (recording + pings) is part of phase 2's definition of done.
- **Playwright (later):** two Chromium contexts pairing through a test-only
  copy/paste signaling path, exercising sync and reconnect.

## 13. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| LAN WebRTC fails (mDNS blocked, hotspot quirks, iOS local-network prompt) | medium | pairing impossible on some courts | Phase 0 test A1/A2 first; keep D13 (STUN) as the switch; the scoreboard still works alone |
| Safari MP4 chunks not remuxable on the actual iOS version | low | export unusable | A3 in phase 0; fallback is a single `dataavailable` at stop (loses crash safety) |
| Camera stops in installed iOS app (bug 273938) | low-medium | no recording | Run the camera role in a Safari tab on that iOS version; A11 |
| Storage evicted before export | low (persisted, installed) | lost match | `persist()`, install prompt, "export today" nudge, show usage |
| QR too dense to scan between phones | low | pairing friction | Compaction keeps QR ≤ version 13; QR level L; big on-screen rendering; "start over" |
| Accidental taps on a wet screen | high | wrong score | Touch guards (R-DISP-6), one-tap Undo, redo |
| Phone overheats or dies mid-match | medium | lost video | Power bank advice, 720p option, measured in A10 |
| Audio too quiet in a gym | medium | feature unused | Short phrases; Bluetooth speaker works with no code change |
| Browser update changes recorder output | low | Mac tool breaks | Mac tool probes with ffprobe and remuxes; record `ua` in the bundle |
| Service worker serves a stale build on one phone | medium | version mismatch | `hello.app` check, update prompt (R-PAIR-7) |
