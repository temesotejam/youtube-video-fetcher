#!/usr/bin/env python3
"""Fetch requested media clips and transcribe their audio without YouTube subtitles."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("request_file", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("audio-transcripts"))
    return parser.parse_args()


def find_media(output_dir: Path) -> Path:
    candidates = [
        p for p in output_dir.glob("video.*")
        if p.is_file()
        and p.suffix.lower() not in {".json", ".part", ".ytdl"}
        and not p.name.endswith(".info.json")
    ]
    if not candidates:
        raise RuntimeError(f"No media file found in {output_dir}")
    return max(candidates, key=lambda p: p.stat().st_size)


def main() -> int:
    args = parse_args()
    request = json.loads(args.request_file.read_text(encoding="utf-8"))
    model = str(request.get("model", "large-v3-turbo"))
    language = str(request.get("language", "ja"))
    items = request.get("items") or []
    if not items:
        print("error: request contains no items", file=sys.stderr)
        return 2

    fetch_script = Path(__file__).with_name("fetch_video.py")
    transcribe_script = Path(__file__).with_name("transcribe_media_audio.py")
    media_root = Path("_audio_validation_media")
    args.output_dir.mkdir(parents=True, exist_ok=True)

    failures = []
    for item in items:
        name = str(item["name"])
        url = str(item["youtube_url"])
        start = str(item.get("start_time", ""))
        end = str(item.get("end_time", ""))
        media_dir = media_root / name
        out_dir = args.output_dir / name

        print(f"=== {name}: fetching media ===")
        fetch_cmd = [
            sys.executable,
            str(fetch_script),
            url,
            "--start",
            start,
            "--end",
            end,
            "--output-dir",
            str(media_dir),
        ]
        rc = subprocess.call(fetch_cmd)
        if rc != 0:
            failures.append({"name": name, "stage": "fetch", "exit_code": rc})
            continue

        media = find_media(media_dir)
        print(f"=== {name}: transcribing {media} ===")
        transcribe_cmd = [
            sys.executable,
            str(transcribe_script),
            str(media),
            "--output-dir",
            str(out_dir),
            "--model",
            model,
            "--language",
            language,
            "--device",
            "cpu",
            "--compute-type",
            "int8",
        ]
        rc = subprocess.call(transcribe_cmd)
        if rc != 0:
            failures.append({"name": name, "stage": "transcribe", "exit_code": rc})
            continue

        (out_dir / "source.json").write_text(
            json.dumps(
                {
                    "name": name,
                    "youtube_url": url,
                    "start_time": start,
                    "end_time": end,
                    "model": model,
                    "language": language,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    summary = {
        "model": model,
        "language": language,
        "item_count": len(items),
        "failures": failures,
    }
    (args.output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    shutil.rmtree(media_root, ignore_errors=True)
    if failures:
        print(json.dumps(failures, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
