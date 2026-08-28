#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def require_mapping(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def validate(path: Path) -> None:
    value = require_mapping(json.loads(path.read_text("utf-8")), "template")
    version = int(value.get("version") or 0)
    if version < 2:
        raise ValueError("version must be 2 or newer")
    for key in ("id", "name"):
        if not str(value.get(key) or "").strip():
            raise ValueError(f"{key} is required")
    template_id = str(value.get("id") or "").strip()
    if version >= 10:
        if int(value.get("package_contract_version") or 0) < 3:
            raise ValueError("package_contract_version must be >= 3")
        if value.get("package_mode") != "isolated":
            raise ValueError("package_mode must be isolated")
        if value.get("fallback_policy") != "forbid-cross-template":
            raise ValueError("fallback_policy must forbid cross-template fallback")
        if not str(value.get("renderer_key") or "").strip():
            raise ValueError("renderer_key is required")
    canvas = require_mapping(value.get("canvas"), "canvas")
    width = int(canvas.get("width") or 0)
    height = int(canvas.get("height") or 0)
    if width < 320 or height < 320 or width % 2 or height % 2:
        raise ValueError("canvas width and height must be even numbers >= 320")
    body = require_mapping(value.get("body"), "body")
    if int(body.get("caption_max_chars") or 0) < 4:
        raise ValueError("body.caption_max_chars must be >= 4")
    if float(body.get("minimum_transition_gap_seconds") or 0) < 0.5:
        raise ValueError("body.minimum_transition_gap_seconds must be >= 0.5")
    if version >= 3:
        if float(body.get("rhythm_interval_seconds") or 0) < 1:
            raise ValueError("body.rhythm_interval_seconds must be >= 1")
        if body.get("bilingual") not in (True, False):
            raise ValueError("body.bilingual must be a boolean")
    audio = require_mapping(value.get("audio"), "audio")
    if audio.get("preserve_source") is not True:
        raise ValueError("audio.preserve_source must be true")
    sfx = audio.get("sfx") if isinstance(audio.get("sfx"), dict) else {}
    for pool_name, pool_value in sfx.items():
        if not str(pool_name).endswith("_pool"):
            continue
        if not isinstance(pool_value, list):
            raise ValueError(f"audio.sfx.{pool_name} must be a list")
        if any(not str(asset).startswith(f"sfx/{template_id}/") for asset in pool_value):
            raise ValueError(f"audio.sfx.{pool_name} must use the template-owned SFX namespace")
    music = audio.get("music")
    if music not in (False, None) and not isinstance(music, dict):
        raise ValueError("audio.music must be false or an object")
    if isinstance(music, dict) and music.get("enabled") is True:
        if not str(music.get("file") or "").strip():
            raise ValueError("enabled audio.music requires a licensed file")
        volume = float(music.get("volume") or 0)
        if not 0 < volume <= 0.18:
            raise ValueError("audio.music.volume must be between 0 and 0.18")
        tracks = music.get("tracks")
        if version >= 10 and (not isinstance(tracks, list) or not tracks):
            raise ValueError("enabled Template V10 music requires a non-empty tracks pool")
        seen_ids: set[str] = set()
        seen_files: set[str] = set()
        for index, track in enumerate(tracks or []):
            if not isinstance(track, dict):
                raise ValueError(f"audio.music.tracks[{index}] must be an object")
            track_id = str(track.get("id") or "").strip()
            track_file = str(track.get("file") or "").strip()
            if not track_id or track_id in seen_ids:
                raise ValueError(f"audio.music.tracks[{index}] id must be unique")
            if not track_file or track_file in seen_files:
                raise ValueError(f"audio.music.tracks[{index}] file must be unique")
            if not track_file.startswith(f"music/{template_id}/"):
                raise ValueError(f"audio.music.tracks[{index}] must use the template-owned music namespace")
            track_volume = float(track.get("volume") or 0)
            if not 0 < track_volume <= 0.18:
                raise ValueError(f"audio.music.tracks[{index}] volume must be between 0 and 0.18")
            if not isinstance(track.get("moods"), list) or not track.get("moods"):
                raise ValueError(f"audio.music.tracks[{index}] requires moods")
            if not isinstance(track.get("match_keywords"), list) or not track.get("match_keywords"):
                raise ValueError(f"audio.music.tracks[{index}] requires match_keywords")
            seen_ids.add(track_id)
            seen_files.add(track_file)
    if version >= 8:
        gate = require_mapping(value.get("quality_gate"), "quality_gate")
        if gate.get("frame_analysis") != "every-decoded-frame":
            raise ValueError("quality_gate.frame_analysis must be every-decoded-frame")
        if float(gate.get("caption_text_coverage_min") or 0) < 0.9:
            raise ValueError("quality_gate.caption_text_coverage_min must be >= 0.9")
        if float(gate.get("speech_time_coverage_min") or 0) < 0.92:
            raise ValueError("quality_gate.speech_time_coverage_min must be >= 0.92")
        if gate.get("decoded_frame_match_required") is not True:
            raise ValueError("quality_gate.decoded_frame_match_required must be true")
        if int(gate.get("maximum_corrupt_frames", -1)) != 0:
            raise ValueError("quality_gate.maximum_corrupt_frames must be 0")
        if int(gate.get("minimum_test_videos") or 0) < 2:
            raise ValueError("quality_gate.minimum_test_videos must be >= 2")
        if version >= 10 and gate.get("cross_template_fallback_allowed") is not False:
            raise ValueError("quality_gate.cross_template_fallback_allowed must be false")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: validate_template.py /absolute/path/template.json")
    path = Path(sys.argv[1]).expanduser().resolve()
    try:
        validate(path)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"Template validation failed: {error}") from error
    print(f"Template valid: {path}")


if __name__ == "__main__":
    main()
