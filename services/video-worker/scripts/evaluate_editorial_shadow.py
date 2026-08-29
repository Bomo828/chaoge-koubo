#!/usr/bin/env python3
"""Evaluate AI editorial candidates without changing production template output.

This is deliberately a read-only promotion gate. It compares the immutable
template package contract with an optional local routing/validation review and
produces a Chinese Markdown report plus machine-readable JSON.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


PROJECT = Path(__file__).resolve().parents[3]
TEMPLATE_IDS = ("template-9", "template-10", "template-11", "template-12")


def read_json(path: Path | None, fallback: Any) -> Any:
    if path is None or not path.exists():
        return fallback
    return json.loads(path.read_text("utf-8"))


def scales(states: dict[str, Any]) -> list[float]:
    values: list[float] = []
    for state in states.values():
        if isinstance(state, dict):
            values.append(float(state.get("scale") or 1.0))
    return values


def pools(sfx: dict[str, Any]) -> list[str]:
    values: list[str] = []
    for key, value in sfx.items():
        if key.endswith("_pool") and isinstance(value, list):
            values.extend(str(item) for item in value if str(item).strip())
    return values


def add(checks: list[dict[str, Any]], name: str, passed: bool, detail: str, critical: bool = True) -> None:
    checks.append({
        "name": name,
        "passed": bool(passed),
        "critical": bool(critical),
        "detail": detail,
    })


def evaluate_template(
    template_id: str,
    profile: dict[str, Any],
    materials: dict[str, Any],
    asset_root: Path,
    routing: dict[str, Any] | None,
    validation: dict[str, Any] | None,
) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    typography = profile.get("typography_direction") or {}
    camera = profile.get("camera_language") or {}
    transitions = profile.get("transition_direction") or {}
    audio = profile.get("audio") or {}
    mix = audio.get("mix") or {}
    music = audio.get("music") or {}
    sfx = audio.get("sfx") or {}
    quality = profile.get("quality_gate") or {}
    camera_states = camera.get("style_states") or {}
    camera_scales = scales(camera_states)
    coverage = [
        str(item.get("style") or "")
        for item in transitions.get("coverage_cycle") or []
        if isinstance(item, dict) and str(item.get("style") or "")
    ]
    forbidden = set(str(item) for item in transitions.get("forbidden") or [])
    sfx_assets = pools(sfx)
    music_tracks = [item for item in music.get("tracks") or [] if isinstance(item, dict)]
    music_file = str(music.get("file") or "").strip()
    music_paths = [str(item.get("file") or "").strip() for item in music_tracks]
    declared_assets = [item for item in materials.get("assets") or [] if isinstance(item, dict)]
    declared_music = {
        str(item.get("file") or "").strip()
        for item in materials.get("music") or []
        if isinstance(item, dict)
    } | {
        str(item.get("file") or "").strip()
        for item in declared_assets
        if str(item.get("type") or "").strip().lower() in {"music", "bgm"}
    }
    missing_music = [path for path in music_paths if not (asset_root / path).is_file()]
    undeclared_music = [path for path in music_paths if path not in declared_music]

    add(checks, "批准样式锁", typography.get("policy") == "approved-style-locked", str(typography.get("policy") or "未配置"))
    add(checks, "保护原片镜头", camera.get("protect_source_scene_changes") is True, "必须优先保留原片真实镜头变化")
    add(checks, "独立镜头语言", bool(camera.get("identity")) and len(camera_states) >= 6, f"identity={camera.get('identity') or '-'}，状态={len(camera_states)}")
    camera_range = (max(camera_scales) - min(camera_scales)) if camera_scales else 0.0
    add(checks, "可见构图变化", camera_range >= 0.14, f"缩放跨度={camera_range:.2f}")
    add(checks, "镜头变化不单一", len(set(coverage)) >= 4, f"镜头类型={len(set(coverage))}")
    add(checks, "禁止装饰性扫切", {"random-sweep", "single-style-loop"}.issubset(forbidden), "随机扫切与单效果循环必须禁用")
    add(checks, "保留原声", audio.get("preserve_source") is True, str(audio.get("preserve_source")))
    add(checks, "统一语音优先混音", mix.get("standard") == "speech-first-v2", str(mix.get("standard") or "未配置"))
    add(checks, "重点词音效稀疏路由", sfx.get("keyword_emphasis_enabled") is True and 0.58 <= float(sfx.get("keyword_min_confidence") or 0) <= 0.8, f"阈值={sfx.get('keyword_min_confidence')}")
    add(checks, "模板独立音效池", bool(sfx_assets) and all(f"sfx/{template_id}/" in item for item in sfx_assets), f"音效资产={len(set(sfx_assets))}")
    add(checks, "背景音乐池", music.get("enabled") is True and bool(music_file or music_tracks), f"enabled={music.get('enabled')}，曲目={len(music_tracks)}")
    add(checks, "背景音乐资产可用", bool(music_paths) and not missing_music, f"缺失={missing_music or '0'}")
    add(checks, "背景音乐来源已登记", bool(music_paths) and not undeclared_music, f"未登记={undeclared_music or '0'}")
    add(checks, "逐帧质量门", quality.get("frame_analysis") == "every-decoded-frame" and quality.get("maximum_corrupt_frames") == 0, "必须逐帧检查且坏帧为0")

    if routing:
        runtime_transitions = routing.get("transition_plan") or []
        runtime_styles = {str(item.get("style") or "") for item in runtime_transitions if isinstance(item, dict)}
        add(checks, "样片镜头覆盖", len(runtime_transitions) >= 3 and len(runtime_styles) >= 3, f"节点={len(runtime_transitions)}，类型={len(runtime_styles)}")
        keyword_sfx_count = int(routing.get("keyword_sfx_count") or 0)
        add(checks, "样片重点词音效密度", 1 <= keyword_sfx_count <= 3, f"重点词音效={keyword_sfx_count}")
        runtime_bgm = routing.get("bgm") or {}
        add(checks, "样片BGM非机械循环", bool(runtime_bgm.get("file")) and runtime_bgm.get("loop") is False, f"file={runtime_bgm.get('file') or '-'}，loop={runtime_bgm.get('loop')}")
        add(checks, "样片统一混音", (routing.get("audio_mix") or {}).get("standard") == "speech-first-v2", str((routing.get("audio_mix") or {}).get("standard") or "未配置"))
    else:
        add(checks, "样片路由报告", False, "未提供样片路由报告", critical=False)

    if validation:
        metrics = validation.get("metrics") or {}
        add(checks, "样片逐帧通过", validation.get("passed") is True, f"分析帧={metrics.get('analyzed_frames')}/{metrics.get('expected_frames')}")
        add(checks, "字幕文本完整", float(metrics.get("caption_text_coverage") or 0) >= 0.95, f"覆盖率={metrics.get('caption_text_coverage')}")
        add(checks, "口播时间完整", float(metrics.get("speech_time_coverage") or 0) >= 0.94, f"覆盖率={metrics.get('speech_time_coverage')}")
        add(checks, "零坏帧", int(metrics.get("corrupt_frame_count") or 0) == 0, f"坏帧={metrics.get('corrupt_frame_count')}")
    else:
        add(checks, "样片逐帧报告", False, "未提供逐帧报告", critical=False)

    passed_count = sum(1 for item in checks if item["passed"])
    score = round(passed_count / max(1, len(checks)) * 100)
    blockers = [item for item in checks if item["critical"] and not item["passed"]]
    return {
        "template_id": template_id,
        "template_name": str(profile.get("name") or template_id),
        "score": score,
        "eligible": score >= 90 and not blockers,
        "blockers": blockers,
        "checks": checks,
    }


def render_markdown(result: dict[str, Any]) -> str:
    lines = [
        "# AI 剪辑影子测试报告",
        "",
        "> 本报告只评估候选剪辑计划，不替换生产模板，也不改变已批准的标题、字幕、字体、配色与混音身份。",
        "",
        f"- 总体结论：**{'允许进入人工 A/B 复核' if result['eligible'] else '暂不允许晋级生产'}**",
        f"- 已通过模板：{result['eligible_count']}/{len(result['templates'])}",
        "",
    ]
    for item in result["templates"]:
        lines.extend([
            f"## {item['template_name']}（{item['template_id']}）",
            "",
            f"- 分数：{item['score']}",
            f"- 结论：{'通过' if item['eligible'] else '拦截'}",
            "",
            "| 检查项 | 结果 | 说明 |",
            "|---|---|---|",
        ])
        for check in item["checks"]:
            marker = "通过" if check["passed"] else ("阻断" if check["critical"] else "待补")
            detail = str(check["detail"]).replace("|", "\\|")
            lines.append(f"| {check['name']} | {marker} | {detail} |")
        lines.append("")
    lines.extend([
        "## 晋级规则",
        "",
        "只有单模板达到 90 分且没有关键阻断项，才允许进入人工 A/B 复核；人工确认后才能逐任务灰度启用，不能全量替换。",
        "",
    ])
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate four-template AI editorial candidates in shadow mode")
    parser.add_argument("--templates-root", type=Path, default=PROJECT / "services/video-worker/templates-v2")
    parser.add_argument("--asset-root", type=Path, default=PROJECT / "services/remotion-worker/public")
    parser.add_argument("--routing-summary", type=Path)
    parser.add_argument("--validation-summary", type=Path)
    parser.add_argument("--output", type=Path, default=PROJECT / "artifacts/editorial-shadow-test")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    routing_items = read_json(args.routing_summary, [])
    routing_by_template = {
        str(item.get("template_id")): item
        for item in routing_items
        if isinstance(item, dict) and str(item.get("label") or "short") == "short"
    }
    validation_payload = read_json(args.validation_summary, {})
    validation_by_template = validation_payload.get("results") or {}
    templates: list[dict[str, Any]] = []
    for template_id in TEMPLATE_IDS:
        profile_path = args.templates_root / template_id / "template.json"
        profile = read_json(profile_path, {})
        materials = read_json(args.templates_root / template_id / "materials.json", {})
        templates.append(evaluate_template(
            template_id,
            profile,
            materials,
            args.asset_root,
            routing_by_template.get(template_id),
            validation_by_template.get(f"{template_id}/short"),
        ))
    result = {
        "mode": "shadow",
        "eligible": all(item["eligible"] for item in templates),
        "eligible_count": sum(1 for item in templates if item["eligible"]),
        "templates": templates,
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", "utf-8")
    (args.output / "report.md").write_text(render_markdown(result), "utf-8")
    print(json.dumps({
        "ok": True,
        "eligible": result["eligible"],
        "eligible_count": result["eligible_count"],
        "report": str(args.output / "report.md"),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
