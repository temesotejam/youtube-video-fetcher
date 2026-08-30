# Agent handoff

For any task that asks an agent to inspect, understand, compare, or analyze a YouTube video using this repository, read and follow `CHATGPT_WORKFLOW.md` first.

The main path is `request.json` -> self-hosted GitHub Actions -> media Artifact -> direct analysis of the actual video file.

Do not treat YouTube captions as ground truth. Caption and Whisper workflows are optional helpers, not the primary path.
