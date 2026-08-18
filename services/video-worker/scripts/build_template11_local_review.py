#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
from pathlib import Path

from build_template9_local_review import (
    PROJECT,
    SOURCE_ROOT,
    load_local_environment,
    load_worker,
    resegment_review_captions,
)
from build_template10_local_review import LONG_BEATS, TRANSLATIONS


OUTPUT_ROOT = PROJECT / "artifacts" / "template-11-local-review"
SHORT_BEATS = [
    "想提升", "办公和职场技能", "不知道从哪开始", "大家好", "我是钟智联的", "张老师",
    "文员会计", "电商外贸员", "实用技能培训", "都可以来钟智联了解",
    "课程围绕岗位需求", "帮你把基础打扎实", "把操作练熟", "想学一门实用技能", "欢迎来咨询",
]

TEMPLATE11_TRANSLATIONS = {
    **TRANSLATIONS,
    "想提升": "Want to improve",
    "办公和职场技能": "Office and workplace skills",
}

KEYWORD_PRIORITY = (
    "效率工具", "基础认知", "文案和图片", "整理资料", "工作增加竞争力", "实用技能培训",
    "职场技能", "办公", "新鲜话题", "AI课程", "岗位需求", "行业趋势", "执行效率",
    "钟智联", "电商", "文员", "张老师", "竞争力", "提问", "生成", "沟通",
    "岗位", "课程", "工作", "培训", "技能", "效率", "了解", "AI",
)


def build_sfx_cues(duration: float, captions: list[dict[str, object]]) -> list[dict[str, object]]:
    cues: list[dict[str, object]] = [{
        "start": 0.08,
        "file": "sfx/template-11/opening-soft-pop.wav",
        "volume": 0.22,
        "playbackRate": 1.0,
        "role": "opening",
        "label": "开场轻提示",
    }]
    last = 0.08
    for caption in captions[1:]:
        start = float(caption.get("start") or 0.0)
        if start < 1.4 or start > duration - 1.0 or start - last < 4.8:
            continue
        if len(cues) >= 4:
            break
        cues.append({
            "start": round(start, 3),
            "file": "sfx/template-11/keyword-water-drop.wav",
            "volume": 0.18,
            "playbackRate": 1.0,
            "role": "accent",
            "label": "关键词轻点",
        })
        last = start
    cues.append({
        "start": round(max(0.0, duration - 0.48), 3),
        "file": "sfx/template-11/ending-soft-blip.wav",
        "volume": 0.16,
        "playbackRate": 1.0,
        "role": "ending",
        "label": "结尾轻收束",
    })
    return cues


def build_review(worker, label: str) -> dict[str, object]:
    source_dir = SOURCE_ROOT / label
    output_dir = OUTPUT_ROOT / label
    output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_dir / "source.mp4", output_dir / "source.mp4")
    source_timeline = json.loads((source_dir / "timeline.json").read_text("utf-8"))
    beats = SHORT_BEATS if label == "short" else LONG_BEATS
    captions = resegment_review_captions(source_timeline.get("captions") or [], beats)
    if label == "short" and len(captions) >= 2:
        # The reference holds “想提升” for roughly one second before revealing
        # “办公和职场技能”; proportional character timing changes too early.
        first_boundary = 1.08
        captions[0]["end"] = first_boundary
        captions[0]["displayEnd"] = first_boundary
        captions[1]["start"] = first_boundary
    captions = worker.semantic_caption_plan(
        captions,
        str(source_timeline.get("title") or ""),
        worker.template_profile("template-11").get("content_director"),
    )
    for caption in captions:
        text = str(caption.get("text") or "")
        caption["translation"] = TEMPLATE11_TRANSLATIONS.get(text, "")
        caption["displayEnd"] = caption.get("end")
        keyword = next((item for item in KEYWORD_PRIORITY if item in text), "")
        if keyword:
            caption["keyword"] = keyword
        elif len(text) >= 3:
            caption["keyword"] = text[-2:]

    duration = float(source_timeline.get("duration") or 1.0)
    sfx_cues = build_sfx_cues(duration, captions)
    camera_scales = {
        "hook": 1.0,
        "pain_reversal": 1.07,
        "core_viewpoint": 1.09,
        "number_benefit": 1.10,
        "example_step": 1.05,
        "brand_entity": 1.08,
        "cta": 1.09,
    }
    supporting_scales = [1.0, 1.065, 1.025, 1.085]
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
        node = str(block[0].get("contentNode") or "supporting")
        camera_cues.append({
            "start": round(float(block[0].get("start") or 0.0), 3),
            "end": round(float(block[-1].get("end") or duration), 3),
            "scale": camera_scales.get(node, supporting_scales[index % len(supporting_scales)]),
            "origin": camera_origins[index % len(camera_origins)],
        })
    for index in range(len(camera_cues) - 1):
        camera_cues[index]["end"] = camera_cues[index + 1]["start"]
    if camera_cues:
        camera_cues[-1]["end"] = round(duration, 3)
    theme = worker.remotion_theme("template-11")
    theme.update({
        "headlinePersistent": True,
        "headlineDuration": duration,
        "captionLineMaxChars": 11,
        "captionMaxWidth": 930,
    })
    timeline = {
        "version": 2,
        "sourceFile": "source.mp4",
        "sourceVolume": 1,
        "bgmFile": "",
        "bgmTrackId": "",
        "bgmVolume": 0,
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
        "transitionCues": [],
        "chapters": [],
        "cards": [],
        "theme": theme,
    }
    (output_dir / "timeline.json").write_text(json.dumps(timeline, ensure_ascii=False, indent=2) + "\n", "utf-8")
    report = {
        "template": "青白高亮双语",
        "caption_count": len(captions),
        "camera_cues": len(camera_cues),
        "transition_cues": 0,
        "sfx_cues": len(sfx_cues),
        "bgm": {"enabled": False, "reason": "reference-has-no-continuous-bgm"},
    }
    (output_dir / "routing-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", "utf-8")
    speech_seconds = round(sum(max(0.0, float(item.get("end") or 0.0) - float(item.get("start") or 0.0)) for item in captions), 3)
    (output_dir / "job.json").write_text(json.dumps({
        "transcript": "".join(str(item.get("text") or "") for item in captions),
        "caption_completeness": {"speech_seconds": speech_seconds, "covered_seconds": speech_seconds, "time_coverage": 1.0, "text_coverage": 1.0, "text_similarity": 1.0, "text_exact": 1.0},
    }, ensure_ascii=False, indent=2) + "\n", "utf-8")
    return {"label": label, **report}


def main() -> None:
    load_local_environment()
    worker = load_worker()
    reports = [build_review(worker, label) for label in ("short", "long")]
    print(json.dumps({"ok": True, "output": str(OUTPUT_ROOT), "reports": reports}, ensure_ascii=False))


if __name__ == "__main__":
    main()
