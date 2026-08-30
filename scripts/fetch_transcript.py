#!/usr/bin/env python3
"""Download YouTube subtitles/automatic captions and convert JSON3 to text."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def ts(ms: int) -> str:
    sec = max(0, ms // 1000)
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("request_file", nargs="?", default="transcript_request.json")
    ap.add_argument("--output-dir", default="transcript-output")
    args = ap.parse_args()

    req = json.loads(Path(args.request_file).read_text(encoding="utf-8"))
    url = str(req.get("youtube_url", "")).strip()
    langs = req.get("languages") or ["ja-orig", "ja"]
    if not url:
        print("error: youtube_url is empty", file=sys.stderr)
        return 2

    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    lang_expr = ",".join(str(x) for x in langs)
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "--no-playlist",
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs", lang_expr,
        "--sub-format", "json3",
        "--remote-components", "ejs:npm",
        "-o", str(out / "captions.%(ext)s"),
        url,
    ]
    print("Downloading captions:", url)
    rc = subprocess.call(cmd)
    if rc != 0:
        return rc

    candidates = []
    for lang in langs:
        candidates.extend(sorted(out.glob(f"captions.{lang}.json3")))
    if not candidates:
        candidates = sorted(out.glob("*.json3"))
    if not candidates:
        print("error: no JSON3 captions were downloaded", file=sys.stderr)
        return 3

    src = candidates[0]
    data = json.loads(src.read_text(encoding="utf-8"))
    lines = []
    plain_parts = []
    last_text = None
    for event in data.get("events", []):
        segs = event.get("segs") or []
        text = "".join(str(seg.get("utf8", "")) for seg in segs)
        text = " ".join(text.replace("\n", " ").split())
        if not text or text == last_text:
            continue
        start = int(event.get("tStartMs", 0) or 0)
        lines.append(f"[{ts(start)}] {text}")
        plain_parts.append(text)
        last_text = text

    (out / "transcript_timestamped.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (out / "transcript_plain.txt").write_text("\n".join(plain_parts) + "\n", encoding="utf-8")
    meta = {
        "source_url": url,
        "requested_languages": langs,
        "selected_caption_file": src.name,
        "line_count": len(lines),
    }
    (out / "transcript_manifest.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Transcript complete: {len(lines)} lines from {src.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
