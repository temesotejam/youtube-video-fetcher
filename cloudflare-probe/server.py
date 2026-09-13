#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "0.0.0.0"
PORT = 8080
TEST_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
TEST_VIDEO_ID = "jNQXAC9IVRw"


def run_command(command: list[str], timeout: int = 120) -> tuple[int, str, str, float]:
    started = time.perf_counter()
    try:
        proc = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
        elapsed = time.perf_counter() - started
        return proc.returncode, proc.stdout, proc.stderr, elapsed
    except subprocess.TimeoutExpired as exc:
        elapsed = time.perf_counter() - started
        stdout = exc.stdout if isinstance(exc.stdout, str) else ""
        stderr = exc.stderr if isinstance(exc.stderr, str) else ""
        return 124, stdout, stderr + "\nprobe timed out", elapsed


def tail(text: str, limit: int = 5000) -> str:
    if len(text) <= limit:
        return text
    return text[-limit:]


def versions_payload() -> dict:
    commands = {
        "python": [sys.executable, "--version"],
        "yt_dlp": [sys.executable, "-m", "yt_dlp", "--version"],
        "deno": ["deno", "--version"],
        "ffmpeg": ["ffmpeg", "-version"],
    }
    result: dict[str, object] = {}
    for name, command in commands.items():
        code, stdout, stderr, elapsed = run_command(command, timeout=20)
        result[name] = {
            "exit_code": code,
            "stdout": tail(stdout.strip(), 1200),
            "stderr": tail(stderr.strip(), 1200),
            "elapsed_ms": round(elapsed * 1000, 1),
        }
    return result


def info_probe() -> dict:
    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--no-playlist",
        "--skip-download",
        "--dump-single-json",
        "--remote-components",
        "ejs:npm",
        TEST_URL,
    ]
    code, stdout, stderr, elapsed = run_command(command, timeout=120)

    payload: dict[str, object] = {
        "ok": False,
        "probe": "metadata",
        "test_url": TEST_URL,
        "expected_video_id": TEST_VIDEO_ID,
        "exit_code": code,
        "elapsed_ms": round(elapsed * 1000, 1),
        "stderr_tail": tail(stderr),
    }

    if code != 0:
        payload["classification"] = (
            "youtube_bot_or_access_failure"
            if "Sign in to confirm you're not a bot" in (stdout + stderr)
            else "yt_dlp_failure"
        )
        return payload

    try:
        metadata = json.loads(stdout)
    except json.JSONDecodeError:
        payload["classification"] = "invalid_json_from_yt_dlp"
        payload["stdout_tail"] = tail(stdout)
        return payload

    payload.update(
        {
            "ok": metadata.get("id") == TEST_VIDEO_ID,
            "classification": "success" if metadata.get("id") == TEST_VIDEO_ID else "unexpected_video",
            "video": {
                "id": metadata.get("id"),
                "title": metadata.get("title"),
                "duration": metadata.get("duration"),
                "extractor": metadata.get("extractor"),
                "webpage_url": metadata.get("webpage_url"),
            },
        }
    )
    return payload


def sample_probe() -> dict:
    workdir = Path(tempfile.mkdtemp(prefix="yt-probe-"))
    try:
        output_template = str(workdir / "sample.%(ext)s")
        command = [
            sys.executable,
            "-m",
            "yt_dlp",
            "--no-playlist",
            "--remote-components",
            "ejs:npm",
            "--download-sections",
            "*00:00:00-00:00:03",
            "--force-keyframes-at-cuts",
            "--merge-output-format",
            "mp4",
            "-f",
            "18/b[ext=mp4]/best",
            "-o",
            output_template,
            TEST_URL,
        ]
        code, stdout, stderr, elapsed = run_command(command, timeout=180)
        payload: dict[str, object] = {
            "ok": False,
            "probe": "three_second_sample",
            "test_url": TEST_URL,
            "expected_video_id": TEST_VIDEO_ID,
            "exit_code": code,
            "elapsed_ms": round(elapsed * 1000, 1),
            "stdout_tail": tail(stdout),
            "stderr_tail": tail(stderr),
            "media_returned_to_client": False,
        }

        if code != 0:
            payload["classification"] = (
                "youtube_bot_or_access_failure"
                if "Sign in to confirm you're not a bot" in (stdout + stderr)
                else "yt_dlp_or_ffmpeg_failure"
            )
            return payload

        media_files = [
            path
            for path in workdir.iterdir()
            if path.is_file()
            and path.suffix not in {".json", ".part", ".ytdl"}
            and not path.name.endswith(".info.json")
        ]
        if not media_files:
            payload["classification"] = "no_media_file"
            return payload

        media_file = max(media_files, key=lambda p: p.stat().st_size)
        sha256 = hashlib.sha256(media_file.read_bytes()).hexdigest()
        size_bytes = media_file.stat().st_size
        payload.update(
            {
                "ok": size_bytes > 0,
                "classification": "success" if size_bytes > 0 else "empty_media_file",
                "downloaded_sample": {
                    "filename": media_file.name,
                    "size_bytes": size_bytes,
                    "sha256": sha256,
                },
                "cleanup": "temporary media is deleted before the HTTP response is returned",
            }
        )
        return payload
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "youtube-video-fetcher-probe/0.1"

    def log_message(self, format: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}", flush=True)

    def send_json(self, payload: dict, status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json({"ok": True, "service": "youtube-video-fetcher Cloudflare Container probe"})
            return
        if self.path == "/probe/versions":
            self.send_json({"ok": True, "versions": versions_payload()})
            return
        if self.path == "/probe/info":
            result = info_probe()
            self.send_json(result, 200 if result.get("ok") else 502)
            return
        if self.path == "/probe/sample":
            result = sample_probe()
            self.send_json(result, 200 if result.get("ok") else 502)
            return
        self.send_json({"ok": False, "error": "not_found"}, 404)


if __name__ == "__main__":
    print(f"Starting probe server on {HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
