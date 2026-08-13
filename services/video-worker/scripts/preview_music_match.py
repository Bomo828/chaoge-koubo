#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def read_transcript(value: str) -> str:
    candidate = Path(value).expanduser()
    if candidate.is_file():
        payload = json.loads(candidate.read_text("utf-8"))
        if isinstance(payload, dict):
            segments = payload.get("segments")
            if isinstance(segments, list):
                return " ".join(str(item.get("text") or "") for item in segments if isinstance(item, dict))
            return str(payload.get("transcript") or payload.get("text") or "")
        if isinstance(payload, list):
            return " ".join(str(item.get("text") or "") for item in payload if isinstance(item, dict))
    return value


def stable_index(seed: str, length: int) -> int:
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % max(1, length)


def main() -> None:
    parser = argparse.ArgumentParser(description="Preview deterministic content-aware background music selection.")
    parser.add_argument("--template", required=True, type=Path)
    parser.add_argument("--title", default="")
    parser.add_argument("--transcript", default="")
    parser.add_argument("--job-key", default="preview")
    args = parser.parse_args()

    template = json.loads(args.template.expanduser().resolve().read_text("utf-8"))
    audio = template.get("audio") if isinstance(template.get("audio"), dict) else {}
    music = audio.get("music") if isinstance(audio.get("music"), dict) else {}
    tracks = music.get("tracks") if isinstance(music.get("tracks"), list) else []
    tracks = [item for item in tracks if isinstance(item, dict) and str(item.get("file") or "").strip()]
    if not tracks:
        raise SystemExit("Template has no enabled music tracks")

    semantic_text = f"{args.title} {read_transcript(args.transcript)}".lower()
    scored: list[tuple[int, dict[str, Any], list[str]]] = []
    for track in tracks:
        matched = [
            str(keyword)
            for keyword in track.get("match_keywords") or []
            if str(keyword).strip().lower() in semantic_text
        ]
        scored.append((len(matched) * 6, track, matched))
    best_score = max(score for score, _, _ in scored)
    candidates = [track for score, track, _ in scored if score == best_score] if best_score > 0 else tracks
    weighted = [
        track
        for track in candidates
        for _ in range(max(1, min(8, int(track.get("weight") or 1))))
    ]
    selected = weighted[stable_index(f"{args.job_key}:{args.title}:{semantic_text}", len(weighted))]
    result = {
        "template_id": template.get("id"),
        "selected": {
            "id": selected.get("id"),
            "file": selected.get("file"),
            "volume": selected.get("volume"),
            "moods": selected.get("moods") or [],
        },
        "scores": [
            {"id": track.get("id"), "score": score, "matched_keywords": matched}
            for score, track, matched in sorted(scored, key=lambda item: (-item[0], str(item[1].get("id") or "")))
        ],
        "fallback_to_full_pool": best_score == 0,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
