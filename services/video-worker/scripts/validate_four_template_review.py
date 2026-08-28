#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


def run(command: list[str], *, environment: dict[str, str], capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=True,
        text=True,
        capture_output=capture,
        env=environment,
    )


def probe(ffprobe: str, video: Path, environment: dict[str, str]) -> dict[str, Any]:
    completed = run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames:format=duration,size",
            "-of",
            "json",
            str(video),
        ],
        environment=environment,
        capture=True,
    )
    return json.loads(completed.stdout)


def parse_loudnorm(stderr: str) -> dict[str, float | str | None]:
    matches = re.findall(r"\{\s*\"input_i\".*?\}", stderr, flags=re.DOTALL)
    if not matches:
        return {"input_i": None, "input_tp": None, "input_lra": None}
    raw = json.loads(matches[-1])
    result: dict[str, float | str | None] = {}
    for key in ("input_i", "input_tp", "input_lra", "input_thresh"):
        value = raw.get(key)
        try:
            result[key] = float(value)
        except (TypeError, ValueError):
            result[key] = value
    return result


def validate_one(
    *,
    video: Path,
    timeline: Path,
    job: Path,
    ffmpeg: str,
    ffprobe: str,
    validator: Path,
    environment: dict[str, str],
) -> dict[str, Any]:
    output_dir = video.parent
    report_path = output_dir / "validation-report.json"
    cover_path = output_dir / "cover.jpg"
    metadata = probe(ffprobe, video, environment)
    stream = next(item for item in metadata.get("streams", []) if item.get("codec_type") == "video")
    expected_frames = int(stream.get("nb_frames") or 0)

    run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-ss",
            "0.8",
            "-i",
            str(video),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            "-update",
            "1",
            str(cover_path),
        ],
        environment=environment,
    )

    with tempfile.TemporaryDirectory(prefix="four-template-frame-validation-") as temporary:
        analysis_dir = Path(temporary)
        frame_dir = analysis_dir / "reference" / "frames"
        frame_dir.mkdir(parents=True)
        run(
            [
                ffmpeg,
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(video),
                "-an",
                "-vsync",
                "0",
                "-vf",
                "scale=180:320:flags=fast_bilinear",
                "-q:v",
                "8",
                str(frame_dir / "frame-%06d.jpg"),
            ],
            environment=environment,
        )
        frames = sorted(frame_dir.glob("frame-*.jpg"))
        frame_analysis = {
            "mode": "every-decoded-frame",
            "expected_frames": expected_frames or len(frames),
            "analyzed_frames": len(frames),
        }
        frame_analysis_path = analysis_dir / "frame-analysis.json"
        frame_analysis_path.write_text(json.dumps(frame_analysis, ensure_ascii=False, indent=2) + "\n", "utf-8")
        run(
            [
                sys.executable,
                str(validator),
                "--video",
                str(video),
                "--timeline",
                str(timeline),
                "--frame-analysis",
                str(frame_analysis_path),
                "--job",
                str(job),
                "--report",
                str(report_path),
                "--require-speech-coverage",
            ],
            environment=environment,
        )

    loudness = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-i",
            str(video),
            "-vn",
            "-af",
            "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
            "-f",
            "null",
            "-",
        ],
        check=False,
        text=True,
        capture_output=True,
        env=environment,
    )
    report = json.loads(report_path.read_text("utf-8"))
    report["audio"] = parse_loudnorm(loudness.stderr)
    report["cover"] = str(cover_path)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", "utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate all four-template review renders frame by frame.")
    parser.add_argument("--review-root", required=True, type=Path)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    parser.add_argument("--validator", required=True, type=Path)
    parser.add_argument("--short-only", action="store_true", help="Validate only the four short review renders")
    args = parser.parse_args()

    review_root = args.review_root.expanduser().resolve()
    ffmpeg = str(args.ffmpeg.expanduser().resolve())
    ffprobe = str(args.ffmpeg.expanduser().resolve().with_name("ffprobe"))
    validator = args.validator.expanduser().resolve()
    environment = os.environ.copy()
    binary_dir = str(Path(ffmpeg).parent)
    environment["PATH"] = f"{binary_dir}:{environment.get('PATH', '')}"
    environment["DYLD_LIBRARY_PATH"] = binary_dir

    results: dict[str, Any] = {}
    variants = ("short",) if args.short_only else ("short", "long")
    for template_id in range(9, 13):
        for variant in variants:
            key = f"template-{template_id}/{variant}"
            folder = review_root / f"template-{template_id}" / variant
            video = folder / "output.mp4"
            if not video.exists():
                video = folder / "sample.mp4"
            print(f"validating {key}", flush=True)
            results[key] = validate_one(
                video=video,
                timeline=folder / "timeline.json",
                job=folder / "job.json",
                ffmpeg=ffmpeg,
                ffprobe=ffprobe,
                validator=validator,
                environment=environment,
            )

    summary = {
        "passed": all(bool(item.get("passed")) for item in results.values()),
        "results": results,
    }
    summary_path = review_root / "validation-summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", "utf-8")
    if not summary["passed"]:
        raise SystemExit(f"Validation failed: {summary_path}")
    print(f"all renders valid: {summary_path}")


if __name__ == "__main__":
    main()
