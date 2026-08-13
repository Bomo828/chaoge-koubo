#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import wave
from pathlib import Path

import numpy as np


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze an A080 audio reel into transient regions.")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    wav_path = args.output.with_suffix(".analysis.wav")
    subprocess.run([
        str(args.ffmpeg), "-loglevel", "error", "-y", "-i", str(args.input),
        "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav_path),
    ], check=True)
    with wave.open(str(wav_path), "rb") as stream:
        rate = stream.getframerate()
        samples = np.frombuffer(stream.readframes(stream.getnframes()), dtype="<i2").astype(np.float32) / 32768
    window = max(1, round(rate * .02))
    padded = np.pad(samples, (0, (-len(samples)) % window))
    frames = padded.reshape(-1, window)
    rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
    peak = np.max(np.abs(frames), axis=1)
    times = np.arange(len(rms)) * window / rate
    threshold = max(10 ** (-42 / 20), float(np.percentile(rms, 38)) * 2.4)
    active = rms >= threshold
    # Fill gaps shorter than 140ms and remove bursts shorter than 45ms.
    max_gap = max(1, round(.14 * rate / window))
    active_indices = np.flatnonzero(active)
    for left, right in zip(active_indices, active_indices[1:]):
        if right - left - 1 <= max_gap:
            active[left:right + 1] = True
    regions = []
    start = None
    for index, value in enumerate(np.r_[active, False]):
        if value and start is None:
            start = index
        elif not value and start is not None:
            if index - start >= max(2, round(.045 * rate / window)):
                left = max(0, start * window / rate - .035)
                right = min(len(samples) / rate, index * window / rate + .12)
                region = samples[int(left * rate):int(right * rate)]
                region_rms = float(np.sqrt(np.mean(region * region) + 1e-12))
                region_peak = float(np.max(np.abs(region))) if len(region) else 0
                regions.append({
                    "start": round(left, 3),
                    "end": round(right, 3),
                    "duration": round(right - left, 3),
                    "rms_db": round(20 * np.log10(region_rms + 1e-9), 2),
                    "peak_db": round(20 * np.log10(region_peak + 1e-9), 2),
                })
            start = None
    result = {
        "source": str(args.input),
        "duration": round(len(samples) / rate, 3),
        "threshold_db": round(20 * np.log10(threshold), 2),
        "regions": regions,
    }
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", "utf-8")
    wav_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
