# youtube-video-fetcher

A small GitHub Actions based YouTube media fetcher.

The first goal is intentionally narrow: provide a YouTube URL, fetch the video in a GitHub Actions runner, and publish the result as a short-lived workflow artifact for downstream analysis.

## Version 0.1 scope

- Manual `workflow_dispatch` from GitHub Actions
- YouTube URL input
- Optional start/end timestamps for partial downloads
- `yt-dlp` + FFmpeg on an Ubuntu GitHub-hosted runner
- Video and metadata exported as a workflow artifact
- Artifact retention set to 1 day
- Playlist URLs are treated as a single-video request (`--no-playlist`)

## Usage

1. Open **Actions** in this repository.
2. Choose **Fetch YouTube video**.
3. Select **Run workflow**.
4. Paste a YouTube URL.
5. Optionally specify `start_time` and `end_time` such as `00:03:20` and `00:03:40`.
6. When the run finishes, download the `youtube-video-*` artifact from the workflow run.

## Notes

The downloader runs on a GitHub-hosted runner. YouTube may apply network-, client-, region-, authentication-, or token-dependent restrictions, so some videos can fail even when they play normally in a browser. If that becomes the limiting factor, the same repository can later add a self-hosted runner mode without changing the basic interface.

Only download material when you have the necessary rights or permission and when doing so is consistent with applicable service terms and law.
