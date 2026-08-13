#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sfx_router import build_semantic_sfx_cues
from music_router import select_content_music
from caption_router import select_caption_material


SFX_NODE_LABELS = {
    "opening": "开场钩子",
    "reversal": "痛点或反差",
    "conclusion": "核心观点",
    "number": "数字与利益点",
    "step": "举例或步骤",
    "brand": "品牌、人名、产品名",
    "cta": "行动号召",
    "ending": "结尾确认",
}


ROLE_ANIMATION = {
    "steady": "steady",
    "hook": "hook-slam",
    "keyword": "keyword-hit",
    "number": "number-count",
    "reversal": "reversal-swap",
    "step": "step-card",
    "conclusion": "conclusion-stamp",
    "cta": "cta-push",
    "warning": "reversal-swap",
    "example": "steady",
    "brand": "brand-tag",
}


def role_for(text: str, index: int) -> str:
    compact = re.sub(r"\s+", "", text)
    if index == 0 or any(value in compact for value in ("你知道", "为什么", "千万", "别再", "很多人", "最重要", "想提升")):
        return "hook"
    if re.search(r"\d|[一二三四五六七八九十百千万]+个|第[一二三四五六七八九十]", compact):
        return "number"
    if any(value in compact for value in ("但是", "不过", "其实", "相反", "没想到", "结果却", "真正", "而是")):
        return "reversal"
    if any(value in compact for value in ("第一", "第二", "第三", "首先", "其次", "最后一步", "步骤", "一步步")):
        return "step"
    if any(value in compact for value in ("所以", "记住", "核心", "结论", "关键是", "这就是")):
        return "conclusion"
    if any(value in compact for value in ("马上", "现在就", "欢迎", "点击", "咨询", "预约", "行动", "开始")):
        return "cta"
    if any(value in compact for value in ("错误", "不要", "不能", "风险", "警惕", "注意")):
        return "warning"
    if any(value in compact for value in ("比如", "例如", "举个例子")):
        return "example"
    if any(value in compact for value in ("提升", "价值", "方法", "效果", "重点", "专业", "技能", "岗位")):
        return "keyword"
    return "steady"


def content_node_for(text: str, index: int, total: int) -> str:
    compact = re.sub(r"\s+", "", text)
    if index == total - 1 and any(value in compact for value in ("欢迎", "咨询", "预约", "点击", "联系", "了解", "开始", "留言", "关注")):
        return "cta"
    if index == 0 or any(value in compact for value in ("你知道", "为什么", "千万", "别再", "很多人", "最重要", "想不想", "是不是")):
        return "hook"
    if any(value in compact for value in ("但是", "不过", "其实", "相反", "没想到", "结果却", "真正", "而是", "不是", "不知道", "担心", "问题")):
        return "pain_reversal"
    if re.search(r"\d|\d+(?:\.\d+)?[%折元万+]|[一二三四五六七八九十百千万]+个|第[一二三四五六七八九十]", compact) or any(value in compact for value in ("省", "提升", "增长", "效率", "收益", "优惠", "免费", "实用", "帮你", "打扎实", "练熟", "竞争力")):
        return "number_benefit"
    if any(value in compact for value in ("比如", "例如", "举个例子", "第一", "第二", "第三", "首先", "其次", "最后一步", "步骤", "怎么做", "如何")):
        return "example_step"
    if any(value in compact for value in ("老师", "品牌", "公司", "门店", "产品", "钟智联", "我们是", "我是", "叫做", "型号", "AI课程")):
        return "brand_entity"
    if any(value in compact for value in ("所以", "记住", "核心", "结论", "关键是", "这就是", "本质", "观点", "方法", "价值", "重点", "专业", "围绕", "会从")):
        return "core_viewpoint"
    return "supporting"


def build(source_timeline: Path, source_video: Path, output_dir: Path, music: str) -> None:
    source = json.loads(source_timeline.read_text("utf-8"))
    template_document = json.loads(
        (Path(__file__).resolve().parents[1] / "templates-v2" / "viral-pulse" / "template.json").read_text("utf-8")
    )
    content_director = template_document.get("content_director") if isinstance(template_document.get("content_director"), dict) else {}
    output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_video, output_dir / "source.mp4")
    captions = []
    strong = 0
    max_strong = max(1, (len(source.get("captions") or []) * 35 + 99) // 100)
    last_strong = -2
    for index, raw in enumerate(source.get("captions") or []):
        caption = dict(raw)
        node = content_node_for(str(caption.get("text") or ""), index, len(source.get("captions") or []))
        role = {
            "pain_reversal": "reversal",
            "core_viewpoint": "conclusion",
            "number_benefit": "number",
            "example_step": "step",
            "brand_entity": "brand",
            "supporting": "steady",
        }.get(node, node)
        effect_level = "normal"
        if role not in {"steady", "example", "brand", "hook", "cta"}:
            if strong >= max_strong or index - last_strong <= 1:
                effect_level = "subtle"
            else:
                strong += 1
                last_strong = index
        if index == len(source.get("captions") or []) - 1 and any(value in str(caption.get("text") or "") for value in ("欢迎", "咨询", "预约", "开始", "了解")):
            role = "cta"
        caption["semanticRole"] = role
        caption["contentNode"] = node
        caption["effectLevel"] = effect_level
        caption["animation"] = ROLE_ANIMATION[role]
        fallback_caption_style = {"hook": "hook-impact", "reversal": "contrast-swap", "conclusion": "viewpoint-stamp", "number": "number-benefit", "step": "step-card", "brand": "brand-nameplate", "cta": "cta-action"}.get(role, "supporting-clean")
        caption_style = select_caption_material(
            content_director,
            node,
            str(source.get("title") or ""),
            str(caption.get("text") or ""),
            index,
            fallback_caption_style,
        )
        caption["captionStyle"] = caption_style
        caption["materialRoute"] = {
            "caption": caption_style,
            "camera": {"hook": "hook-push", "reversal": "contrast-shift", "conclusion": "viewpoint-hold", "number": "benefit-push", "step": "step-drift", "brand": "brand-hold", "cta": "cta-push"}.get(role, "supporting-breathe"),
            "sfx": {"hook": "hook", "reversal": "reversal", "conclusion": "conclusion", "number": "number", "step": "step", "brand": "brand", "cta": "cta"}.get(role, "none"),
            "transition": {"hook": "soft-punch", "reversal": "drift-left", "conclusion": "soft-punch", "number": "soft-flash", "step": "drift-right", "cta": "soft-flash"}.get(role, "none"),
        }
        if effect_level == "subtle":
            caption["materialRoute"]["sfx"] = "none"
            caption["materialRoute"]["transition"] = "none"
        caption.pop("layout", None)
        caption.pop("sectionEmphasis", None)
        captions.append(caption)

    step_number = 0
    for caption in captions:
        if caption.get("contentNode") == "example_step" and caption.get("animation") == "step-card":
            step_number += 1
            caption["stepNumber"] = step_number
        else:
            caption.pop("stepNumber", None)

    transitions = []
    transition_map = {
        "reversal": {"style": "drift-left", "duration": .38, "intensity": .28},
        "conclusion": {"style": "soft-punch", "duration": .34, "intensity": .28},
        "number": {"style": "soft-flash", "duration": .24, "intensity": .28},
        "step": {"style": "drift-right", "duration": .36, "intensity": .26},
        "cta": {"style": "soft-flash", "duration": .24, "intensity": .28},
    }
    last_transition = -9.0
    for caption in captions:
        role = str(caption.get("semanticRole") or "steady")
        start = float(caption.get("start") or 0)
        route = caption.get("materialRoute") if isinstance(caption.get("materialRoute"), dict) else {}
        if route.get("transition") != "none" and role in transition_map and 1.2 < start < float(source.get("duration") or 999) - .8 and start - last_transition >= 5.5:
            transitions.append({"start": start, **transition_map[role]})
            last_transition = start

    duration = float(source.get("duration") or max((float(item.get("end") or 0) for item in captions), default=1.0))
    audio = template_document.get("audio") if isinstance(template_document.get("audio"), dict) else {}
    sfx = build_semantic_sfx_cues(
        output_dir,
        {"name": template_document.get("name", "模板1"), "sfx_profile": audio.get("sfx", {})},
        duration,
        captions,
        [float(item.get("start") or 0) for item in transitions],
        str(source.get("title") or ""),
    )

    camera = []
    origins = ["50% 43%"]
    rhythm_scales = [1.018, 1.045, 1.028, 1.055, 1.035]
    scale_for = {"hook": 1.035, "number": 1.055, "reversal": 1.048, "step": 1.052, "conclusion": 1.05, "cta": 1.055, "warning": 1.048}
    for index, caption in enumerate(captions):
        camera.append({
            "start": caption["start"],
            "end": caption["end"],
            "scale": {**scale_for, "brand": 1.025}.get(caption.get("semanticRole"), rhythm_scales[index % len(rhythm_scales)]),
            "origin": origins[0],
        })

    music_tracks = ((audio.get("music") or {}).get("tracks") or []) if isinstance(audio.get("music"), dict) else []
    selected_music = select_content_music(
        music_tracks,
        str(source.get("title") or ""),
        captions,
        f"{output_dir.name}:{duration:.3f}",
    )
    source.update({
        "sourceFile": "source.mp4",
        "sourceVolume": 1,
        "bgmFile": str((selected_music or {}).get("file") or music),
        "bgmTrackId": str((selected_music or {}).get("id") or Path(music).stem),
        "bgmVolume": float((selected_music or {}).get("volume") or .09),
        "sfxFile": "",
        "sfxCues": sfx,
        "captions": captions,
        "cameraCues": camera,
        "transitionCues": transitions,
        "chapters": [],
        "cards": [],
        "coverTime": .8,
        "theme": {
            "rendererKey": "viral-pulse-director-v1",
            "name": str(template_document.get("name") or "模板1"),
            "background": "#080808",
            "foreground": "#fffdf7",
            "accent": "#fff300",
            "accentSoft": "#fff30033",
            "titlePosition": "top",
            "subtitlePosition": "bottom",
            "captionMode": "kinetic-viral-pulse",
            "keywordColor": "#fff300",
            "headlineDuration": 2.6,
            "headlineTop": 164,
            "headlinePersistent": False,
            "headlineAnimation": "staggered-punch",
            "headlineFontSize": 88,
            "headlineLineGap": 15,
            "captionSafeInset": 92,
            "captionMaxWidth": 896,
            "captionLineMaxChars": 8,
        },
    })
    (output_dir / "timeline.json").write_text(json.dumps(source, ensure_ascii=False, indent=2) + "\n", "utf-8")
    routing_report = {
        "title": str(source.get("title") or ""),
        "selection_policy": str((audio.get("sfx") or {}).get("selection_policy") or "node-pool-stable-rotation-v1"),
        "minimum_gap_seconds": float((audio.get("sfx") or {}).get("minimum_gap_seconds") or 3.2),
        "cue_count": len(sfx),
        "unique_file_count": len({str(item.get("file") or "") for item in sfx}),
        "cues": [
            {
                "time": item.get("start"),
                "content_node": SFX_NODE_LABELS.get(str(item.get("role") or ""), str(item.get("label") or "")),
                "role": item.get("role"),
                "sound": Path(str(item.get("file") or "")).name,
                "volume": item.get("volume"),
                "playback_rate": item.get("playbackRate"),
            }
            for item in sfx
        ],
    }
    (output_dir / "sfx-routing-report.json").write_text(
        json.dumps(routing_report, ensure_ascii=False, indent=2) + "\n",
        "utf-8",
    )
    routing_lines = [
        f"# {routing_report['title']}｜音效路由",
        "",
        f"选择策略：{routing_report['selection_policy']}；共 {routing_report['cue_count']} 个音效点，使用 {routing_report['unique_file_count']} 个不同文件。",
        "",
        "| 时间 | 内容节点 | 音效 | 音量 | 速度 |",
        "|---:|---|---|---:|---:|",
    ]
    routing_lines.extend(
        f"| {float(item['time']):.2f}s | {item['content_node']} | {item['sound']} | {float(item['volume']):.3f} | {float(item['playback_rate']):.2f} |"
        for item in routing_report["cues"]
    )
    (output_dir / "sfx-routing-report.md").write_text("\n".join(routing_lines) + "\n", "utf-8")
    music_report = {
        "title": str(source.get("title") or ""),
        "selected": {
            "id": source.get("bgmTrackId"),
            "file": source.get("bgmFile"),
            "volume": source.get("bgmVolume"),
            "moods": (selected_music or {}).get("moods") or [],
        },
        "dominant_node": (selected_music or {}).get("dominant_node"),
        "match_score": (selected_music or {}).get("match_score"),
        "candidate_ids": (selected_music or {}).get("candidate_ids") or [],
    }
    (output_dir / "music-routing-report.json").write_text(
        json.dumps(music_report, ensure_ascii=False, indent=2) + "\n",
        "utf-8",
    )


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise SystemExit("usage: build_viral_pulse_review.py <source-timeline> <source-video> <output-dir> <music-file>")
    build(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4])
