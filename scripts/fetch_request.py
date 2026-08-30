#!/usr/bin/env python3
"""Read request.json, fetch media, and preserve analysis context.

This is the bridge used when an authorized GitHub writer updates request.json.
The push starts the self-hosted workflow. The script invokes fetch_video.py and
stores the original analysis request beside the fetched media so downstream
clients can recover not only the video, but also the question that caused the
fetch.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Execute a YouTube analysis request")
    parser.add_argument("request_file", nargs="?", default="request.json")
    parser.add_argument("--output-dir", default="output")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    request_path = Path(args.request_file)
    request = json.loads(request_path.read_text(encoding="utf-8"))

    request_id = str(request.get("request_id", "")).strip()
    url = str(request.get("youtube_url", "")).strip()
    start = str(request.get("start_time", "")).strip()
    end = str(request.get("end_time", "")).strip()
    question = str(request.get("question", "")).strip()
    note = str(request.get("note", "")).strip()

    if not request_id:
        print("error: request.json does not contain request_id", file=sys.stderr)
        return 2
    if not url:
        print("error: request.json does not contain youtube_url", file=sys.stderr)
        return 2
    if bool(start) != bool(end):
        print("error: start_time and end_time must be provided together", file=sys.stderr)
        return 2

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    context = {
        "request_id": request_id,
        "youtube_url": url,
        "start_time": start or None,
        "end_time": end or None,
        "question": question or None,
        "note": note or None,
        "request_file": str(request_path),
        "started_at_utc": datetime.now(timezone.utc).isoformat(),
        "fetch_exit_code": None,
    }
    context_path = output_dir / "analysis_request.json"
    context_path.write_text(
        json.dumps(context, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    fetch_script = Path(__file__).with_name("fetch_video.py")
    command = [
        sys.executable,
        str(fetch_script),
        url,
        "--start",
        start,
        "--end",
        end,
        "--output-dir",
        str(output_dir),
    ]

    print(f"Request ID: {request_id}")
    print(f"Executing request for: {url}")
    print(f"Question: {question if question else '(none)'}")
    print(f"Requested section: {start + ' - ' + end if start else 'full video'}")

    return_code = subprocess.call(command)
    context["fetch_exit_code"] = return_code
    context["finished_at_utc"] = datetime.now(timezone.utc).isoformat()
    context_path.write_text(
        json.dumps(context, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
