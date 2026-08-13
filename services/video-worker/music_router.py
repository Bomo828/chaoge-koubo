from __future__ import annotations

import random
from typing import Any


def select_content_music(
    tracks: list[dict[str, Any]],
    title: str,
    captions: list[dict[str, Any]],
    seed_key: str,
) -> dict[str, Any] | None:
    """Choose one complete speech-safe track from semantic text and nodes."""
    usable_tracks = [
        item for item in tracks
        if isinstance(item, dict) and str(item.get("file") or "").strip()
    ]
    if not usable_tracks:
        return None
    semantic_text = " ".join([
        str(title or ""),
        *[str(item.get("text") or "") for item in captions],
    ]).lower()
    node_counts: dict[str, int] = {}
    for caption in captions:
        node = str(caption.get("contentNode") or "supporting")
        if node not in {"supporting", "hook", "cta"}:
            node_counts[node] = node_counts.get(node, 0) + 1
    dominant_node = max(node_counts, key=node_counts.get) if node_counts else "supporting"
    scored_tracks: list[tuple[int, dict[str, Any]]] = []
    for item in usable_tracks:
        keywords = item.get("match_keywords") if isinstance(item.get("match_keywords"), list) else []
        dominant_nodes = item.get("dominant_nodes") if isinstance(item.get("dominant_nodes"), list) else []
        score = sum(6 for keyword in keywords if str(keyword).strip().lower() in semantic_text)
        if dominant_node in dominant_nodes:
            score += 8
        scored_tracks.append((score, item))
    best_score = max((score for score, _ in scored_tracks), default=0)
    candidates = [item for score, item in scored_tracks if score == best_score] if best_score > 0 else usable_tracks
    weighted_tracks = [
        item
        for item in candidates
        for _ in range(max(1, min(8, int(item.get("weight") or 1))))
    ]
    selected = random.Random(f"{seed_key}:{title}:bgm-v3").choice(weighted_tracks)
    return {
        **selected,
        "match_score": best_score,
        "dominant_node": dominant_node,
        "candidate_ids": [str(item.get("id") or "") for item in candidates],
    }
