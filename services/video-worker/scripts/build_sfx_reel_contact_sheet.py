#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a labeled contact sheet from SFX reel regions.")
    parser.add_argument("video", type=Path)
    parser.add_argument("regions", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    parser.add_argument("--columns", type=int, default=4)
    args = parser.parse_args()
    data = json.loads(args.regions.read_text("utf-8"))
    regions = data.get("regions") or []
    frame_dir = args.output.parent / f".{args.output.stem}-frames"
    frame_dir.mkdir(parents=True, exist_ok=True)
    frames: list[tuple[dict, Image.Image]] = []
    for index, region in enumerate(regions, 1):
        moment = float(region.get("start") or 0) + min(.18, float(region.get("duration") or 0) * .35)
        frame_path = frame_dir / f"{index:03d}.jpg"
        subprocess.run([
            str(args.ffmpeg), "-loglevel", "error", "-y", "-ss", f"{moment:.3f}",
            "-i", str(args.video), "-frames:v", "1", "-update", "1", "-vf", "scale=360:-2", str(frame_path),
        ], check=True)
        frames.append((region, Image.open(frame_path).convert("RGB")))
    columns = max(1, args.columns)
    cell_w, cell_h = 380, 250
    rows = (len(frames) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * cell_w, rows * cell_h), "#171717")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=22)
    for zero_index, (region, frame) in enumerate(frames):
        x = zero_index % columns * cell_w
        y = zero_index // columns * cell_h
        frame.thumbnail((360, 202))
        sheet.paste(frame, (x + 10, y + 36))
        label = f"#{zero_index + 1:02d}  {float(region['start']):.2f}s  {float(region['duration']):.2f}s"
        draw.text((x + 10, y + 7), label, fill="#fff300", font=font)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.output, quality=88)


if __name__ == "__main__":
    main()
