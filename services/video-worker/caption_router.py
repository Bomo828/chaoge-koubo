from __future__ import annotations

import hashlib
from typing import Any


def select_caption_material(
    content_director: dict[str, Any] | None,
    node: str,
    title: str,
    text: str,
    index: int,
    fallback: str,
) -> str:
    """Select a stable caption treatment from a semantic node's local pool."""
    director = content_director if isinstance(content_director, dict) else {}
    nodes = director.get("nodes") if isinstance(director.get("nodes"), dict) else {}
    node_config = nodes.get(node) if isinstance(nodes.get(node), dict) else {}
    pool = [str(item).strip() for item in node_config.get("caption_pool") or [] if str(item).strip()]
    if not pool:
        return fallback
    policy = str(director.get("caption_selection_policy") or "node-caption-stable-rotation-v1")
    digest = hashlib.sha1(f"{policy}:{title}:{node}:{text}:{index}".encode("utf-8")).hexdigest()
    return pool[int(digest[:10], 16) % len(pool)]
