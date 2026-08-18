#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import statistics
import subprocess
from datetime import datetime
from pathlib import Path


def executable(env_name: str, fallback: str) -> str:
    configured = os.environ.get(env_name, "").strip()
    if configured:
        return configured
    resolved = shutil.which(fallback)
    if not resolved:
        raise RuntimeError(f"找不到 {fallback}，请设置 {env_name}")
    return resolved


def probe_video(path: Path, ffprobe: str) -> dict[str, object]:
    command = [
        ffprobe, "-v", "error", "-show_entries",
        "stream=index,codec_type,codec_name,width,height,r_frame_rate,pix_fmt,color_range,color_space,bit_rate:format=duration,bit_rate",
        "-of", "json", str(path),
    ]
    payload = json.loads(subprocess.check_output(command, text=True))
    streams = payload.get("streams") or []
    video = next((item for item in streams if item.get("codec_type") == "video"), {})
    audio = next((item for item in streams if item.get("codec_type") == "audio"), {})
    return {
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "fps": str(video.get("r_frame_rate") or ""),
        "video_codec": str(video.get("codec_name") or ""),
        "audio_codec": str(audio.get("codec_name") or ""),
        "pixel_format": str(video.get("pix_fmt") or ""),
        "color_range": str(video.get("color_range") or ""),
        "color_space": str(video.get("color_space") or ""),
        "duration": float((payload.get("format") or {}).get("duration") or 0),
        "bit_rate": int((payload.get("format") or {}).get("bit_rate") or 0),
        "video_bit_rate": int(video.get("bit_rate") or 0),
    }


def audio_levels(path: Path, ffmpeg: str) -> dict[str, float | None]:
    process = subprocess.run(
        [
            ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-vn", "-af",
            "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-",
        ],
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        check=False,
    )
    output = process.stderr or ""
    marker = output.rfind('"input_i"')
    start = output.rfind("{", 0, marker) if marker >= 0 else -1
    end = output.find("}", marker) if marker >= 0 else -1
    if start < 0 or end < 0:
        return {"integrated_lufs": None, "true_peak_dbtp": None}
    try:
        payload = json.loads(output[start:end + 1])
        return {
            "integrated_lufs": float(payload.get("input_i")),
            "true_peak_dbtp": float(payload.get("input_tp")),
        }
    except (TypeError, ValueError, json.JSONDecodeError):
        return {"integrated_lufs": None, "true_peak_dbtp": None}


def format_mbps(value: int) -> str:
    return f"{value / 1_000_000:.2f} Mbps" if value else "未知"


def pass_mark(value: bool) -> str:
    return "通过" if value else "仍有差距"


def main() -> None:
    parser = argparse.ArgumentParser(description="生成模板9与固定原片的自动对比报告")
    parser.add_argument("--reference", required=True)
    parser.add_argument("--rendered", required=True)
    parser.add_argument("--timeline", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--validation-report")
    args = parser.parse_args()

    reference = Path(args.reference).resolve()
    rendered = Path(args.rendered).resolve()
    timeline_path = Path(args.timeline).resolve()
    report_path = Path(args.report).resolve()
    ffprobe = executable("FFPROBE_BIN", "ffprobe")
    ffmpeg = executable("FFMPEG_BIN", "ffmpeg")

    timeline = json.loads(timeline_path.read_text("utf-8"))
    reference_meta = probe_video(reference, ffprobe)
    rendered_meta = probe_video(rendered, ffprobe)
    reference_audio = audio_levels(reference, ffmpeg)
    rendered_audio = audio_levels(rendered, ffmpeg)
    captions = timeline.get("captions") or []
    caption_lengths = [len(re.sub(r"\s+", "", str(item.get("text") or ""))) for item in captions]
    sfx_cues = timeline.get("sfxCues") or []
    sfx_volumes = [float(item.get("volume") or 0) for item in sfx_cues]
    title_parts = [part.strip() for part in str(timeline.get("title") or "").split("｜") if part.strip()]
    if len(title_parts) == 2:
        main_title = max(title_parts, key=len)
        title_rows = [next(item for item in title_parts if item != main_title), main_title]
    else:
        title_rows = title_parts

    validation: dict[str, object] = {}
    if args.validation_report and Path(args.validation_report).is_file():
        validation = json.loads(Path(args.validation_report).read_text("utf-8"))
    validation_metrics = validation.get("metrics") if isinstance(validation.get("metrics"), dict) else {}

    checks = {
        "分辨率与原片一致": (rendered_meta["width"], rendered_meta["height"]) == (reference_meta["width"], reference_meta["height"]),
        "帧率与原片一致": rendered_meta["fps"] == reference_meta["fps"],
        "码率达到原片的65%": int(rendered_meta["bit_rate"]) >= int(reference_meta["bit_rate"]) * 0.65,
        "标题具备两排层级": len(title_rows) == 2,
        "字幕平均不超过7字": bool(caption_lengths) and statistics.mean(caption_lengths) <= 7,
        "语义音效达到可听区间": bool(sfx_volumes) and statistics.mean(sfx_volumes) >= 0.13,
        "逐帧完整性通过": bool(validation.get("passed")),
    }

    report = [
        "# 模板9｜固定原片自动对比报告",
        "",
        f"- 生成时间：{datetime.now().astimezone().isoformat(timespec='seconds')}",
        f"- 固定原片：`{reference}`",
        f"- 本次成片：`{rendered}`",
        f"- 时间轴：`{timeline_path}`",
        "",
        "## 技术参数",
        "",
        "| 项目 | 固定原片 | 本次成片 |",
        "|---|---:|---:|",
        f"| 尺寸 | {reference_meta['width']}×{reference_meta['height']} | {rendered_meta['width']}×{rendered_meta['height']} |",
        f"| 帧率 | {reference_meta['fps']} | {rendered_meta['fps']} |",
        f"| 总码率 | {format_mbps(int(reference_meta['bit_rate']))} | {format_mbps(int(rendered_meta['bit_rate']))} |",
        f"| 视频编码 | {reference_meta['video_codec']} | {rendered_meta['video_codec']} |",
        f"| 色彩 | {reference_meta['color_space']} / {reference_meta['color_range']} | {rendered_meta['color_space']} / {rendered_meta['color_range']} |",
        f"| 综合响度 | {reference_audio['integrated_lufs']} LUFS | {rendered_audio['integrated_lufs']} LUFS |",
        f"| 真峰值 | {reference_audio['true_peak_dbtp']} dBTP | {rendered_audio['true_peak_dbtp']} dBTP |",
        "",
        "## 字幕、标题与声音",
        "",
        f"- 标题层级：{' / '.join(title_rows) if title_rows else '无'}；规范为第一排白字红边、第二排红字白边。",
        f"- 字幕：{len(captions)} 条；平均 {statistics.mean(caption_lengths):.2f} 字；最长 {max(caption_lengths) if caption_lengths else 0} 字。",
        f"- 背景音乐：`{timeline.get('bgmTrackId') or timeline.get('bgmFile') or '无'}`，音量 {float(timeline.get('bgmVolume') or 0):.3f}。",
        f"- 语义音效：{len(sfx_cues)} 个；平均音量 {statistics.mean(sfx_volumes):.3f}；最大 {max(sfx_volumes) if sfx_volumes else 0:.3f}。",
        f"- 逐帧：{validation_metrics.get('analyzed_frames', '未检查')} / {validation_metrics.get('expected_frames', '未检查')}；坏帧 {validation_metrics.get('corrupt_frame_count', '未检查')}。",
        "",
        "## 自动结论",
        "",
    ]
    report.extend(f"- {pass_mark(result)}：{name}" for name, result in checks.items())
    report.extend([
        "",
        "## 每版仍需人工对照",
        "",
        "- 标题是否遮挡人物或抢过人脸；两排字的红白关系是否符合原片。",
        "- 字幕的字形气质、描边干净度、关键词大小和断句是否舒服。",
        "- 音效是否听得见但不盖人声，背景音乐是否有情绪而不抢口播。",
        "- 转场是否只出现在内容节点，不出现机械推近。",
        "",
    ])
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(report), "utf-8")
    report_path.with_suffix(".json").write_text(json.dumps({
        "reference": reference_meta,
        "rendered": rendered_meta,
        "reference_audio": reference_audio,
        "rendered_audio": rendered_audio,
        "checks": checks,
        "timeline": {
            "title_rows": title_rows,
            "caption_count": len(captions),
            "caption_mean_chars": statistics.mean(caption_lengths) if caption_lengths else 0,
            "caption_max_chars": max(caption_lengths) if caption_lengths else 0,
            "bgm": timeline.get("bgmTrackId") or timeline.get("bgmFile"),
            "bgm_volume": timeline.get("bgmVolume"),
            "sfx_count": len(sfx_cues),
            "sfx_mean_volume": statistics.mean(sfx_volumes) if sfx_volumes else 0,
        },
    }, ensure_ascii=False, indent=2), "utf-8")
    print(json.dumps({"ok": True, "report": str(report_path)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
