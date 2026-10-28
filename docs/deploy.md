# Deploying to Vercel

The app is a static Vite build plus one function, `api/signal.ts` (the
signaling helper, technical-design.md §4.2). `vercel.json` already holds the
build settings, the `/api/signal/*` rewrite and the cache headers, so the
whole setup is two steps in the Vercel dashboard, plus a third (a Cloudflare
TURN key) so phones that share no network can still pair. After that every
push deploys by itself.

## 1. Import the repository

1. On https://vercel.com/new choose **Import Git Repository** and pick
   `adisak1618/Badminton-replay` (allow Vercel's GitHub app to see it if asked).
2. Leave the settings as Vercel fills them in from `vercel.json`: framework
   Vite, build command `pnpm build`, output directory `dist`. No environment
   variables are needed yet.
3. **Deploy.** The app already works on both phones alone; pairing answers
   "The pairing helper is not working (store-not-configured)" until step 2.

## 2. Add the Redis store

1. In the project, open **Storage** and choose **Create Database** (or browse
   the Marketplace), pick **Upstash** (Redis), accept the free plan, and
   create it in a region near you (e.g. Singapore).
2. **Connect** it to this project for all environments (Production, Preview,
   Development). Leave the custom environment-variable prefix empty.
3. The project's **Settings › Environment Variables** now lists the
   variables the integration injected. The helper reads:

   | Variable | Used |
   |---|---|
   | `KV_REST_API_URL`, `KV_REST_API_TOKEN` | yes: the Redis REST endpoint and token |
   | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | yes, if present instead (Upstash's own names; they win when both exist) |
   | `<PREFIX>_KV_REST_API_URL`, `<PREFIX>_KV_REST_API_TOKEN` | yes, if a custom prefix was chosen when connecting |
   | `KV_REST_API_READ_ONLY_TOKEN`, `KV_URL`, `REDIS_URL` | no |

4. Environment variables only reach new deployments: **Deployments**, the
   latest one, **⋯ › Redeploy**.

Check it: `https://<project>.vercel.app/api/signal/rooms/000000` should answer
`{"error":"no-room"}`. `{"error":"store-not-configured"}` means the variables
are not in this deployment yet (redeploy); `{"error":"store"}` means the
store did not answer.

## 3. Add the TURN relay (phones on different networks)

Without this step pairing works only when both phones share a network (the
same Wi-Fi, or one phone's Personal Hotspot). With it, phones on mobile data
or on two different Wi-Fi networks connect through Cloudflare's TURN relay;
phones on one network still connect directly. The helper keeps the key and
gives each pairing credentials that expire after an hour; the phones never
see the key.

1. Log in at https://dash.cloudflare.com (a free account is enough). Open
   **Realtime** in the sidebar (formerly "Calls"), then the **TURN Server**
   section, and choose **Create**. Give it a name (e.g. `badminton-replay`)
   and create it.
2. The new key shows two values: the **Turn Token ID** and the **API Token**.
   Copy both now: the API token is shown only once (if lost, create another
   key).
3. Put them into the Vercel project, for Production and Preview:

   | Variable | Value |
   |---|---|
   | `TURN_KEY_ID` | the Turn Token ID |
   | `TURN_KEY_API_TOKEN` | the API Token |

   In the dashboard: **Settings › Environment Variables › Add**. Or from a
   checkout linked to the project: `vercel env add TURN_KEY_ID production`
   (it asks for the value), the same for `TURN_KEY_API_TOKEN`, and again with
   `preview`.
4. Redeploy (**Deployments**, the latest one, **⋯ › Redeploy**): variables
   only reach new deployments.

Cost: Cloudflare charges $0.05 per GB the relay sends, and the first 1,000 GB
each month are free (shared with its SFU, which this app does not use;
https://developers.cloudflare.com/realtime/pricing/); its STUN server is free.
A relayed match is score messages and pings, about 2 MB per hour, so the free
tier is never reached. Only links that cannot go direct use the relay.

Check it:

1. Create a throwaway room and ask for credentials with its secret (the room
   expires by itself in 10 minutes):

   ```sh
   APP=https://<project>.vercel.app
   R=$(curl -s -X POST $APP/api/signal/rooms -H 'Content-Type: application/json' -d '{"offer":"v=0"}')
   S=$(echo "$R" | sed -E 's/.*"session":"([0-9a-f]+)".*/\1/'); K=$(echo "$R" | sed -E 's/.*"secret":"([0-9a-f]+)".*/\1/')
   curl -s -H "X-Signal-Secret: $K" $APP/api/signal/sessions/$S/ice
   ```

   `{"relay":"ok","iceServers":[…],"ttl":3600}` means the key works.
   `{"relay":"not-configured"}`: the variables are not in this deployment
   (redeploy). `{"error":"relay-failed","reason":"auth"}`: Cloudflare refused
   the key (wrong value, or the key was deleted); `upstream` or `unreachable`:
   Cloudflare's API failed or did not answer within 3 s (the function log on
   Vercel says which).
2. On the phones, turn Wi-Fi off on both (mobile data only) and pair. The
   pairing screens' diagnostics chip (or ⋯ › Pairing diagnostics) shows
   `path relay` and `relay: ready until …`. On one Wi-Fi it shows
   `path direct`.
3. Cloudflare's dashboard shows the relay's traffic under the TURN key a few
   minutes later.

What the diagnostics say about the relay: `relay: ready until <time> UTC`
(credentials in hand), `relay: not configured` (no key on the helper: local
network only), `relay: failed (…)` (the fetch failed, with the helper's
reason). When phones on different networks do not connect, the pairing
screens say why: the relay is not set up, could not be used, this phone could
not reach the relay server, the other phone could not use it, or it did not
connect.

## After that

- Every push to `main` deploys production; every other branch gets its own
  preview URL with the function and the same store. Preview deployments are
  behind Vercel Authentication by default, so open them on a phone that is
  logged in to Vercel, or test on the production URL.
- The store only ever holds a room code (10 minutes), a session secret and the
  latest offer and answer (6 hours from the last write) and per-minute rate
  counters, all with a TTL (R-PAIR-9). Nothing needs cleaning up. TURN
  credentials are not stored: Cloudflare mints them on each request and they
  expire after an hour.
- If a build log ever complains about the pnpm version (`package.json` pins
  `pnpm@12.11.2`), add the environment variable `ENABLE_EXPERIMENTAL_COREPACK`
  = `1` and redeploy.
- Local alternative with no Vercel at all: `pnpm build && pnpm serve:local`,
  then `tailscale serve --bg --https=<port> http://127.0.0.1:8787` (README).
