#!/usr/bin/env python3
"""Generate the mandatory user-facing release checklist for an isolated template."""

from __future__ import annotations

import argparse
import json
from datetime import date
from pathlib import Path


STYLE_LABELS = {
    "editorial-cut": "编辑跳切（快速推近 + 左右错位）",
    "editorial-wipe": "红白扫光",
    "drift-left": "向左漂移",
    "drift-right": "向右漂移",
    "soft-flash": "柔光闪切",
    "soft-punch": "轻推近",
}


def load_json(path: Path) -> dict:
    return json.loads(path.read_text("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("template_dir", type=Path)
    parser.add_argument("--timeline", type=Path)
    parser.add_argument("--review", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    template_path = args.template_dir / "template.json"
    template = load_json(template_path)
    timeline = load_json(args.timeline) if args.timeline and args.timeline.is_file() else {}
    body = template.get("body") or {}
    audio = template.get("audio") or {}
    music = audio.get("music") or {}
    sfx = audio.get("sfx") or {}
    gate = template.get("quality_gate") or {}
    transition_pool = body.get("transition_pool") or []
    transition_cues = timeline.get("transitionCues") or []
    music_tracks = music.get("tracks") if isinstance(music.get("tracks"), list) else []
    music_files = [
        str(item.get("file") or "")
        for item in music_tracks
        if isinstance(item, dict) and str(item.get("file") or "").strip()
    ]
    if not music_files and music.get("enabled") and music.get("file"):
        music_files = [str(music.get("file"))]
    sfx_files = []
    for pool_name in ("opening_pool", "accent_pool", "transition_pool", "ending_pool"):
        sfx_files.extend(sfx.get(pool_name) or [])

    output = args.output or args.template_dir / str(template.get("release_checklist_file") or "acceptance-checklist.md")
    lines = [
        f"# {template.get('name', template.get('id'))} · 模板新增验收清单",
        "",
        f"- 生成日期：{date.today().isoformat()}",
        f"- 模板 ID：`{template.get('id', '')}`",
        f"- 模板版本：`{template.get('version', '')}`",
        f"- 渲染器：`{template.get('renderer_key', '')}`",
        f"- 资源隔离：`{template.get('package_mode', '')}` / `{template.get('fallback_policy', '')}`",
        f"- 参考视频：`{template.get('reference_url', '')}`",
        f"- 本地验收成片：`{args.review.resolve() if args.review else '待生成'}`",
        "",
        "## 1. 字幕与口播",
        "",
        f"- [ ] 字幕逐字相似度 ≥ {gate.get('caption_text_similarity_min', '未配置')}",
        f"- [ ] 字幕文字覆盖率 ≥ {gate.get('caption_text_coverage_min', '未配置')}",
        f"- [ ] 口播时间覆盖率 ≥ {gate.get('speech_time_coverage_min', '未配置')}",
        "- [ ] 长句完整拆行，无截字、漏句和凭空改写",
        "- [ ] 关键词高亮与当前句语义一致",
        "",
        "## 2. 视觉与转场",
        "",
        f"- 转场触发：`{body.get('transition_trigger', '')}`",
        f"- 最小间隔：`{body.get('minimum_transition_gap_seconds', '')}` 秒",
        f"- 每分钟最大效果数：`{body.get('maximum_effects_per_minute', '')}`",
        "- 模板可用转场：",
    ]
    for item in transition_pool:
        style = str(item.get("style") or "")
        lines.append(
            f"  - {STYLE_LABELS.get(style, style)}：{item.get('duration', '')} 秒，强度 {item.get('intensity', '')}"
        )
    lines.extend(["- 本次验收时间点："])
    if transition_cues:
        for cue in transition_cues:
            style = str(cue.get("style") or "")
            lines.append(
                f"  - `{float(cue.get('start') or 0):05.2f}s`：{STYLE_LABELS.get(style, style)}"
            )
    else:
        lines.append("  - 待本地验收成片生成后自动补充")
    lines.extend([
        "- [ ] 每个时间点均能肉眼看到效果，但不遮挡人脸与字幕",
        "- [ ] 标题、字幕安全区符合短视频平台界面遮挡范围",
        "",
        "## 3. 音频资源",
        "",
        f"- 背景音乐数量：**{len(music_files)}**",
        f"- 本次选中背景音乐：`{timeline.get('bgmTrackId') or timeline.get('bgmFile') or '待生成'}`",
        f"- 本次背景音乐音量：`{timeline.get('bgmVolume', music.get('volume', 0))}`",
        f"- 独立音效数量：**{len(set(sfx_files))}**",
        f"- 本次成片音效节点：**{len(timeline.get('sfxCues') or [])}**",
        "- 背景音乐池：",
    ])
    if music_tracks:
        for item in music_tracks:
            if not isinstance(item, dict) or not str(item.get("file") or "").strip():
                continue
            moods = " / ".join(str(value) for value in item.get("moods") or [])
            lines.append(
                f"  - `{item.get('id', '')}`：`{item.get('file', '')}`，权重 {item.get('weight', 1)}，校准音量 {item.get('volume', music.get('volume', 0))}，标签 {moods or '未标注'}"
            )
    else:
        lines.append(f"  - `{music_files[0] if music_files else '未配置'}`")
    lines.extend([
        "- 音效池分组：",
        f"  - 开场：{len(sfx.get('opening_pool') or [])} 个",
        f"  - 关键词：{len(sfx.get('accent_pool') or [])} 个",
        f"  - 转场：{len(sfx.get('transition_pool') or [])} 个",
        f"  - 收尾：{len(sfx.get('ending_pool') or [])} 个",
        "- [ ] 人声始终清晰，背景音乐与音效不压过口播",
        "- [ ] 所有音乐、音效均来自当前模板独立目录",
        "",
        "## 4. 封面与导出",
        "",
        "- [ ] 封面取首个有内容画面，不使用黑帧",
        f"- [ ] 输出比例：`{(template.get('canvas') or {}).get('aspect_ratio', '')}`",
        f"- [ ] 输出尺寸：`{(template.get('canvas') or {}).get('width', '')}×{(template.get('canvas') or {}).get('height', '')}`",
        f"- [ ] 逐帧分析：`{gate.get('frame_analysis', '未配置')}`",
        "- [ ] 本地验收通过后再同步云端",
        "",
        "## 5. 用户确认",
        "",
        "- [ ] 字幕准确",
        "- [ ] 字体与配色正确",
        "- [ ] 转场可见且节奏合适",
        "- [ ] 音效正确",
        "- [ ] 背景音乐正确",
        "- [ ] 封面正确",
        "- [ ] 同意发布到云端",
        "",
    ])
    output.write_text("\n".join(lines), "utf-8")
    print(output)


if __name__ == "__main__":
    main()
