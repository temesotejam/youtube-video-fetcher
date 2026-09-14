# Cloudflare free-only YouTube probe

This experiment asks one narrow question:

> Can Cloudflare Browser Run on the Workers Free plan render a public YouTube watch page without a local self-hosted PC?

## Cost guardrails

This probe is intentionally limited to services available on the Cloudflare free tier:

- Cloudflare Worker
- Browser Run / Browser Rendering free allowance
- no Cloudflare Containers
- no R2
- no Workers AI
- no paid storage
- no local PC runner

Workers Free currently includes 10 minutes/day of Browser Run usage. This probe performs one `content` Quick Action per request and blocks images, fonts, stylesheets, and media to keep the experiment small.

## What `/probe` does

`/probe?v=VIDEO_ID`:

1. Builds a fixed `https://www.youtube.com/watch?v=...` URL from an 11-character video ID.
2. Opens it with Cloudflare Browser Run.
3. Captures rendered HTML only.
4. Checks for:
   - bot/interstitial text
   - consent page text
   - `ytInitialPlayerResponse`
   - `playabilityStatus`
   - `videoDetails`
   - `streamingData`
   - `googlevideo.com`
   - `signatureCipher`
5. Returns only a small JSON diagnostic result.

It does **not** download video media in this phase.

Default test video ID: `2NJdNKJ9LPM`.

## Why this is separate from the existing fetcher

The existing production path remains unchanged:

```text
GitHub Actions -> Windows self-hosted runner -> yt-dlp + Deno + FFmpeg -> Artifact
```

This free-only experiment is isolated on `experimental-cloudflare-free-browser`. It will only replace the PC path if the browser experiment proves that YouTube can be reached reliably and a practical media path can be built without paid services.

## Deployment

The workflow `.github/workflows/deploy-cloudflare-free-probe.yml` is manual-only (`workflow_dispatch`). It expects repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The API token should be a Cloudflare User API Token capable of deploying Workers. Browser Run itself is accessed through the Worker browser binding, so the Worker code does not contain an API token.

## Success criteria for phase 1

Promising result:

- no bot/interstitial page
- rendered YouTube page returned
- player response and/or streaming data detected

If that succeeds, phase 2 can test whether a short media segment can be obtained and passed onward without local software and without leaving the free tier.
