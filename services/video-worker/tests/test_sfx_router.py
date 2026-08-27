from pathlib import Path

from sfx_router import build_semantic_sfx_cues


def template9_profile() -> dict:
    return {
        "name": "红白双语",
        "sfx_profile": {
            "selection_policy": "node-highlight-stable-rotation-v4",
            "minimum_gap_seconds": 1.8,
            "maximum_hits_per_minute": 18,
            "keyword_emphasis_enabled": True,
            "keyword_min_confidence": 0.62,
            "opening_pool": ["opening-a.wav", "opening-b.wav"],
            "accent_pool": ["accent-a.wav", "accent-b.wav", "accent-c.wav"],
            "number_pool": ["number-a.wav", "number-b.wav"],
            "reversal_pool": ["reversal-a.wav", "reversal-b.wav"],
            "step_pool": ["step-a.wav", "step-b.wav"],
            "brand_pool": ["brand-a.wav", "brand-b.wav"],
            "cta_pool": ["cta-a.wav", "cta-b.wav"],
            "ending_pool": ["ending-a.wav"],
        },
    }


def caption(index: int, text: str, keyword: str, role: str = "steady", category: str = "", keyword_sfx: bool = True) -> dict:
    start = index * 2.5
    return {
        "start": start,
        "end": start + 2.0,
        "text": text,
        "keyword": keyword,
        "keywordCategory": category,
        "keywordConfidence": 0.9,
        "keywordSfx": keyword_sfx,
        "semanticRole": role,
        "materialRoute": {"sfx": "none" if role == "steady" else role},
        "words": [
            {"text": text[:2], "start": start, "end": start + 0.6},
            {"text": text[2:], "start": start + 0.6, "end": start + 2.0},
        ],
    }


def test_highlighted_supporting_captions_receive_varied_keyword_sfx() -> None:
    captions = [
        caption(0, "今天分享方法", "分享"),
        caption(1, "重点提升效率", "提升效率", category="benefit"),
        caption(2, "但是成本更低", "成本更低", category="contrast"),
        caption(3, "第一步先检查", "第一步", category="action"),
        caption(4, "品牌服务升级", "品牌服务", category="entity"),
        caption(5, "现在马上咨询", "马上咨询", category="cta"),
        caption(6, "真实案例复盘", "案例复盘"),
        caption(7, "记住关键结果", "关键结果"),
        caption(8, "最后欢迎关注", "欢迎关注", role="cta", category="cta"),
    ]
    cues = build_semantic_sfx_cues(
        Path("/tmp/template9-keyword-test"),
        template9_profile(),
        23.0,
        captions,
        [],
        "重点效率方法",
    )

    assert len(cues) >= 7
    assert any(cue["keyword"] == "提升效率" and cue["role"] == "number" for cue in cues)
    assert any(cue["keyword"] == "成本更低" and cue["role"] == "reversal" for cue in cues)
    assert any(cue["keyword"] == "品牌服务" and cue["role"] == "brand" for cue in cues)
    assert len({cue["file"] for cue in cues}) >= 5
    assert all(
        float(current["start"]) - float(previous["start"]) >= 1.79
        for previous, current in zip(cues, cues[1:])
    )


def test_keyword_cue_uses_confirmed_word_timestamp() -> None:
    captions = [caption(1, "重点提升效率", "提升效率", category="benefit")]
    cues = build_semantic_sfx_cues(
        Path("/tmp/template9-word-time-test"),
        template9_profile(),
        8.0,
        captions,
        [],
        "效率提升",
    )

    keyword_cue = next(cue for cue in cues if cue.get("keyword") == "提升效率")
    assert keyword_cue["start"] == 3.1


def test_regular_visual_highlight_does_not_receive_keyword_sfx() -> None:
    captions = [
        caption(1, "重点提升效率", "提升效率", category="benefit", keyword_sfx=False),
        caption(3, "成本降低一半", "降低一半", category="contrast", keyword_sfx=True),
    ]
    cues = build_semantic_sfx_cues(
        Path("/tmp/template9-regular-highlight-test"),
        template9_profile(),
        10.0,
        captions,
        [],
        "视觉提亮和声音重点分层",
    )

    assert not any(cue.get("keyword") == "提升效率" for cue in cues)
    assert any(cue.get("keyword") == "降低一半" for cue in cues)
    assert not any(cue.get("role") == "accent" and not cue.get("keyword") for cue in cues)


def test_role_gain_makes_keyword_cues_audibly_stronger() -> None:
    profile = template9_profile()
    profile["sfx_profile"]["role_gain_map"] = {"number": 2.05, "transition": 1.0}
    profile["sfx_profile"]["maximum_cue_volume"] = 0.46
    profile["sfx_profile"]["level_map"] = {"number-a.wav": 0.18, "number-b.wav": 0.18}
    captions = [caption(1, "福利达到8000万", "8000万", category="number")]

    cues = build_semantic_sfx_cues(
        Path("/tmp/template9-gain-test"),
        profile,
        8.0,
        captions,
        [],
        "响度测试",
    )
    number_cue = next(cue for cue in cues if cue["role"] == "number")

    assert 0.34 <= number_cue["volume"] <= 0.46


def test_long_video_respects_template_per_minute_density() -> None:
    captions = [
        caption(index, f"第{index + 1}个重点方法", f"第{index + 1}个重点", category="action")
        for index in range(24)
    ]
    cues = build_semantic_sfx_cues(
        Path("/tmp/template9-long-density-test"),
        template9_profile(),
        60.0,
        captions,
        [],
        "长视频音效密度测试",
    )

    # Opening + semantic keyword cues should no longer be globally capped at 10.
    assert 11 <= len(cues) <= 18


def test_isolated_template_never_falls_back_to_public_transition_sfx() -> None:
    profile = {
        "name": "独立模板",
        "package_mode": "isolated",
        "fallback_policy": "forbid-cross-template",
        "sfx_profile": {
            "opening_pool": ["sfx/template-11/open.wav"],
            "accent_pool": ["sfx/template-11/tick.wav"],
            "transition_pool": [],
            "ending_pool": ["sfx/template-11/end.wav"],
            "minimum_gap_seconds": 1.8,
            "maximum_hits_per_minute": 12,
        },
    }
    cues = build_semantic_sfx_cues(
        Path("/tmp/isolated-transition-test"),
        profile,
        12.0,
        [],
        [4.0, 8.0],
        "独立音效测试",
    )

    assert not any(cue.get("role") == "transition" for cue in cues)
    assert all(str(cue.get("file") or "").startswith("sfx/template-11/") for cue in cues)
