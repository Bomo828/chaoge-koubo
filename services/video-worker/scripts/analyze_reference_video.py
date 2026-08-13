#!/usr/bin/env python3
"""Extract reproducible visual/audio timing evidence from a reference video.

The script intentionally avoids OCR and semantic guessing. It records decoded
frame changes, exports review frames/contact sheets, and detects audio
transients. Template authoring can then use those measurements as evidence.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--sample-seconds", type=float, default=0.5)
    parser.add_argument("--scene-threshold", type=float, default=0.085)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    return parser.parse_args()


def make_contact_sheet(frames: list[tuple[float, np.ndarray]], output: Path) -> None:
    if not frames:
        return
    thumb_width, thumb_height = 270, 480
    columns = 4
    rows = math.ceil(len(frames) / columns)
    sheet = Image.new("RGB", (columns * thumb_width, rows * thumb_height), (245, 245, 245))
    for index, (timestamp, frame) in enumerate(frames):
        resized = Image.fromarray(frame, "RGB").resize((thumb_width, thumb_height), Image.Resampling.LANCZOS)
        draw = ImageDraw.Draw(resized)
        draw.rectangle((0, 0, thumb_width, 34), fill=(10, 20, 16))
        draw.text((10, 8), f"{timestamp:05.2f}s", fill=(244, 210, 85), font=ImageFont.load_default())
        row, column = divmod(index, columns)
        sheet.paste(resized, (column * thumb_width, row * thumb_height))
    sheet.save(output, quality=90)


def analyze_video(source: Path, output: Path, sample_seconds: float, scene_threshold: float, ffmpeg: str) -> dict:
    probe = subprocess.run(
        [ffmpeg.replace("ffmpeg", "ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,nb_frames,duration", "-of", "json", str(source)],
        capture_output=True,
        text=True,
        check=True,
    )
    stream = json.loads(probe.stdout)["streams"][0]
    rate_parts = str(stream.get("r_frame_rate") or "30/1").split("/", 1)
    fps = float(rate_parts[0]) / max(1.0, float(rate_parts[1] if len(rate_parts) > 1 else 1))
    frame_count = int(stream.get("nb_frames") or 0)
    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    duration = frame_count / fps if fps else 0.0
    if not duration:
        duration = float(stream.get("duration") or 0.0)
    step = max(1, round(sample_seconds * fps))
    review_frames: list[tuple[float, np.ndarray]] = []
    scene_changes: list[dict] = []
    previous_gray: np.ndarray | None = None
    frame_scores: list[dict] = []
    frame_index = 0
    frames_dir = output / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="template-frame-analysis-") as temporary:
        pattern = str(Path(temporary) / "%08d.jpg")
        decoded = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(source), "-an", "-vf", "scale=180:320", "-vsync", "0", "-q:v", "4", pattern],
            capture_output=True,
            text=True,
        )
        if decoded.returncode:
            raise SystemExit(f"Unable to decode video: {source}: {decoded.stderr[-500:]}")
        for frame_path in sorted(Path(temporary).glob("*.jpg")):
            frame = np.asarray(Image.open(frame_path).convert("RGB"), dtype=np.uint8)
            timestamp = frame_index / fps
            gray = np.dot(frame[..., :3], np.asarray([0.299, 0.587, 0.114], dtype=np.float32)).astype(np.uint8)
            score = 0.0
            top_score = 0.0
            caption_score = 0.0
            if previous_gray is not None:
                difference = np.abs(gray.astype(np.int16) - previous_gray.astype(np.int16)).astype(np.uint8)
                score = float(np.mean(difference) / 255.0)
                top_score = float(np.mean(difference[:112, :]) / 255.0)
                caption_score = float(np.mean(difference[128:272, :]) / 255.0)
                frame_scores.append({
                    "frame": frame_index,
                    "time": round(timestamp, 4),
                    "whole": round(score, 6),
                    "top": round(top_score, 6),
                    "caption": round(caption_score, 6),
                })
                if score >= scene_threshold:
                    scene_changes.append({"time": round(timestamp, 3), "score": round(score, 4)})
            previous_gray = gray
            if frame_index % step == 0:
                review_frames.append((timestamp, frame.copy()))
                Image.fromarray(frame, "RGB").resize((540, 960), Image.Resampling.LANCZOS).save(
                    frames_dir / f"frame-{timestamp:06.2f}.jpg",
                    quality=90,
                )
            frame_index += 1
    if not frame_count:
        frame_count = frame_index
        duration = frame_count / fps if fps else duration
    make_contact_sheet(review_frames, output / "contact-sheet.jpg")
    (output / "frame-scores.json").write_text(
        json.dumps(frame_scores, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

    def strongest(region: str) -> list[dict]:
        return sorted(frame_scores, key=lambda item: float(item[region]), reverse=True)[:40]

    def grouped_motion(region: str, threshold: float) -> list[dict]:
        groups: list[dict] = []
        active: list[dict] = []
        for item in frame_scores:
            if float(item[region]) >= threshold:
                active.append(item)
                continue
            if active:
                groups.append({
                    "start": active[0]["time"],
                    "end": active[-1]["time"],
                    "peak": round(max(float(value[region]) for value in active), 6),
                })
                active = []
        if active:
            groups.append({
                "start": active[0]["time"],
                "end": active[-1]["time"],
                "peak": round(max(float(value[region]) for value in active), 6),
            })
        return groups

    return {
        "fps": round(fps, 6),
        "frame_count": frame_count,
        "duration_seconds": round(duration, 6),
        "width": width,
        "height": height,
        "sample_seconds": sample_seconds,
        "scene_threshold": scene_threshold,
        "scene_changes": scene_changes,
        "frame_analysis": {
            "method": "every-decoded-frame",
            "analyzed_deltas": len(frame_scores),
            "scores_file": "frame-scores.json",
            "strongest_whole": strongest("whole"),
            "strongest_top": strongest("top"),
            "strongest_caption": strongest("caption"),
            "top_motion_groups": grouped_motion("top", 0.018),
            "caption_motion_groups": grouped_motion("caption", 0.018),
        },
    }


def analyze_audio(source: Path, output: Path, ffmpeg: str) -> dict:
    wav_path = output / "reference-audio.wav"
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(wav_path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True)
    if completed.returncode != 0:
        return {"available": False, "error": completed.stderr.strip()[-500:]}

    with wave.open(str(wav_path), "rb") as handle:
        rate = handle.getframerate()
        samples = np.frombuffer(handle.readframes(handle.getnframes()), dtype=np.int16).astype(np.float32)
    if samples.size == 0:
        return {"available": False, "error": "No decoded audio samples"}

    window_seconds = 0.05
    window = max(1, round(rate * window_seconds))
    rms: list[float] = []
    for offset in range(0, len(samples), window):
        chunk = samples[offset : offset + window]
        if len(chunk):
            rms.append(float(np.sqrt(np.mean(np.square(chunk))) / 32768.0))
    values = np.asarray(rms, dtype=np.float32)
    baseline = float(np.median(values))
    deviation = float(np.median(np.abs(values - baseline))) or 1e-6
    threshold = baseline + 5.0 * deviation
    candidates: list[tuple[float, float]] = []
    for index in range(1, max(1, len(values) - 1)):
        value = float(values[index])
        if value >= threshold and value >= float(values[index - 1]) and value >= float(values[index + 1]):
            candidates.append((index * window_seconds, value))

    peaks: list[dict] = []
    for timestamp, value in sorted(candidates, key=lambda item: item[1], reverse=True):
        if all(abs(timestamp - float(existing["time"])) >= 0.35 for existing in peaks):
            peaks.append({"time": round(timestamp, 3), "rms": round(value, 5)})
        if len(peaks) >= 24:
            break
    peaks.sort(key=lambda item: float(item["time"]))
    return {
        "available": True,
        "sample_rate": rate,
        "window_seconds": window_seconds,
        "median_rms": round(baseline, 6),
        "transient_threshold": round(threshold, 6),
        "transient_peaks": peaks,
    }


def main() -> None:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    analysis = analyze_video(args.input, args.output, args.sample_seconds, args.scene_threshold, args.ffmpeg)
    analysis["audio"] = analyze_audio(args.input, args.output, args.ffmpeg)
    analysis["source"] = str(args.input.resolve())
    (args.output / "analysis.json").write_text(
        json.dumps(analysis, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(analysis, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
