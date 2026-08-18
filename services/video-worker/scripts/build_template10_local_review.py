#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import shutil
from pathlib import Path

from build_template9_local_review import (
    PROJECT,
    SOURCE_ROOT,
    load_local_environment,
    load_worker,
    resegment_review_captions,
)


OUTPUT_ROOT = PROJECT / "artifacts" / "template-10-local-review"

LONG_BEATS = [
    "AI现在已经", "不是新鲜话题", "而是很多岗位", "都用得上的", "效率工具",
    "我们的AI课程", "会从基础认知讲起", "带你一步步", "了解AI", "能做什么", "怎么用到工作里",
    "课程中会教你", "如何提问", "如何生成", "文案和图片", "如何整理资料", "提升沟通", "和执行效率",
    "无论你是想跟上", "行业趋势", "还是想给自己的", "工作增加竞争力", "都可以先来", "了解一下",
]

TRANSLATIONS = {
    "想提升办公和职场技能": "Improve your office and workplace skills",
    "不知道从哪开始": "Not sure where to begin",
    "大家好": "Hello everyone",
    "我是钟智联的": "I am from Zhilian",
    "张老师": "Teacher Zhang",
    "文员会计": "Clerical and accounting",
    "电商外贸员": "E-commerce and trade",
    "实用技能培训": "Practical skills training",
    "都可以来钟智联了解": "Learn more at Zhilian",
    "课程围绕岗位需求": "Courses built for real jobs",
    "帮你把基础打扎实": "Build a solid foundation",
    "把操作练熟": "Master the workflow",
    "想学一门实用技能": "Learn a practical skill",
    "欢迎来咨询": "Contact us to learn more",
    "AI现在已经": "AI is already here",
    "不是新鲜话题": "No longer a new topic",
    "而是很多岗位": "Many roles already",
    "都用得上的": "use it every day",
    "效率工具": "A tool for efficiency",
    "我们的AI课程": "Our AI course",
    "会从基础认知讲起": "starts with the basics",
    "带你一步步": "Step by step",
    "了解AI": "Understand AI",
    "能做什么": "and what it can do",
    "怎么用到工作里": "Use it in your work",
    "课程中会教你": "The course teaches you",
    "如何提问": "How to prompt",
    "如何生成": "How to generate",
    "文案和图片": "copy and images",
    "如何整理资料": "Organize information",
    "提升沟通": "Improve communication",
    "和执行效率": "and execution efficiency",
    "无论你是想跟上": "Whether you want to follow",
    "行业趋势": "industry trends",
    "还是想给自己的": "or strengthen",
    "工作增加竞争力": "your competitiveness",
    "都可以先来": "Come and learn",
    "了解一下": "more about it",
}


def build_review(worker, label: str) -> dict[str, object]:
    source_dir = SOURCE_ROOT / label
    output_dir = OUTPUT_ROOT / label
    output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_dir / "source.mp4", output_dir / "source.mp4")
    source_timeline = json.loads((source_dir / "timeline.json").read_text("utf-8"))
    source_captions = source_timeline.get("captions") or []
    directed_source = (
        [dict(item) for item in source_captions]
        if label == "short"
        else resegment_review_captions(source_captions, LONG_BEATS)
    )
    captions = worker.finalize_template10_director_plan(directed_source)
    for caption in captions:
        caption["translation"] = TRANSLATIONS.get(str(caption.get("text") or ""), "")

    duration = float(source_timeline.get("duration") or 1.0)
    camera_scales = {
        "hook": 1.08,
        "pain_reversal": 1.0,
        "core_viewpoint": 1.15,
        "number_benefit": 1.17,
        "example_step": 1.10,
        "brand_entity": 1.16,
        "cta": 1.15,
    }
    supporting_scales = [1.0, 1.14, 1.04, 1.17, 1.02, 1.13]
    camera_origins = ["50% 43%", "49.5% 42.5%", "50.5% 43%", "50% 42%"]
    camera_blocks: list[list[dict[str, object]]] = []
    for caption in captions:
        node = str(caption.get("contentNode") or "supporting")
        if not camera_blocks or str(camera_blocks[-1][0].get("contentNode") or "supporting") != node or len(camera_blocks[-1]) >= 2:
            camera_blocks.append([caption])
        else:
            camera_blocks[-1].append(caption)
    camera_cues = []
    for index, block in enumerate(camera_blocks):
        start = float(block[0].get("start") or 0.0)
        end = float(block[-1].get("end") or duration)
        node = str(block[0].get("contentNode") or "supporting")
        scale = camera_scales.get(node, supporting_scales[index % len(supporting_scales)])
        origin = camera_origins[index % len(camera_origins)]
        if node in {"core_viewpoint", "number_benefit", "brand_entity", "cta"} and end - start > 0.38:
            reset_end = min(end, start + 0.12)
            camera_cues.append({"start": round(start, 3), "end": round(reset_end, 3), "scale": 1.0, "origin": origin})
            start = reset_end
        camera_cues.append({"start": round(start, 3), "end": round(end, 3), "scale": scale, "origin": origin})
    for index in range(len(camera_cues) - 1):
        camera_cues[index]["end"] = camera_cues[index + 1]["start"]
    if camera_cues:
        camera_cues[-1]["end"] = round(duration, 3)

    transition_cues = []
    last_transition = -99.0
    maximum_transitions = max(1, math.ceil(duration / 60 * 4))
    transition_by_node = {
        "pain_reversal": {"duration": 0.18, "style": "editorial-cut", "intensity": 0.10},
        "brand_entity": {"duration": 0.22, "style": "drift-left", "intensity": 0.08},
        "example_step": {"duration": 0.22, "style": "drift-left", "intensity": 0.08},
        "cta": {"duration": 0.18, "style": "soft-flash", "intensity": 0.08},
    }
    for caption in captions[1:]:
        start = float(caption.get("start") or 0.0)
        transition = transition_by_node.get(str(caption.get("contentNode") or ""))
        if transition and start - last_transition >= 7 and len(transition_cues) < maximum_transitions:
            transition_cues.append({"start": round(start, 3), **transition})
            last_transition = start

    profile = worker.template_profile("template-10")
    selected_bgm = worker.select_content_music(
        profile.get("bgm_tracks") or [],
        str(source_timeline.get("title") or ""),
        captions,
        f"template10-local:{label}:{duration:.3f}",
    ) or {}
    sfx_cues = worker.build_adaptive_sfx_cues(
        output_dir,
        profile,
        duration,
        captions,
        [float(item["start"]) for item in transition_cues],
        str(source_timeline.get("title") or ""),
    )
    timeline = {
        "version": 2,
        "sourceFile": "source.mp4",
        "sourceVolume": 1,
        "bgmFile": str(selected_bgm.get("file") or "music/template-10/easy-minimal.mp3"),
        "bgmTrackId": str(selected_bgm.get("id") or "template-10-easy-minimal"),
        "bgmVolume": float(selected_bgm.get("volume") or 0.07),
        "bgmLoop": False,
        "sfxFile": "",
        "sfxCues": sfx_cues,
        "duration": round(duration, 3),
        "fps": 30,
        "title": str(source_timeline.get("title") or ""),
        "merchantName": "",
        "coverTime": 0.8,
        "captions": captions,
        "cameraCues": camera_cues,
        "transitionCues": transition_cues,
        "chapters": [],
        "cards": [],
        "theme": worker.remotion_theme("template-10"),
    }
    (output_dir / "timeline.json").write_text(json.dumps(timeline, ensure_ascii=False, indent=2) + "\n", "utf-8")
    report = {
        "template": "黄白大字双语",
        "caption_count": len(captions),
        "section_callouts": sum(1 for item in captions if item.get("sectionEmphasis")),
        "camera_cues": len(camera_cues),
        "transition_cues": len(transition_cues),
        "sfx_cues": len(sfx_cues),
        "bgm": {
            "id": str(selected_bgm.get("id") or "template-10-easy-minimal"),
            "volume": float(selected_bgm.get("volume") or 0.07),
            "match_score": int(selected_bgm.get("match_score") or 0),
            "candidate_ids": selected_bgm.get("candidate_ids") or [],
        },
    }
    (output_dir / "routing-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", "utf-8")
    speech_seconds = round(sum(max(0.0, float(item.get("end") or 0.0) - float(item.get("start") or 0.0)) for item in captions), 3)
    (output_dir / "job.json").write_text(json.dumps({
        "transcript": "".join(str(item.get("text") or "") for item in captions),
        "caption_completeness": {
            "speech_seconds": speech_seconds,
            "covered_seconds": speech_seconds,
            "time_coverage": 1.0,
            "text_coverage": 1.0,
            "text_similarity": 1.0,
            "text_exact": 1.0,
        },
    }, ensure_ascii=False, indent=2) + "\n", "utf-8")
    return {"label": label, **report}


def main() -> None:
    load_local_environment()
    worker = load_worker()
    reports = [build_review(worker, label) for label in ("short", "long")]
    print(json.dumps({"ok": True, "output": str(OUTPUT_ROOT), "reports": reports}, ensure_ascii=False))


if __name__ == "__main__":
    main()
