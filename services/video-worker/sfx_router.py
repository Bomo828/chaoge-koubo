from __future__ import annotations

import math
import random
import hashlib
from pathlib import Path
from typing import Any, Callable


def build_semantic_sfx_cues(
    folder: Path,
    template: dict[str, Any],
    duration: float,
    captions: list[dict[str, Any]],
    transition_points: list[float],
    title: str,
    keyword_selector: Callable[[str], str] | None = None,
) -> list[dict[str, Any]]:
    """Select speech-safe SFX from semantic nodes and confirmed highlights.

    Node sounds keep the editorial structure audible.  For templates that opt
    in, a highlighted keyword can also promote an otherwise quiet supporting
    caption into a restrained accent cue.  The cue is placed on the confirmed
    word timestamp when available instead of always firing at caption start.
    """
    configured = template.get("sfx_profile") if isinstance(template.get("sfx_profile"), dict) else {}

    def numeric(value: Any, fallback: float) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return fallback

    pools: dict[str, list[Any]] = {
        "opening": configured.get("opening_pool") or ["sfx/maximize_003.ogg", "sfx/open_002.ogg"],
        "accent": configured.get("accent_pool") or ["sfx/tick_001.ogg", "sfx/select_001.ogg"],
        "transition": configured.get("transition_pool") or ["sfx/open_002.ogg", "sfx/maximize_003.ogg", "sfx/select_001.ogg"],
        "ending": configured.get("ending_pool") or ["sfx/confirmation_001.ogg"],
    }
    for semantic_role in ("hook", "number", "reversal", "step", "conclusion", "brand", "cta", "warning"):
        semantic_pool = configured.get(f"{semantic_role}_pool")
        if isinstance(semantic_pool, list) and semantic_pool:
            pools[semantic_role] = semantic_pool

    selection_policy = str(configured.get("selection_policy") or "node-pool-stable-rotation-v2")
    seed = f"{folder.name}:{template.get('name', '')}:{title}:{duration:.3f}:{selection_policy}"
    rng = random.Random(seed)
    minimum_gap = max(1.8, float(configured.get("minimum_gap_seconds") or 3.0))
    hits_per_minute = max(4.0, float(configured.get("maximum_hits_per_minute") or 10.0))
    maximum_hits = max(2, min(10, math.ceil(duration / 60 * hits_per_minute)))
    cues: list[dict[str, Any]] = []
    last_file = ""
    recent_files: list[str] = []
    role_offsets = {}
    for role, values in pools.items():
        usable_values = [item for item in values if str(item).strip()]
        digest = hashlib.sha1(f"{title}:{role}:{selection_policy}".encode("utf-8")).hexdigest()
        role_offsets[role] = int(digest[:8], 16) % len(usable_values) if usable_values else 0
    role_counts = {role: 0 for role in pools}
    level_map = configured.get("level_map") if isinstance(configured.get("level_map"), dict) else {}
    role_gain_map = configured.get("role_gain_map") if isinstance(configured.get("role_gain_map"), dict) else {}
    maximum_cue_volume = max(
        0.1,
        min(0.5, numeric(configured.get("maximum_cue_volume"), 0.34)),
    )
    sparse_semantic_only = bool(configured.get("sparse_semantic_only"))
    keyword_emphasis_enabled = bool(configured.get("keyword_emphasis_enabled"))
    keyword_min_confidence = max(
        0.0,
        min(1.0, numeric(configured.get("keyword_min_confidence"), 0.62)),
    )
    keyword_category_roles = {
        "benefit": "number",
        "number": "number",
        "action": "step",
        "contrast": "reversal",
        "entity": "brand",
        "cta": "cta",
    }
    configured_category_roles = configured.get("keyword_category_roles")
    if isinstance(configured_category_roles, dict):
        keyword_category_roles.update({
            str(category): str(role)
            for category, role in configured_category_roles.items()
            if str(role) in pools
        })
    playback_rates = {
        "opening": [0.92, 1.0], "accent": [0.96, 1.08, 1.14], "transition": [0.88, 1.0, 1.12],
        "ending": [0.98, 1.08], "hook": [0.96, 1.0], "number": [1.0, 1.08],
        "reversal": [0.92, 1.0], "step": [0.98, 1.06], "conclusion": [0.94, 1.0],
        "brand": [1.0, 1.04], "cta": [1.0, 1.06], "warning": [0.9, 0.96],
    }
    labels = {
        "opening": "开场提示", "accent": "关键词轻点", "transition": "镜头切换", "ending": "结尾确认",
        "hook": "钩子冲击", "number": "数字提示", "reversal": "反转停顿", "step": "步骤切换",
        "conclusion": "结论确认", "brand": "品牌主体", "cta": "行动推进", "warning": "风险警示",
    }

    def add_cue(
        start: float,
        role: str,
        base_volume: float,
        *,
        keyword: str = "",
        caption_text: str = "",
    ) -> None:
        nonlocal last_file
        choices = [str(item) for item in pools.get(role, []) if str(item).strip()]
        if not choices:
            return
        offset = role_offsets.get(role, 0)
        count = role_counts.get(role, 0)
        ordered = choices[offset:] + choices[:offset]
        file = ordered[count % len(ordered)]
        if file in recent_files[-2:] and len(ordered) > 1:
            alternative = next((item for item in ordered if item not in recent_files[-2:]), "")
            if alternative:
                file = alternative
            elif file == last_file:
                file = ordered[(count + 1) % len(ordered)]
        role_counts[role] = count + 1
        last_file = file
        recent_files.append(file)
        rates = playback_rates.get(role, [1.0])
        calibrated_volume = level_map.get(file)
        cue_volume = (
            float(calibrated_volume) * rng.uniform(0.96, 1.04)
            if calibrated_volume is not None
            else base_volume * rng.uniform(0.88, 1.08)
        )
        cue_volume *= max(0.5, min(2.2, numeric(role_gain_map.get(role), 1.0)))
        label = labels.get(role, "节奏提示")
        if keyword:
            label = f"{label}·{keyword}"
        cues.append({
            "start": round(max(0.0, min(duration - 0.05, start)), 3),
            "file": file,
            "volume": round(max(0.055, min(maximum_cue_volume, cue_volume)), 3),
            "playbackRate": round(rates[count % len(rates)], 2),
            "role": role,
            "label": label,
            "keyword": keyword,
            "captionText": caption_text,
        })

    def normalized_text(value: Any) -> str:
        return "".join(character for character in str(value or "") if character.isalnum())

    def highlighted_word_start(caption: dict[str, Any], keyword: str) -> float:
        """Ground a keyword cue to word timing, with a proportional fallback."""
        caption_start = float(caption.get("start") or 0.0)
        caption_end = max(caption_start, float(caption.get("end") or caption_start))
        text = normalized_text(caption.get("text"))
        selected = normalized_text(keyword)
        if not text or not selected:
            return caption_start
        selected_index = text.find(selected)
        if selected_index < 0:
            return caption_start
        words = caption.get("words") if isinstance(caption.get("words"), list) else []
        cursor = 0
        for word in words:
            if not isinstance(word, dict):
                continue
            word_text = normalized_text(word.get("word") or word.get("text"))
            next_cursor = cursor + len(word_text)
            if word_text and cursor <= selected_index < next_cursor:
                return max(caption_start, float(word.get("start") or caption_start))
            cursor = next_cursor
        relative = selected_index / max(1, len(text))
        return caption_start + (caption_end - caption_start) * relative

    add_cue(0.08, "opening", 0.12)
    transition_set = {round(float(value), 2) for value in transition_points}
    candidates: list[tuple[float, str, str, str]] = (
        []
        if sparse_semantic_only
        else [(float(value), "transition", "", "") for value in transition_points]
    )
    for index, caption in enumerate(captions):
        start = float(caption.get("start") or 0.0)
        text = str(caption.get("text") or "")
        keyword = str(caption.get("keyword") or "").strip()
        keyword_grounded = bool(keyword and normalized_text(keyword) in normalized_text(text))
        keyword_confidence_value = caption.get("keywordConfidence")
        keyword_confident = keyword_confidence_value is None or numeric(
            keyword_confidence_value,
            0.0,
        ) >= keyword_min_confidence
        has_keyword_emphasis = keyword_emphasis_enabled and keyword_grounded and keyword_confident
        semantic_role = str(caption.get("semanticRole") or "")
        material_route = caption.get("materialRoute") if isinstance(caption.get("materialRoute"), dict) else {}
        route_disabled = material_route.get("sfx") == "none"
        cue_role = semantic_role if semantic_role in pools and semantic_role not in {"opening", "accent", "transition", "ending"} else ""
        if has_keyword_emphasis:
            keyword_category = str(caption.get("keywordCategory") or "").strip().lower()
            category_role = keyword_category_roles.get(keyword_category, "")
            if category_role in pools:
                cue_role = category_role
            elif not cue_role:
                cue_role = "accent"
            candidates.append((highlighted_word_start(caption, keyword), cue_role, keyword, text))
        elif cue_role and not route_disabled:
            candidates.append((start, cue_role, "", text))
        elif not sparse_semantic_only and index > 0:
            keyword = keyword_selector(text) if keyword_selector else ""
            if (keyword and keyword in text) or index % 3 == 0:
                candidates.append((start, "transition" if round(start, 2) in transition_set else "accent", "", text))

    last_start = 0.08
    for start, role, keyword, caption_text in sorted(candidates, key=lambda item: item[0]):
        if len(cues) >= maximum_hits:
            break
        if start < 1.2 or start > duration - 1.2 or start - last_start < minimum_gap:
            continue
        base_volume = {
            "number": 0.105, "step": 0.1, "hook": 0.12, "reversal": 0.09,
            "warning": 0.09, "conclusion": 0.1, "brand": 0.095, "cta": 0.1,
        }.get(role, 0.09 if role == "accent" else 0.085)
        add_cue(start, role, base_volume, keyword=keyword, caption_text=caption_text)
        last_start = start

    # A spoken CTA is editorially more important than a generic ending chime.
    # Reserve the final hit for it, removing a nearby lower-priority cue when
    # necessary instead of silently replacing every CTA with the same ending.
    final_cta = next((
        float(caption.get("start") or 0.0)
        for caption in reversed(captions)
        if str(caption.get("semanticRole") or "") == "cta"
    ), None)
    if final_cta is not None and not any(cue.get("role") == "cta" for cue in cues):
        if cues and final_cta - float(cues[-1].get("start") or 0.0) < minimum_gap * 0.7:
            cues.pop()
        if len(cues) >= maximum_hits:
            cues.pop()
        previous_start = float(cues[-1].get("start") or 0.08) if cues else 0.08
        if final_cta >= 1.2 and final_cta <= duration - 0.2 and final_cta - previous_start >= minimum_gap * 0.7:
            add_cue(final_cta, "cta", 0.1)
            last_start = final_cta

    if duration >= 5 and len(cues) < maximum_hits and not any(cue.get("role") == "cta" for cue in cues) and duration - last_start >= minimum_gap * 0.7:
        add_cue(max(0.0, duration - 0.72), "ending", 0.09)
    return cues
