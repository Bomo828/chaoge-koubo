#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import math
import os
import re
import shutil
import sys
import types
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[3]
VIDEO_WORKER = PROJECT / "services" / "video-worker"
SOURCE_ROOT = Path("/Users/chaoge/Documents/Codex/2026-07-14/new-chat/merchant-studio-web/artifacts/template-series-3-8/template-5")
OUTPUT_ROOT = PROJECT / "artifacts" / "template-9-local-review"


def load_local_environment() -> None:
    for candidate in (PROJECT / ".env.local", PROJECT / ".env"):
        if not candidate.is_file():
            continue
        for raw_line in candidate.read_text("utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key in {"LK888_API_KEY", "LK888_API_BASE_URL", "VIDEO_WORKER_TITLE_MODEL"}:
                os.environ.setdefault(key, value.strip().strip('"').strip("'"))


def load_worker():
    # The local review builder only uses pure planning helpers.  Keep it
    # runnable without installing the web server's FastAPI runtime.
    if "fastapi" not in sys.modules:
        fastapi = types.ModuleType("fastapi")

        class StubFastAPI:
            def __init__(self, *args, **kwargs):
                pass

            def add_middleware(self, *args, **kwargs):
                return None

            def __getattr__(self, name):
                if name in {"get", "post", "put", "delete", "patch", "api_route"}:
                    return lambda *args, **kwargs: (lambda function: function)
                raise AttributeError(name)

        class StubHTTPException(Exception):
            def __init__(self, status_code=500, detail=""):
                super().__init__(detail)
                self.status_code = status_code
                self.detail = detail

        fastapi.FastAPI = StubFastAPI
        fastapi.File = lambda *args, **kwargs: None
        fastapi.Form = lambda *args, **kwargs: None
        fastapi.HTTPException = StubHTTPException
        fastapi.Request = type("Request", (), {})
        fastapi.UploadFile = type("UploadFile", (), {})
        middleware = types.ModuleType("fastapi.middleware")
        cors = types.ModuleType("fastapi.middleware.cors")
        cors.CORSMiddleware = type("CORSMiddleware", (), {})
        responses = types.ModuleType("fastapi.responses")
        responses.FileResponse = type("FileResponse", (), {})
        sys.modules.update({
            "fastapi": fastapi,
            "fastapi.middleware": middleware,
            "fastapi.middleware.cors": cors,
            "fastapi.responses": responses,
        })
    sys.path.insert(0, str(VIDEO_WORKER))
    spec = importlib.util.spec_from_file_location("template9_video_worker", VIDEO_WORKER / "main.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载视频工作器")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def split_reference_beats(worker, captions: list[dict[str, object]]) -> list[dict[str, object]]:
    """Re-time long legacy review cues into the reference's 5–7 character beats."""
    output: list[dict[str, object]] = []
    boundary_before = ("不是", "而是", "但是", "如果", "所以", "然后", "包括", "比如", "无论", "还是", "都可以", "都用", "会从", "带你", "了解")
    boundary_after = ("话题", "工具", "讲起", "做什么", "工作", "岗位", "技能", "资料", "培训", "了解")
    prepared: list[dict[str, object]] = []
    for source_caption in captions:
        caption = dict(source_caption)
        text = re.sub(r"[\s，。！？；：、,.!?;:]", "", str(caption.get("text") or ""))
        if prepared and len(text) <= 2:
            prepared[-1]["text"] = str(prepared[-1].get("text") or "") + text
            prepared[-1]["end"] = caption.get("end")
            prepared[-1]["displayEnd"] = caption.get("displayEnd") or caption.get("end")
            continue
        prepared.append(caption)

    for caption in prepared:
        text = re.sub(r"[\s，。！？；：、,.!?;:]", "", str(caption.get("text") or ""))
        if not text:
            continue
        start = float(caption.get("start") or 0.0)
        end = max(start + 0.08, float(caption.get("end") or start + 0.08))
        beats: list[str] = []
        cursor = 0
        while len(text) - cursor > 7:
            remaining = len(text) - cursor
            candidates = [size for size in range(4, 8) if remaining - size == 0 or remaining - size >= 3]

            def boundary_score(size: int) -> float:
                boundary = cursor + size
                current = text[cursor:boundary]
                following = text[boundary:boundary + 4]
                score = -abs(size - 6) * 1.2
                if any(following.startswith(marker) for marker in boundary_before):
                    score += 4.5
                if any(current.endswith(marker) for marker in boundary_after):
                    score += 3.5
                return score

            size = max(candidates, key=boundary_score)
            if remaining <= 9 and boundary_score(size) < 1:
                beats.append(text[cursor:])
                cursor = len(text)
                break
            beats.append(text[cursor:cursor + size])
            cursor += size
        if cursor < len(text):
            beats.append(text[cursor:])

        consumed = 0
        for index, beat in enumerate(beats):
            beat_start = start + (end - start) * consumed / len(text)
            consumed += len(beat)
            beat_end = end if index == len(beats) - 1 else start + (end - start) * consumed / len(text)
            item = dict(caption)
            item.update({
                "start": round(beat_start, 3),
                "end": round(beat_end, 3),
                "displayEnd": round(beat_end, 3),
                "text": beat,
            })
            for key in ("keyword", "blockId", "blockSlot", "blockSize", "layout", "emphasis", "role"):
                item.pop(key, None)
            output.append(item)
    return output


def resegment_review_captions(captions: list[dict[str, object]], beats: list[str]) -> list[dict[str, object]]:
    """Map hand-directed semantic beats back onto the source transcript timing."""
    cleaned_sources: list[tuple[dict[str, object], str]] = []
    for source_caption in captions:
        text = re.sub(r"[\s，。！？；：、,.!?;:]", "", str(source_caption.get("text") or ""))
        if text:
            cleaned_sources.append((dict(source_caption), text))
    source_text = "".join(text for _, text in cleaned_sources)
    beat_text = "".join(beats)
    if source_text != beat_text:
        raise RuntimeError(f"语义字幕与转写不一致: {source_text!r} != {beat_text!r}")

    character_times: list[tuple[float, float, dict[str, object]]] = []
    for source_caption, text in cleaned_sources:
        start = float(source_caption.get("start") or 0.0)
        end = max(start + 0.08, float(source_caption.get("end") or start + 0.08))
        for index, _ in enumerate(text):
            char_start = start + (end - start) * index / len(text)
            char_end = start + (end - start) * (index + 1) / len(text)
            character_times.append((char_start, char_end, source_caption))

    output: list[dict[str, object]] = []
    cursor = 0
    for beat in beats:
        length = len(beat)
        first = character_times[cursor]
        last = character_times[cursor + length - 1]
        item = dict(first[2])
        item.update({
            "start": round(first[0], 3),
            "end": round(last[1], 3),
            "displayEnd": round(last[1], 3),
            "text": beat,
        })
        for key in ("keyword", "blockId", "blockSlot", "blockSize", "layout", "emphasis", "role"):
            item.pop(key, None)
        output.append(item)
        cursor += length
    return output


def build_review(worker, label: str) -> dict[str, object]:
    source_dir = SOURCE_ROOT / label
    output_dir = OUTPUT_ROOT / label
    output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_dir / "source.mp4", output_dir / "source.mp4")
    source_timeline = json.loads((source_dir / "timeline.json").read_text("utf-8"))
    review_beats = {
        "short": [
            "想提升办公", "和职场技能", "不知道从哪开始", "大家好", "我是钟智联的", "张老师",
            "文员会计", "电商外贸员", "实用技能培训", "都可以来", "钟智联了解",
            "课程围绕岗位需求", "帮你把基础打扎实", "把操作练熟", "想学一门实用技能", "欢迎来咨询",
        ],
        "long": [
            "AI现在已经", "不是新鲜话题", "而是很多岗位", "都用得上的", "效率工具",
            "我们的AI课程", "会从基础认知讲起", "带你一步步", "了解AI", "能做什么", "怎么用到工作里",
            "课程中会教你", "如何提问", "如何生成", "文案和图片", "如何整理资料", "提升沟通", "和执行效率",
            "无论你是想跟上", "行业趋势", "还是想给自己的", "工作增加竞争力", "都可以先来", "了解一下",
        ],
    }
    directed_source = resegment_review_captions(
        source_timeline.get("captions") or [],
        review_beats.get(label) or [],
    )
    transcript = "。".join(str(item.get("text") or "").strip() for item in directed_source)
    fallback_title = str(source_timeline.get("title") or "")
    title, title_source = worker.ai_title_from_transcript(
        transcript,
        fallback_title,
        worker.template_profile("template-9"),
    )
    captions, director_source = worker.ai_direct_template9_captions(
        directed_source,
        title,
        worker.template_profile("template-9").get("content_director"),
    )
    review_translations = {
        "想提升办公": "Improve your office skills",
        "和职场技能": "and workplace skills",
        "不知道从哪开始": "Not sure where to begin",
        "大家好": "Hello everyone",
        "我是钟智联的": "I am from Zhilian",
        "张老师": "Teacher Zhang",
        "文员会计": "Clerical and accounting",
        "电商外贸员": "E-commerce and trade",
        "实用技能培训": "Practical skills training",
        "都可以来": "You can come to",
        "钟智联了解": "learn more at Zhilian",
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
    for caption in captions:
        caption["translation"] = review_translations.get(str(caption.get("text") or ""), "")
    keyword_priority = (
        "效率工具", "基础认知", "文案和图片", "整理资料", "工作增加竞争力", "实用技能培训",
        "职场技能", "提升办公", "新鲜话题", "AI课程", "岗位需求", "行业趋势", "执行效率",
        "钟智联", "电商外贸员", "文员会计", "张老师", "一步步", "跟上", "自己的", "从哪开始",
        "打扎实", "练熟", "咨询", "竞争力", "提问", "生成", "沟通", "岗位", "课程", "工作",
        "培训", "技能", "效率", "了解", "先来", "AI",
    )
    captions, keyword_source = worker.ai_select_caption_highlights(captions, title)
    if not keyword_source.startswith("ai-highlight:"):
        for caption in captions:
            text = str(caption.get("text") or "")
            matched_keyword = next((keyword for keyword in keyword_priority if keyword in text), "")
            if matched_keyword:
                caption["keyword"] = matched_keyword
                caption["keywordOrigin"] = "review-fallback"
            elif len(text) <= 4:
                caption["keyword"] = text
                caption["keywordOrigin"] = "review-fallback"
    duration = float(source_timeline.get("duration") or 1.0)
    blocks: list[list[dict[str, object]]] = []
    for caption in captions:
        if not blocks or blocks[-1][0].get("blockId") != caption.get("blockId"):
            blocks.append([caption])
        else:
            blocks[-1].append(caption)
    camera_scales = {
        "hook": 1.08,
        "pain_reversal": 1.0,
        "core_viewpoint": 1.15,
        "number_benefit": 1.17,
        "example_step": 1.11,
        "brand_entity": 1.14,
        "cta": 1.16,
    }
    supporting_scales = [1.0, 1.13, 1.04, 1.16, 1.02, 1.12]
    camera_origins = ["50% 43%", "49% 42.5%", "51% 43%", "50% 42%"]
    camera_cues = []
    for index, block in enumerate(blocks):
        start = float(block[0].get("start") or 0.0)
        end = float(block[-1].get("end") or duration)
        node = str(block[0].get("contentNode") or "supporting")
        scale = camera_scales.get(node, supporting_scales[index % len(supporting_scales)])
        origin = camera_origins[index % len(camera_origins)]
        # The reference repeatedly breathes back to a wider frame for a few
        # frames before landing on a close semantic beat. Recreate that rhythm
        # without copying its absolute timestamps.
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
        "pain_reversal": {"duration": 0.18, "style": "editorial-cut", "intensity": 0.1},
        "core_viewpoint": {"duration": 0.2, "style": "editorial-wipe", "intensity": 0.08},
        "cta": {"duration": 0.18, "style": "soft-flash", "intensity": 0.08},
    }
    for block in blocks[1:]:
        start = float(block[0].get("start") or 0.0)
        node = str(block[0].get("contentNode") or "supporting")
        transition = transition_by_node.get(node)
        if transition and start - last_transition >= 7 and len(transition_cues) < maximum_transitions:
            transition_cues.append({"start": round(start, 3), **transition})
            last_transition = start
    profile = worker.template_profile("template-9")
    selected_bgm = worker.select_content_music(
        profile.get("bgm_tracks") or [],
        title,
        captions,
        f"template9-local:{label}:{duration:.3f}",
    ) or {}
    sfx_cues = worker.build_adaptive_sfx_cues(
        output_dir,
        profile,
        duration,
        captions,
        [float(item["start"]) for item in transition_cues],
        title,
    )
    theme = worker.remotion_theme("template-9")
    theme.update({"titleVariant": "primary", "headlinePersistent": True})
    timeline = {
        "version": 2,
        "sourceFile": "source.mp4",
        "sourceVolume": 1,
        "bgmFile": str(selected_bgm.get("file") or "music/template-9/calm-piano-003.mp3"),
        "bgmTrackId": str(selected_bgm.get("id") or "calm-piano-003"),
        "bgmVolume": float(selected_bgm.get("volume") or 0.045),
        "sfxFile": "",
        "sfxCues": sfx_cues,
        "duration": round(duration, 3),
        "fps": 30,
        "title": title,
        "merchantName": "",
        "coverTime": 0.8,
        "captions": captions,
        "cameraCues": camera_cues,
        "transitionCues": transition_cues,
        "chapters": [],
        "cards": [],
        "theme": theme,
    }
    (output_dir / "timeline.json").write_text(json.dumps(timeline, ensure_ascii=False, indent=2) + "\n", "utf-8")
    report = {
        "template": "红白双语",
        "director": director_source,
        "title_source": title_source,
        "keyword_source": keyword_source,
        "highlighted_captions": sum(bool(str(item.get("keyword") or "").strip()) for item in captions),
        "ai_highlighted_captions": sum(str(item.get("keywordOrigin") or "") == "ai" for item in captions),
        "caption_count": len(captions),
        "semantic_blocks": len(blocks),
        "camera_cues": len(camera_cues),
        "transition_cues": len(transition_cues),
        "sfx_cues": len(sfx_cues),
        "bgm": {
            "id": str(selected_bgm.get("id") or "calm-piano-003"),
            "volume": float(selected_bgm.get("volume") or 0.045),
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
