#!/usr/bin/env python3
"""Transcribe audio directly from one or more media files with faster-whisper.

This path intentionally does not use YouTube captions/subtitles. It is used to
verify that media downloaded by the fetcher can be understood from the audio
track alone.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from faster_whisper import WhisperModel


def fmt_time(seconds: float) -> str:
    total_ms = int(round(seconds * 1000))
    hours, rem = divmod(total_ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("media", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--language", default="ja")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading Whisper model: {args.model}")
    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
    )

    segments_iter, info = model.transcribe(
        str(args.media),
        language=args.language or None,
        beam_size=5,
        vad_filter=False,
        condition_on_previous_text=True,
        word_timestamps=False,
    )
    segments = list(segments_iter)

    records = []
    timestamped = []
    plain_parts = []
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        records.append(
            {
                "start": seg.start,
                "end": seg.end,
                "text": text,
                "avg_logprob": getattr(seg, "avg_logprob", None),
                "no_speech_prob": getattr(seg, "no_speech_prob", None),
            }
        )
        timestamped.append(f"[{fmt_time(seg.start)} --> {fmt_time(seg.end)}] {text}")
        plain_parts.append(text)

    payload = {
        "media": str(args.media),
        "model": args.model,
        "requested_language": args.language,
        "detected_language": getattr(info, "language", None),
        "language_probability": getattr(info, "language_probability", None),
        "duration": getattr(info, "duration", None),
        "segment_count": len(records),
        "segments": records,
    }

    (args.output_dir / "whisper_transcript.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (args.output_dir / "whisper_transcript_timestamped.txt").write_text(
        "\n".join(timestamped) + "\n", encoding="utf-8"
    )
    (args.output_dir / "whisper_transcript_plain.txt").write_text(
        " ".join(plain_parts) + "\n", encoding="utf-8"
    )

    print(f"Transcribed {len(records)} segments")
    print(f"Detected language: {getattr(info, 'language', None)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
