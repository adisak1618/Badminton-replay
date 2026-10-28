# Deploying to Vercel

The app is a static Vite build plus one function, `api/signal.ts` (the
signaling helper, technical-design.md §4.2). `vercel.json` already holds the
build settings, the `/api/signal/*` rewrite and the cache headers, so the
whole setup is two steps in the Vercel dashboard. After that every push
deploys by itself.

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

## After that

- Every push to `main` deploys production; every other branch gets its own
  preview URL with the function and the same store. Preview deployments are
  behind Vercel Authentication by default, so open them on a phone that is
  logged in to Vercel, or test on the production URL.
- The store only ever holds a room code (10 minutes), a session secret and the
  latest offer and answer (6 hours from the last write) and per-minute rate
  counters, all with a TTL (R-PAIR-9). Nothing needs cleaning up.
- If a build log ever complains about the pnpm version (`package.json` pins
  `pnpm@12.11.2`), add the environment variable `ENABLE_EXPERIMENTAL_COREPACK`
  = `1` and redeploy.
- Local alternative with no Vercel at all: `pnpm build && pnpm serve:local`,
  then `tailscale serve --bg --https=<port> http://127.0.0.1:8787` (README).
