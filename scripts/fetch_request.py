#!/usr/bin/env python3
"""Read a repository request JSON file and invoke fetch_video.py.

This is the bridge used when an authorized GitHub writer updates request.json.
The push starts the self-hosted workflow; this script converts the JSON request
into the same fetch_video.py command used by the manual workflow.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Execute a YouTube fetch request JSON file")
    parser.add_argument("request_file", nargs="?", default="request.json")
    parser.add_argument("--output-dir", default="output")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    request_path = Path(args.request_file)
    request = json.loads(request_path.read_text(encoding="utf-8"))

    url = str(request.get("youtube_url", "")).strip()
    start = str(request.get("start_time", "")).strip()
    end = str(request.get("end_time", "")).strip()

    if not url:
        print("error: request.json does not contain youtube_url", file=sys.stderr)
        return 2

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
        args.output_dir,
    ]

    print(f"Executing request for: {url}")
    print(f"Requested section: {start + ' - ' + end if start or end else 'full video'}")
    return subprocess.call(command)


if __name__ == "__main__":
    raise SystemExit(main())
