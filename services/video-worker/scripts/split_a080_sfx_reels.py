#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Split analyzed A080 reels into calibrated WAV assets.")
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--analysis-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    mapping = {
        "emotion": "【情节情绪】自用IP剪辑高级感常用音效.mp3",
        "atmosphere": "【氛围】自用IP剪辑高级感常用音效.mp3",
        "impact": "【重击音效】自用IP剪辑高级感常用音效.mp3",
    }
    target_peak = {"emotion": -9.0, "atmosphere": -12.0, "impact": -15.0}
    catalog = {
        "schema_version": 1,
        "source_pack": "A080.剪映900款口播字幕动态排版 / 自用IP剪辑高级感常用音效",
        "license_basis": "用户于 2026-08-12 明确确认 A080 素材可直接商用",
        "selection_note": "全部独立片段进入本地素材库；自动节点池只启用口播友好的轻量子集。",
        "sources": [],
        "assets": [],
    }
    environment = os.environ.copy()
    environment["DYLD_LIBRARY_PATH"] = str(args.ffmpeg.resolve().parent)
    for family, source_name in mapping.items():
        source = args.source_dir / source_name
        analysis = json.loads((args.analysis_dir / f"{family}.json").read_text("utf-8"))
        catalog["sources"].append({
            "family": family,
            "file": source.name,
            "sha256": sha256(source),
            "duration": analysis.get("duration"),
        })
        for index, region in enumerate(analysis.get("regions") or [], 1):
            name = f"a080-ip-{family}-{index:02d}.wav"
            output = args.output_dir / name
            peak_value = region.get("peak_db")
            peak_db = float(peak_value) if peak_value is not None else -12.0
            gain_db = min(8.0, max(-18.0, target_peak[family] - peak_db))
            subprocess.run([
                str(args.ffmpeg), "-loglevel", "error", "-y",
                "-ss", f"{float(region['start']):.3f}", "-t", f"{float(region['duration']):.3f}",
                "-i", str(source), "-map", "0:a:0", "-af", f"volume={gain_db:.2f}dB",
                "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(output),
            ], check=True, env=environment)
            catalog["assets"].append({
                "id": output.stem,
                "family": family,
                "file": f"sfx/viral-pulse/a080-ip-pack/{name}",
                "source_start": region.get("start"),
                "duration": region.get("duration"),
                "source_rms_db": region.get("rms_db"),
                "source_peak_db": region.get("peak_db"),
                "calibration_gain_db": round(gain_db, 2),
                "sha256": sha256(output),
                "automatic_pool": False,
            })
    args.catalog.parent.mkdir(parents=True, exist_ok=True)
    args.catalog.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", "utf-8")


if __name__ == "__main__":
    main()
