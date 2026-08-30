# ChatGPT operating procedure

This file is the canonical handoff for using this repository as a generic YouTube-to-ChatGPT video bridge.

## Purpose

The primary job of this repository is to move the actual YouTube media file to a downstream analysis client. It is **not** primarily a transcript service.

Preferred path:

```text
user question + YouTube URL
        -> request.json
        -> GitHub Actions
        -> Windows self-hosted runner
        -> video.mp4
        -> GitHub Actions Artifact
        -> ChatGPT
        -> direct video/frame analysis
```

YouTube captions and independent ASR are optional aids only.

## Preconditions

- GitHub write access to `temesotejam/youtube-video-fetcher`.
- A Windows x64 self-hosted runner for this repository is online.
- The runner has Python 3.12 available as `py -3.12`.
- Do not put private URLs, credentials, cookies, tokens, or secrets in request files because this repository is public.

## Standard procedure for a video-analysis request

1. Read `request.schema.json` and the current `request.json`.
2. Create a new unique `request_id` for **every** run. A UTC timestamp plus a short nonce is suitable. Change it even when repeating the exact same URL and question.
3. Put the user's YouTube URL in `youtube_url`.
4. Put the user's actual analysis goal in `question`. Preserve enough detail that another downstream client could understand the requested analysis from the Artifact alone.
5. Choose the media range:
   - If the user asks about the whole video, leave `start_time` and `end_time` empty.
   - If the user gives a specific interval, use that interval.
   - If the question is local to a known time, fetch the smallest interval that still includes useful context around the event.
   - If a full video is impractically large and the question can be answered from a segment, prefer the relevant segment.
6. Update `request.json` on `main`. This push is the trigger for `.github/workflows/fetch-request.yml`.
7. Identify the resulting `Fetch YouTube request` workflow run. Prefer matching the run's head SHA to the commit produced by the `request.json` update.
8. Wait for the run to finish and inspect job status. If it fails, inspect the job log before changing the downloader.
9. Fetch the `youtube-request-<run_id>` Artifact and download the ZIP.
10. Extract the Artifact. It should contain:
    - `video.mp4` or another fetched media file,
    - `video.info.json`,
    - `download.log`,
    - `manifest.json`,
    - `analysis_request.json` containing the original request context.
11. Analyze the actual media file. For visual questions, start with representative frames across the relevant range, then increase temporal density around important events.
12. Use captions or ASR only when spoken content materially matters. Never treat YouTube automatic captions as ground truth.

## Recommended direct-video analysis pattern

For an overall video understanding task:

1. Inspect duration and basic media metadata.
2. Sample frames at a coarse interval to map the whole video.
3. Identify scene or state transitions.
4. Re-sample interesting ranges more densely.
5. If needed, use Python/OpenCV for measurements such as position, angle, trajectory, timing, or frame-to-frame change.
6. Combine visual evidence with logs/CSV/RWLOG or other user data when supplied.

For a question such as "What changed around 8:20 and how did the behavior change?":

1. Fetch a local window such as 8:00-8:50 when sufficient.
2. Inspect frames before, during, and after the change.
3. Compare geometry/configuration and motion behavior.
4. Report observations separately from inference.

## Failure handling

### Runner is offline

The GitHub job will remain queued. The user must make a registered runner available, for example by running `C:\actions-runner\run.cmd` or by using an auto-start/service configuration.

### GitHub-hosted runner gets YouTube bot challenge

Do not switch back to a signed `googlevideo.com` URL generated in another environment. The established working design is extraction and media download in the same self-hosted runner/network environment.

### Requested format is unavailable

Use the repository's normal `fetch_video.py` selection logic. It can choose separate video/audio streams and merge them with FFmpeg rather than requiring progressive itag 18.

### Artifact is too large

If the user's question is time-local, issue a new request for a smaller interval. Do not use GitHub as permanent bulk video storage.

### Captions disagree with the video/audio

Treat captions as supplemental evidence. Prefer the actual frames for visual facts and independent ASR/audio inspection when exact spoken content matters.

## Optional helpers

- `transcript_request.json` + `Optional: Fetch YouTube captions`: fetches existing YouTube captions. Useful but not authoritative.
- `audio_transcript_request.json` + `Experimental: Transcribe media audio`: independent Whisper/faster-whisper experiment. Not required for normal operation.

## Example generic request

```json
{
  "request_id": "2026-08-30T14-35-00Z-a1b2",
  "youtube_url": "https://youtu.be/example",
  "start_time": "",
  "end_time": "",
  "question": "Explain the development process in this video and identify the major design changes and their effects.",
  "note": "Triggered for direct video analysis"
}
```

## Definition of success

The bridge is working when ChatGPT can recover the Artifact produced for a request, open the actual media file, and answer the user's question from the video itself. A correct transcript is not required unless the user's question specifically depends on speech.
