#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT.parent
TEMPLATE_ROOT = ROOT / "video-worker" / "templates-v2"

STYLE = {
    1: {"directory": "viral-pulse", "background": "#0f0a0e", "foreground": "#fffdf8", "accent": "#ff287f", "caption": "a080-brush-stagger"},
    2: {"directory": "template-2", "background": "#22101a", "foreground": "#fffdfb", "accent": "#904565", "caption": "a080-blur-right"},
    3: {"directory": "template-3", "background": "#071a2b", "foreground": "#f9fbff", "accent": "#ffd64f", "caption": "note-card-yellow-blue"},
    4: {"directory": "template-4", "background": "#1d110b", "foreground": "#fffdf7", "accent": "#ff7849", "caption": "number-chapter-orange"},
    5: {"background": "#08211b", "foreground": "#ffffff", "accent": "#77e6bd", "caption": "mint-underline"},
    6: {"directory": "template-6", "background": "#2f111c", "foreground": "#fffaf0", "accent": "#d8b36a", "caption": "quote-editorial-gold"},
    7: {"directory": "template-7", "background": "#181210", "foreground": "#fffdf8", "accent": "#ff5a36", "caption": "split-poster-red"},
    8: {"directory": "template-8", "background": "#060607", "foreground": "#ffffff", "accent": "#ffffff", "caption": "typewriter-mono"},
}


def build(template_number: int, source_timeline: Path, source_video: Path, output_dir: Path) -> None:
    style = STYLE[template_number]
    package_directory = style.get("directory", f"template-{template_number}")
    package = json.loads((TEMPLATE_ROOT / package_directory / "template.json").read_text("utf-8"))
    source = json.loads(source_timeline.read_text("utf-8"))
    output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_video, output_dir / "source.mp4")
    captions = []
    for caption in source.get("captions") or []:
        item = dict(caption)
        item["captionStyle"] = style["caption"]
        route = dict(item.get("materialRoute") or {})
        route["caption"] = style["caption"]
        item["materialRoute"] = route
        captions.append(item)

    tracks = package["audio"]["music"]["tracks"]
    semantic = "".join([str(source.get("title") or ""), *[str(item.get("text") or "") for item in captions]])
    scored = [(sum(1 for word in item.get("match_keywords") or [] if word.lower() in semantic.lower()), item) for item in tracks]
    selected = max(scored, key=lambda pair: (pair[0], pair[1].get("weight", 1)))[1]

    transition_defs = package["body"]["transition_pool"]
    old_transitions = source.get("transitionCues") or []
    transitions = []
    for index, cue in enumerate(old_transitions):
        definition = transition_defs[index % len(transition_defs)]
        transitions.append({"start": cue["start"], **definition})

    semantic_starts = [
        float(item.get("start") or 0)
        for item in captions
        if item.get("contentNode") in {"number_benefit", "core_viewpoint", "example_step", "cta"}
    ]
    cue_times = [0.08]
    for value in semantic_starts:
        if value > 1.2 and value < float(source.get("duration") or 1) - .8 and value - cue_times[-1] >= 4.0:
            cue_times.append(value)
        if len(cue_times) >= 4:
            break
    if float(source.get("duration") or 0) - cue_times[-1] >= 4.0:
        cue_times.append(float(source["duration"]) - .72)
    sfx_names = ["open.ogg", "accent.ogg", "transition.ogg", "accent.ogg", "ending.ogg"]
    sfx_cues = [
        {"start": round(value, 3), "file": f"sfx/{package['id']}/{sfx_names[index]}", "volume": round(.065 - template_number * .001 + index * .002, 3), "playbackRate": 1.0}
        for index, value in enumerate(cue_times)
    ]

    opening = package["opening"]
    body = package["body"]
    source.update({
        "sourceFile": "source.mp4",
        "sourceVolume": 1,
        "bgmFile": selected["file"],
        "bgmTrackId": selected["id"],
        "bgmVolume": selected["volume"],
        "sfxFile": "",
        "sfxCues": sfx_cues,
        "captions": captions,
        "transitionCues": transitions,
        "coverTime": .8,
        "theme": {
            "rendererKey": package["renderer_key"],
            "name": package["name"],
            "background": style["background"],
            "foreground": style["foreground"],
            "accent": style["accent"],
            "accentSoft": style["accent"] + "33",
            "titlePosition": "top",
            "subtitlePosition": "bottom",
            "captionMode": "kinetic-studio-series",
            "keywordColor": style["accent"],
            "titleVariant": "primary" if len(captions) % 2 == 0 else "secondary",
            "headlineDuration": opening["max_seconds"],
            "headlineTop": opening["safe_top_px"],
            "headlinePersistent": False,
            "headlineAnimation": "fade-scale",
            "headlineFontSize": opening["title_font_size_px"],
            "headlineLineGap": opening["title_line_gap_px"],
            "captionSafeInset": body["caption_safe_inset"],
            "captionMaxWidth": body["caption_max_width"],
            "captionLineMaxChars": body["caption_line_max_chars"],
        },
    })
    (output_dir / "timeline.json").write_text(json.dumps(source, ensure_ascii=False, indent=2) + "\n", "utf-8")
    report = {
        "template": package["name"],
        "caption_style": style["caption"],
        "music": {"id": selected["id"], "file": selected["file"], "volume": selected["volume"]},
        "sfx_count": len(sfx_cues),
        "transition_count": len(transitions),
    }
    (output_dir / "routing-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", "utf-8")


def main() -> None:
    review_root = PROJECT / "artifacts" / "template-rebuild-1-2-3-4-6-7-8"
    sources = [
        ("short", PROJECT / "artifacts/template-1-frozen-test-clean/t01-23s/timeline.json", Path("/Users/chaoge/Downloads/8ae0c839dbd7b173f254ee8587d6b7aa.mp4")),
        ("long", PROJECT / "artifacts/template-1-frozen-test-clean/t02-32s/timeline.json", Path("/Users/chaoge/Downloads/对口型成片.mp4")),
    ]
    for number in (1, 2, 3, 4, 6, 7, 8):
        for label, timeline, video in sources:
            build(number, timeline, video, review_root / f"template-{number}" / label)
    print(json.dumps({"ok": True, "review_root": str(review_root), "jobs": 12}, ensure_ascii=False))


if __name__ == "__main__":
    main()
