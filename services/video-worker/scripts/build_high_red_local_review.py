#!/usr/bin/env python3
"""Build a deterministic local 高级红 review timeline from grounded ASR."""

from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path


TRANSLATIONS = [
    "AI is no longer a novelty.",
    "It is a productivity tool used in many jobs.",
    "Our AI course starts with the basics.",
    "Learn step by step what AI can do.",
    "And how to use it at work.",
    "Learn how to ask better questions.",
    "Create copy and images with AI.",
    "Organize information more efficiently.",
    "Improve communication and execution.",
    "Keep up with industry trends.",
    "Build a stronger edge at work.",
    "Start by learning more today.",
]

PREFERRED_KEYWORDS = [
    "AI", "效率工具", "基础认知", "一步步", "工作", "如何提问",
    "文案和图片", "整理资料", "执行效率", "行业趋势", "竞争力", "了解",
]


def plain(value: str) -> str:
    return re.sub(r"[\s，。！？；：、,.!?;:]", "", value)


def keyword_for(text: str) -> str:
    for keyword in PREFERRED_KEYWORDS:
        if keyword in text:
            return keyword
    compact = plain(text)
    return compact[-4:] if len(compact) >= 4 else compact


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("transcript", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument(
        "--bgm-only",
        action="store_true",
        help="仅叠加持续背景音乐，不叠加任何短促音效，便于独立验收配乐。",
    )
    args = parser.parse_args()

    transcript = json.loads(args.transcript.read_text("utf-8"))
    source_segments = transcript.get("segments") or []
    if not source_segments:
        raise SystemExit("transcript has no segments")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(args.source, args.output_dir / "source.mp4")

    captions = []
    for index, segment in enumerate(source_segments):
        text = re.sub(r"\s+", "", str(segment.get("text") or "")).strip("，。！？；：、,.!?;: ")
        captions.append({
            "start": round(float(segment.get("start") or 0), 3),
            "end": round(float(segment.get("end") or 0), 3),
            "text": text,
            "translation": TRANSLATIONS[index] if index < len(TRANSLATIONS) else "",
            "keyword": keyword_for(text),
            "role": "anchor" if index % 2 == 0 else "focus",
            "sectionEmphasis": index in {0, 6, 9},
            "layout": ["stack-left", "stack-right", "center"][index % 3],
            "animation": "word-reveal" if index % 2 == 0 else "spark-emphasis",
        })

    source_text = plain("".join(str(item.get("text") or "") for item in source_segments))
    caption_text = plain("".join(item["text"] for item in captions))
    if source_text != caption_text:
        raise SystemExit("caption grounding check failed")

    duration = max(float(transcript.get("audio_duration_ms") or 0) / 1000, max(float(item["end"]) for item in captions))
    transition_starts = [float(captions[index]["start"]) for index in (2, 4, 6, 8, 10) if index < len(captions)]
    transition_styles = ["editorial-cut", "drift-left", "editorial-wipe", "drift-right", "soft-flash"]
    sfx_files = [
        "sfx/high-red/editorial-bell-soft.m4a",
        "sfx/high-red/editorial-paper-flip.m4a",
        "sfx/high-red/editorial-fast-swish.m4a",
        "sfx/high-red/editorial-blip.m4a",
        "sfx/high-red/editorial-whoosh.m4a",
        "sfx/high-red/editorial-hit-short.m4a",
        "sfx/high-red/editorial-solid-hit.m4a",
        "sfx/high-red/editorial-success.ogg",
        "sfx/high-red/editorial-flare.m4a",
    ]
    sfx_starts = [0.10, 3.30, 7.15, 10.95, 15.45, 18.15, 22.45, 25.00, max(0.0, duration - 1.0)]
    sfx_levels = [0.78, 0.66, 1.10, 0.29, 0.50, 0.54, 0.45, 0.43, 0.88]

    timeline = {
        "version": 2,
        "sourceFile": "source.mp4",
        "sourceVolume": 0.84,
        # This is the verified, continuous CC0 music loop. Short caption,
        # texture and transition clips must never be used as background music.
        "bgmFile": "music/high-red/editorial-bed.ogg",
        "bgmTrackId": "high-red-editorial-bed-v1",
        "bgmVolume": 0.18,
        "sfxFile": "",
        "sfxVolume": 1.0,
        "sfxCues": [] if args.bgm_only else [
            {"start": round(start, 3), "file": file, "volume": level, "playbackRate": 1.0}
            for start, file, level in zip(sfx_starts, sfx_files, sfx_levels)
        ],
        "duration": round(duration, 3),
        "fps": 30,
        "title": "AI课程｜职场效率提升",
        "merchantName": "懿周美学",
        "coverTime": 0.35,
        "captions": captions,
        "cameraCues": [],
        "transitionCues": [
            {
                "start": round(start, 3),
                "duration": 0.22 if style == "editorial-cut" else 0.24 if style in {"editorial-wipe", "soft-flash"} else 0.30,
                "style": style,
                "intensity": 0.82 if style == "editorial-cut" else 0.76 if style == "editorial-wipe" else 0.68,
            }
            for start, style in zip(transition_starts, transition_styles)
        ],
        "chapters": [],
        "cards": [],
        "theme": {
            "rendererKey": "high-red-editorial-v1",
            "name": "高级红",
            "background": "#3d0d11",
            "foreground": "#fffdf8",
            "accent": "#8b1e2d",
            "accentSoft": "#8b1e2d33",
            "titlePosition": "top",
            "subtitlePosition": "bottom",
            "captionMode": "kinetic-red-white",
            "keywordColor": "#8b1e2d",
            "headlineDuration": 2.5,
            "headlineTop": 168,
            "headlinePersistent": True,
            "headlineAnimation": "staggered-punch",
            "headlineFontSize": 104,
            "headlineLineGap": -8,
            "captionSafeInset": 78,
            "captionMaxWidth": 850,
            "captionLineMaxChars": 8,
        },
        "grounding": {
            "source": str(args.transcript),
            "textExact": True,
            "sourceChars": len(source_text),
            "captionChars": len(caption_text),
        },
    }
    (args.output_dir / "timeline.json").write_text(json.dumps(timeline, ensure_ascii=False, indent=2), "utf-8")
    print(json.dumps({"ok": True, "captions": len(captions), "duration": duration, "text_exact": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()
