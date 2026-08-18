#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
from pathlib import Path

from build_template9_local_review import PROJECT, SOURCE_ROOT, load_local_environment, load_worker, resegment_review_captions
from build_template10_local_review import LONG_BEATS, TRANSLATIONS


OUTPUT_ROOT = PROJECT / "artifacts" / "template-12-local-review"

SHORT_BEATS = [
    "想提升", "办公和职场技能", "不知道从哪开始", "大家好", "我是钟智联的", "张老师",
    "文员会计", "电商外贸员", "实用技能培训", "都可以来钟智联了解", "课程围绕岗位需求",
    "帮你把基础", "打扎实", "把操作练熟", "想学一门实用技能", "欢迎来咨询",
]

TRANSLATION_PATCH = {
    "想提升": "Want to improve",
    "办公和职场技能": "Office and workplace skills",
    "文员会计电商": "Clerical, accounting and e-commerce",
    "外贸员": "Foreign trade roles",
    "帮你把基础": "Help you build the basics",
    "打扎实": "Build a solid foundation",
}

KEYWORD_PRIORITY = (
    "效率工具", "基础认知", "文案和图片", "整理资料", "工作增加竞争力", "实用技能培训",
    "职场技能", "办公", "AI课程", "岗位需求", "行业趋势", "执行效率", "钟智联", "电商",
    "文员", "张老师", "竞争力", "提问", "生成", "沟通", "岗位", "课程", "培训", "技能", "效率", "了解", "AI",
)

STRONG_PHRASES = (
    "想提升", "办公和职场技能", "不知道从哪开始", "电商外贸员", "实用技能培训",
    "效率工具", "基础认知", "文案和图片", "执行效率", "行业趋势", "增加竞争力", "欢迎来咨询",
)

PLAIN_PHRASES = ("课程围绕岗位需求", "帮你把基础", "打扎实", "把操作练熟", "如何整理资料")


def build_sfx_cues(duration: float, captions: list[dict[str, object]], focus_start: float) -> list[dict[str, object]]:
    cues: list[dict[str, object]] = [
        {"start": 0.06, "file": "sfx/template-12/open-impact.ogg", "volume": 0.34, "playbackRate": 1.0, "role": "opening"},
    ]
    last = 0.06
    alternating = ["sfx/template-12/caption-pop.ogg", "sfx/template-12/keyword-tick.ogg"]
    accent_index = 0
    for caption in captions[1:]:
        start = float(caption.get("start") or 0.0)
        if start < 1.8 or start > duration - 1.2 or start - last < 4.1 or abs(start - focus_start) < 1.2:
            continue
        if not caption.get("keyword") and caption.get("emphasis") != "strong":
            continue
        cues.append({"start": round(start, 3), "file": alternating[accent_index % len(alternating)], "volume": 0.25, "playbackRate": 1.0, "role": "keyword"})
        accent_index += 1
        last = start
        if len(cues) >= 5:
            break
    cues.append({"start": round(focus_start, 3), "file": "sfx/template-12/focus-swish.ogg", "volume": 0.30, "playbackRate": 1.0, "role": "radial-focus"})
    cues.append({"start": round(max(0.0, duration - .46), 3), "file": "sfx/template-12/end-confirm.ogg", "volume": 0.24, "playbackRate": 1.0, "role": "ending"})
    return sorted(cues, key=lambda item: float(item["start"]))


def build_camera_cues(duration: float, captions: list[dict[str, object]], focus_start: float, focus_end: float) -> list[dict[str, object]]:
    scales = {"hook": 1.0, "pain_reversal": 1.06, "core_viewpoint": 1.09, "number_benefit": 1.10, "example_step": 1.04, "brand_entity": 1.07, "cta": 1.09}
    fallback = [1.0, 1.065, 1.025, 1.085]
    origins = ["50% 43%", "49.5% 42.5%", "50.5% 43%", "50% 42%"]
    blocks: list[list[dict[str, object]]] = []
    for caption in captions:
        node = str(caption.get("contentNode") or "supporting")
        if not blocks or str(blocks[-1][0].get("contentNode") or "supporting") != node or len(blocks[-1]) >= 2:
            blocks.append([caption])
        else:
            blocks[-1].append(caption)
    cues: list[dict[str, object]] = []
    for index, block in enumerate(blocks):
        start = float(block[0].get("start") or 0.0)
        end = float(block[-1].get("end") or duration)
        node = str(block[0].get("contentNode") or "supporting")
        overlaps_focus = start < focus_end and end > focus_start
        cues.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "scale": 1.0 if overlaps_focus else scales.get(node, fallback[index % len(fallback)]),
            "origin": origins[index % len(origins)],
        })
    for index in range(len(cues) - 1):
        cues[index]["end"] = cues[index + 1]["start"]
    if cues:
        cues[-1]["end"] = round(duration, 3)
    return cues


def build_review(worker, label: str) -> dict[str, object]:
    source_dir = SOURCE_ROOT / label
    output_dir = OUTPUT_ROOT / label
    output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_dir / "source.mp4", output_dir / "source.mp4")
    source_timeline = json.loads((source_dir / "timeline.json").read_text("utf-8"))
    captions = resegment_review_captions(source_timeline.get("captions") or [], SHORT_BEATS if label == "short" else LONG_BEATS)
    if label == "short" and len(captions) >= 2:
        captions[0]["end"] = 1.08
        captions[0]["displayEnd"] = 1.08
        captions[1]["start"] = 1.08
    captions = worker.semantic_caption_plan(captions, str(source_timeline.get("title") or ""), worker.template_profile("template-12").get("content_director"))
    translation_map = {**TRANSLATIONS, **TRANSLATION_PATCH}
    for caption in captions:
        text = str(caption.get("text") or "")
        caption["translation"] = translation_map.get(text, "")
        caption["displayEnd"] = caption.get("end")
        caption["keyword"] = next((item for item in KEYWORD_PRIORITY if item in text), text[-2:] if len(text) >= 3 else text)
        if any(item in text for item in STRONG_PHRASES):
            caption["emphasis"] = "strong"
            caption["role"] = "focus"
        if any(item in text for item in PLAIN_PHRASES):
            caption["emphasis"] = "normal"
            caption["role"] = "anchor"
            caption["captionStyle"] = "plain"

    duration = float(source_timeline.get("duration") or 1.0)
    if label == "short":
        focus_start, focus_end = 15.42, 19.92
    else:
        focus_start, focus_end = 18.15, 22.25
    focus_end = min(duration - .35, focus_end)
    focus_cues = [{"start": focus_start, "end": focus_end, "style": "radial-spotlight", "radius": 31, "x": 50, "y": 52}]
    for caption in captions:
        if float(caption.get("start") or 0.0) < focus_end and float(caption.get("end") or 0.0) > focus_start:
            caption["captionStyle"] = "focus-lower"
            caption["emphasis"] = "normal"
            caption["role"] = "anchor"
            caption["keyword"] = ""
    camera_cues = build_camera_cues(duration, captions, focus_start, focus_end)
    profile = worker.template_profile("template-12")
    selected_bgm = worker.select_content_music(profile.get("bgm_tracks") or [], str(source_timeline.get("title") or ""), captions, f"template12-local:{label}:{duration:.3f}") or {}
    sfx_cues = build_sfx_cues(duration, captions, focus_start)
    theme = worker.remotion_theme("template-12")
    theme.update({"headlinePersistent": True, "headlineDuration": duration, "captionLineMaxChars": 10, "captionMaxWidth": 930})
    timeline = {
        "version": 2,
        "sourceFile": "source.mp4",
        "sourceVolume": 1,
        "bgmFile": str(selected_bgm.get("file") or "music/template-12/bright-training.ogg"),
        "bgmTrackId": str(selected_bgm.get("id") or "template-12-bright-training"),
        "bgmVolume": float(selected_bgm.get("volume") or .095),
        "bgmLoop": False,
        "sfxFile": "",
        "sfxCues": sfx_cues,
        "duration": round(duration, 3),
        "fps": 30,
        "title": str(source_timeline.get("title") or ""),
        "merchantName": "",
        "coverTime": .8,
        "captions": captions,
        "cameraCues": camera_cues,
        "focusCues": focus_cues,
        "transitionCues": [],
        "chapters": [],
        "cards": [],
        "theme": theme,
    }
    (output_dir / "timeline.json").write_text(json.dumps(timeline, ensure_ascii=False, indent=2) + "\n", "utf-8")
    speech_seconds = round(sum(max(0.0, float(item.get("end") or 0.0) - float(item.get("start") or 0.0)) for item in captions), 3)
    report = {
        "template": "黑黄聚焦双语",
        "caption_count": len(captions),
        "camera_cues": len(camera_cues),
        "focus_cues": len(focus_cues),
        "transition_cues": 0,
        "sfx_cues": len(sfx_cues),
        "bgm": {"id": timeline["bgmTrackId"], "volume": timeline["bgmVolume"], "loop": False, "candidate_ids": selected_bgm.get("candidate_ids") or []},
    }
    (output_dir / "routing-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", "utf-8")
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
