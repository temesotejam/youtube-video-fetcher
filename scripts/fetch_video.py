#!/usr/bin/env python3
"""Fetch one YouTube video (or an optional time range) with yt-dlp.

This script intentionally contains no AI logic. Its only job is to turn a
YouTube URL into a media file plus metadata in a reproducible way.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch a YouTube video with yt-dlp")
    parser.add_argument("url", help="YouTube video URL")
    parser.add_argument("--start", default="", help="Optional section start, e.g. 00:03:20")
    parser.add_argument("--end", default="", help="Optional section end, e.g. 00:03:40")
    parser.add_argument("--output-dir", default="output", help="Directory for generated files")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if bool(args.start) != bool(args.end):
        print("error: --start and --end must be provided together", file=sys.stderr)
        return 2

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Prefer H.264/AAC MP4 when available because it is broadly compatible,
    # then fall back to a progressive MP4, and finally to yt-dlp's best choice.
    format_selector = (
        "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/"
        "b[ext=mp4]/"
        "bv*+ba/b"
    )

    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--no-playlist",
        "--newline",
        "--write-info-json",
        "--merge-output-format",
        "mp4",
        "-f",
        format_selector,
        "-o",
        str(output_dir / "video.%(ext)s"),
    ]

    if args.start and args.end:
        command.extend(
            [
                "--download-sections",
                f"*{args.start}-{args.end}",
                "--force-keyframes-at-cuts",
            ]
        )

    command.append(args.url)

    log_path = output_dir / "download.log"
    print("Running yt-dlp...")
    print("Requested section:", f"{args.start} - {args.end}" if args.start else "full video")

    with log_path.open("w", encoding="utf-8") as log_file:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert process.stdout is not None
        for line in process.stdout:
            print(line, end="")
            log_file.write(line)
        return_code = process.wait()

    files = []
    for path in sorted(output_dir.iterdir()):
        if path.is_file():
            files.append({"name": path.name, "size_bytes": path.stat().st_size})

    manifest = {
        "source_url": args.url,
        "requested_start": args.start or None,
        "requested_end": args.end or None,
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "yt_dlp_exit_code": return_code,
        "files": files,
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    if return_code != 0:
        print(f"yt-dlp failed with exit code {return_code}", file=sys.stderr)
        return return_code

    media_files = [
        p
        for p in output_dir.glob("video.*")
        if p.suffix not in {".json", ".part", ".ytdl"}
        and not p.name.endswith(".info.json")
    ]
    if not media_files:
        print("error: yt-dlp reported success but no media file was produced", file=sys.stderr)
        return 3

    print("Fetch complete:")
    for media_file in media_files:
        print(f"  {media_file} ({media_file.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
