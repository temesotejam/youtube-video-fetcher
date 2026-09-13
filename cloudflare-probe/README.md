# Experimental Cloudflare Container probe

This directory tests whether the existing self-hosted Windows YouTube fetch path can eventually be replaced by an on-demand Cloudflare Container.

The existing Windows self-hosted runner remains unchanged. This experiment is isolated on the `experimental-cloudflare-container` branch.

## What the container contains

- Python 3.12
- yt-dlp
- Deno
- FFmpeg
- a tiny HTTP probe server on port 8080

The Worker starts one `basic` Cloudflare Container on demand and lets it sleep after two minutes of inactivity.

## Fixed test target

The probe intentionally does **not** accept an arbitrary YouTube URL. It uses one fixed, short public test video:

- `https://www.youtube.com/watch?v=jNQXAC9IVRw`

This keeps the experimental Worker from becoming a public YouTube proxy.

## Endpoints

- `/` — Worker metadata; does not start the container
- `/health` — starts the container and checks its HTTP server
- `/probe/versions` — reports Python / yt-dlp / Deno / FFmpeg versions
- `/probe/info` — yt-dlp metadata-only test; this is the main bot-detection probe
- `/probe/sample` — downloads only the first 3 seconds to ephemeral container storage, computes size + SHA-256, then deletes the media before returning JSON. No media bytes are returned to the client.

`/probe/info` classifies a `Sign in to confirm you're not a bot` response as `youtube_bot_or_access_failure` so the GitHub Actions log can distinguish the key failure mode from ordinary setup errors.

## Deploy

Deployment is done by `.github/workflows/deploy-cloudflare-probe.yml` with GitHub-hosted Ubuntu + Docker + Wrangler.

The repository needs these GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Use a Cloudflare user API token suitable for Wrangler Worker deployment. Cloudflare Containers require the Workers Paid plan.

The deployment workflow automatically calls `/probe/info` after deploy and prints the JSON result. If metadata succeeds, it then calls `/probe/sample` to verify that a short real media transfer and FFmpeg path also work from Cloudflare.

## Success criteria

1. Worker deploy succeeds.
2. Container image builds and rolls out.
3. `/probe/info` returns `"ok": true` without YouTube bot confirmation.
4. `/probe/sample` returns `"ok": true` and a non-zero temporary media size.
5. The temporary media is deleted inside the container and never returned by the HTTP response.

If 3 or 4 fails specifically because YouTube rejects Cloudflare datacenter traffic, the current self-hosted residential-network path remains necessary.
