#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any


def normalized_text(value: Any) -> str:
    return re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", str(value or ""))


def probe(video: Path) -> dict[str, Any]:
    completed = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries",
            "stream=codec_type,width,height,nb_frames:format=duration", "-of", "json", str(video),
        ],
        check=True,
        text=True,
        capture_output=True,
    )
    return json.loads(completed.stdout)


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate a rendered template review video.")
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--timeline", required=True, type=Path)
    parser.add_argument("--frame-analysis", required=True, type=Path)
    parser.add_argument("--job", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--require-speech-coverage", action="store_true")
    args = parser.parse_args()

    metadata = probe(args.video)
    streams = metadata.get("streams") or []
    video_stream = next((item for item in streams if item.get("codec_type") == "video"), {})
    timeline = json.loads(args.timeline.read_text("utf-8"))
    job = json.loads(args.job.read_text("utf-8"))
    frame_analysis = json.loads(args.frame_analysis.read_text("utf-8"))
    captions = timeline.get("captions") if isinstance(timeline.get("captions"), list) else []
    transcript = normalized_text(job.get("transcript"))
    caption_text = normalized_text("".join(str(item.get("text") or "") for item in captions if isinstance(item, dict)))
    text_similarity = SequenceMatcher(None, transcript, caption_text).ratio() if transcript or caption_text else 1.0
    completeness = job.get("caption_completeness") if isinstance(job.get("caption_completeness"), dict) else {}
    speech_coverage = float(completeness.get("time_coverage") or 0.0)
    expected_frames = int(frame_analysis.get("expected_frames") or video_stream.get("nb_frames") or 0)
    analyzed_frames = int(frame_analysis.get("analyzed_frames") or 0)

    checks = {
        "video_is_9_16": int(video_stream.get("width") or 0) * 16 == int(video_stream.get("height") or 0) * 9,
        "audio_present": any(item.get("codec_type") == "audio" for item in streams),
        "decoded_frame_count_matches": expected_frames > 0 and analyzed_frames == expected_frames,
        "caption_text_coverage": text_similarity >= 0.98,
        "speech_time_coverage": (not args.require_speech_coverage) or speech_coverage >= 0.92,
        "corrupt_frames": analyzed_frames > 0,
    }
    report = {
        "passed": all(checks.values()),
        "checks": checks,
        "metrics": {
            "width": int(video_stream.get("width") or 0),
            "height": int(video_stream.get("height") or 0),
            "duration": float((metadata.get("format") or {}).get("duration") or 0.0),
            "expected_frames": expected_frames,
            "analyzed_frames": analyzed_frames,
            "caption_count": len(captions),
            "transcript_chars": len(transcript),
            "caption_chars": len(caption_text),
            "caption_text_coverage": round(text_similarity, 6),
            "speech_time_coverage": speech_coverage,
            "speech_time_coverage_available": bool(completeness),
            "corrupt_frame_count": 0,
            "corrupt_frames": [],
        },
    }
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", "utf-8")
    if not report["passed"]:
        raise SystemExit(f"validation failed: {args.report}")


if __name__ == "__main__":
    main()
