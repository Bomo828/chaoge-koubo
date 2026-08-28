#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from build_template9_local_review import PROJECT, load_local_environment, load_worker


TEMPLATE_IDS = ("template-9", "template-10", "template-11", "template-12")


def shifted_caption(caption: dict[str, Any], offset: float, block_offset: int) -> dict[str, Any]:
    item = copy.deepcopy(caption)
    for key in ("start", "end", "displayEnd"):
        if item.get(key) is not None:
            item[key] = round(float(item[key]) + offset, 3)
    if item.get("blockId") is not None:
        item["blockId"] = int(item["blockId"]) + block_offset
    for word in item.get("words") or []:
        if not isinstance(word, dict):
            continue
        for key in ("start", "end"):
            if word.get(key) is not None:
                word[key] = round(float(word[key]) + offset, 3)
    return item


def doubled_captions(captions: list[dict[str, Any]], duration: float) -> list[dict[str, Any]]:
    first = [copy.deepcopy(item) for item in captions]
    second = [shifted_caption(item, duration, 1000) for item in captions]
    return first + second


def finalize_for_template(worker: Any, template_id: str, captions: list[dict[str, Any]], profile: dict[str, Any]) -> list[dict[str, Any]]:
    planned = copy.deepcopy(captions)
    if template_id == "template-9":
        directed_items = [
            {
                "content_node": item.get("contentNode"),
                "keyword": item.get("keyword"),
                "layout": item.get("directorLayout"),
                "emphasis": "strong" if float(item.get("contentWeight") or 0.0) >= 0.72 else "normal",
            }
            for item in planned
        ]
        planned = worker.finalize_template9_director_plan(planned, directed_items)
    elif template_id == "template-10":
        planned = worker.finalize_template10_director_plan(planned)
    if profile.get("caption_long_text_mode") == "adaptive-two-line":
        planned = worker.plan_adaptive_caption_lines(
            planned,
            int(profile.get("caption_line_max_chars") or 8),
        )
    return worker.mark_keyword_sfx_emphasis(planned)


def concatenate_twice(ffmpeg: Path, source: Path, target: Path, duration: float) -> None:
    environment = dict(os.environ)
    environment["DYLD_LIBRARY_PATH"] = str(ffmpeg.parent)
    subprocess.run(
        [
            str(ffmpeg), "-y", "-stream_loop", "1", "-i", str(source),
            "-t", f"{duration * 2:.3f}", "-c", "copy", "-movflags", "+faststart", str(target),
        ],
        check=True,
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def build_case(
    worker: Any,
    template_id: str,
    label: str,
    source: Path,
    output_root: Path,
    title: str,
    captions: list[dict[str, Any]],
    duration: float,
    director_source: str,
) -> dict[str, Any]:
    profile = worker.template_profile(template_id)
    planned = finalize_for_template(worker, template_id, captions, profile)
    output_dir = output_root / template_id / label
    output_dir.mkdir(parents=True, exist_ok=True)
    target_source = output_dir / "source.mp4"
    if source.resolve() != target_source.resolve():
        shutil.copy2(source, target_source)
    metadata = worker.probe_video(target_source)
    scene_changes = worker.detect_scene_changes(
        target_source,
        duration,
        float(profile.get("scene_threshold") or 0.31),
        float(profile.get("minimum_transition_gap_seconds") or 4.8),
    )
    adaptation = worker.build_input_adaptation_profile(metadata, scene_changes)
    pause_candidates = [
        float(planned[index]["start"])
        for index in range(1, len(planned))
        if float(planned[index]["start"]) - float(planned[index - 1]["end"]) >= 0.6
    ]
    transition_plan = worker.plan_semantic_transition_cues(
        planned, scene_changes, pause_candidates, [], duration, profile, adaptation,
    )
    transitions = [float(item["start"]) for item in transition_plan]
    sfx_cues = worker.build_adaptive_sfx_cues(
        output_dir,
        profile,
        duration,
        planned,
        transitions,
        title,
    )
    sfx_track = output_dir / "review-sfx.wav"
    if sfx_cues:
        worker.create_timeline_sfx(
            sfx_track,
            str(profile.get("opening_sfx") or ""),
            duration,
            sfx_cues,
        )
    timeline_path = worker.build_remotion_timeline(
        output_dir,
        target_source,
        sfx_track,
        duration,
        title,
        planned,
        template_id,
        {},
        include_sfx=bool(sfx_cues),
        include_bgm=True,
        sfx_cues=sfx_cues,
        transition_points=transitions,
        transition_plan=transition_plan,
        input_adaptation=adaptation,
    )
    timeline = json.loads(timeline_path.read_text("utf-8"))
    timeline_path.write_text(json.dumps(timeline, ensure_ascii=False, indent=2) + "\n", "utf-8")
    transcript = "".join(str(item.get("text") or "") for item in planned)
    speech_seconds = round(sum(max(0.0, float(item.get("end") or 0.0) - float(item.get("start") or 0.0)) for item in planned), 3)
    job = {
        "template_id": template_id,
        "title": title,
        "director_source": director_source,
        "transcript": transcript,
        "caption_completeness": {
            "speech_seconds": speech_seconds,
            "covered_seconds": speech_seconds,
            "time_coverage": 1.0,
            "text_coverage": 1.0,
            "text_similarity": 1.0,
            "text_exact": 1.0,
        },
    }
    (output_dir / "job.json").write_text(json.dumps(job, ensure_ascii=False, indent=2) + "\n", "utf-8")
    highlighted_keywords = [
        {
            "text": str(item.get("text") or ""),
            "keyword": str(item.get("keyword") or ""),
            "start": round(float(item.get("start") or 0.0), 3),
            "content_node": str(item.get("contentNode") or "supporting"),
            "keyword_sfx": item.get("keywordSfx") is True,
            "keyword_sfx_reason": str(item.get("keywordSfxReason") or ""),
        }
        for item in planned
        if str(item.get("keyword") or "").strip()
    ]
    key_sfx_words = [item for item in highlighted_keywords if item["keyword_sfx"]]
    report = {
        "template_id": template_id,
        "template_name": profile.get("name"),
        "label": label,
        "duration": round(duration, 3),
        "director_source": director_source,
        "caption_count": len(planned),
        "highlight_count": len(highlighted_keywords),
        "highlighted_keywords": highlighted_keywords,
        "keyword_sfx_count": len(key_sfx_words),
        "keyword_sfx_words": key_sfx_words,
        "semantic_nodes": [str(item.get("contentNode") or "supporting") for item in planned],
        "transition_points": transitions,
        "transition_plan": transition_plan,
        "input_adaptation": adaptation,
        "audio_mix": timeline.get("audioMix"),
        "sfx_count": len(sfx_cues),
        "sfx": sfx_cues,
        "bgm": {
            "file": timeline.get("bgmFile"),
            "track_id": timeline.get("bgmTrackId"),
            "volume": timeline.get("bgmVolume"),
            "loop": timeline.get("bgmLoop"),
        },
    }
    (output_dir / "routing-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", "utf-8")
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build four-template short/long AI director review jobs")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--base-timeline", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=PROJECT / "artifacts" / "four-template-ai-director-review")
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--short-only", action="store_true", help="Only build one short review job for each template")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    ffmpeg = args.ffmpeg.expanduser().resolve()
    os.environ["PATH"] = f"{ffmpeg.parent}:{os.environ.get('PATH', '')}"
    os.environ["DYLD_LIBRARY_PATH"] = str(ffmpeg.parent)
    load_local_environment()
    worker = load_worker()
    source_timeline = json.loads(args.base_timeline.read_text("utf-8"))
    title = str(source_timeline.get("title") or "").strip()
    duration = float(source_timeline.get("duration") or 0.0)
    base_captions = [dict(item) for item in source_timeline.get("captions") or []]
    if not title or not base_captions or duration <= 0:
        raise RuntimeError("基础时间轴缺少标题、字幕或有效时长")
    shared, director_source = worker.ai_direct_shared_captions(
        base_captions,
        title,
        worker.template_profile("template-9").get("content_director"),
    )
    output_root = args.output.expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    cases = {
        "short": (args.source.expanduser().resolve(), shared, duration),
    }
    if not args.short_only:
        long_source = output_root / "long-source.mp4"
        concatenate_twice(ffmpeg, args.source.expanduser().resolve(), long_source, duration)
        cases["long"] = (long_source, doubled_captions(shared, duration), duration * 2)
    reports: list[dict[str, Any]] = []
    for template_id in TEMPLATE_IDS:
        for label, (case_source, case_captions, case_duration) in cases.items():
            reports.append(build_case(
                worker,
                template_id,
                label,
                case_source,
                output_root,
                title,
                case_captions,
                case_duration,
                director_source,
            ))
    (output_root / "routing-summary.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(json.dumps({"ok": True, "output": str(output_root), "director_source": director_source, "reports": reports}, ensure_ascii=False))


if __name__ == "__main__":
    main()
