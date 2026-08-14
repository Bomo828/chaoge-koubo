from __future__ import annotations

import base64
import hashlib
import hmac
import json
import http.client
import math
import os
import random
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from caption_router import select_caption_material
from douyin_resolver import first_media_url, resolve_public_douyin_video
from music_router import select_content_music
from sfx_router import build_semantic_sfx_cues

ROOT = Path(__file__).resolve().parent
VENDOR_DIR = ROOT / "vendor"
if VENDOR_DIR.is_dir():
    sys.path.insert(0, str(VENDOR_DIR))
REMOTION_WORKER_DIR = next(
    (
        candidate.resolve()
        for candidate in (ROOT / "remotion-worker", ROOT.parent / "remotion-worker")
        if candidate.exists()
    ),
    (ROOT.parent / "remotion-worker").resolve(),
)
DATA_DIR = Path(os.getenv("VIDEO_WORKER_DATA_DIR", ROOT / "data")).resolve()
MAX_UPLOAD_BYTES = int(os.getenv("VIDEO_WORKER_MAX_UPLOAD_MB", "500")) * 1024 * 1024
BENCHMARK_MAX_BYTES = min(
    MAX_UPLOAD_BYTES,
    int(os.getenv("VIDEO_WORKER_BENCHMARK_MAX_MB", "250")) * 1024 * 1024,
)
BENCHMARK_MAX_DURATION_SECONDS = max(
    30,
    int(os.getenv("VIDEO_WORKER_BENCHMARK_MAX_DURATION_SECONDS", "600")),
)
AI_API_BASE_URL = os.getenv("LK888_API_BASE_URL", "https://api.lk888.ai").rstrip("/")
AI_API_KEY = os.getenv("LK888_API_KEY", "").strip()
AI_TITLE_MODEL = os.getenv("VIDEO_WORKER_TITLE_MODEL", "gpt-5.5")
AI_VIDEO_MODEL = os.getenv("VIDEO_WORKER_VIDEO_ANALYSIS_MODEL", "gemini-3.5-flash").strip()
TENCENT_CLOUD_APP_ID = os.getenv("TENCENT_CLOUD_APP_ID", os.getenv("TENCENT_APP_ID", "")).strip()
TENCENT_CLOUD_SECRET_ID = os.getenv(
    "TENCENT_CLOUD_SECRET_ID",
    os.getenv("TENCENT_SECRET_ID", ""),
).strip()
TENCENT_CLOUD_SECRET_KEY = os.getenv(
    "TENCENT_CLOUD_SECRET_KEY",
    os.getenv("TENCENT_SECRET_KEY", ""),
).strip()
TENCENT_ASR_ENGINE_TYPE = os.getenv("TENCENT_ASR_ENGINE_TYPE", "16k_zh_en").strip() or "16k_zh_en"
TENCENT_ASR_TIMEOUT_SECONDS = max(15, int(os.getenv("TENCENT_ASR_TIMEOUT_SECONDS", "90")))
PUBLIC_BASE_URL = os.getenv("VIDEO_WORKER_PUBLIC_BASE_URL", "").strip().rstrip("/")
WORKERS = max(1, int(os.getenv("VIDEO_WORKER_CONCURRENCY", "1")))
TRANSCRIPTION_WORKERS = max(1, int(os.getenv("VIDEO_WORKER_TRANSCRIPTION_CONCURRENCY", "1")))
CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "VIDEO_WORKER_CORS_ORIGINS",
        "http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000,http://127.0.0.1:3001",
    ).split(",")
    if origin.strip()
]

DATA_DIR.mkdir(parents=True, exist_ok=True)
EXECUTOR = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="video-worker")
TRANSCRIPTION_EXECUTOR = ThreadPoolExecutor(
    max_workers=TRANSCRIPTION_WORKERS,
    thread_name_prefix="transcription-worker",
)
app = FastAPI(title="Merchant Studio Video Worker", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


TEMPLATE_MANIFEST = ROOT / "templates.json"
TEMPLATE_V2_DIR = ROOT / "templates-v2"
TEMPLATE_REGISTRY_MANIFEST = ROOT / "template-registry.json"
TEMPLATE_REGISTRY_URL = os.getenv("VIDEO_TEMPLATE_REGISTRY_URL", "").strip()
TEMPLATE_REGISTRY_CACHE_SECONDS = max(
    30,
    int(os.getenv("VIDEO_TEMPLATE_REGISTRY_CACHE_SECONDS", "300")),
)
TEMPLATE_REGISTRY_LOCK = threading.Lock()
TEMPLATE_REGISTRY_LAST_REFRESH = 0.0
TEMPLATE_REGISTRY_ERROR = ""
TEMPLATE_CATALOG: dict[str, dict[str, Any]] = {}
AUTHORING_SKILL_DIR = next(
    (
        candidate
        for candidate in (
            ROOT / "authoring-skill",
            ROOT.parent.parent / "skills" / "distill-viral-video-template",
        )
        if candidate.exists()
    ),
    ROOT / "authoring-skill",
)
ADMIN_TOKEN = os.getenv("VIDEO_WORKER_ADMIN_TOKEN", "").strip()


def load_templates() -> dict[str, dict[str, Any]]:
    try:
        value = json.loads(TEMPLATE_MANIFEST.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"视频模板清单读取失败：{error}") from error
    if not isinstance(value, dict) or "clean-green" not in value:
        raise RuntimeError("视频模板清单缺少默认模板 clean-green。")
    return {
        str(template_id): dict(profile)
        for template_id, profile in value.items()
        if isinstance(profile, dict)
    }


TEMPLATES = load_templates()


def valid_template_package(value: Any, expected_id: str = "") -> bool:
    if not isinstance(value, dict) or int(value.get("version") or 0) < 2:
        return False
    template_id = str(value.get("id") or "").strip()
    if not template_id or (expected_id and template_id != expected_id):
        return False
    # Version 3 makes template isolation a hard contract. A published template
    # must declare its own renderer and must never silently inherit another
    # template's visual or audio package.
    if int(value.get("package_contract_version") or 0) >= 3:
        if value.get("package_mode") != "isolated":
            return False
        if value.get("fallback_policy") != "forbid-cross-template":
            return False
        checklist_file = str(value.get("release_checklist_file") or "").strip()
        if not checklist_file or Path(checklist_file).name != checklist_file:
            return False
        renderer_key = str(value.get("renderer_key") or "").strip()
        renderer_prefix = "template-1-" if template_id == "viral-pulse" else f"{template_id}-"
        if not renderer_key or not renderer_key.startswith(renderer_prefix):
            return False
        audio = value.get("audio") if isinstance(value.get("audio"), dict) else {}
        music = audio.get("music") if isinstance(audio.get("music"), dict) else {}
        music_file = str(music.get("file") or "").strip()
        if music.get("enabled") and not music_file.startswith(f"music/{template_id}/"):
            return False
        music_tracks = music.get("tracks") if isinstance(music.get("tracks"), list) else []
        for track in music_tracks:
            if not isinstance(track, dict):
                return False
            track_file = str(track.get("file") or "").strip()
            if not track_file.startswith(f"music/{template_id}/"):
                return False
        sfx = audio.get("sfx") if isinstance(audio.get("sfx"), dict) else {}
        for pool_name in ("opening_pool", "accent_pool", "transition_pool", "ending_pool"):
            pool = sfx.get(pool_name) if isinstance(sfx.get(pool_name), list) else []
            if any(not str(asset).startswith(f"sfx/{template_id}/") for asset in pool):
                return False
    return True


def load_template_packages() -> dict[str, dict[str, Any]]:
    packages: dict[str, dict[str, Any]] = {}
    if not TEMPLATE_V2_DIR.exists():
        return packages
    for path in TEMPLATE_V2_DIR.glob("*/template.json"):
        try:
            value = json.loads(path.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if str(value.get("status") or "published").strip().lower() in {"designing", "draft"}:
            continue
        # Template packages are forward-compatible. Newer versions may extend
        # the schema with captions, music pools and cloud catalog metadata.
        if not valid_template_package(value):
            continue
        if int(value.get("package_contract_version") or 0) >= 3:
            checklist = path.parent / str(value.get("release_checklist_file") or "")
            if not checklist.is_file():
                continue
        template_id = str(value.get("id") or path.parent.name)
        if template_id == path.parent.name:
            packages[template_id] = value
    return packages


def read_json_document(source: str) -> dict[str, Any]:
    if re.match(r"^https?://", source):
        request = urllib.request.Request(
            source,
            headers={"Accept": "application/json", "User-Agent": "merchant-video-worker/1.0"},
        )
        with urllib.request.urlopen(request, timeout=8) as response:
            value = json.loads(response.read().decode("utf-8"))
    else:
        value = json.loads(Path(source).read_text("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("JSON 文档格式无效。")
    return value


def read_registry_document(source: str) -> dict[str, Any]:
    value = read_json_document(source)
    if not isinstance(value, dict) or not isinstance(value.get("templates"), list):
        raise ValueError("模板注册表格式无效。")
    return value


def packages_from_registry(
    document: dict[str, Any],
    source: str,
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    packages: dict[str, dict[str, Any]] = {}
    catalog: dict[str, dict[str, Any]] = {}
    for raw_entry in document.get("templates") or []:
        if not isinstance(raw_entry, dict) or raw_entry.get("status", "published") != "published":
            continue
        template_id = str(raw_entry.get("id") or "").strip()
        if not template_id:
            continue
        package = raw_entry.get("package")
        package_path = str(raw_entry.get("package_path") or "").strip()
        package_url = str(raw_entry.get("package_url") or "").strip()
        try:
            if not isinstance(package, dict) and package_path:
                package = json.loads((ROOT / package_path).resolve().read_text("utf-8"))
            if not isinstance(package, dict) and package_url:
                package_document = read_json_document(package_url)
                package = package_document.get("package", package_document)
        except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError):
            continue
        if not valid_template_package(package, template_id):
            continue
        metadata = {
            key: value
            for key, value in raw_entry.items()
            if key not in {"package", "package_path", "package_url"}
        }
        metadata["source"] = source
        package = {**package, "_catalog": metadata}
        packages[template_id] = package
        catalog[template_id] = metadata
    return packages, catalog


def load_local_template_registry() -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    if not TEMPLATE_REGISTRY_MANIFEST.exists():
        return {}, {}
    document = read_registry_document(str(TEMPLATE_REGISTRY_MANIFEST))
    return packages_from_registry(document, "cloud-bundled")


LOCAL_TEMPLATE_PACKAGES = load_template_packages()
LOCAL_REGISTRY_PACKAGES, LOCAL_TEMPLATE_CATALOG = load_local_template_registry()
TEMPLATE_PACKAGES = {**LOCAL_TEMPLATE_PACKAGES, **LOCAL_REGISTRY_PACKAGES}
TEMPLATE_CATALOG.update(LOCAL_TEMPLATE_CATALOG)


def refresh_remote_template_registry(force: bool = False) -> None:
    global TEMPLATE_PACKAGES, TEMPLATE_CATALOG
    global TEMPLATE_REGISTRY_LAST_REFRESH, TEMPLATE_REGISTRY_ERROR
    if not TEMPLATE_REGISTRY_URL:
        return
    now = time.monotonic()
    if not force and now - TEMPLATE_REGISTRY_LAST_REFRESH < TEMPLATE_REGISTRY_CACHE_SECONDS:
        return
    with TEMPLATE_REGISTRY_LOCK:
        now = time.monotonic()
        if not force and now - TEMPLATE_REGISTRY_LAST_REFRESH < TEMPLATE_REGISTRY_CACHE_SECONDS:
            return
        try:
            document = read_registry_document(TEMPLATE_REGISTRY_URL)
            remote_packages, remote_catalog = packages_from_registry(document, "cloud-remote")
            if not remote_packages:
                raise ValueError("云端模板注册表中没有已发布模板。")
            TEMPLATE_PACKAGES = {
                **LOCAL_TEMPLATE_PACKAGES,
                **LOCAL_REGISTRY_PACKAGES,
                **remote_packages,
            }
            TEMPLATE_CATALOG = {**LOCAL_TEMPLATE_CATALOG, **remote_catalog}
            TEMPLATE_REGISTRY_ERROR = ""
        except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as error:
            # 云端临时不可用时继续使用最后一次成功结果或内置首个模板。
            TEMPLATE_REGISTRY_ERROR = str(error)
        finally:
            TEMPLATE_REGISTRY_LAST_REFRESH = time.monotonic()

DEFAULT_TEMPLATE_VALUES: dict[str, Any] = {
    "outline": "&H70000000",
    "shadow": "&H90000000",
    "boxed": True,
    "title_persistent": False,
    "title_size_ratio": 0.075,
    "subtitle_size_ratio": 0.048,
    "title_margin_ratio": 0.075,
    "subtitle_margin_ratio": 0.06,
    "title_outline": 3,
    "subtitle_outline": 2,
    "title_shadow": 0,
    "subtitle_shadow": 0,
    "title_max_chars": 20,
    "caption_max_chars": 15,
    "opening_sfx": "soft",
    "transition": "preserve-source",
    "box_padding": 10,
    "title_animation": "pop",
    "subtitle_animation": "fade",
    "font_name": "Noto Sans CJK SC",
    "title_bold": True,
    "subtitle_bold": True,
    "title_italic": False,
    "subtitle_italic": False,
    "title_spacing": 1.0,
    "subtitle_spacing": 0.0,
    "transition_duration": 0.28,
    "title_description": "两行钩子标题",
    "subtitle_description": "自动字幕",
}

HIGHLIGHT_PATTERN = re.compile(
    r"(\d+(?:\.\d+)?(?:元|折|岁|天|次|分钟|小时)?|免费|优惠|限时|一定|千万|不要|必须|最(?:新|省|美|好)|专业|自然|真实)"
)


def check_binary(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"服务器缺少 {name}，请先完成视频处理环境安装。")
    return path


def run(command: list[str]) -> str:
    try:
        completed = subprocess.run(command, check=True, capture_output=True, text=True)
        return completed.stdout
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or error.stdout or str(error)).strip()
        raise RuntimeError(detail[-3000:] or "视频处理命令执行失败。") from error


def remotion_renderer_available() -> bool:
    mode = os.getenv("VIDEO_WORKER_RENDERER", "auto").strip().lower()
    if mode == "ffmpeg":
        return False
    renderer = REMOTION_WORKER_DIR / "scripts" / "render.mjs"
    packages = REMOTION_WORKER_DIR / "node_modules" / "remotion"
    available = bool(shutil.which("node") and renderer.exists() and packages.exists())
    if mode == "remotion" and not available:
        raise RuntimeError("已指定 Remotion 渲染，但服务器尚未安装包装引擎依赖。")
    return available


def css_color(value: Any, fallback: str) -> str:
    """Convert either #RRGGBB or ASS &HAABBGGRR into a CSS colour."""
    text = str(value or "").strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", text):
        return text.lower()
    match = re.fullmatch(r"&H[0-9a-fA-F]{2}([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})", text)
    if match:
        blue, green, red = match.groups()
        return f"#{red}{green}{blue}".lower()
    return fallback


def remotion_theme(template_id: str) -> dict[str, Any]:
    themes = {
        "clean-green": ("#08140f", "#ffffff", "#f2cf63"),
        "soft-white": ("#f4ecef", "#2d3145", "#d79aab"),
        "warm-gold": ("#23170f", "#fff4d6", "#ffb45d"),
        "brand-card": ("#0b2318", "#ffffff", "#89edc2"),
        "bold-yellow": ("#f0c934", "#172019", "#ffffff"),
        "classic-blue": ("#10283d", "#ffffff", "#b9d9ff"),
        "warm-brown": ("#302219", "#fff7e9", "#e9b679"),
        "high-red": ("#3d0d11", "#ffffff", "#ff6f6f"),
        "bold-yellow-white": ("#090909", "#ffffff", "#fff300"),
    }
    profile = template_profile(template_id)
    background, default_foreground, default_accent = themes.get(template_id, themes["clean-green"])
    foreground = css_color(profile.get("primary"), default_foreground)
    accent = css_color(profile.get("accent"), default_accent)
    caption_mode = str(profile.get("caption_mode") or "")
    if caption_mode not in {"classic", "kinetic-red-white", "kinetic-yellow-white", "kinetic-mint-white", "kinetic-bold-yellow-white", "kinetic-viral-pulse", "kinetic-soft-rose", "kinetic-studio-series"}:
        caption_mode = "kinetic-yellow-white" if template_id == "clean-green" else "kinetic-red-white" if template_id == "high-red" else "classic"
    title_y_ratio = float(profile.get("title_margin_ratio") or .075)
    subtitle_y_ratio = float(profile.get("subtitle_margin_ratio") or .68)
    theme: dict[str, Any] = {
        "rendererKey": str(profile.get("renderer_key") or "legacy-generic"),
        "name": str(profile.get("name") or "网感模板"),
        "background": background,
        "foreground": foreground,
        "accent": accent,
        "accentSoft": accent + "33",
        "titlePosition": "top" if title_y_ratio < .28 else "center",
        "subtitlePosition": "middle" if subtitle_y_ratio < .58 else "bottom",
        "captionMode": caption_mode,
        "keywordColor": str(profile.get("keyword_color") or accent),
        "headlineDuration": float(profile.get("title_duration_seconds") or 2.6),
        "headlineTop": max(72, min(1480, round(1920 * title_y_ratio))),
        "headlinePersistent": bool(profile.get("title_persistent")),
        "headlineAnimation": "staggered-punch" if str(profile.get("title_animation")) in {"staggered-punch", "bounce", "pop"} else "fade-scale",
        "headlineFontSize": max(52, min(176, round(1080 * float(profile.get("title_size_ratio") or .075)))),
        "headlineLineGap": int(profile.get("title_line_gap_px") or -4),
        "captionSafeInset": int(profile.get("caption_safe_inset") or 72),
        "captionMaxWidth": int(profile.get("caption_max_width") or 936),
        "captionLineMaxChars": int(profile.get("caption_line_max_chars") or profile.get("caption_max_chars") or 12),
    }
    if template_id == "clean-green":
        package = profile.get("package") if isinstance(profile.get("package"), dict) else {}
        opening = package.get("opening") if isinstance(package.get("opening"), dict) else {}
        theme.update({
            "captionMode": "kinetic-yellow-white",
            "keywordColor": "#ffef00",
            "headlineDuration": 2.45,
            "headlineTop": int(opening.get("safe_top_px") or 220),
            "headlinePersistent": bool(opening.get("persistent_title", False)),
            "headlineAnimation": str(opening.get("title_animation") or "staggered-punch"),
            "headlineFontSize": int(opening.get("title_font_size_px") or 112),
            "headlineLineGap": int(opening.get("title_line_gap_px") or -8),
            "captionSafeInset": 96,
            "captionMaxWidth": 888,
            "captionLineMaxChars": 8,
        })
    elif template_id == "warm-gold":
        package = profile.get("package") if isinstance(profile.get("package"), dict) else {}
        opening = package.get("opening") if isinstance(package.get("opening"), dict) else {}
        theme.update({
            "captionMode": "kinetic-mint-white",
            "keywordColor": "#71efd0",
            "headlineDuration": float(opening.get("max_seconds") or 23.6),
            "headlineTop": int(opening.get("safe_top_px") or 156),
            "headlinePersistent": bool(opening.get("persistent_title", True)),
            "headlineAnimation": str(opening.get("title_animation") or "fade-scale"),
            "headlineFontSize": int(opening.get("title_font_size_px") or 76),
            "headlineLineGap": int(opening.get("title_line_gap_px") or 2),
            "captionSafeInset": 112,
            "captionMaxWidth": 836,
            "captionLineMaxChars": 9,
        })
    elif template_id == "bold-yellow-white":
        package = profile.get("package") if isinstance(profile.get("package"), dict) else {}
        opening = package.get("opening") if isinstance(package.get("opening"), dict) else {}
        theme.update({
            "rendererKey": "bold-yellow-white-impact-v1",
            "captionMode": "kinetic-bold-yellow-white",
            "keywordColor": "#fff300",
            "headlineDuration": float(opening.get("max_seconds") or 60.0),
            "headlineTop": int(opening.get("safe_top_px") or 172),
            "headlinePersistent": True,
            "headlineAnimation": "staggered-punch",
            "headlineFontSize": int(opening.get("title_font_size_px") or 92),
            "headlineLineGap": int(opening.get("title_line_gap_px") or -7),
            "captionSafeInset": 104,
            "captionMaxWidth": 872,
            "captionLineMaxChars": 8,
        })
    elif template_id in {"viral-pulse", "template-2", "template-3", "template-4", "template-5", "template-6", "template-7", "template-8"}:
        package = profile.get("package") if isinstance(profile.get("package"), dict) else {}
        opening = package.get("opening") if isinstance(package.get("opening"), dict) else {}
        theme.update({
            "rendererKey": str(profile.get("renderer_key") or f"{template_id}-studio-v1"),
            "captionMode": "kinetic-studio-series",
            "keywordColor": str(profile.get("keyword_color") or accent),
            "headlineDuration": float(opening.get("max_seconds") or 2.6),
            "headlineTop": int(opening.get("safe_top_px") or 154),
            "headlinePersistent": False,
            "headlineAnimation": "staggered-punch" if template_id == "viral-pulse" else "fade-scale",
            "headlineFontSize": int(opening.get("title_font_size_px") or 82),
            "headlineLineGap": int(opening.get("title_line_gap_px") or 8),
            "captionSafeInset": int(profile.get("caption_safe_inset") or 84),
            "captionMaxWidth": int(profile.get("caption_max_width") or 912),
            "captionLineMaxChars": int(profile.get("caption_line_max_chars") or 8),
        })
    return theme


def semantic_caption_plan(
    captions: list[dict[str, Any]],
    title: str = "",
    content_director: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Route captions, camera, transitions and audio through content nodes."""
    planned = [dict(item) for item in captions]
    route_by_node = {
        "hook": {"animation": "hook-slam", "caption": "hook-impact", "camera": "hook-push", "sfx": "hook", "transition": "soft-punch"},
        "pain_reversal": {"animation": "reversal-swap", "caption": "contrast-swap", "camera": "contrast-shift", "sfx": "reversal", "transition": "drift-left"},
        "core_viewpoint": {"animation": "conclusion-stamp", "caption": "viewpoint-stamp", "camera": "viewpoint-hold", "sfx": "conclusion", "transition": "soft-punch"},
        "number_benefit": {"animation": "number-count", "caption": "number-benefit", "camera": "benefit-push", "sfx": "number", "transition": "soft-flash"},
        "example_step": {"animation": "step-card", "caption": "step-card", "camera": "step-drift", "sfx": "step", "transition": "drift-right"},
        "brand_entity": {"animation": "brand-tag", "caption": "brand-nameplate", "camera": "brand-hold", "sfx": "brand", "transition": "none"},
        "cta": {"animation": "cta-push", "caption": "cta-action", "camera": "cta-push", "sfx": "cta", "transition": "soft-flash"},
        "supporting": {"animation": "steady", "caption": "supporting-clean", "camera": "supporting-breathe", "sfx": "none", "transition": "none"},
    }
    hard_node_count = 0
    maximum_hard_nodes = max(2, math.ceil(len(planned) * 0.52))
    for index, caption in enumerate(planned):
        text = re.sub(r"\s+", "", str(caption.get("text") or ""))
        is_final = index == len(planned) - 1
        if is_final and any(marker in text for marker in ("欢迎", "咨询", "预约", "点击", "联系", "了解", "开始", "留言", "关注")):
            node = "cta"
        elif index == 0 or any(marker in text for marker in ("你知道", "为什么", "千万", "别再", "很多人", "最重要", "想不想", "是不是")):
            node = "hook"
        elif any(marker in text for marker in ("但是", "不过", "其实", "相反", "没想到", "结果却", "真正", "而是", "不是", "痛点", "难", "不会", "不知道", "担心", "问题")):
            node = "pain_reversal"
        elif re.search(r"\d|\d+(?:\.\d+)?[%折元万+]|[一二三四五六七八九十百千万]+个|第[一二三四五六七八九十]", text) or any(marker in text for marker in ("省", "提升", "增长", "效率", "收益", "优惠", "免费", "实用", "帮你", "打扎实", "练熟", "竞争力")):
            node = "number_benefit"
        elif any(marker in text for marker in ("比如", "例如", "举个例子", "第一", "第二", "第三", "首先", "其次", "最后一步", "步骤", "怎么做", "如何")):
            node = "example_step"
        elif any(marker in text for marker in ("老师", "品牌", "公司", "门店", "产品", "钟智联", "我们是", "我是", "叫做", "型号", "AI课程")):
            node = "brand_entity"
        elif any(marker in text for marker in ("所以", "记住", "核心", "结论", "关键是", "这就是", "本质", "观点", "方法", "价值", "重点", "专业", "围绕", "会从")):
            node = "core_viewpoint"
        elif any(marker in text for marker in ("马上", "现在就", "欢迎", "点击", "咨询", "预约", "行动", "联系", "了解", "留言", "关注")):
            node = "cta"
        else:
            node = "supporting"
        effect_level = "normal"
        if node not in {"supporting", "brand_entity", "hook", "cta"}:
            previous_node = str(planned[index - 1].get("contentNode") or "") if index > 0 else ""
            if hard_node_count >= maximum_hard_nodes or previous_node not in {"", "supporting", "brand_entity"}:
                effect_level = "subtle"
            else:
                hard_node_count += 1
        route = dict(route_by_node[node])
        caption_style = select_caption_material(content_director, node, title, text, index, str(route["caption"]))
        route["caption"] = caption_style
        caption["contentNode"] = node
        caption["semanticRole"] = {
            "pain_reversal": "reversal", "core_viewpoint": "conclusion", "number_benefit": "number",
            "example_step": "step", "brand_entity": "brand", "supporting": "steady",
        }.get(node, node)
        caption["animation"] = route["animation"]
        caption["captionStyle"] = caption_style
        if effect_level == "subtle":
            route["sfx"] = "none"
            route["transition"] = "none"
        caption["effectLevel"] = effect_level
        caption["materialRoute"] = route
        caption["role"] = "focus" if node not in {"supporting", "brand_entity"} else "anchor"
        caption["keyword"] = str(caption.get("keyword") or kinetic_keyword(text))
    step_number = 0
    for caption in planned:
        if caption.get("contentNode") == "example_step" and caption.get("animation") == "step-card":
            step_number += 1
            caption["stepNumber"] = step_number
        else:
            caption.pop("stepNumber", None)
    return planned


def attach_word_timing(captions: list[dict[str, Any]], words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not words:
        return captions
    output: list[dict[str, Any]] = []
    for caption in captions:
        current = dict(caption)
        start = float(caption.get("start") or 0)
        end = float(caption.get("end") or start)
        matched = [dict(word) for word in words if float(word.get("end") or 0) > start and float(word.get("start") or 0) < end]
        if matched:
            current["words"] = matched
        output.append(current)
    return output


def kinetic_keyword(text: str) -> str:
    compact = re.sub(r"[\s，。！？；：、]", "", text)
    preferred = [
        "免费", "优惠", "技能", "培训", "岗位", "基础", "实用", "咨询",
        "开始", "老师", "钟智联", "会计", "电商", "外贸", "课程", "练熟",
    ]
    for candidate in preferred:
        if candidate in compact:
            return candidate
    if len(compact) <= 4:
        return compact
    length = 4 if len(compact) >= 10 else 3
    start = max(0, (len(compact) - length) // 2)
    return compact[start:start + length]


def ai_select_caption_highlights(
    captions: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], str]:
    """Select one grounded emphasis phrase for every confirmed caption beat.

    The selected phrase must come from the user's confirmed caption verbatim;
    each visual template decides whether it is rendered in yellow, burgundy or
    another accent. Generation remains available when the upstream model is
    unavailable, so a deterministic local selector is retained as fallback.
    """
    prepared = [dict(item) for item in captions]
    for item in prepared:
        item["keyword"] = kinetic_keyword(str(item.get("text") or ""))
    if not AI_API_KEY or not prepared:
        return prepared, "local-keyword"

    source = [
        {"id": index, "text": str(item.get("text") or "").strip()}
        for index, item in enumerate(prepared)
    ]
    prompt = f"""你是短视频字幕动态强调词策划。请针对每一段已由用户核对确认的口播字幕，选择一个最值得使用模板强调色和加粗动效的连续词组。
要求：
1. 每段必须单独判断，优先选择核心观点、利益点、动作词、数字结果、反差词或结论词。
2. keyword 必须是该段 text 中原样连续出现的文字，不能改写、补字或创造新词。
3. 每段只选一个，通常2到6个中文字；短句确有必要时可以1到8个字。
4. 不要选择“这个、那个、然后、就是、我们、大家”等无信息量词语。
5. id、数量和顺序必须与输入完全一致。
6. 只返回JSON：{{"items":[{{"id":0,"keyword":"原文中的词组"}}]}}。

已确认口播字幕：
{json.dumps(source, ensure_ascii=False)}"""
    request = urllib.request.Request(
        f"{AI_API_BASE_URL}/v1/chat/completions",
        data=json.dumps({
            "model": AI_TITLE_MODEL,
            "temperature": 0.15,
            "max_tokens": max(320, len(prepared) * 32),
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": "你只从已确认的原字幕中抽取每段的语义强调词，并严格输出JSON。"},
                {"role": "user", "content": prompt},
            ],
        }, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {AI_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            payload = json.loads(response.read().decode("utf-8"))
        raw = extract_provider_text(payload)
        cleaned = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        parsed = json.loads(cleaned)
        values = parsed.get("items") if isinstance(parsed, dict) else None
        if not isinstance(values, list) or len(values) != len(prepared):
            raise ValueError("标黄词数量不一致")
        for index, item in enumerate(prepared):
            value = values[index] if isinstance(values[index], dict) else {}
            if int(value.get("id", -1)) != index:
                raise ValueError("标黄词顺序不一致")
            text = re.sub(r"\s+", "", str(item.get("text") or ""))
            keyword = re.sub(r"[\s，。！？；：、,.!?;:]", "", str(value.get("keyword") or ""))
            if not keyword or len(keyword) > 8 or keyword not in text:
                raise ValueError("标黄词不在对应原文中")
            item["keyword"] = keyword
        return prepared, f"ai-highlight:{AI_TITLE_MODEL}"
    except (urllib.error.URLError, http.client.RemoteDisconnected, ConnectionError, TimeoutError, OSError, json.JSONDecodeError, ValueError, TypeError):
        return prepared, "local-keyword-fallback"


def build_remotion_timeline(
    folder: Path,
    source: Path,
    sfx_file: Path,
    duration: float,
    title: str,
    captions: list[dict[str, Any]],
    template_id: str,
    merchant: dict[str, Any],
    include_sfx: bool = True,
    include_bgm: bool = False,
    sfx_cues: list[dict[str, Any]] | None = None,
    transition_points: list[float] | None = None,
) -> Path:
    current_template = template_profile(template_id)
    usable_captions = [dict(item) for item in captions if str(item.get("text") or "").strip()]
    caption_mode = str(current_template.get("caption_mode") or "classic")
    if caption_mode in {"kinetic-red-white", "kinetic-yellow-white", "kinetic-mint-white", "kinetic-bold-yellow-white"} or bool(current_template.get("word_highlight")):
        for caption in usable_captions:
            text = str(caption.get("text") or "").strip()
            caption["keyword"] = str(caption.get("keyword") or kinetic_keyword(text))
    if template_id == "clean-green":
        for index, caption in enumerate(usable_captions):
            text = str(caption.get("text") or "").strip()
            caption["keyword"] = str(caption.get("keyword") or kinetic_keyword(text))
            is_anchor = index % 2 == 0
            caption["role"] = "anchor" if is_anchor else "focus"
            caption["layout"] = "center"
            caption["animation"] = "fade-rise" if is_anchor else "word-reveal"
            caption["sectionEmphasis"] = bool(index > 0 and index % 6 == 5)
            # The reference keeps the first bilingual group on screen while
            # the second group enters below it. Pairing cues reproduces that
            # two-row rhythm without random vertical layouts.
            next_caption = usable_captions[index + 1] if index + 1 < len(usable_captions) else None
            line_limit = int(current_template.get("caption_line_max_chars") or 8)
            can_pair = bool(
                is_anchor
                and next_caption
                and len(caption_plain_text(text)) <= line_limit
                and len(caption_plain_text(str(next_caption.get("text") or ""))) <= line_limit
            )
            if can_pair and next_caption:
                caption["displayEnd"] = round(
                    min(duration, max(float(caption.get("end") or 0.0), float(next_caption.get("end") or 0.0))),
                    3,
                )
    elif template_id == "high-red":
        for index, caption in enumerate(usable_captions):
            text = str(caption.get("text") or "").strip()
            caption["keyword"] = str(caption.get("keyword") or kinetic_keyword(text))
            is_anchor = index % 2 == 0
            caption["role"] = "anchor" if is_anchor else "focus"
            caption["layout"] = "stack-left" if is_anchor else "stack-right"
            caption["animation"] = "word-reveal" if is_anchor else "spark-emphasis"
            caption["sectionEmphasis"] = bool(index == 0 or index % 6 == 0)
            # The reference overlaps two short bilingual beats as one editorial
            # composition.  Keep the first beat visible while the second beat
            # enters at the opposite side instead of centring every subtitle.
            next_caption = usable_captions[index + 1] if index + 1 < len(usable_captions) else None
            line_limit = int(current_template.get("caption_line_max_chars") or 8)
            can_pair = bool(
                is_anchor
                and next_caption
                and len(caption_plain_text(text)) <= line_limit * 2
                and len(caption_plain_text(str(next_caption.get("text") or ""))) <= line_limit * 2
            )
            if can_pair and next_caption:
                caption["displayEnd"] = round(
                    min(duration, max(float(caption.get("end") or 0.0), float(next_caption.get("end") or 0.0))),
                    3,
                )
    elif template_id == "bold-yellow-white":
        for index, caption in enumerate(usable_captions):
            text = str(caption.get("text") or "").strip()
            caption["keyword"] = str(caption.get("keyword") or kinetic_keyword(text))
            caption["role"] = "focus" if index % 3 == 0 else "anchor"
            caption["layout"] = "impact"
            caption["animation"] = "impact"
            caption["sectionEmphasis"] = bool(index == 0 or index % 5 == 0)
    elif template_id in {"viral-pulse", "template-2", "template-3", "template-4", "template-5", "template-6", "template-7", "template-8"}:
        if not all(str(item.get("contentNode") or "").strip() for item in usable_captions):
            usable_captions = semantic_caption_plan(
                usable_captions,
                title,
                current_template.get("content_director"),
            )
    chapter_count = max(1, min(5, math.ceil(duration / 7))) if bool(current_template.get("enable_chapters")) else 0
    chapters: list[dict[str, Any]] = []
    for index in range(chapter_count):
        cue_index = min(len(usable_captions) - 1, round(index * max(0, len(usable_captions) - 1) / max(1, chapter_count - 1))) if usable_captions else 0
        cue = usable_captions[cue_index] if usable_captions else {"start": index * duration / chapter_count, "text": title}
        start = max(0.0, float(cue.get("start") or 0.0))
        chapters.append({
            "start": round(start, 3),
            "end": round(min(duration, start + 1.85), 3),
            "index": index + 1,
            "title": str(cue.get("text") or title).strip()[:14],
        })
    card_candidates = (
        [item for index, item in enumerate(usable_captions) if index > 0 and index % 3 == 0]
        if bool(current_template.get("enable_cards"))
        else []
    )
    cards = []
    for index, cue in enumerate(card_candidates[:3]):
        start = max(2.8, float(cue.get("start") or 0.0))
        cards.append({
            "start": round(start, 3),
            "end": round(min(duration, start + 2.15), 3),
            "type": ["quote", "metric", "list"][index % 3],
            "eyebrow": str(merchant.get("name") or "内容重点")[:12],
            "title": str(cue.get("text") or "").strip()[:18],
            "body": "来自原片真实口播内容",
        })
    camera_cues = []
    camera_motion = str(current_template.get("camera_motion") or "none")
    if template_id in {"viral-pulse", "template-2", "template-3", "template-4", "template-5", "template-6", "template-7", "template-8"}:
        rhythm_scales = [1.018, 1.028, 1.022, 1.032]
        for cue_index, caption in enumerate(usable_captions):
            node = str(caption.get("contentNode") or "supporting")
            scale = {
                "hook": 1.035, "pain_reversal": 1.04, "core_viewpoint": 1.042,
                "number_benefit": 1.048, "example_step": 1.038,
                "brand_entity": 1.025, "cta": 1.055,
            }.get(node, rhythm_scales[cue_index % len(rhythm_scales)])
            camera_cues.append({
                "start": round(max(0.0, float(caption.get("start") or 0.0)), 3),
                "end": round(min(duration, float(caption.get("end") or duration)), 3),
                "scale": scale,
                "origin": "50% 43%",
            })
    elif template_id == "clean-green" or camera_motion in {"subtle-punch", "rhythmic-punch"}:
        origins = ["50% 44%", "46% 42%", "54% 43%"]
        scales = [1.0, 1.055, 1.025, 1.07] if template_id == "clean-green" or camera_motion == "rhythmic-punch" else [1.0, 1.028, 1.012, 1.036]
        for pair_index, caption in enumerate(usable_captions[::2]):
            end_caption = usable_captions[min(pair_index * 2 + 1, len(usable_captions) - 1)]
            camera_cues.append({
                "start": round(max(0.0, float(caption.get("start") or 0.0)), 3),
                "end": round(min(duration, float(end_caption.get("end") or duration)), 3),
                "scale": scales[pair_index % len(scales)],
                "origin": origins[pair_index % len(origins)],
            })
    configured_transitions = current_template.get("transition_profile")
    if not isinstance(configured_transitions, list) or not configured_transitions:
        configured_transitions = [
            {"style": "soft-punch", "duration": 0.34, "intensity": 0.72},
            {"style": "drift-left", "duration": 0.28, "intensity": 0.58},
            {"style": "drift-right", "duration": 0.28, "intensity": 0.58},
            {"style": "soft-flash", "duration": 0.24, "intensity": 0.52},
        ]
    allowed_transition_styles = {
        "soft-punch", "drift-left", "drift-right", "soft-flash",
        "editorial-cut", "editorial-wipe",
    }
    transition_cues: list[dict[str, Any]] = []
    transition_rng = random.Random(f"{folder.name}:{title}:{duration:.3f}:transition-v14")
    transition_offset = transition_rng.randrange(len(configured_transitions))
    for index, point in enumerate(transition_points or []):
        nearby_caption = next((caption for caption in usable_captions if abs(float(caption.get("start") or 0) - float(point)) < .55), None)
        semantic_role = str((nearby_caption or {}).get("semanticRole") or "")
        content_node = str((nearby_caption or {}).get("contentNode") or "")
        role_matches = [
            item for item in configured_transitions
            if isinstance(item, dict)
            and (semantic_role in (item.get("roles") or []) or content_node in (item.get("nodes") or []))
        ]
        configured = role_matches[0] if role_matches else configured_transitions[(transition_offset + index) % len(configured_transitions)]
        configured = configured if isinstance(configured, dict) else {}
        style = str(configured.get("style") or "soft-punch")
        if style not in allowed_transition_styles:
            style = "soft-punch"
        transition_cues.append({
            "start": round(float(point), 3),
            "duration": round(max(.18, min(.48, float(configured.get("duration") or .32))), 3),
            "style": style,
            "intensity": round(max(.3, min(1.0, float(configured.get("intensity") or .7))), 3),
        })
    bgm_tracks = current_template.get("bgm_tracks")
    if not isinstance(bgm_tracks, list):
        bgm_tracks = []
    selected_bgm = None
    if include_bgm:
        selected_bgm = select_content_music(bgm_tracks, title, usable_captions, f"{folder.name}:{duration:.3f}")
    timeline = {
        "version": 2,
        "sourceFile": source.name,
        "sourceVolume": float(current_template.get("speech_gain") or 1.0),
        "bgmFile": str((selected_bgm or {}).get("file") or current_template.get("bgm_file") or "") if include_bgm else "",
        "bgmTrackId": str((selected_bgm or {}).get("id") or current_template.get("music_track_id") or "") if include_bgm else "",
        "bgmVolume": float((selected_bgm or {}).get("volume") or current_template.get("bgm_volume") or 0.05),
        # Use the mixed track assembled from the selected template sound pool.
        # This guarantees that effects reach the exported MP4 and also avoids
        # playing the same cue twice.
        "sfxFile": sfx_file.name if include_sfx and sfx_file.exists() else "",
        "sfxVolume": 0.9,
        "sfxCues": [],
        "duration": round(duration, 3),
        "fps": 30,
        "title": title,
        "merchantName": str(merchant.get("name") or "")[:24],
        "coverTime": float(current_template.get("cover_time_seconds") or 0.8),
        "captions": usable_captions,
        "cameraCues": camera_cues,
        "transitionCues": transition_cues,
        "chapters": chapters,
        "cards": cards,
        "theme": remotion_theme(template_id),
    }
    path = folder / "timeline.json"
    path.write_text(json.dumps(timeline, ensure_ascii=False, indent=2), "utf-8")
    return path


def render_with_remotion(timeline_file: Path, output: Path) -> None:
    run([
        check_binary("node"),
        str(REMOTION_WORKER_DIR / "scripts" / "render.mjs"),
        str(timeline_file),
        str(output),
    ])


def job_dir(job_id: str) -> Path:
    return DATA_DIR / job_id


def job_file(job_id: str) -> Path:
    return job_dir(job_id) / "job.json"


def read_job(job_id: str) -> dict[str, Any]:
    path = job_file(job_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="视频任务不存在。")
    return json.loads(path.read_text("utf-8"))


def write_job(job_id: str, **updates: Any) -> dict[str, Any]:
    path = job_file(job_id)
    current = json.loads(path.read_text("utf-8")) if path.exists() else {"id": job_id}
    current.update(updates, updated_at=int(time.time() * 1000))
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(current, ensure_ascii=False, indent=2), "utf-8")
    temporary.replace(path)
    return current


def media_url(job_id: str, name: str) -> str:
    return f"/media/{job_id}/{name}"


def require_template_admin(request: Request) -> None:
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=503, detail="服务器尚未配置模板学习管理密钥。")
    supplied = request.headers.get("x-video-worker-admin-token", "").strip()
    if supplied != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="模板学习管理密钥无效。")


def clamp_number(value: Any, minimum: float, maximum: float, fallback: float) -> float:
    try:
        return max(minimum, min(maximum, float(value)))
    except (TypeError, ValueError):
        return fallback


def ass_color_from_hex(value: Any, fallback: str) -> str:
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", str(value or "").strip())
    if not match:
        return fallback
    red, green, blue = match.group(1)[0:2], match.group(1)[2:4], match.group(1)[4:6]
    return f"&H00{blue}{green}{red}".upper()


def ai_learn_visual_template(package_dir: Path, analysis: dict[str, Any], template: dict[str, Any]) -> tuple[dict[str, Any], str]:
    frame_manifest_path = package_dir / "frame-analysis.json"
    if not AI_API_KEY or not frame_manifest_path.exists():
        raise RuntimeError("模板学习未连接多模态模型，不能生成真实视觉模板。")
    manifest = json.loads(frame_manifest_path.read_text("utf-8"))
    sheet_names = manifest.get("contact_sheets") if isinstance(manifest.get("contact_sheets"), list) else []
    sheet_paths = [package_dir / str(name) for name in sheet_names]
    sheet_paths = [path for path in sheet_paths if path.is_file()]
    if not sheet_paths:
        raise RuntimeError("逐帧分析没有生成视觉联络图，已停止保存，避免把默认模板误当作学习结果。")
    transcript = analysis.get("transcript") if isinstance(analysis.get("transcript"), dict) else {}
    transcript_text = "".join(str(item.get("text") or "") for item in transcript.get("segments") or [])
    prompt = f"""你是资深短视频包装导演和动态设计系统工程师。下面按时间顺序提供了覆盖参考视频全部解码帧的连续帧联络表，共 {len(sheet_paths)} 张。

你的任务不是给已有模板换颜色或换字体，而是从零规划一个具有独立视觉签名、可复用且能适配任意原片时长的新模板。
必须逐张、逐时间段比较并归纳：
1. 开场标题：出现时间、行数、对齐、画面安全区、字体气质、字号、行距、描边、阴影、色彩层级、入场/保持/退场动作。
2. 口播字幕：单句长度、单双行规则、左右留白、垂直位置、关键词选择与高亮方式、是否双语、逐字/整句/分组动画。
3. 版式组件：是否真的存在章节角标、信息卡片、贴纸或色块；参考视频没有的组件必须关闭，禁止凭空套用默认组件。
4. 镜头与转场：硬切、推近、漂移、闪白等出现条件、强度、最小间隔和每分钟上限。
5. 音效与音乐：开场、关键词、转场、结尾分别如何触发；只提炼规则，不复制固定时间点。
6. 输出一段 template_signature，清楚说明该模板与常见黄白双语模板的结构差异，不能只描述颜色和字体。

如果某个特征无法从画面确认，使用保守值并在 evidence_notes 中说明，不得套用默认“黄白双语”结构。

视频信息：{json.dumps(analysis.get('metadata') or {}, ensure_ascii=False)}
镜头变化：{json.dumps(analysis.get('scene_changes') or [], ensure_ascii=False)}
识别文案：{transcript_text[:5000]}

只返回 JSON：
{{
  "template_signature":"结构、节奏与视觉层级的独立说明",
  "design_family":"editorial|luxury|knowledge|promotion|lifestyle|bold-hook",
  "description":"模板说明",
  "title_effect":"标题效果说明",
  "subtitle_effect":"字幕效果说明",
  "caption_mode":"classic|kinetic-red-white|kinetic-yellow-white|kinetic-mint-white|kinetic-bold-yellow-white",
  "transition_key":"hard-cut-punch|fade|zoom|slide|preserve-source",
  "transition_label":"转场说明",
  "sfx_key":"soft|impact|click|bright",
  "sfx_label":"音效说明",
  "accent":"#RRGGBB",
  "primary":"#RRGGBB",
  "font_name":"Noto Sans CJK SC|Noto Serif CJK SC|Kaiti SC",
  "title_lines":1,
  "title_persistent":false,
  "title_animation":"fade-scale|staggered-punch",
  "title_size_ratio":0.08,
  "title_y_ratio":0.04,
  "title_line_gap_px":-4,
  "title_outline":3,
  "title_shadow":4,
  "subtitle_size_ratio":0.055,
  "subtitle_y_ratio":0.40,
  "subtitle_outline":3,
  "subtitle_shadow":3,
  "caption_safe_inset":72,
  "caption_max_width":936,
  "caption_line_max_chars":10,
  "keyword_color":"#RRGGBB",
  "bilingual":false,
  "caption_max_chars":10,
  "caption_max_seconds":2.4,
  "enable_chapters":false,
  "enable_cards":false,
  "camera_motion":"none|subtle-punch|rhythmic-punch",
  "rhythm_interval_seconds":3.2,
  "digital_punch_in":0.08,
  "maximum_effects_per_minute":12,
  "sfx_gain":0.18,
  "evidence_notes":["从哪些时间段观察到哪些规则"]
}}"""
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for sheet_path in sheet_paths:
        encoded = base64.b64encode(sheet_path.read_bytes()).decode("ascii")
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{encoded}", "detail": "high"}})
    request = urllib.request.Request(
        f"{AI_API_BASE_URL}/v1/chat/completions",
        data=json.dumps({
            "model": AI_TITLE_MODEL,
            "temperature": 0.1,
            "max_tokens": 2200,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": "你从覆盖全片的连续帧中提炼可复用的视频视觉模板，只输出JSON。"},
                {"role": "user", "content": content},
            ],
        }, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {AI_API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = json.loads(response.read().decode("utf-8"))
        raw = extract_provider_text(payload).strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        parsed = json.loads(raw)
        return (parsed if isinstance(parsed, dict) else {}), f"vision:{AI_TITLE_MODEL}"
    except (urllib.error.URLError, http.client.RemoteDisconnected, ConnectionError, TimeoutError, OSError, json.JSONDecodeError, ValueError, TypeError) as error:
        raise RuntimeError(f"多模态模板规划失败：{str(error).strip() or '返回内容无法解析'}") from error


def apply_learned_profile(template: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    opening = template.setdefault("opening", {})
    body = template.setdefault("body", {})
    style = template.setdefault("style", {})
    audio = template.setdefault("audio", {})
    opening["title_lines"] = 2 if int(profile.get("title_lines") or 1) == 2 else 1
    opening["title_mode"] = "persistent" if bool(profile.get("title_persistent")) else "opening"
    opening["title_animation"] = str(profile.get("title_animation") or "fade-scale")
    if opening["title_animation"] not in {"fade-scale", "staggered-punch"}:
        opening["title_animation"] = "fade-scale"
    style["font_name"] = str(profile.get("font_name") or style.get("font_name") or "Noto Sans CJK SC")
    if style["font_name"] not in {"Noto Sans CJK SC", "Noto Serif CJK SC", "Kaiti SC"}:
        style["font_name"] = "Noto Sans CJK SC"
    style["primary"] = ass_color_from_hex(profile.get("primary"), str(style.get("primary") or "&H00FFFFFF"))
    style["accent"] = ass_color_from_hex(profile.get("accent"), str(style.get("accent") or "&H003BCDF5"))
    style["title_size_ratio"] = clamp_number(profile.get("title_size_ratio"), 0.05, 0.16, float(style.get("title_size_ratio") or 0.078))
    style["title_y_ratio"] = clamp_number(profile.get("title_y_ratio"), 0.02, 0.35, float(style.get("title_y_ratio") or 0.034))
    style["subtitle_size_ratio"] = clamp_number(profile.get("subtitle_size_ratio"), 0.035, 0.11, float(style.get("subtitle_size_ratio") or 0.052))
    style["subtitle_y_ratio"] = clamp_number(profile.get("subtitle_y_ratio"), 0.10, 0.82, float(style.get("subtitle_y_ratio") or 0.40))
    style["title_line_gap_px"] = int(clamp_number(profile.get("title_line_gap_px"), -28, 24, -4))
    style["title_outline"] = clamp_number(profile.get("title_outline"), 0.0, 8.0, 3.0)
    style["title_shadow"] = clamp_number(profile.get("title_shadow"), 0.0, 14.0, 4.0)
    style["subtitle_outline"] = clamp_number(profile.get("subtitle_outline"), 0.0, 8.0, 3.0)
    style["subtitle_shadow"] = clamp_number(profile.get("subtitle_shadow"), 0.0, 14.0, 3.0)
    caption_mode = str(profile.get("caption_mode") or "classic")
    if caption_mode not in {"classic", "kinetic-red-white", "kinetic-yellow-white", "kinetic-mint-white", "kinetic-bold-yellow-white"}:
        caption_mode = "classic"
    style["caption_mode"] = caption_mode
    style["keyword_color"] = str(profile.get("keyword_color") or profile.get("accent") or "#f5cd3b")
    body["bilingual"] = bool(profile.get("bilingual"))
    body["caption_max_chars"] = int(clamp_number(profile.get("caption_max_chars"), 6, 16, float(body.get("caption_max_chars") or 10)))
    body["caption_max_seconds"] = clamp_number(profile.get("caption_max_seconds"), 1.2, 4.0, float(body.get("caption_max_seconds") or 2.8))
    body["caption_line_max_chars"] = int(clamp_number(profile.get("caption_line_max_chars"), 5, 16, float(body.get("caption_max_chars") or 10)))
    body["caption_safe_inset"] = int(clamp_number(profile.get("caption_safe_inset"), 48, 160, 72))
    body["caption_max_width"] = int(clamp_number(profile.get("caption_max_width"), 720, 984, 936))
    body["enable_chapters"] = bool(profile.get("enable_chapters"))
    body["enable_cards"] = bool(profile.get("enable_cards"))
    body["camera_motion"] = str(profile.get("camera_motion") or "none")
    body["rhythm_interval_seconds"] = clamp_number(profile.get("rhythm_interval_seconds"), 1.2, 8.0, float(body.get("rhythm_interval_seconds") or 3.2))
    body["digital_punch_in"] = clamp_number(profile.get("digital_punch_in"), 0.0, 0.22, 0.0)
    body["maximum_effects_per_minute"] = int(clamp_number(profile.get("maximum_effects_per_minute"), 0, 30, 12))
    transition = str(profile.get("transition_key") or "preserve-source")
    if transition not in {"hard-cut-punch", "fade", "zoom", "slide", "preserve-source"}:
        transition = "preserve-source"
    body["transition_style"] = transition
    body["transition_trigger"] = "scene-change-or-long-pause-or-cadence"
    audio["sfx_gain"] = clamp_number(profile.get("sfx_gain"), 0.05, 0.42, float(audio.get("sfx_gain") or 0.18))
    template["planning"] = {
        "template_signature": str(profile.get("template_signature") or "").strip(),
        "design_family": str(profile.get("design_family") or "").strip(),
        "evidence_notes": profile.get("evidence_notes") if isinstance(profile.get("evidence_notes"), list) else [],
        "source": "multimodal-frame-analysis",
    }
    return template


def process_template_learning_job(job_id: str) -> None:
    folder = job_dir(job_id)
    job = read_job(job_id)
    source = folder / str(job.get("source_name") or "source.mp4")
    package_dir = folder / "package"
    try:
        write_job(job_id, state="running", stage="decode", progress=8, message="正在解码并逐帧学习参考视频…")
        script = AUTHORING_SKILL_DIR / "scripts" / "distill_template.py"
        if not script.exists():
            raise RuntimeError("服务器缺少模板逐帧学习组件。")
        run([
            check_binary("python3"), str(script), "--input", str(source),
            "--id", str(job["template_id"]), "--name", str(job["template_name"]),
            "--output", str(package_dir), "--contact-columns", "10", "--contact-rows", "10",
        ])
        write_job(job_id, stage="visual", progress=62, message="逐帧分析完成，正在匹配标题、字幕、转场和色彩…")
        analysis = json.loads((package_dir / "analysis.json").read_text("utf-8"))
        template = json.loads((package_dir / "template.json").read_text("utf-8"))
        frame_info = analysis.get("frame_by_frame") if isinstance(analysis.get("frame_by_frame"), dict) else {}
        if int(frame_info.get("contact_sheet_count") or 0) < 1:
            raise RuntimeError("逐帧解码成功，但视觉联络图为 0，已停止生成，避免保存成换色版默认模板。")
        profile, learning_model = ai_learn_visual_template(package_dir, analysis, template)
        signature = str(profile.get("template_signature") or "").strip()
        if len(signature) < 18:
            raise RuntimeError("多模态模型没有给出独立模板结构说明，已停止保存，请重新学习。")
        template = apply_learned_profile(template, profile)
        template["reference_url"] = str(job.get("preview_url") or "")
        (package_dir / "template.json").write_text(json.dumps(template, ensure_ascii=False, indent=2) + "\n", "utf-8")
        metadata = analysis.get("metadata") if isinstance(analysis.get("metadata"), dict) else {}
        catalog = {
            "description": str(profile.get("description") or f"已逐帧分析 {frame_info.get('analyzed_frames', 0)} 帧，生成可适配不同时长原片的标题、字幕与转场规则。")[:260],
            "titleEffect": str(profile.get("title_effect") or "根据参考视频自动匹配标题布局")[:100],
            "subtitleEffect": str(profile.get("subtitle_effect") or "根据口播语义自动生成字幕")[:100],
            "transitionKey": str(profile.get("transition_key") or "preserve-source")[:40],
            "transitionLabel": str(profile.get("transition_label") or "按镜头变化与停顿触发")[:100],
            "sfxKey": str(profile.get("sfx_key") or "soft")[:40],
            "sfxLabel": str(profile.get("sfx_label") or "自动匹配轻提示音")[:100],
            "accent": str(profile.get("accent") or "#f5cd3b")[:20],
            "titleColor": str(profile.get("primary") or "#ffffff")[:20],
            "templateSignature": signature[:500],
            "designFamily": str(profile.get("design_family") or "")[:80],
            "visualPlan": profile,
            "learningMethod": "frame-by-frame-independent-plan-v11",
            "learningModel": learning_model,
            "validationStatus": "learning-complete-awaiting-regression",
            "packagePath": f"templates-v2/{job['template_id']}/template.json",
        }
        write_job(
            job_id, state="success", stage="complete", progress=100,
            message="模板学习完成，已生成草稿，等待两条原片回归测试。",
            template=template, catalog=catalog,
            analysis_summary={
                "duration": metadata.get("duration"), "width": metadata.get("width"), "height": metadata.get("height"),
                "analyzed_frames": frame_info.get("analyzed_frames"), "expected_frames": frame_info.get("expected_frames"),
                "contact_sheet_count": frame_info.get("contact_sheet_count"), "complete": frame_info.get("complete"),
            },
        )
    except Exception as error:
        write_job(job_id, state="failed", stage="failed", progress=100, message=str(error).strip() or "模板学习失败。", error=str(error).strip() or "模板学习失败。")


def probe_video(source: Path) -> dict[str, Any]:
    payload = json.loads(run([
        check_binary("ffprobe"),
        "-v", "error",
        "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration",
        "-of", "json",
        str(source),
    ]))
    streams = payload.get("streams") or []
    stream = next((item for item in streams if item.get("codec_type") == "video"), {})
    return {
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
        "frame_rate": str(stream.get("r_frame_rate") or ""),
        "duration": float((payload.get("format") or {}).get("duration") or 0),
        "has_audio": any(item.get("codec_type") == "audio" for item in streams),
    }


def extract_contentful_cover(
    source: Path,
    cover: Path,
    duration: float,
    preferred_time_seconds: float | None = None,
) -> None:
    """Create a useful cover from the opening instead of exporting frame zero.

    Encoders and template fade-ins often make the first decoded frame black.
    Seeking a small, duration-aware distance into the opening is deliberately
    filter-free so it behaves the same on the local and cloud ffmpeg builds.
    The selected image still feels like the video's first frame to users, while
    containing the opening subject, title and scene instead of encoder black.
    """
    ffmpeg = check_binary("ffmpeg")
    video_duration = max(0.0, float(duration or 0.0))
    automatic_seek = min(0.8, max(0.2, video_duration * 0.10))
    seek_seconds = automatic_seek if preferred_time_seconds is None else max(0.2, float(preferred_time_seconds))
    seek_seconds = min(seek_seconds, max(0.0, video_duration - 0.05))
    run([
        ffmpeg,
        "-y",
        "-ss", f"{seek_seconds:.3f}",
        "-i", str(source),
        "-frames:v", "1",
        "-q:v", "2",
        str(cover),
    ])


def ass_time(seconds: float) -> str:
    seconds = max(0, seconds)
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    remaining = seconds % 60
    return f"{hours}:{minutes:02d}:{remaining:05.2f}"


def ass_text(value: str) -> str:
    return value.replace("\\", "＼").replace("{", "（").replace("}", "）").replace("\n", "\\N")


def template_profile(template_id: str) -> dict[str, Any]:
    refresh_remote_template_registry()
    profile = {**DEFAULT_TEMPLATE_VALUES, **TEMPLATES.get(template_id, TEMPLATES["clean-green"])}
    package = TEMPLATE_PACKAGES.get(template_id)
    if not package:
        return profile
    opening = package.get("opening") if isinstance(package.get("opening"), dict) else {}
    body = package.get("body") if isinstance(package.get("body"), dict) else {}
    ending = package.get("ending") if isinstance(package.get("ending"), dict) else {}
    cover = package.get("cover") if isinstance(package.get("cover"), dict) else {}
    style = package.get("style") if isinstance(package.get("style"), dict) else {}
    audio = package.get("audio") if isinstance(package.get("audio"), dict) else {}
    music = audio.get("music") if isinstance(audio.get("music"), dict) else {}
    music_tracks = music.get("tracks") if isinstance(music.get("tracks"), list) else []
    package_values = {
        "package_mode": package.get("package_mode", "legacy-shared"),
        "renderer_key": package.get("renderer_key", "legacy-generic"),
        "fallback_policy": package.get("fallback_policy", "allow-legacy"),
        "name": package.get("name", profile["name"]),
        "reference_url": package.get("reference_url", profile.get("reference_url", "")),
        "font_name": style.get("font_name", profile["font_name"]),
        "primary": style.get("primary", profile["primary"]),
        "accent": style.get("accent", profile["accent"]),
        "outline": style.get("outline", profile["outline"]),
        "shadow": style.get("shadow", profile["shadow"]),
        "title_size_ratio": style.get("title_size_ratio", profile["title_size_ratio"]),
        "subtitle_size_ratio": style.get("subtitle_size_ratio", profile["subtitle_size_ratio"]),
        "title_margin_ratio": style.get("title_y_ratio", profile["title_margin_ratio"]),
        "subtitle_margin_ratio": style.get("subtitle_y_ratio", profile["subtitle_margin_ratio"]),
        "title_outline": style.get("title_outline", profile["title_outline"]),
        "subtitle_outline": style.get("subtitle_outline", profile["subtitle_outline"]),
        "title_shadow": style.get("title_shadow", profile["title_shadow"]),
        "subtitle_shadow": style.get("subtitle_shadow", profile["subtitle_shadow"]),
        "title_bold": style.get("title_bold", profile["title_bold"]),
        "subtitle_bold": style.get("subtitle_bold", profile["subtitle_bold"]),
        "title_spacing": style.get("title_spacing", profile["title_spacing"]),
        "subtitle_spacing": style.get("subtitle_spacing", profile["subtitle_spacing"]),
        "title_second_line_color": style.get("title_second_line_color", style.get("primary", profile["primary"])),
        "subtitle_english_size_ratio": style.get("subtitle_english_size_ratio", 0.03),
        "subtitle_english_color": style.get("subtitle_english_color", "&H00E8E8E8"),
        "title_animation": opening.get("title_animation", profile["title_animation"]),
        "subtitle_animation": style.get("subtitle_animation", profile["subtitle_animation"]),
        "caption_mode": style.get("caption_mode", profile.get("caption_mode", "classic")),
        "keyword_color": style.get("keyword_color", profile.get("keyword_color", "")),
        "title_line_gap_px": style.get("title_line_gap_px", profile.get("title_line_gap_px", -4)),
        "title_persistent": opening.get("title_mode") == "persistent",
        "title_duration_seconds": opening.get("max_seconds", profile.get("title_duration_seconds", 3.2)),
        "title_force_two_lines": int(opening.get("title_lines") or 1) == 2,
        "caption_max_chars": body.get("caption_max_chars", profile["caption_max_chars"]),
        "caption_line_max_chars": body.get("caption_line_max_chars", body.get("caption_max_chars", profile["caption_max_chars"])),
        "caption_safe_inset": body.get("caption_safe_inset", 72),
        "caption_max_width": body.get("caption_max_width", 936),
        "caption_min_chars": body.get("caption_min_chars", 4),
        "caption_max_seconds": body.get("caption_max_seconds", 2.8),
        "pause_split_seconds": body.get("pause_split_seconds", 0.42),
        "caption_word_timing": body.get("word_timing", False),
        "caption_bilingual": body.get("bilingual", False),
        "word_highlight": body.get("word_highlight", False),
        "transition": body.get("transition_style", "content-aware" if body.get("transition_trigger") else profile["transition"]),
        "transition_profile": body.get("transition_pool", []),
        "transition_trigger": body.get("transition_trigger", "fixed"),
        "rhythm_interval_seconds": body.get("rhythm_interval_seconds", 0.0),
        "minimum_transition_gap_seconds": body.get("minimum_transition_gap_seconds", 3.2),
        "scene_threshold": body.get("scene_threshold", 0.32),
        "digital_punch_in": body.get("digital_punch_in", 0.0),
        "maximum_effects_per_minute": body.get("maximum_effects_per_minute", 18),
        "enable_chapters": body.get("enable_chapters", False),
        "enable_cards": body.get("enable_cards", False),
        "camera_motion": body.get("camera_motion", "none"),
        "content_director": package.get("content_director", {}) if isinstance(package.get("content_director"), dict) else {},
        "ending_mode": ending.get("mode", "none"),
        "ending_seconds": ending.get("max_seconds", 0.0),
        "cover_mode": cover.get("mode", "first-usable-content-frame"),
        "cover_time_seconds": max(0.2, float(cover.get("preferred_time_seconds") or 0.8)),
        "cover_reject_black_frame": bool(cover.get("reject_black_frame", True)),
        "opening_sfx": opening.get("sfx", profile["opening_sfx"]),
        "sfx_gain": audio.get("sfx_gain", 0.14),
        "speech_gain": max(0.2, min(1.0, float(audio.get("speech_gain") or 1.0))),
        "sfx_profile": audio.get("sfx", {}) if isinstance(audio.get("sfx"), dict) else {},
        "bgm_file": music.get("file", "") if music.get("enabled", False) else "",
        "bgm_tracks": [
            {
                "id": str(item.get("id") or ""),
                "file": str(item.get("file") or ""),
                "weight": max(1, int(item.get("weight") or 1)),
                "volume": max(0.02, min(1.0, float(item.get("volume") or music.get("volume") or 0.05))),
                "moods": item.get("moods") if isinstance(item.get("moods"), list) else [],
                "dominant_nodes": item.get("dominant_nodes") if isinstance(item.get("dominant_nodes"), list) else [],
                "match_keywords": item.get("match_keywords") if isinstance(item.get("match_keywords"), list) else [],
            }
            for item in music_tracks
            if isinstance(item, dict) and str(item.get("file") or "").strip()
        ] if music.get("enabled", False) else [],
        "bgm_volume": music.get("volume", 0.05),
        "music_pool_id": music.get("pool_id", ""),
        "music_track_id": music.get("track_id", ""),
        "template_version": int(package.get("version") or 2),
        "package": package,
    }
    return {**profile, **package_values}


def split_title_lines(
    value: str,
    max_chars: int,
    force_two_lines: bool = False,
) -> list[str]:
    text = normalize_speech_text(value).strip("，。！？、,.!?;: ")
    if not text:
        return ["真实内容", "值得看见"]
    if speech_language(text) == "en":
        words = text.split()
        if len(words) <= 5 and not (force_two_lines and len(words) >= 4):
            return [text]
        target = max(2, math.ceil(len(words) / 2))
        return [" ".join(words[:target]), " ".join(words[target:])]
    text = text[:max_chars]
    if len(text) <= 9 and not (force_two_lines and len(text) >= 6):
        return [text]
    preferred_breaks = [match.end() for match in re.finditer(r"[，、：｜|]", text)]
    target = len(text) // 2
    split_at = min(preferred_breaks, key=lambda item: abs(item - target)) if preferred_breaks else target
    split_at = max(5, min(len(text) - 4, split_at))
    return [text[:split_at].strip("，、：｜|"), text[split_at:].strip("，、：｜|")]


def split_caption_segments(
    segments: list[dict[str, Any]],
    max_chars: int,
) -> list[dict[str, Any]]:
    return local_semantic_caption_segments(segments, 4, max_chars)


def word_timed_caption_segments(
    words: list[dict[str, Any]],
    max_chars: int,
    max_seconds: float,
    pause_split_seconds: float,
) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []

    def flush() -> None:
        nonlocal current
        if not current:
            return
        groups.append({
            "start": round(float(current[0]["start"]), 2),
            "end": round(max(float(current[-1]["end"]), float(current[0]["start"]) + 0.35), 2),
            "text": join_speech_parts(str(item["text"]) for item in current),
            "words": current,
        })
        current = []

    for raw in words:
        text = normalize_speech_text(str(raw.get("text") or ""))
        start = float(raw.get("start") or 0)
        end = max(start + 0.04, float(raw.get("end") or start + 0.04))
        if not text:
            continue
        word = {"start": round(start, 3), "end": round(end, 3), "text": text}
        if current:
            previous_end = float(current[-1]["end"])
            prospective_text = join_speech_parts([*(str(item["text"]) for item in current), text])
            prospective_duration = end - float(current[0]["start"])
            if (
                start - previous_end >= pause_split_seconds
                or caption_unit_count(prospective_text) > max_chars
                or prospective_duration > max_seconds
            ):
                flush()
        current.append(word)
        if re.search(r"[，。！？；：]$", text):
            flush()
    flush()
    return groups


def caption_plain_text(value: str) -> str:
    return re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", value).lower()


def speech_language(value: str) -> str:
    cjk_count = len(re.findall(r"[\u3400-\u9fff]", value))
    latin_words = re.findall(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*", value)
    return "en" if len(latin_words) * 2 > cjk_count else "zh"


def normalize_speech_text(value: str) -> str:
    text = str(value or "").strip()
    if speech_language(text) == "en":
        return re.sub(r"\s+", " ", text).strip()
    return re.sub(r"\s+", "", text).strip()


def caption_unit_count(value: str) -> int:
    if speech_language(value) == "en":
        return len(re.findall(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*", value))
    return len(caption_plain_text(value))


def join_speech_parts(parts: Any) -> str:
    values = [normalize_speech_text(str(part)) for part in parts if str(part).strip()]
    if not values:
        return ""
    return normalize_speech_text((" " if speech_language(" ".join(values)) == "en" else "").join(values))


def split_semantic_caption_text(
    value: str,
    min_chars: int,
    max_chars: int,
) -> list[str]:
    """Create readable caption beats without cutting ordinary phrases every N chars."""
    text = normalize_speech_text(value)
    if not text:
        return []
    if speech_language(text) == "en":
        clauses = [
            item.strip(" ,.!?;:—-")
            for item in re.split(r"(?<=[,.!?;:])\s+", text)
            if item.strip(" ,.!?;:—-")
        ] or [text.strip(" ,.!?;:—-")]
        beats: list[str] = []
        for clause in clauses:
            words = clause.split()
            while len(words) > max_chars:
                window = words[:max_chars]
                split_at = next((
                    index
                    for index in range(len(window) - 1, max(min_chars, 4) - 1, -1)
                    if window[index].lower() in {
                        "and", "but", "or", "because", "so", "while", "when",
                        "that", "which", "who", "if", "then", "also",
                    }
                ), max_chars)
                if split_at < min_chars:
                    split_at = max_chars
                beats.append(" ".join(words[:split_at]))
                words = words[split_at:]
            if words:
                tail = " ".join(words)
                if beats and len(words) < min_chars and caption_unit_count(beats[-1]) + len(words) <= max_chars + 2:
                    beats[-1] = f"{beats[-1]} {tail}"
                else:
                    beats.append(tail)
        return [item for item in beats if item]
    clauses = [
        item.strip("，,。！？!?；;：:、 ")
        for item in re.split(r"(?<=[，,。！？!?；;：:、])", text)
        if item.strip("，,。！？!?；;：:、 ")
    ]
    if not clauses:
        clauses = [text.strip("，,。！？!?；;：:、 ")]

    preferred_markers = (
        "不知道", "都可以", "帮你", "想学", "欢迎", "但是", "所以", "然后",
        "同时", "以及", "适合", "需要", "就是", "课程", "培训", "技能",
    )
    beats: list[str] = []
    for clause in clauses:
        remaining = clause
        while len(remaining) > max_chars:
            lower = max(min_chars, max_chars - 3)
            candidates: list[int] = []
            for marker in preferred_markers:
                cursor = remaining.find(marker, min_chars)
                while cursor > 0:
                    if lower <= cursor <= max_chars:
                        candidates.append(cursor)
                    after = cursor + len(marker)
                    if lower <= after <= max_chars:
                        candidates.append(after)
                    cursor = remaining.find(marker, cursor + 1)
            split_at = max(candidates) if candidates else max_chars
            beats.append(remaining[:split_at])
            remaining = remaining[split_at:]
        if remaining:
            if beats and len(remaining) < min_chars and len(beats[-1]) + len(remaining) <= max_chars + 2:
                beats[-1] += remaining
            else:
                beats.append(remaining)
    return [item for item in beats if item]


def timed_caption_beats(
    segments: list[dict[str, Any]],
    beats_by_segment: list[list[str]],
) -> list[dict[str, Any]]:
    timed: list[dict[str, Any]] = []
    for index, segment in enumerate(segments):
        beats = beats_by_segment[index] if index < len(beats_by_segment) else []
        if not beats:
            continue
        start = float(segment.get("start") or 0)
        end = max(start + 0.4, float(segment.get("end") or start + 0.4))
        weights = [max(1, caption_unit_count(item)) for item in beats]
        total_weight = max(1, sum(weights))
        cursor = start
        for beat_index, beat in enumerate(beats):
            remaining_duration = max(0.35, end - cursor)
            remaining_weight = max(1, sum(weights[beat_index:]))
            duration = remaining_duration * weights[beat_index] / remaining_weight
            beat_end = end if beat_index == len(beats) - 1 else min(end, cursor + max(0.45, duration))
            timed.append({
                "start": round(cursor, 2),
                "end": round(max(cursor + 0.35, beat_end), 2),
                "text": beat.strip("，,。！？!?；;：:、 "),
            })
            cursor = beat_end
    return [item for item in timed if item["text"]]


def merge_short_caption_beats(
    captions: list[dict[str, Any]],
    min_chars: int,
    max_chars: int,
    max_gap: float = 0.48,
) -> list[dict[str, Any]]:
    """Merge tiny adjacent beats even when Whisper split them into separate segments."""
    merged: list[dict[str, Any]] = []
    # Treat the template maximum as a real on-screen width constraint. A tiny
    # trailing beat may stay short, but must not be merged back into an
    # overlong caption that reaches the frame edges.
    soft_limit = max(max_chars, min_chars)
    for raw in captions:
        current = {**raw, "text": str(raw.get("text") or "").strip()}
        if not current["text"]:
            continue
        if not merged:
            merged.append(current)
            continue

        previous = merged[-1]
        previous_text = str(previous.get("text") or "").strip()
        current_text = current["text"]
        previous_chars = caption_unit_count(previous_text)
        current_chars = caption_unit_count(current_text)
        gap = float(current.get("start") or 0) - float(previous.get("end") or 0)
        can_join = (
            gap <= max_gap
            and (previous_chars < min_chars or current_chars < min_chars)
            and previous_chars + current_chars <= soft_limit
        )
        if not can_join:
            merged.append(current)
            continue

        enumeration = (
            current_chars <= 3
            and (previous_chars <= 3 or "、" in previous_text)
            and not previous_text.endswith(("的", "和", "与", "及"))
        )
        joiner = "、" if enumeration else ""
        previous["text"] = f"{previous_text}{joiner or (' ' if speech_language(previous_text + current_text) == 'en' else '')}{current_text}"
        previous["end"] = current.get("end", previous.get("end"))

    if len(merged) >= 2:
        first_chars = caption_unit_count(str(merged[0].get("text") or ""))
        second_chars = caption_unit_count(str(merged[1].get("text") or ""))
        first_gap = float(merged[1].get("start") or 0) - float(merged[0].get("end") or 0)
        if first_chars < min_chars and first_gap <= max_gap and first_chars + second_chars <= soft_limit:
            first = merged.pop(0)
            separator = " " if speech_language(f"{first['text']} {merged[0]['text']}") == "en" else ""
            merged[0]["text"] = f"{first['text']}{separator}{merged[0]['text']}"
            merged[0]["start"] = first.get("start", merged[0].get("start"))
    return merged


def local_semantic_caption_segments(
    segments: list[dict[str, Any]],
    min_chars: int,
    max_chars: int,
) -> list[dict[str, Any]]:
    beats = [
        split_semantic_caption_text(str(segment.get("text") or ""), min_chars, max_chars)
        for segment in segments
    ]
    return merge_short_caption_beats(
        timed_caption_beats(segments, beats),
        min_chars,
        max_chars,
    )


def merged_time_ranges(items: list[dict[str, Any]]) -> list[tuple[float, float]]:
    ranges = sorted(
        (
            float(item.get("start") or 0),
            max(float(item.get("start") or 0), float(item.get("end") or 0)),
        )
        for item in items
        if float(item.get("end") or 0) > float(item.get("start") or 0)
    )
    merged: list[tuple[float, float]] = []
    for start, end in ranges:
        if not merged or start > merged[-1][1] + 0.08:
            merged.append((start, end))
        else:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
    return merged


def caption_completeness_report(
    speech_segments: list[dict[str, Any]],
    captions: list[dict[str, Any]],
) -> dict[str, float]:
    """Measure whether captions preserve the transcript and cover voiced time."""
    speech_ranges = merged_time_ranges(speech_segments)
    caption_ranges = merged_time_ranges(captions)
    speech_seconds = sum(end - start for start, end in speech_ranges)
    covered_seconds = 0.0
    for speech_start, speech_end in speech_ranges:
        for caption_start, caption_end in caption_ranges:
            covered_seconds += max(
                0.0,
                min(speech_end, caption_end) - max(speech_start, caption_start),
            )
    source_text = caption_plain_text("".join(
        str(item.get("text") or "") for item in speech_segments
    ))
    caption_text = caption_plain_text("".join(
        str(item.get("text") or "") for item in captions
    ))
    source_chars = len(source_text)
    caption_chars = len(caption_text)
    text_similarity = SequenceMatcher(None, source_text, caption_text).ratio()
    return {
        "speech_seconds": round(speech_seconds, 3),
        "covered_seconds": round(min(speech_seconds, covered_seconds), 3),
        "time_coverage": round(covered_seconds / max(0.001, speech_seconds), 4),
        "source_chars": float(source_chars),
        "caption_chars": float(caption_chars),
        "text_coverage": round(caption_chars / max(1, source_chars), 4),
        "text_similarity": round(text_similarity, 4),
        "text_exact": 1.0 if source_text == caption_text else 0.0,
    }


def ai_video_visual_context(source: Path, duration: float, folder: Path) -> str:
    """Sample video frames and let the multimodal model extract grounded visual context."""
    if not AI_API_KEY or duration <= 0:
        return ""
    ffmpeg = check_binary("ffmpeg")
    frames: list[Path] = []
    for index, ratio in enumerate((0.12, 0.5, 0.86)):
        target = folder / f"context-{index}.jpg"
        try:
            run([
                ffmpeg, "-y", "-ss", f"{max(0.05, duration * ratio):.3f}",
                "-i", str(source), "-frames:v", "1", "-vf", "scale='min(960,iw)':-2",
                "-q:v", "4", str(target),
            ])
            if target.exists() and target.stat().st_size:
                frames.append(target)
        except Exception:
            continue
    if not frames:
        return ""
    content: list[dict[str, Any]] = [{
        "type": "text",
        "text": "请查看这些同一视频的关键帧，只提取画面中能明确核实的场景、品牌/机构名称、人物身份线索和可见文字。不要推测。只返回JSON：{\"visual_context\":\"简短说明\"}",
    }]
    for frame in frames:
        encoded = base64.b64encode(frame.read_bytes()).decode("ascii")
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{encoded}"},
        })
    request = urllib.request.Request(
        f"{AI_API_BASE_URL}/v1/chat/completions",
        data=json.dumps({
            "model": AI_TITLE_MODEL,
            "temperature": 0.05,
            "max_tokens": 320,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": "你只提取视频关键帧中可见且可核实的信息。"},
                {"role": "user", "content": content},
            ],
        }, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {AI_API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=55) as response:
            payload = json.loads(response.read().decode("utf-8"))
        raw = extract_provider_text(payload)
        cleaned = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        parsed = json.loads(cleaned)
        return str(parsed.get("visual_context") or "").strip()[:1200] if isinstance(parsed, dict) else ""
    except (urllib.error.URLError, http.client.RemoteDisconnected, ConnectionError, TimeoutError, OSError, json.JSONDecodeError, ValueError, TypeError):
        return ""


def tencent_flash_asr_enabled() -> bool:
    return bool(
        TENCENT_CLOUD_APP_ID
        and TENCENT_CLOUD_SECRET_ID
        and TENCENT_CLOUD_SECRET_KEY
    )


def merchant_asr_hotwords(merchant: dict[str, Any]) -> str:
    """Build a small, conservative temporary hotword list for store-specific terms."""
    values: list[str] = []
    for key in ("name", "miniappName", "storeDisplayName", "category"):
        value = str(merchant.get(key) or "").strip()
        if value:
            values.append(value)
    for key in ("serviceTags", "storeTags"):
        raw = merchant.get(key)
        if isinstance(raw, list):
            values.extend(str(item).strip() for item in raw if str(item).strip())
        elif isinstance(raw, str):
            values.extend(part.strip() for part in re.split(r"[,，、]", raw) if part.strip())
    unique: list[str] = []
    for value in values:
        compact = re.sub(r"\s+", "", value)[:30]
        if compact and compact not in unique:
            unique.append(compact)
    return ",".join(f"{value}|8" for value in unique[:24])


def normalize_tencent_flash_segments(payload: dict[str, Any]) -> list[dict[str, Any]]:
    results = payload.get("flash_result")
    if not isinstance(results, list) or not results:
        return []
    channel = next((item for item in results if isinstance(item, dict)), None)
    if not channel:
        return []
    sentences = channel.get("sentence_list")
    normalized: list[dict[str, Any]] = []
    if isinstance(sentences, list):
        for sentence in sentences:
            if not isinstance(sentence, dict):
                continue
            text = normalize_speech_text(str(sentence.get("text") or ""))
            try:
                start = max(0.0, float(sentence.get("start_time") or 0) / 1000)
                end = max(start + 0.04, float(sentence.get("end_time") or 0) / 1000)
            except (TypeError, ValueError):
                continue
            if not text:
                continue
            words: list[dict[str, Any]] = []
            raw_words = sentence.get("word_list")
            if isinstance(raw_words, list):
                for word in raw_words:
                    if not isinstance(word, dict):
                        continue
                    value = str(word.get("word") or "").strip()
                    try:
                        word_start = max(start, float(word.get("start_time") or 0) / 1000)
                        word_end = max(word_start + 0.02, float(word.get("end_time") or 0) / 1000)
                    except (TypeError, ValueError):
                        continue
                    if value:
                        words.append({
                            "start": round(word_start, 3),
                            "end": round(word_end, 3),
                            "text": value,
                        })
            item: dict[str, Any] = {
                "start": round(start, 3),
                "end": round(end, 3),
                "text": text,
            }
            if words:
                item["words"] = words
            normalized.append(item)
    if normalized:
        return normalized
    text = normalize_speech_text(str(channel.get("text") or ""))
    duration = max(0.1, float(payload.get("audio_duration") or 0) / 1000)
    return [{"start": 0.0, "end": round(duration, 3), "text": text}] if text else []


def tencent_flash_asr(
    audio: Path,
    merchant: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Synchronously transcribe a WAV file with Tencent Cloud Flash ASR."""
    if not tencent_flash_asr_enabled():
        raise RuntimeError("腾讯云极速语音识别尚未配置。")
    audio_bytes = audio.read_bytes()
    if not audio_bytes:
        raise RuntimeError("待识别的人声音轨为空。")
    params: dict[str, str] = {
        "convert_num_mode": "1",
        "engine_type": TENCENT_ASR_ENGINE_TYPE,
        "filter_dirty": "0",
        "filter_modal": "0",
        "filter_punc": "0",
        "first_channel_only": "1",
        "secretid": TENCENT_CLOUD_SECRET_ID,
        "speaker_diarization": "0",
        "timestamp": str(int(time.time())),
        "voice_format": "wav",
        "word_info": "3",
    }
    if TENCENT_ASR_ENGINE_TYPE in {"8k_zh", "16k_zh"}:
        params["sentence_max_length"] = "18"
    # Do not add merchant hotwords to the signed Flash ASR query. Tencent's
    # legacy Flash-ASR signature is calculated from the raw request path, and
    # non-ASCII temporary hotwords can be normalized/encoded differently by
    # the HTTP layer. That makes otherwise valid credentials fail with 4002.
    # Merchant vocabulary is still supplied to the downstream AI correction
    # pass, which is both safer and more accurate for store/brand names.
    hotwords = merchant_asr_hotwords(merchant)
    query = urllib.parse.urlencode(sorted(params.items()))
    path = f"/asr/flash/v1/{TENCENT_CLOUD_APP_ID}?{query}"
    sign_source = f"POSTasr.cloud.tencent.com{path}".encode("utf-8")
    signature = base64.b64encode(
        hmac.new(
            TENCENT_CLOUD_SECRET_KEY.encode("utf-8"),
            sign_source,
            hashlib.sha1,
        ).digest(),
    ).decode("ascii")
    request = urllib.request.Request(
        f"https://asr.cloud.tencent.com{path}",
        data=audio_bytes,
        headers={
            "Authorization": signature,
            "Content-Type": "application/octet-stream",
            "Content-Length": str(len(audio_bytes)),
            "Host": "asr.cloud.tencent.com",
        },
        method="POST",
    )
    last_error = ""
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=TENCENT_ASR_TIMEOUT_SECONDS) as response:
                payload = json.loads(response.read().decode("utf-8"))
            code = int(payload.get("code") or 0)
            if code:
                message = str(payload.get("message") or "未知错误")
                last_error = f"腾讯云极速语音识别失败（{code}）：{message}"
                if code in {5001, 5002, 5003} and attempt == 0:
                    time.sleep(0.6)
                    continue
                raise RuntimeError(last_error)
            segments = normalize_tencent_flash_segments(payload)
            if not segments:
                raise RuntimeError("腾讯云极速语音识别没有返回可编辑的口播时间轴。")
            return segments, {
                "request_id": str(payload.get("request_id") or ""),
                "audio_duration_ms": int(payload.get("audio_duration") or 0),
                "engine_type": TENCENT_ASR_ENGINE_TYPE,
                "merchant_hotwords_deferred_to_ai": bool(hotwords),
            }
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="ignore")[:600]
            last_error = f"腾讯云极速语音识别请求失败（{error.code}）：{detail or '上游未返回详情'}"
        except (urllib.error.URLError, http.client.RemoteDisconnected, ConnectionError, TimeoutError, OSError, json.JSONDecodeError) as error:
            last_error = f"腾讯云极速语音识别连接失败：{error}"
        if attempt == 0:
            time.sleep(0.6)
    raise RuntimeError(last_error or "腾讯云极速语音识别失败。")


def ai_correct_and_segment_captions(
    segments: list[dict[str, Any]],
    min_chars: int,
    max_chars: int,
    visual_context: str = "",
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    """Correct ASR homophones in full context, then split into natural caption beats."""
    fallback_captions = local_semantic_caption_segments(segments, min_chars, max_chars)
    if not AI_API_KEY or not segments:
        return segments, fallback_captions, "local-semantic"

    source = [
        {"id": index, "text": str(segment.get("text") or "").strip()}
        for index, segment in enumerate(segments)
    ]
    source_language = speech_language(" ".join(item["text"] for item in source))
    language_rules = (
        f"英文口播：必须保留英文单词之间的空格；每个 beat 优先 {min_chars} 到 {max_chars} 个完整英文单词；"
        "根据标点、停顿和语义从句拆分，绝不能从单词中间截断。"
        if source_language == "en"
        else f"中文口播：每个 beat 优先 {min_chars} 到 {max_chars} 个中文字；固定词组不得从中间拆开。"
    )
    prompt = f"""你是多语言口播字幕校对师。请结合全部上下文，校正语音识别错误，并把每段拆成自然、完整的字幕短句。
要求：
1. 只校正错别字、同音词、标点和明显漏字；不得改写观点，不得增加原口播没有的营销内容。
2. 品牌名、机构名、人物名要根据上下文前后一致；无法确认时保留原词。
3. 保持原口播语言。{language_rules}
4. 短句必须自然可读，禁止按字符数量硬切单词、词组或机构名。
5. 每个 beat 必须能单独顺畅朗读；不要让上一句停在“和、与、的、等”，也不要让下一句以这些连接词开头。
6. “办公和职场技能”“等实用技能培训”“都可以来钟智联了解”这类完整语义块不得从中间拆开。
7. 返回数组数量、id和输入完全一致。每项 text 是校正后的完整分段；beats 顺序拼接后必须与 text 内容一致（忽略标点）。
8. 只返回JSON：{{"segments":[{{"id":0,"text":"校正后的完整分段","beats":["自然短句1","自然短句2"]}}]}}。

画面中可核实的上下文（仅用于辅助判断品牌名、场景和屏幕文字，不得据此改写口播）：
{visual_context[:1200] or "未提供"}

语音识别分段：
{json.dumps(source, ensure_ascii=False)}"""
    request = urllib.request.Request(
        f"{AI_API_BASE_URL}/v1/chat/completions",
        data=json.dumps({
            "model": AI_TITLE_MODEL,
            "temperature": 0.05,
            "max_tokens": max(700, len(caption_plain_text(json.dumps(source, ensure_ascii=False))) * 5),
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": "你只校正真实口播字幕并进行自然语义分句，不创作新内容。"},
                {"role": "user", "content": prompt},
            ],
        }, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {AI_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=55) as response:
            payload = json.loads(response.read().decode("utf-8"))
        raw = extract_provider_text(payload)
        cleaned = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        parsed = json.loads(cleaned)
        values = parsed.get("segments") if isinstance(parsed, dict) else None
        if not isinstance(values, list) or len(values) != len(segments):
            raise ValueError("字幕校对结果数量不一致")

        corrected_segments: list[dict[str, Any]] = []
        beats_by_segment: list[list[str]] = []
        for index, original in enumerate(segments):
            item = values[index] if isinstance(values[index], dict) else {}
            if int(item.get("id", -1)) != index:
                raise ValueError("字幕校对结果顺序不一致")
            original_text = str(original.get("text") or "").strip()
            corrected_text = normalize_speech_text(str(item.get("text") or ""))
            original_plain = caption_plain_text(original_text)
            corrected_plain = caption_plain_text(corrected_text)
            similarity = SequenceMatcher(None, original_plain, corrected_plain).ratio()
            if not corrected_plain or similarity < 0.88 or not (0.86 <= len(corrected_plain) / max(1, len(original_plain)) <= 1.16):
                raise ValueError("字幕校对改写幅度过大")
            raw_beats = item.get("beats") if isinstance(item.get("beats"), list) else []
            beats = [normalize_speech_text(str(beat)).strip("，,。！？!?；;：:、 ") for beat in raw_beats]
            beats = [beat for beat in beats if beat]
            if caption_plain_text("".join(beats)) != corrected_plain:
                beats = split_semantic_caption_text(corrected_text, min_chars, max_chars)
            corrected_segments.append({**original, "text": corrected_text})
            beats_by_segment.append(beats)

        corrected_captions = merge_short_caption_beats(
            timed_caption_beats(corrected_segments, beats_by_segment),
            min_chars,
            max_chars,
        )
        if corrected_captions:
            return corrected_segments, corrected_captions, f"ai-corrected:{AI_TITLE_MODEL}"
    except (urllib.error.URLError, http.client.RemoteDisconnected, ConnectionError, TimeoutError, OSError, json.JSONDecodeError, ValueError, TypeError):
        pass
    return segments, fallback_captions, "local-semantic"


def highlighted_ass_text(value: str, primary: str, accent: str, keyword: str = "") -> str:
    if keyword and keyword in value:
        start = value.index(keyword)
        end = start + len(keyword)
        return (
            ass_text(value[:start])
            + f"{{\\c{accent}}}{ass_text(value[start:end])}{{\\c{primary}}}"
            + ass_text(value[end:])
        )
    output: list[str] = []
    cursor = 0
    for match in HIGHLIGHT_PATTERN.finditer(value):
        output.append(ass_text(value[cursor:match.start()]))
        output.append(f"{{\\c{accent}}}{ass_text(match.group(0))}{{\\c{primary}}}")
        cursor = match.end()
    output.append(ass_text(value[cursor:]))
    return "".join(output)


def karaoke_ass_text(segment: dict[str, Any], primary: str, accent: str) -> str:
    words = segment.get("words") if isinstance(segment.get("words"), list) else []
    if not words:
        return highlighted_ass_text(
            str(segment.get("text") or ""),
            primary,
            accent,
            str(segment.get("keyword") or ""),
        )
    output: list[str] = []
    for word in words:
        duration = max(4, round((float(word.get("end") or 0) - float(word.get("start") or 0)) * 100))
        output.append(f"{{\\2c{primary}\\1c{accent}\\kf{duration}}}{ass_text(str(word.get('text') or ''))}")
    return "".join(output)


def title_ass_text(value: str, template: dict[str, Any]) -> str:
    lines = split_title_lines(
        value,
        int(template["title_max_chars"]),
        bool(template.get("title_force_two_lines")),
    )
    if len(lines) == 1:
        return highlighted_ass_text(lines[0], template["primary"], template["accent"])
    first = highlighted_ass_text(lines[0], template["primary"], template["accent"])
    second_color = str(template.get("title_second_line_color") or template["accent"])
    second = highlighted_ass_text(lines[1], second_color, second_color)
    return f"{first}\\N{{\\c{second_color}}}{second}{{\\c{template['primary']}}}"


def animation_tags(
    kind: str,
    role: str,
    width: int,
    height: int,
    align: str,
    margin_top: int,
    margin_bottom: int,
) -> str:
    if role == "title":
        target_x = width // 2 if align == "center" else max(24, round(width * 0.055))
        target_y = margin_top
        slide_from_x = -round(width * 0.42) if align == "left" else width + round(width * 0.22)
        return {
            "soft": r"{\blur2.4\fscx90\fscy90\t(0,420,\blur0\fscx100\fscy100)\fad(220,180)}",
            "zoom": r"{\fscx58\fscy58\t(0,260,\fscx112\fscy112)\t(260,390,\fscx100\fscy100)\fad(30,120)}",
            "slide": f"{{\\move({slide_from_x},{target_y},{target_x},{target_y},0,380)\\fad(35,110)}}",
            "bounce": r"{\fscx55\fscy55\t(0,160,\fscx116\fscy116)\t(160,300,\fscx96\fscy96)\t(300,390,\fscx100\fscy100)\fad(20,90)}",
            "flash": r"{\blur2.2\fscx122\fscy122\t(0,150,\blur0\fscx100\fscy100)\fad(15,70)}",
            "pop": r"{\fscx62\fscy62\t(0,210,\fscx110\fscy110)\t(210,330,\fscx100\fscy100)\fad(35,110)}",
        }.get(kind, r"{\fad(90,120)}")
    target_x = width // 2
    target_y = height - margin_bottom
    return {
        "soft": r"{\blur1.5\fscx94\fscy94\t(0,220,\blur0\fscx100\fscy100)\fad(120,100)}",
        "pop": r"{\fscx72\fscy72\t(0,150,\fscx108\fscy108)\t(150,240,\fscx100\fscy100)\fad(35,65)}",
        "karaoke-pop": r"{\fscx82\fscy82\t(0,120,\fscx104\fscy104)\t(120,210,\fscx100\fscy100)\fad(25,55)}",
        "slide": f"{{\\move({width + round(width * 0.2)},{target_y},{target_x},{target_y},0,260)\\fad(25,65)}}",
        "flash": r"{\blur1.5\fscx116\fscy116\t(0,100,\blur0\fscx100\fscy100)\fad(15,50)}",
        "fade": r"{\fad(55,70)}",
    }.get(kind, r"{\fad(55,70)}")


def create_ass(
    path: Path,
    width: int,
    height: int,
    duration: float,
    title: str,
    segments: list[dict[str, Any]],
    template_id: str,
) -> None:
    template = template_profile(template_id)
    title_alignment = 8 if template["align"] == "center" else 7
    title_size = max(36, round(width * float(template["title_size_ratio"])))
    subtitle_size = max(28, round(width * float(template["subtitle_size_ratio"])))
    subtitle_english_size = max(18, round(width * float(template.get("subtitle_english_size_ratio") or 0.03)))
    margin = max(34, round(width * 0.055))
    title_margin = round(height * float(template["title_margin_ratio"]))
    subtitle_margin = round(height * float(template["subtitle_margin_ratio"]))
    boxed = bool(template["boxed"])
    title_border_style = 3 if boxed else 1
    subtitle_border_style = 3 if boxed else 1
    title_outline_colour = template["panel"] if boxed else template["outline"]
    subtitle_outline_colour = template["panel"] if boxed else template["outline"]
    title_back_colour = template["panel"] if boxed else template["shadow"]
    subtitle_back_colour = template["panel"] if boxed else template["shadow"]
    title_outline = float(template["box_padding"]) if boxed else float(template["title_outline"])
    subtitle_outline = float(template["box_padding"]) if boxed else float(template["subtitle_outline"])
    title_shadow = 0 if boxed else float(template["title_shadow"])
    subtitle_shadow = 0 if boxed else float(template["subtitle_shadow"])
    title_end = (
        max(1.8, duration - 0.08)
        if template["title_persistent"]
        else min(
            float(template.get("title_duration_seconds") or 3.2),
            max(1.8, duration - 0.08),
        )
    )
    compact_segments = (
        segments
        if any(isinstance(item.get("words"), list) and item.get("words") for item in segments)
        else split_caption_segments(segments, int(template["caption_max_chars"]))
    )
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,{template["font_name"]},{title_size},{template["primary"]},{template["primary"]},{title_outline_colour},{title_back_colour},{-1 if template["title_bold"] else 0},{-1 if template["title_italic"] else 0},0,0,100,100,{template["title_spacing"]},0,{title_border_style},{title_outline},{title_shadow},{title_alignment},{margin},{margin},{title_margin},1
Style: Subtitle,{template["font_name"]},{subtitle_size},{template["primary"]},{template["primary"]},{subtitle_outline_colour},{subtitle_back_colour},{-1 if template["subtitle_bold"] else 0},{-1 if template["subtitle_italic"] else 0},0,0,100,100,{template["subtitle_spacing"]},0,{subtitle_border_style},{subtitle_outline},{subtitle_shadow},2,{margin},{margin},{subtitle_margin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = [
        f"Dialogue: 1,{ass_time(0.08)},{ass_time(title_end)},Title,,0,0,0,,"
        f"{animation_tags(str(template['title_animation']), 'title', width, height, str(template['align']), title_margin, subtitle_margin)}"
        f"{title_ass_text(title, template)}"
    ]
    for segment in compact_segments:
        chinese_text = (
            karaoke_ass_text(segment, template["primary"], template["accent"])
            if template.get("word_highlight")
            else highlighted_ass_text(
                str(segment["text"]),
                template["primary"],
                template["accent"],
                str(segment.get("keyword") or ""),
            )
        )
        translation = str(segment.get("translation") or "").strip()
        bilingual_text = chinese_text
        if translation and template.get("caption_bilingual"):
            bilingual_text += (
                f"\\N{{\\fs{subtitle_english_size}\\c{template.get('subtitle_english_color', '&H00E8E8E8')}"
                f"\\bord1.4\\shad0}}{ass_text(translation)}"
            )
        events.append(
            f"Dialogue: 0,{ass_time(float(segment['start']))},{ass_time(float(segment['end']))},Subtitle,,0,0,0,,"
            f"{animation_tags(str(template['subtitle_animation']), 'subtitle', width, height, str(template['align']), title_margin, subtitle_margin)}"
            f"{bilingual_text}"
        )
    path.write_text(header + "\n".join(events) + "\n", "utf-8")


def derive_title(segments: list[dict[str, Any]], fallback: str) -> str:
    candidate = normalize_speech_text(fallback).strip("，,。！？!? ")
    generic_markers = ("真实体验", "一键网感", "值得看见")
    # Never truncate a caller-provided sentence into a title. A previous title
    # such as “AI现在已经不是新鲜话题而是很多岗位” looked plausible but was only
    # the first half of the speaker's conclusion.
    if (
        candidate
        and title_is_valid(candidate)
        and not any(marker in candidate for marker in generic_markers)
    ):
        return candidate
    if speech_language(" ".join(str(item.get("text") or "") for item in segments)) == "en":
        for item in segments:
            clause = normalize_speech_text(str(item.get("text") or "")).strip(" ,.!?;:")
            if title_is_valid(clause):
                return clause
        return "Key Insights from the Speaker"
    text = "，".join(str(item["text"]).strip("，。！？ ") for item in segments[:5])
    clauses = [
        re.sub(r"^(大家好|哈喽大家好|今天给大家|今天带大家|今天我们来|接下来)[，。！ ]*", "", item.strip())
        for item in re.split(r"[，。！？；]", text)
    ]
    informative = [
        item
        for item in clauses
        if len(item) >= 2
        and not re.match(r"^(大家好|哈喽|我是|我叫|欢迎大家|感谢大家)", item)
    ]
    complete_clause = next(
        (
            item
            for item in informative
            if 6 <= len(item) <= 16 and title_is_complete(item)
        ),
        "",
    )
    if complete_clause:
        return complete_clause
    return "完整口播内容解析中"


def extract_provider_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return "".join(filter(None, (extract_provider_text(item) for item in value))).strip()
    if not isinstance(value, dict):
        return ""
    for key in (
        "output_text", "text", "value", "content", "parts", "message",
        "choices", "candidates", "output",
    ):
        result = extract_provider_text(value.get(key))
        if result:
            return result
    return ""


def clean_provider_json(value: str) -> dict[str, Any]:
    cleaned = value.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("多模态模型没有返回可用的结构化口播文案。")
        parsed = json.loads(cleaned[start:end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("多模态模型返回的数据格式无效。")
    return parsed


def normalize_video_ai_segments(
    value: Any,
    duration: float,
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    normalized: list[dict[str, Any]] = []
    cursor = 0.0
    for raw in value[:180]:
        if not isinstance(raw, dict):
            continue
        text = normalize_speech_text(str(raw.get("text") or "")).strip("，,。！？!?；;：:、 ")
        if not text:
            continue
        start = max(cursor, min(duration, float(raw.get("start") or cursor)))
        end = max(start + 0.08, min(duration, float(raw.get("end") or start + 1.2)))
        if start >= duration or end <= start:
            continue
        normalized.append({
            "start": round(start, 2),
            "end": round(end, 2),
            "text": text[:80],
        })
        cursor = end
    return normalized


def ai_transcribe_video_url(
    source_url: str,
    duration: float,
    merchant: dict[str, Any],
    profile: dict[str, Any],
) -> tuple[str, list[dict[str, Any]], str]:
    """Read one public video directly with the fast multimodal model.

    This is the primary path for the interactive transcript review screen.  It
    intentionally asks for title and timed speech beats in one request so a
    30-second clip does not wait for ASR, frame extraction and two additional
    language-model calls in series.
    """
    if not AI_API_KEY or not AI_VIDEO_MODEL or not source_url.startswith(("http://", "https://")):
        raise RuntimeError("视频多模态识别通道尚未配置。")
    min_chars = int(profile.get("caption_min_chars") or 4)
    max_chars = int(profile.get("caption_max_chars") or 15)
    merchant_context = {
        key: value
        for key, value in merchant.items()
        if key in {
            "name", "miniappName", "storeDisplayName", "category",
            "address", "serviceTags", "storeTags", "positioning",
        }
    }
    prompt = f"""你是中文短视频口播识别与校对专家。请完整读取视频中的人声和关键画面，一次完成标题提炼与逐段口播时间轴。
要求：
1. 识别全部有效口播，不总结、不删减、不增加原片没有说过的内容。
2. 结合整段上下文和画面校正同音错字、品牌名、机构名、数字和明显漏字；无法确认时忠实保留听到的内容。
3. segments 是适合视频字幕列表的口播短句，不是长段落。优先按真实停顿、语义短语和句意划分，一般每条 {min_chars} 到 {max_chars} 个中文字、持续约0.6到3.5秒；问候语可更短。
4. start/end 使用秒，必须对应真实说话时间，递增、不重叠、不超过视频时长 {duration:.2f} 秒。
5. title 必须理解完整视频后生成，8到15个中文字，准确概括核心议题或结论，不能机械截取第一句，不能在“不是、而是、因为、所以”等半句话处结束。
6. 只返回JSON，不要Markdown：{{"title":"完整标题","summary":"一句识别说明","segments":[{{"start":0.0,"end":2.2,"text":"口播短句"}}]}}。

商家资料仅用于校对专有名词，不得据此改写口播：
{json.dumps(merchant_context, ensure_ascii=False)}"""
    request = urllib.request.Request(
        f"{AI_API_BASE_URL}/v1beta/models/{AI_VIDEO_MODEL}:generateContent",
        data=json.dumps({
            "contents": [{
                "role": "user",
                "parts": [
                    {"fileData": {"mimeType": "video/mp4", "fileUri": source_url}},
                    {"text": prompt},
                ],
            }],
            "generationConfig": {
                "temperature": 0.05,
                "responseMimeType": "application/json",
                "maxOutputTokens": 4096,
            },
        }, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {AI_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        # The upstream multimodal service may spend more than 100 seconds
        # downloading and analysing a merchant-uploaded video.  Keep the
        # request alive long enough for short production clips to finish,
        # while the transcription job remains asynchronous for the UI.
        with urllib.request.urlopen(request, timeout=240) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="ignore")[:800]
        raise RuntimeError(f"视频多模态识别失败（{error.code}）：{detail or '上游未返回详情'}") from error
    except (urllib.error.URLError, http.client.RemoteDisconnected, ConnectionError, TimeoutError, OSError) as error:
        raise RuntimeError(f"视频多模态识别连接失败：{error}") from error
    parsed = clean_provider_json(extract_provider_text(payload))
    segments = normalize_video_ai_segments(parsed.get("segments"), duration)
    if not segments:
        raise RuntimeError("多模态模型没有识别到可编辑的口播时间轴。")
    transcript = "。".join(str(item["text"]) for item in segments)
    fallback_title = derive_title(segments, "")
    candidate = re.sub(r"[《》“”\"'‘’：:。！？!?，,；;、*#\s]+", "", str(parsed.get("title") or ""))
    title = candidate if 6 <= len(candidate) <= 16 and title_is_complete(candidate) else fallback_title
    summary = str(parsed.get("summary") or "多模态大模型已读取原片并整理口播。")[:300]
    return title, segments, summary


def title_is_grounded(title: str, transcript: str) -> bool:
    """Reject attractive but unrelated titles hallucinated by the title model."""
    ignored = set("的一了是在和与及为把对就都而也很更最这那我你他她它们个种次让用做说看讲聊来去")
    title_chars = {
        char.lower()
        for char in title
        if ("\u4e00" <= char <= "\u9fff" or char.isalnum()) and char not in ignored
    }
    transcript_chars = {
        char.lower()
        for char in transcript
        if ("\u4e00" <= char <= "\u9fff" or char.isalnum()) and char not in ignored
    }
    if not title_chars or not transcript_chars:
        return False
    overlap = title_chars & transcript_chars
    required = max(2, math.ceil(len(title_chars) * 0.22))
    return len(overlap) >= required


def title_is_complete(title: str) -> bool:
    """Reject truncated hooks and sentence fragments that cannot stand alone."""
    compact = normalize_speech_text(title)
    if not compact:
        return False
    if speech_language(compact) == "en":
        return not bool(re.search(
            r"\b(?:and|or|but|because|so|the|a|an|to|of|for|with|that|which)$",
            compact,
            re.IGNORECASE,
        ))
    incomplete_endings = (
        "不是", "而是", "但是", "因为", "所以", "以及", "还有", "对于", "关于",
        "已经", "正在", "很多岗位", "这个问题", "这件事情", "这件事",
    )
    if compact.endswith(incomplete_endings):
        return False
    # “不是……而是……” is only useful when the conclusion after “而是” is
    # present and meaningful. This prevents hooks such as
    # “AI已经不是新鲜话题而是很多岗位”.
    if "不是" in compact:
        if "而是" not in compact:
            return False
        conclusion = compact.rsplit("而是", 1)[-1]
        if len(conclusion) < 4:
            return False
    return True


def title_is_valid(title: str) -> bool:
    normalized = normalize_speech_text(title).strip("，,。！？!?；;：:、 ")
    if not title_is_complete(normalized):
        return False
    if speech_language(normalized) == "en":
        return 3 <= caption_unit_count(normalized) <= 12
    return 6 <= len(normalized) <= 16


def ai_title_from_transcript(
    transcript: str,
    fallback: str,
    template: dict[str, Any],
    visual_context: str = "",
) -> tuple[str, str]:
    compact_transcript = re.sub(r"\s+", "", transcript).strip()
    if not AI_API_KEY or len(compact_transcript) < 6:
        return fallback, "local-transcript"
    prompt = f"""你是资深多语言短视频标题策划。请先完整理解全部口播，再提炼核心议题、目标受众和最终结论，生成适合短视频开场的标题。
要求：
1. 必须依据整段口播的核心结论，不得直接截取第一句或拼接若干原句，不得根据商家名称或画面虚构内容。
2. 标题保持原口播语言。中文每个候选8到15字；英文每个候选3到12个完整单词并保留单词空格。必须语义完整、可以独立阅读。
3. 优先使用“明确对象 + 关键变化/利益/结论”的结构；避免空泛的“你知道吗、一定要看”。
4. 严禁输出在“不是、而是、因为、所以、以及、很多岗位、现在已经”等位置戛然而止的半句话。
5. 不要书名号、引号、句号、感叹号、冒号、Markdown或解释。
6. 已选视觉模板：{template.get("name", "网感模板")}，只影响语气，不改变事实。

关键帧中可核实的画面信息（仅用于识别人物、场景、机构和标题用词，不得脱离口播虚构内容）：
{visual_context[:1200] or "未提供"}

口播文案：
{compact_transcript[:3200]}

请给出3个不同角度的候选，并选择其中语义最完整、最准确的一条。
只返回JSON：{{"candidates":["候选1","候选2","候选3"],"selected":"最终标题"}}"""
    request = urllib.request.Request(
        f"{AI_API_BASE_URL}/v1/chat/completions",
        data=json.dumps({
            "model": AI_TITLE_MODEL,
            "temperature": 0.25,
            "max_tokens": 260,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": "你只依据完整口播总结语义完整、短而准确的短视频标题，绝不截断句子。"},
                {"role": "user", "content": prompt},
            ],
        }, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {AI_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            payload = json.loads(response.read().decode("utf-8"))
        raw = extract_provider_text(payload)
        cleaned = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        try:
            parsed = json.loads(cleaned)
            selected = str(parsed.get("selected") or parsed.get("title") or "")
            candidates = parsed.get("candidates") if isinstance(parsed.get("candidates"), list) else []
            values = [selected, *(str(item) for item in candidates)]
        except (json.JSONDecodeError, AttributeError):
            match = re.search(r'"(?:selected|title)"\s*:\s*"([^"]+)"', cleaned)
            values = [match.group(1) if match else cleaned]
        for value in values:
            title = normalize_speech_text(re.sub(r"[《》“”\"'‘’*#]+", "", value)).strip("，,。！？!?；;、: ")
            if (
                title_is_valid(title)
                and title_is_grounded(title, compact_transcript)
            ):
                return title, f"ai:{AI_TITLE_MODEL}"
    except (urllib.error.URLError, http.client.RemoteDisconnected, ConnectionError, TimeoutError, OSError, json.JSONDecodeError, ValueError):
        pass
    return fallback, "local-transcript"


def ai_translate_caption_segments(segments: list[dict[str, Any]]) -> list[str]:
    """Translate short Chinese caption beats without changing their timing or meaning."""
    if not AI_API_KEY or not segments:
        return ["" for _ in segments]
    source = [str(item.get("text") or "").strip() for item in segments]
    if speech_language(" ".join(source)) == "en":
        return ["" for _ in segments]
    prompt = f"""把下面的中文短视频字幕逐条翻译成简短自然的英文字幕。
要求：
1. 必须与输入逐条对应，数量完全一致。
2. 每条尽量控制在1到6个英文单词，适合放在中文字幕下方。
3. 只翻译原文，不补充商家、行业或营销信息。
4. 只返回JSON：{{"translations":["..."]}}。

中文字幕：
{json.dumps(source, ensure_ascii=False)}"""
    request = urllib.request.Request(
        f"{AI_API_BASE_URL}/v1/chat/completions",
        data=json.dumps({
            "model": AI_TITLE_MODEL,
            "temperature": 0.1,
            "max_tokens": max(240, len(source) * 20),
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": "你只做逐条对应的中英字幕翻译。"},
                {"role": "user", "content": prompt},
            ],
        }, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {AI_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            payload = json.loads(response.read().decode("utf-8"))
        raw = extract_provider_text(payload)
        cleaned = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        parsed = json.loads(cleaned)
        values = parsed.get("translations") if isinstance(parsed, dict) else None
        if isinstance(values, list) and len(values) == len(source):
            return [re.sub(r"\s+", " ", str(value)).strip()[:64] for value in values]
    except (urllib.error.URLError, http.client.RemoteDisconnected, ConnectionError, TimeoutError, OSError, json.JSONDecodeError, ValueError):
        pass
    return ["" for _ in segments]


def merchant_fallback_caption(job: dict[str, Any]) -> str:
    merchant = job.get("merchant") if isinstance(job.get("merchant"), dict) else {}
    service_tags = merchant.get("serviceTags") if isinstance(merchant.get("serviceTags"), list) else []
    candidates = [
        merchant.get("positioning"),
        " · ".join(str(item).strip() for item in service_tags[:3] if str(item).strip()),
        merchant.get("storeDisplayName"),
        merchant.get("name"),
        job.get("title"),
    ]
    return next((str(item).strip() for item in candidates if str(item or "").strip()), "真实门店体验，值得到店感受")[:36]


def create_opening_sfx(path: Path, kind: str) -> None:
    frequency = {
        "soft": 680,
        "bright": 980,
        "click": 520,
        "impact": 180,
        "wood": 360,
    }.get(kind, 680)
    run([
        check_binary("ffmpeg"),
        "-y",
        "-f", "lavfi",
        "-i", f"sine=frequency={frequency}:sample_rate=44100:duration=0.22",
        "-af", "volume=0.045,afade=t=in:st=0:d=0.025,afade=t=out:st=0.08:d=0.14",
        "-c:a", "pcm_s16le",
        str(path),
    ])


def build_adaptive_sfx_cues(
    folder: Path,
    template: dict[str, Any],
    duration: float,
    captions: list[dict[str, Any]],
    transition_points: list[float],
    title: str,
) -> list[dict[str, Any]]:
    """Build a restrained, content-aware effect track from a template pool."""
    if isinstance(template.get("content_director"), dict):
        return build_semantic_sfx_cues(
            folder,
            template,
            duration,
            captions,
            transition_points,
            title,
            keyword_selector=kinetic_keyword,
        )

    # Preserve the original four templates' established sound routing.
    configured = template.get("sfx_profile") if isinstance(template.get("sfx_profile"), dict) else {}
    pools = {
        "opening": configured.get("opening_pool") or [
            "sfx/maximize_003.ogg",
            "sfx/open_002.ogg",
        ],
        "accent": configured.get("accent_pool") or [
            "sfx/tick_001.ogg",
            "sfx/select_001.ogg",
        ],
        "transition": configured.get("transition_pool") or [
            "sfx/open_002.ogg",
            "sfx/maximize_003.ogg",
            "sfx/select_001.ogg",
        ],
        "ending": configured.get("ending_pool") or [
            "sfx/confirmation_001.ogg",
        ],
    }
    seed = f"{folder.name}:{template.get('name', '')}:{title}:{duration:.3f}"
    rng = random.Random(seed)
    minimum_gap = max(1.8, float(configured.get("minimum_gap_seconds") or 3.0))
    hits_per_minute = max(4.0, float(configured.get("maximum_hits_per_minute") or 10.0))
    maximum_hits = max(2, min(10, math.ceil(duration / 60 * hits_per_minute)))
    cues: list[dict[str, Any]] = []
    last_file = ""
    role_offsets = {
        role: rng.randrange(len([item for item in values if str(item).strip()]))
        if [item for item in values if str(item).strip()] else 0
        for role, values in pools.items()
    }
    role_counts = {role: 0 for role in pools}
    level_map = configured.get("level_map") if isinstance(configured.get("level_map"), dict) else {}

    playback_rates = {
        "opening": [0.92, 1.0],
        "accent": [0.96, 1.08, 1.14],
        "transition": [0.88, 1.0, 1.12],
        "ending": [0.98, 1.08],
    }

    def add_cue(start: float, role: str, base_volume: float) -> None:
        nonlocal last_file
        choices = [str(item) for item in pools[role] if str(item).strip()]
        if not choices:
            return
        # Cycle through every sound in the role pool before reusing one. The
        # seed only changes the starting position, so each video feels fresh
        # while opening/accent/transition/ending keep a stable sound identity.
        offset = role_offsets.get(role, 0)
        count = role_counts.get(role, 0)
        ordered = choices[offset:] + choices[:offset]
        file = ordered[count % len(ordered)]
        if file == last_file and len(ordered) > 1:
            file = ordered[(count + 1) % len(ordered)]
        role_counts[role] = count + 1
        last_file = file
        rates = playback_rates.get(role, [1.0])
        calibrated_volume = level_map.get(file)
        cue_volume = (
            float(calibrated_volume) * rng.uniform(0.96, 1.04)
            if calibrated_volume is not None
            else base_volume * rng.uniform(0.88, 1.08)
        )
        cues.append({
            "start": round(max(0.0, min(duration - 0.05, start)), 3),
            "file": file,
            "volume": round(max(0.08, min(8.0, cue_volume)), 3),
            "playbackRate": round(rates[count % len(rates)], 2),
            "role": role,
            "label": {
                "opening": "开场提示",
                "accent": "关键词轻点",
                "transition": "镜头切换",
                "ending": "结尾确认",
            }.get(role, "节奏提示"),
        })

    add_cue(0.08, "opening", 0.34)
    transition_set = {round(float(value), 2) for value in transition_points}
    candidates: list[tuple[float, str]] = [(float(value), "transition") for value in transition_points]
    for index, caption in enumerate(captions):
        start = float(caption.get("start") or 0.0)
        text = str(caption.get("text") or "")
        # Accent only a few meaningful phrases, never every subtitle.
        if index > 0 and (kinetic_keyword(text) in text or index % 3 == 0):
            role = "transition" if round(start, 2) in transition_set else "accent"
            candidates.append((start, role))
    last_start = 0.08
    for start, role in sorted(candidates, key=lambda item: item[0]):
        if len(cues) >= max(1, maximum_hits - 1):
            break
        if start < 1.2 or start > duration - 1.2 or start - last_start < minimum_gap:
            continue
        add_cue(start, role, 0.19 if role == "accent" else 0.25)
        last_start = start
    if duration >= 5 and len(cues) < maximum_hits and duration - last_start >= minimum_gap * 0.7:
        add_cue(max(0.0, duration - 0.72), "ending", 0.30)
    return cues


def create_timeline_sfx(path: Path, kind: str, duration: float, cues: list[dict[str, Any]]) -> None:
    # Build one reliable effect track from the real template sound pool. A
    # single mixed WAV prevents short Chromium audio sequences from being
    # dropped during Remotion rendering.
    asset_root = (REMOTION_WORKER_DIR / "public").resolve()
    usable_cues: list[tuple[dict[str, Any], Path]] = []
    for cue in cues:
        relative = str(cue.get("file") or "").strip().lstrip("/")
        candidate = (asset_root / relative).resolve()
        if relative and candidate.is_file() and str(candidate).startswith(f"{asset_root}{os.sep}"):
            usable_cues.append((cue, candidate))
    if usable_cues:
        command = [
            check_binary("ffmpeg"), "-y",
            "-f", "lavfi", "-t", f"{max(0.25, duration):.3f}",
            "-i", "anullsrc=r=44100:cl=stereo",
        ]
        for _, source in usable_cues:
            command.extend(["-i", str(source)])
        filters = ["[0:a]volume=0[base]"]
        labels = ["[base]"]
        for index, (cue, _) in enumerate(usable_cues, start=1):
            delay = max(0, round(float(cue.get("start") or 0.0) * 1000))
            volume = max(0.08, min(8.0, float(cue.get("volume") or 0.24)))
            rate = max(0.5, min(2.0, float(cue.get("playbackRate") or 1.0)))
            label = f"cue{index}"
            filters.append(
                f"[{index}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                f"atempo={rate:.3f},volume={volume:.3f},adelay={delay}|{delay}[{label}]"
            )
            labels.append(f"[{label}]")
        filters.append(
            "".join(labels)
            + f"amix=inputs={len(labels)}:duration=longest:normalize=0,"
            + f"atrim=0:{max(0.25, duration):.3f},apad=pad_dur={max(0.25, duration):.3f}[mixed]"
        )
        command.extend([
            "-filter_complex", ";".join(filters),
            "-map", "[mixed]", "-c:a", "pcm_s16le", str(path),
        ])
        try:
            run(command)
            if path.exists() and path.stat().st_size > 128:
                return
        except RuntimeError:
            # Future templates may reference an unsupported file; keep the
            # deterministic synthesized track below as a safe fallback.
            pass

    sample_rate = 44100
    frequencies = {
        "soft": (148.0, 0.34),
        "bright": (920.0, 0.24),
        "click": (540.0, 0.12),
        "impact": (105.0, 0.30),
        "wood": (310.0, 0.16),
    }
    frequency, cue_duration = frequencies.get(kind, frequencies["soft"])
    cue_samples = max(1, round(cue_duration * sample_rate))
    total_samples = max(1, round(max(0.25, duration) * sample_rate))
    cue_indexes = [
        (
            max(0, min(total_samples - 1, round(float(cue.get("start") or 0.0) * sample_rate))),
            str(cue.get("role") or "accent"),
            float(cue.get("playbackRate") or 1.0),
        )
        for cue in cues
    ]
    frames = bytearray(total_samples * 4)
    noise = random.Random(f"{path.parent.name}:{kind}:{duration:.3f}")
    for cue_index, (start, role, playback_rate) in enumerate(cue_indexes):
        role_multiplier = {
            "opening": 1.0,
            "accent": 1.34,
            "transition": 0.82,
            "ending": 1.56,
        }.get(role, 1.0)
        local_frequency = frequency * role_multiplier * playback_rate
        pan = -0.34 if cue_index % 2 else 0.34
        for offset in range(min(cue_samples, total_samples - start)):
            phase = offset / sample_rate
            progress = offset / cue_samples
            attack = min(1.0, progress / 0.075)
            envelope = attack * (1 - progress) ** 2.2
            thump_gain = 0.23 if role == "opening" else 0.14 if role == "accent" else 0.18
            chime_gain = 0.075 if role == "ending" else 0.035
            thump = math.sin(2 * math.pi * local_frequency * phase) * envelope * thump_gain
            chime = math.sin(2 * math.pi * (720 + cue_index % 4 * 105) * phase) * envelope * chime_gain
            whoosh_envelope = math.sin(math.pi * progress) ** 1.7
            whoosh_gain = 0.065 if role == "transition" else 0.018
            whoosh = (noise.random() * 2 - 1) * whoosh_envelope * whoosh_gain
            sample = thump + chime + whoosh
            left = sample * (1 - pan * 0.55)
            right = sample * (1 + pan * 0.55)
            index = (start + offset) * 4
            existing_left, existing_right = struct.unpack_from("<hh", frames, index)
            mixed_left = max(-32767, min(32767, existing_left + round(left * 32767)))
            mixed_right = max(-32767, min(32767, existing_right + round(right * 32767)))
            struct.pack_into("<hh", frames, index, mixed_left, mixed_right)
    with wave.open(str(path), "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(2)
        target.setframerate(sample_rate)
        target.writeframes(frames)


def template_scene_filter(
    template_id: str,
    width: int,
    height: int,
    segment_index: int,
) -> str:
    color_filters = {
        "clean-green": "eq=contrast=1.04:saturation=1.04",
        "soft-white": "eq=brightness=0.025:contrast=0.97:saturation=0.90",
        "warm-gold": "eq=brightness=0.005:contrast=1.02:saturation=0.96:gamma_b=1.015",
        "brand-card": "eq=contrast=1.06:saturation=1.10,colorbalance=gs=0.025",
        "bold-yellow": "eq=contrast=1.13:saturation=1.18",
        "classic-blue": "eq=contrast=1.05:saturation=0.95,colorbalance=bs=0.055",
        "warm-brown": "eq=brightness=-0.01:contrast=1.06:saturation=1.05,colorbalance=rs=0.045:bs=-0.035",
        "high-red": "eq=contrast=1.14:saturation=1.16,colorbalance=rs=0.035",
        "bold-yellow-white": "eq=contrast=1.07:saturation=1.04:brightness=0.005",
    }
    filters = [color_filters.get(template_id, color_filters["clean-green"])]
    configured_zoom = float(template_profile(template_id).get("digital_punch_in") or 0.0)
    zoom_strength = configured_zoom or {
        "clean-green": 0.012,
        "soft-white": 0.018,
        "warm-gold": 0.012,
        "brand-card": 0.022,
        "bold-yellow": 0.028,
        "classic-blue": 0.018,
        "warm-brown": 0.032,
        "high-red": 0.030,
        "bold-yellow-white": 0.026,
    }.get(template_id, 0.018)
    factor = 1 + (zoom_strength if segment_index % 2 else zoom_strength * 0.18)
    scaled_width = max(width + 2, round(width * factor / 2) * 2)
    scaled_height = max(height + 2, round(height * factor / 2) * 2)
    x_offset = max(0, (scaled_width - width) // 2)
    y_offset = max(0, (scaled_height - height) // 2)
    filters.append(
        f"scale={scaled_width}:{scaled_height}:flags=lanczos,"
        f"crop={width}:{height}:{x_offset}:{y_offset}"
    )
    if template_id == "bold-yellow":
        filters.append(r"drawbox=x=0:y=0:w=iw:h=ih:color=white@0.16:t=fill:enable='lt(mod(t\,3.2)\,0.11)'")
    elif template_id == "high-red":
        filters.append(r"drawbox=x=0:y=0:w=iw:h=ih:color=0xDDE8FF@0.13:t=fill:enable='lt(mod(t\,3.2)\,0.10)'")
    elif template_id == "bold-yellow-white":
        filters.append(r"drawbox=x=0:y=0:w=iw:h=ih:color=white@0.08:t=fill:enable='lt(mod(t\,3.6)\,0.07)'")
    return ",".join(filters)


def detect_scene_changes(
    source: Path,
    duration: float,
    threshold: float,
    minimum_gap: float,
) -> list[float]:
    completed = subprocess.run([
        check_binary("ffmpeg"), "-hide_banner", "-i", str(source),
        "-vf", f"select='gt(scene,{max(0.05, min(0.9, threshold))})',showinfo",
        "-an", "-f", "null", "-",
    ], capture_output=True, text=True, check=False)
    candidates = [float(value) for value in re.findall(r"pts_time:([0-9.]+)", completed.stderr or "")]
    selected: list[float] = []
    for value in candidates:
        if value < 0.8 or value > duration - 0.8:
            continue
        if not selected or value - selected[-1] >= minimum_gap:
            selected.append(round(value, 3))
    return selected


def render_dimensions(metadata: dict[str, Any], template: dict[str, Any]) -> tuple[int, int]:
    package = template.get("package") if isinstance(template.get("package"), dict) else {}
    canvas = package.get("canvas") if isinstance(package.get("canvas"), dict) else {}
    target_width = int(canvas.get("width") or metadata["width"])
    target_height = int(canvas.get("height") or metadata["height"])
    maximum_upscale = max(1.0, float(canvas.get("maximum_upscale") or 2.0))
    source_width = max(2, int(metadata["width"]))
    allowed_width = source_width * maximum_upscale
    standard_widths = [540, 720, 1080]
    width = max((item for item in standard_widths if item <= min(target_width, allowed_width)), default=min(target_width, source_width))
    width = max(2, int(width) // 2 * 2)
    ratio = target_height / max(1, target_width)
    height = max(2, round(width * ratio) // 2 * 2)
    return width, height


def form_boolean(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def normalized_edited_captions(value: Any, duration: float) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    captions: list[dict[str, Any]] = []
    for item in value[:240]:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        try:
            start = max(0.0, float(item.get("start") or 0.0))
            end = min(duration, float(item.get("end") or 0.0))
        except (TypeError, ValueError):
            continue
        if not text or end <= start:
            continue
        captions.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "text": text[:180],
        })
    return sorted(captions, key=lambda item: (float(item["start"]), float(item["end"])))


def build_template_video_graph(
    metadata: dict[str, Any],
    template_id: str,
    escaped_ass: str,
    cut_points: list[float] | None = None,
    output_size: tuple[int, int] | None = None,
) -> str:
    width, height = output_size or (int(metadata["width"]), int(metadata["height"]))
    duration = float(metadata["duration"])
    template = template_profile(template_id)
    transition_duration = max(0.16, min(0.55, float(template["transition_duration"])))
    normalize = f"fps=30,scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,crop={width}:{height},setsar=1,format=yuv420p,settb=AVTB"
    if cut_points is None:
        cadence = 3.2
        cut_points = [
            round(index * cadence, 3)
            for index in range(1, int(duration // cadence) + 1)
            if index * cadence < duration - max(0.9, transition_duration + 0.3)
        ]
    transitions = {
        "preserve-source": "fade",
        "content-aware": "fade",
        "soft-fade": "fade",
        "focus-zoom": "smoothleft",
        "card-slide": "slideleft",
        "rhythm-flash": "fadefast",
        "blue-slide": "wipeleft",
        "warm-push": "dissolve",
        "high-energy-flash": "fadeblack",
    }
    transition = transitions.get(str(template["transition"]), "fade")
    ending_filter = ""
    if template.get("ending_mode") == "soft-fade" and duration > 1.2:
        ending_seconds = max(0.25, min(1.2, float(template.get("ending_seconds") or 0.7)))
        ending_filter = f",fade=t=out:st={max(0.0, duration - ending_seconds):.3f}:d={ending_seconds:.3f}"
    if str(template["transition"]) == "preserve-source":
        return (
            f"[0:v]{normalize},"
            f"ass='{escaped_ass}'{ending_filter}[vout]"
        )
    if not cut_points:
        scene_filter = template_scene_filter(template_id, width, height, 0)
        return (
            f"[0:v]{normalize},{scene_filter},"
            f"fade=t=in:st=0:d={transition_duration:.3f},ass='{escaped_ass}'{ending_filter}[vout]"
        )

    if str(template["transition"]) == "hard-cut-punch":
        segment_count = len(cut_points) + 1
        split_outputs = "".join(f"[vin{index}]" for index in range(segment_count))
        graph_parts = [f"[0:v]{normalize},split={segment_count}{split_outputs}"]
        starts = [0.0, *cut_points]
        ends = [*cut_points, duration]
        for index, (start, end) in enumerate(zip(starts, ends)):
            scene_filter = template_scene_filter(template_id, width, height, index)
            graph_parts.append(
                f"[vin{index}]trim=start={start:.3f}:end={end:.3f},"
                f"setpts=PTS-STARTPTS,{scene_filter},setsar=1,settb=AVTB[scene{index}]"
            )
        concat_inputs = "".join(f"[scene{index}]" for index in range(segment_count))
        graph_parts.append(f"{concat_inputs}concat=n={segment_count}:v=1:a=0[cutmix]")
        graph_parts.append(f"[cutmix]ass='{escaped_ass}'{ending_filter}[vout]")
        return ";".join(graph_parts)

    segment_count = len(cut_points) + 1
    split_outputs = "".join(f"[vin{index}]" for index in range(segment_count))
    graph_parts = [f"[0:v]{normalize},split={segment_count}{split_outputs}"]
    starts = [0.0, *cut_points]
    ends = [*[
        min(duration, cut + transition_duration)
        for cut in cut_points
    ], duration]
    for index, (start, end) in enumerate(zip(starts, ends)):
        scene_filter = template_scene_filter(template_id, width, height, index)
        graph_parts.append(
            f"[vin{index}]trim=start={start:.3f}:end={end:.3f},"
            f"setpts=PTS-STARTPTS,{scene_filter},setsar=1,settb=AVTB[scene{index}]"
        )
    current_label = "scene0"
    for index, offset in enumerate(cut_points, start=1):
        output_label = f"mix{index}"
        graph_parts.append(
            f"[{current_label}][scene{index}]xfade=transition={transition}:"
            f"duration={transition_duration:.3f}:offset={offset:.3f}[{output_label}]"
        )
        current_label = output_label
    graph_parts.append(f"[{current_label}]ass='{escaped_ass}'{ending_filter}[vout]")
    return ";".join(graph_parts)


def process_job(job_id: str) -> None:
    folder = job_dir(job_id)
    job = read_job(job_id)
    source = folder / job["source_name"]
    audio = folder / "speech.wav"
    cover = folder / "cover.jpg"
    subtitle_file = folder / "captions.ass"
    sfx_file = folder / "opening.wav"
    output = folder / "output.mp4"
    try:
        write_job(job_id, state="running", stage="probe", progress=4, message="正在读取原片信息…")
        metadata = probe_video(source)
        if metadata["duration"] <= 0 or metadata["width"] <= 0 or metadata["height"] <= 0:
            raise RuntimeError("没有读取到有效的视频信息。")

        ffmpeg = check_binary("ffmpeg")
        write_job(job_id, stage="extract", progress=12, message="正在提取声音与首帧…", metadata=metadata)
        if metadata["has_audio"]:
            run([ffmpeg, "-y", "-i", str(source), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(audio)])
        current_template = template_profile(str(job.get("template_id") or "clean-green"))
        extract_contentful_cover(
            source,
            cover,
            metadata["duration"],
            float(current_template.get("cover_time_seconds") or 0.8),
        )
        edited_captions = normalized_edited_captions(job.get("edited_captions"), metadata["duration"])
        info: Any = None
        words: list[dict[str, Any]] = []
        if edited_captions:
            write_job(job_id, stage="transcribe", progress=24, message="正在读取已校对的口播文案与时间轴…")
            segments = [{**item} for item in edited_captions]
            caption_segments = local_semantic_caption_segments(
                edited_captions,
                int(current_template.get("caption_min_chars") or 4),
                int(current_template["caption_max_chars"]),
            )
            caption_source = "user-edited:width-safe-segmentation"
            analysis_mode = "user_edited"
        else:
            write_job(job_id, stage="transcribe", progress=24, message="正在识别原片文案与字幕时间轴…")
            if not metadata["has_audio"]:
                raise RuntimeError("原片没有可识别的人声音轨，请先上传带口播的视频。")
            if not tencent_flash_asr_enabled():
                raise RuntimeError("腾讯云极速语音识别尚未配置，请联系管理员完成服务端配置。")
            merchant = job.get("merchant") if isinstance(job.get("merchant"), dict) else {}
            segments, asr_metadata = tencent_flash_asr(audio, merchant)
            for segment in segments:
                raw_words = segment.get("words")
                if isinstance(raw_words, list):
                    words.extend(dict(word) for word in raw_words if isinstance(word, dict))
            analysis_mode = "tencent_flash_asr"
            write_job(job_id, stage="script", progress=34, message="口播识别完成，正在用大模型校正错字并按语义重新断句…")
            segments, caption_segments, caption_source = ai_correct_and_segment_captions(
                segments,
                int(current_template.get("caption_min_chars") or 4),
                int(current_template["caption_max_chars"]),
            )
            caption_source = f"tencent-flash:{caption_source}"
        asr_segments = [{**segment} for segment in segments]
        caption_completeness = caption_completeness_report(asr_segments, caption_segments)
        if (
            caption_completeness["time_coverage"] < 0.92
            or caption_completeness["text_coverage"] < 0.90
            or caption_completeness["text_similarity"] < 0.94
        ):
            segments = asr_segments
            caption_segments = local_semantic_caption_segments(
                asr_segments,
                int(current_template.get("caption_min_chars") or 4),
                int(current_template["caption_max_chars"]),
            )
            caption_source = "local-semantic:completeness-fallback"
            caption_completeness = caption_completeness_report(asr_segments, caption_segments)
        if (
            caption_completeness["time_coverage"] < 0.92
            or caption_completeness["text_coverage"] < 0.90
            or caption_completeness["text_similarity"] < 0.94
        ):
            raise RuntimeError(
                "字幕完整性检查未通过，已停止生成，避免输出漏句成片。"
            )
        caption_segments = attach_word_timing(caption_segments, words)
        # Confirmed caption beats are the user's source of truth. Keeping their
        # boundaries in the title prompt makes the model understand the whole
        # argument instead of copying or truncating the opening sentence.
        transcript = "。".join(str(item["text"]).strip() for item in caption_segments)
        confirmed_title = normalize_speech_text(str(job.get("title") or "")).strip("，,。！？!? ")
        if title_is_valid(confirmed_title):
            title = confirmed_title
            title_source = "user-confirmed"
        else:
            fallback_title = derive_title(caption_segments, confirmed_title)
            title, title_source = ai_title_from_transcript(
                transcript,
                fallback_title,
                current_template,
            )
        if current_template.get("caption_bilingual"):
            write_job(job_id, stage="translate", progress=44, message="正在生成中英双语字幕，接口异常时会自动使用中文字幕继续…")
            translations = ai_translate_caption_segments(caption_segments)
            for segment, translation in zip(caption_segments, translations):
                segment["translation"] = translation
        highlight_source = "not-required"
        if str(job.get("template_id") or "clean-green") in {"clean-green", "high-red"}:
            highlight_template_name = "高级红" if str(job.get("template_id") or "") == "high-red" else "轻奢白"
            write_job(job_id, stage="highlight", progress=48, message=f"AI 正在逐段规划{highlight_template_name}字幕的语义重点词…")
            caption_segments, highlight_source = ai_select_caption_highlights(caption_segments)
        template_id = str(job.get("template_id") or "clean-green")
        if template_id in {"viral-pulse", "template-2", "template-3", "template-4", "template-5", "template-6", "template-7", "template-8"}:
            caption_segments = semantic_caption_plan(
                caption_segments,
                title,
                current_template.get("content_director"),
            )
        output_size = render_dimensions(metadata, current_template)
        scene_changes = detect_scene_changes(
            source,
            metadata["duration"],
            float(current_template.get("scene_threshold") or 0.32),
            float(current_template.get("minimum_transition_gap_seconds") or 3.0),
        ) if current_template.get("transition_trigger") != "fixed" else []
        pause_candidates = [
            float(caption_segments[index]["start"])
            for index in range(1, len(caption_segments))
            if float(caption_segments[index]["start"]) - float(caption_segments[index - 1]["end"])
            >= max(0.6, float(current_template.get("pause_split_seconds") or 0.42))
        ]
        rhythm_interval = float(current_template.get("rhythm_interval_seconds") or 0.0)
        rhythm_candidates = (
            [
                round(index * rhythm_interval, 3)
                for index in range(1, int(metadata["duration"] // rhythm_interval) + 1)
                if index * rhythm_interval < metadata["duration"] - 0.8
            ]
            if rhythm_interval > 0
            else []
        )
        node_transition_candidates = (
            [
                float(caption.get("start") or 0.0)
                for caption in caption_segments
                if str(caption.get("contentNode") or "")
                in {"pain_reversal", "core_viewpoint", "number_benefit", "example_step", "cta"}
            ]
            if template_id in {"viral-pulse", "template-2", "template-3", "template-4", "template-5", "template-6", "template-7", "template-8"}
            else []
        )
        transition_candidates = sorted(
            scene_changes
            + pause_candidates
            + node_transition_candidates
            + ([] if node_transition_candidates else rhythm_candidates)
        )
        transition_points: list[float] = []
        minimum_transition_gap = float(current_template.get("minimum_transition_gap_seconds") or 3.0)
        for point in transition_candidates:
            if point < 0.8 or point > metadata["duration"] - 0.8:
                continue
            if not transition_points or point - transition_points[-1] >= minimum_transition_gap:
                transition_points.append(round(point, 3))
        maximum_effects = max(
            1,
            math.ceil(
                metadata["duration"]
                / 60
                * float(current_template.get("maximum_effects_per_minute") or 18)
            ),
        )
        transition_points = transition_points[:maximum_effects]
        create_ass(
            subtitle_file,
            output_size[0],
            output_size[1],
            metadata["duration"],
            title,
            caption_segments,
            template_id,
        )
        include_sfx = bool(job.get("include_sfx", True))
        include_bgm = bool(job.get("include_bgm", False))
        sfx_cues = build_adaptive_sfx_cues(
            folder,
            current_template,
            metadata["duration"],
            caption_segments,
            transition_points,
            title,
        ) if include_sfx else []
        if include_sfx:
            create_timeline_sfx(
                sfx_file,
                str(current_template["opening_sfx"]),
                metadata["duration"],
                sfx_cues,
            )
        timeline_file = build_remotion_timeline(
            folder,
            source,
            sfx_file,
            metadata["duration"],
            title,
            caption_segments,
            template_id,
            job.get("merchant") if isinstance(job.get("merchant"), dict) else {},
            include_sfx=include_sfx,
            include_bgm=include_bgm,
            sfx_cues=sfx_cues,
            transition_points=transition_points,
        )
        use_remotion = remotion_renderer_available()
        active_output_size = (1080, 1920) if use_remotion else output_size
        write_job(
            job_id,
            stage="render",
            progress=55,
            message=(
                f"正在用 9:16 智能包装引擎套用“{current_template['name']}”并导出 MP4…"
                if use_remotion
                else f"正在用兼容渲染通道套用“{current_template['name']}”并导出 MP4…"
            ),
            title=title,
            title_source=title_source,
            transcript=transcript,
            captions=caption_segments,
            caption_source=caption_source,
            highlight_source=highlight_source,
            caption_completeness=caption_completeness,
            word_count=len(words),
            scene_changes=scene_changes,
            transition_points=transition_points,
            output_width=active_output_size[0],
            output_height=active_output_size[1],
            renderer="remotion-vertical-v1" if use_remotion else "ffmpeg-fallback",
            timeline_version=2,
            sfx_cues=sfx_cues,
            language=getattr(info, "language", "zh") if info else "",
            analysis_mode=analysis_mode,
            template_profile={
                "name": current_template["name"],
                "reference_url": current_template.get("reference_url", ""),
                "title": current_template["title_description"],
                "subtitle": current_template["subtitle_description"],
                "transition": current_template["transition"],
                "audio": "保留原声" + (" + 模板提示音" if include_sfx else "") + (" + 背景音乐" if include_bgm else ""),
                "version": current_template.get("template_version", 1),
            },
        )

        if use_remotion:
            render_with_remotion(timeline_file, output)
        else:
            escaped_ass = str(subtitle_file).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
            video_encoder = os.getenv("VIDEO_WORKER_ENCODER", "libx264")
            video_options = ["-c:v", video_encoder]
            if video_encoder == "libx264":
                video_options.extend([
                    "-preset", os.getenv("VIDEO_WORKER_X264_PRESET", "medium"),
                    "-crf", os.getenv("VIDEO_WORKER_CRF", "20"),
                ])
            elif video_encoder == "mpeg4":
                video_options.extend([
                    "-q:v", os.getenv("VIDEO_WORKER_MPEG4_QUALITY", "3"),
                ])
            else:
                video_options.extend([
                    "-b:v", os.getenv("VIDEO_WORKER_VIDEO_BITRATE", "2500k"),
                    "-maxrate", os.getenv("VIDEO_WORKER_VIDEO_MAXRATE", "4000k"),
                    "-bufsize", os.getenv("VIDEO_WORKER_VIDEO_BUFSIZE", "8000k"),
                ])
            video_graph = build_template_video_graph(
                metadata,
                str(job.get("template_id") or "clean-green"),
                escaped_ass,
                transition_points if current_template.get("transition_trigger") != "fixed" else None,
                output_size,
            )
            filter_complex = video_graph
            if metadata["has_audio"] and include_sfx:
                filter_complex += f";[0:a:0][1:a:0]amix=inputs=2:duration=first:weights='1 {float(current_template.get('sfx_gain') or 0.14):.3f}':dropout_transition=0[aout]"
            render_command = [
                ffmpeg,
                "-y",
                "-i", str(source),
            ]
            if include_sfx:
                render_command.extend(["-i", str(sfx_file)])
            render_command.extend(["-filter_complex", filter_complex, "-map", "[vout]", *video_options])
            if metadata["has_audio"] and include_sfx:
                render_command.extend(["-map", "[aout]"])
            elif metadata["has_audio"]:
                render_command.extend(["-map", "0:a:0"])
            elif include_sfx:
                render_command.extend(["-map", "1:a:0"])
            render_command.extend([
                *(["-c:a", "aac", "-b:a", "160k"] if metadata["has_audio"] or include_sfx else ["-an"]),
                "-movflags", "+faststart",
                str(output),
            ])
            run(render_command)
        # Frame zero can be black because of encoder warm-up or a template
        # fade-in.  Use the first meaningful opening image as the cover.
        output_metadata = probe_video(output)
        extract_contentful_cover(
            output,
            cover,
            output_metadata["duration"],
            float(current_template.get("cover_time_seconds") or 0.8),
        )
        write_job(
            job_id,
            state="success",
            stage="complete",
            progress=100,
            message="处理完成，可预览或下载。",
            result_url=media_url(job_id, output.name),
            cover_url=media_url(job_id, cover.name),
        )
    except Exception as error:
        write_job(
            job_id,
            state="failed",
            stage="failed",
            message=str(error).strip() or "视频处理失败。",
            error=str(error).strip() or "视频处理失败。",
        )


def process_transcription_job(job_id: str) -> None:
    folder = job_dir(job_id)
    job = read_job(job_id)
    source = folder / job["source_name"]
    audio = folder / "speech.wav"
    try:
        write_job(job_id, state="running", stage="probe", progress=5, message="正在读取原片声音与画面信息…")
        metadata = probe_video(source)
        if metadata["duration"] <= 0 or not metadata["has_audio"]:
            raise RuntimeError("原片没有可识别的人声音轨。")
        if job.get("kind") == "douyin_transcription" and metadata["duration"] > BENCHMARK_MAX_DURATION_SECONDS:
            raise RuntimeError(f"对标视频最长支持 {BENCHMARK_MAX_DURATION_SECONDS // 60} 分钟，请选择更短的公开视频。")
        profile = template_profile(str(job.get("template_id") or "clean-green"))
        merchant = job.get("merchant") if isinstance(job.get("merchant"), dict) else {}
        ffmpeg = check_binary("ffmpeg")
        write_job(job_id, stage="extract", progress=12, message="正在提取清晰人声音轨…", metadata=metadata)
        run([ffmpeg, "-y", "-i", str(source), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(audio)])
        if not tencent_flash_asr_enabled():
            raise RuntimeError("腾讯云极速语音识别尚未配置，请联系管理员完成服务端配置。")
        write_job(
            job_id,
            stage="tencent_asr",
            progress=22,
            message="腾讯云极速语音识别正在提取口播与精确时间轴…",
            metadata=metadata,
        )
        original_segments, asr_metadata = tencent_flash_asr(audio, merchant)
        write_job(
            job_id,
            stage="visual",
            progress=46,
            message="语音识别完成，多模态模型正在分析关键画面…",
            asr_provider="tencent-flash",
            asr_request_id=asr_metadata.get("request_id", ""),
        )
        visual_context = ai_video_visual_context(
            source,
            float(metadata["duration"]),
            folder,
        )
        write_job(
            job_id,
            stage="correct",
            progress=62,
            message="正在结合完整口播和画面校正专有名词与错字…",
        )
        corrected_segments, captions, caption_source = ai_correct_and_segment_captions(
            original_segments,
            int(profile.get("caption_min_chars") or 4),
            int(profile.get("caption_max_chars") or 15),
            visual_context,
        )
        transcript = "。".join(
            str(item.get("text") or "").strip()
            for item in corrected_segments
            if str(item.get("text") or "").strip()
        )
        fallback_title = derive_title(captions or corrected_segments, "")
        write_job(
            job_id,
            stage="title",
            progress=82,
            message="正在理解完整内容并生成准确标题…",
        )
        title, title_source = ai_title_from_transcript(
            transcript,
            fallback_title,
            profile,
            visual_context,
        )
        report = caption_completeness_report(corrected_segments, captions)
        write_job(
            job_id,
            state="success",
            stage="complete",
            progress=100,
            message="极速语音识别与多模态校对已完成，可逐段修改后提交模板。",
            title=title,
            title_source=title_source,
            transcript=transcript,
            captions=captions,
            caption_source=f"tencent-flash:{caption_source}",
            caption_completeness=report,
            language="zh",
            analysis_mode="tencent-flash-asr-multimodal",
            analysis_summary="腾讯云极速语音识别已生成时间轴，多模态模型已完成画面分析、错字修正和标题提炼。",
            visual_context=visual_context,
            asr_provider="tencent-flash",
            asr_engine=asr_metadata.get("engine_type", TENCENT_ASR_ENGINE_TYPE),
            asr_request_id=asr_metadata.get("request_id", ""),
        )
    except Exception as error:
        write_job(
            job_id,
            state="failed",
            stage="failed",
            progress=max(1, int(job.get("progress") or 1)),
            message=str(error).strip() or "口播文案提取失败。",
            error=str(error).strip() or "口播文案提取失败。",
        )


def normalize_douyin_share_url(value: Any) -> str:
    raw = str(value or "").strip()
    match = re.search(r"https?://[^\s<>]+", raw, flags=re.IGNORECASE)
    if not match:
        raise ValueError("请粘贴完整的抖音公开视频链接。")
    url = match.group(0).rstrip(".,;:!?，。；：！？、)]}〉》」』\"'")
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower().rstrip(".")
    allowed = host == "douyin.com" or host.endswith(".douyin.com") or host == "iesdouyin.com" or host.endswith(".iesdouyin.com")
    if parsed.scheme not in {"http", "https"} or not allowed:
        raise ValueError("目前只支持 douyin.com 的公开视频链接。")
    return url


def douyin_post_from_public_detail(share_url: str, social_post_class: Any) -> Any:
    resolved = resolve_public_douyin_video(share_url)
    item = resolved["detail"]
    video_id = str(resolved["video_id"])
    video = item.get("video") if isinstance(item.get("video"), dict) else {}
    video_url = first_media_url(
        video.get("play_addr_h264"),
        video.get("play_addr"),
        video.get("play_addr_265"),
    )
    if not video_url:
        raise ValueError("抖音公开视频未返回可读取的视频地址。")

    author = item.get("author") if isinstance(item.get("author"), dict) else {}
    statistics = item.get("statistics") if isinstance(item.get("statistics"), dict) else {}
    cover_url = first_media_url(video.get("cover"), video.get("origin_cover")) or None
    duration_ms = item.get("duration") or video.get("duration")
    duration_sec = None
    if isinstance(duration_ms, (int, float)) and duration_ms > 0:
        duration_sec = max(1, int(round(float(duration_ms) / 1000))) if duration_ms > 1000 else int(duration_ms)
    title = str(item.get("desc") or "").strip() or f"douyin_{video_id}"
    title = re.sub(r'[\\/:*?"<>|]', "_", title)
    sec_uid = str(author.get("sec_uid") or "").strip()
    author_name = str(author.get("nickname") or author.get("unique_id") or "").strip()
    author_profile = {
        "id": author.get("uid") or sec_uid or None,
        "name": author_name or None,
        "nickname": author_name or None,
        "handle": author.get("unique_id") or None,
        "sec_uid": sec_uid or None,
        "profile_url": f"https://www.douyin.com/user/{sec_uid}" if sec_uid else None,
        "extra": author,
    }
    return social_post_class(
        platform="douyin",
        content_type="video",
        source_url=share_url,
        resolved_url=str(resolved["resolved_url"]),
        post_id=video_id,
        title=title,
        body=str(item.get("desc") or "").strip(),
        author_name=author_name or None,
        author_id=author.get("uid") or sec_uid or None,
        publish_time=item.get("create_time"),
        cover_url=cover_url,
        duration_sec=duration_sec,
        video_url=video_url,
        page_url=str(resolved["page_url"]),
        author_profile=author_profile,
        public_metrics={
            "views": statistics.get("play_count"),
            "likes": statistics.get("digg_count"),
            "comments": statistics.get("comment_count"),
            "shares": statistics.get("share_count"),
            "collects": statistics.get("collect_count"),
        },
        media={"cover_url": cover_url, "image_urls": [], "video_url": video_url},
        extra={"aweme_type": item.get("aweme_type"), "statistics": statistics, "resolver": "public-preview-detail"},
    )


def process_douyin_transcription_job(job_id: str) -> None:
    folder = job_dir(job_id)
    job = read_job(job_id)
    try:
        write_job(job_id, state="running", stage="resolve", progress=3, message="正在读取抖音公开视频信息…")
        try:
            from social_media_toolkit.downloader import MediaDownloader
            from social_media_toolkit.platforms.core import DouyinPlatformAdapter, SocialPost
        except ImportError as error:
            raise RuntimeError("抖音链接解析组件尚未安装，请联系管理员更新视频服务。") from error

        share_url = str(job.get("benchmark_source_url") or "")
        try:
            post = DouyinPlatformAdapter().fetch_post(share_url)
        except (ValueError, KeyError, TypeError, json.JSONDecodeError):
            # Since August 2026 the mobile share page may omit videoInfoRes
            # from its initial router payload.  Fall back to Douyin's public
            # desktop preview detail response, which still exposes public
            # video metadata without account cookies.
            post = douyin_post_from_public_detail(share_url, SocialPost)
        if str(post.platform or "").lower() != "douyin" or str(post.content_type or "").lower() != "video":
            raise RuntimeError("该链接不是可读取的抖音公开视频。")

        write_job(job_id, stage="download", progress=7, message="链接读取成功，正在安全下载公开视频…")
        download = MediaDownloader(max_bytes=BENCHMARK_MAX_BYTES).download_post(post, output_dir=str(folder), include=("video",))
        items = download.get("items") if isinstance(download, dict) else []
        video_item = next(
            (item for item in items if isinstance(item, dict) and item.get("kind") == "video" and item.get("local_path")),
            None,
        )
        if not video_item:
            errors = download.get("errors") if isinstance(download, dict) else []
            detail = str(errors[0].get("error") or "") if errors and isinstance(errors[0], dict) else ""
            raise RuntimeError(detail or "暂时无法下载这个抖音视频，请确认链接公开且仍然有效。")

        downloaded = Path(str(video_item["local_path"])).resolve()
        if downloaded.parent != folder.resolve() or not downloaded.is_file():
            raise RuntimeError("公开视频下载结果无效。")
        suffix = downloaded.suffix.lower() if downloaded.suffix.lower() in {".mp4", ".mov", ".m4v", ".webm", ".mkv"} else ".mp4"
        source_name = f"source{suffix}"
        source = folder / source_name
        if downloaded != source:
            downloaded.replace(source)
        source_size = source.stat().st_size
        if source_size <= 0 or source_size > BENCHMARK_MAX_BYTES:
            raise RuntimeError("公开视频文件为空或超过当前大小限制。")

        author = post.author_profile if isinstance(post.author_profile, dict) else {}
        request_base_url = str(job.get("request_base_url") or "").rstrip("/")
        public_base_url = PUBLIC_BASE_URL or request_base_url
        write_job(
            job_id,
            source_name=source_name,
            source_url=f"{public_base_url}/media/{job_id}/{source_name}" if public_base_url else "",
            source_size=source_size,
            benchmark_title=str(post.title or "").strip()[:200],
            benchmark_author=str(author.get("nickname") or author.get("name") or author.get("display_name") or "").strip()[:100],
            benchmark_post_id=str(post.post_id or "").strip()[:100],
            benchmark_resolved_url=str(post.page_url or post.resolved_url or "").strip()[:1000],
            message="公开视频已就绪，正在提取口播文案…",
        )
        process_transcription_job(job_id)
    except Exception as error:
        write_job(
            job_id,
            state="failed",
            stage="failed",
            progress=max(1, int(job.get("progress") or 1)),
            message=str(error).strip() or "抖音对标文案读取失败。",
            error=str(error).strip() or "抖音对标文案读取失败。",
        )


@app.get("/health")
def health() -> dict[str, Any]:
    refresh_remote_template_registry()
    return {
        "ok": bool(shutil.which("ffmpeg") and shutil.which("ffprobe")),
        "ffmpeg": shutil.which("ffmpeg") or "",
        "ffprobe": shutil.which("ffprobe") or "",
        "video_analysis_model": AI_VIDEO_MODEL,
        "video_analysis_enabled": bool(AI_API_KEY and AI_VIDEO_MODEL and PUBLIC_BASE_URL),
        "transcription_primary": "tencent-flash-asr" if tencent_flash_asr_enabled() else "unavailable",
        "transcription_fallback_enabled": False,
        "tencent_flash_asr_enabled": tencent_flash_asr_enabled(),
        "tencent_flash_asr_engine": TENCENT_ASR_ENGINE_TYPE,
        "data_dir": str(DATA_DIR),
        "template_v2_count": len(TEMPLATE_PACKAGES),
        "template_registry": "cloud-remote" if TEMPLATE_REGISTRY_URL and not TEMPLATE_REGISTRY_ERROR else "cloud-bundled",
        "template_registry_error": TEMPLATE_REGISTRY_ERROR,
        "remotion_available": remotion_renderer_available(),
        "renderer": "remotion-vertical-v1" if remotion_renderer_available() else "ffmpeg-fallback",
    }


@app.get("/v1/templates")
def list_templates() -> dict[str, Any]:
    refresh_remote_template_registry()
    return {
        "items": [
            {
                "id": template_id,
                "name": template_profile(template_id)["name"],
                "reference_url": template_profile(template_id).get("reference_url", ""),
                "preview_url": template_profile(template_id).get("reference_url", ""),
                "title": template_profile(template_id)["title_description"],
                "subtitle": template_profile(template_id)["subtitle_description"],
                "transition": template_profile(template_id)["transition"],
                "audio": "背景音乐 + 模板提示音" if template_profile(template_id).get("bgm_file") else f"{template_profile(template_id)['opening_sfx']} 提示音",
                "version": template_profile(template_id).get("template_version", 1),
                "source": TEMPLATE_CATALOG.get(template_id, {}).get("source", "legacy"),
                **{
                    key: value
                    for key, value in TEMPLATE_CATALOG.get(template_id, {}).items()
                    if key not in {"id", "name", "version", "status", "source"}
                },
            }
            for template_id in sorted(set(TEMPLATES) | set(TEMPLATE_PACKAGES))
        ]
    }


@app.get("/v1/templates/{template_id}")
def get_template(template_id: str) -> dict[str, Any]:
    refresh_remote_template_registry()
    if template_id not in TEMPLATES and template_id not in TEMPLATE_PACKAGES:
        raise HTTPException(status_code=404, detail="网感模板不存在。")
    profile = template_profile(template_id)
    return {
        "id": template_id,
        "catalog": TEMPLATE_CATALOG.get(template_id, {}),
        "package": profile.get("package", {}),
        "resolved": {
            "name": profile.get("name", ""),
            "version": profile.get("template_version", 1),
            "bgm_file": profile.get("bgm_file", ""),
            "bgm_volume": profile.get("bgm_volume", 0.0),
            "music_pool_id": profile.get("music_pool_id", ""),
        },
    }


@app.get("/v1/template-registry")
def get_template_registry() -> dict[str, Any]:
    refresh_remote_template_registry()
    return {
        "schema_version": 1,
        "templates": [
            {
                **TEMPLATE_CATALOG.get(template_id, {"id": template_id, "status": "published"}),
                "id": template_id,
                "version": int(package.get("version") or 2),
                "package": {key: value for key, value in package.items() if key != "_catalog"},
            }
            for template_id, package in sorted(TEMPLATE_PACKAGES.items())
        ],
    }


@app.post("/v1/template-learning/jobs")
async def create_template_learning_job(
    request: Request,
    video: UploadFile = File(...),
    template_id: str = Form(...),
    template_name: str = Form(...),
    preview_url: str = Form(""),
) -> dict[str, Any]:
    require_template_admin(request)
    template_id = template_id.strip().lower()
    template_name = template_name.strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,48}", template_id):
        raise HTTPException(status_code=400, detail="模板标识只能使用小写字母、数字和短横线。")
    if not template_name:
        raise HTTPException(status_code=400, detail="请填写模板名称。")
    content_type = (video.content_type or "").lower()
    if not content_type.startswith("video/"):
        raise HTTPException(status_code=400, detail="请上传参考视频文件。")
    job_id = uuid.uuid4().hex
    folder = job_dir(job_id)
    folder.mkdir(parents=True, exist_ok=False)
    suffix = Path(video.filename or "reference.mp4").suffix.lower()
    if suffix not in {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"}:
        suffix = ".mp4"
    source_name = f"reference{suffix}"
    source = folder / source_name
    size = 0
    try:
        with source.open("wb") as target:
            while chunk := await video.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="参考视频超过当前允许的上传大小。")
                target.write(chunk)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    now = int(time.time() * 1000)
    job = {
        "id": job_id, "kind": "template_learning", "state": "queued", "stage": "queued", "progress": 1,
        "message": "参考视频已接收，等待逐帧学习…", "template_id": template_id,
        "template_name": template_name[:60], "preview_url": preview_url.strip()[:1000],
        "source_name": source_name, "source_size": size, "created_at": now, "updated_at": now,
        "error": "",
    }
    job_file(job_id).write_text(json.dumps(job, ensure_ascii=False, indent=2), "utf-8")
    EXECUTOR.submit(process_template_learning_job, job_id)
    return {**job, "status_url": str(request.base_url).rstrip("/") + f"/v1/template-learning/jobs/{job_id}"}


@app.get("/v1/template-learning/jobs/{job_id}")
def get_template_learning_job(request: Request, job_id: str) -> dict[str, Any]:
    require_template_admin(request)
    if not job_id.isalnum() or len(job_id) != 32:
        raise HTTPException(status_code=400, detail="模板学习任务编号无效。")
    job = read_job(job_id)
    if job.get("kind") != "template_learning":
        raise HTTPException(status_code=404, detail="模板学习任务不存在。")
    return job


@app.post("/v1/transcriptions")
async def create_transcription_job(
    request: Request,
    video: UploadFile = File(...),
    template_id: str = Form("clean-green"),
    merchant_json: str = Form("{}"),
) -> dict[str, Any]:
    refresh_remote_template_registry()
    content_type = (video.content_type or "").lower()
    if not content_type.startswith("video/"):
        raise HTTPException(status_code=400, detail="请上传视频文件。")
    if template_id not in TEMPLATES and template_id not in TEMPLATE_PACKAGES:
        raise HTTPException(status_code=400, detail="网感模板无效。")
    job_id = uuid.uuid4().hex
    folder = job_dir(job_id)
    folder.mkdir(parents=True, exist_ok=False)
    suffix = Path(video.filename or "source.mp4").suffix.lower()
    if suffix not in {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"}:
        suffix = ".mp4"
    source_name = f"source{suffix}"
    source = folder / source_name
    size = 0
    try:
        with source.open("wb") as target:
            while chunk := await video.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="原片超过当前允许的上传大小。")
                target.write(chunk)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    try:
        merchant = json.loads(merchant_json)
    except json.JSONDecodeError:
        merchant = {}
    now = int(time.time() * 1000)
    request_base_url = str(request.base_url).rstrip("/")
    public_base_url = PUBLIC_BASE_URL or request_base_url
    source_url = f"{public_base_url}/media/{job_id}/{source_name}"
    job = {
        "id": job_id,
        "kind": "transcription",
        "state": "queued",
        "stage": "queued",
        "progress": 1,
        "message": "原片已接收，等待提取口播文案…",
        "template_id": template_id,
        "merchant": merchant if isinstance(merchant, dict) else {},
        "source_name": source_name,
        "source_url": source_url,
        "source_size": size,
        "created_at": now,
        "updated_at": now,
        "error": "",
    }
    job_file(job_id).write_text(json.dumps(job, ensure_ascii=False, indent=2), "utf-8")
    TRANSCRIPTION_EXECUTOR.submit(process_transcription_job, job_id)
    return {
        **job,
        "status_url": request_base_url + f"/v1/jobs/{job_id}",
    }


@app.post("/v1/douyin/transcriptions")
async def create_douyin_transcription_job(request: Request) -> dict[str, Any]:
    require_template_admin(request)
    try:
        body = await request.json()
    except Exception as error:
        raise HTTPException(status_code=400, detail="请求内容格式无效。") from error
    try:
        share_url = normalize_douyin_share_url(body.get("share_url") if isinstance(body, dict) else "")
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    job_id = uuid.uuid4().hex
    folder = job_dir(job_id)
    folder.mkdir(parents=True, exist_ok=False)
    now = int(time.time() * 1000)
    request_base_url = str(request.base_url).rstrip("/")
    job = {
        "id": job_id,
        "kind": "douyin_transcription",
        "state": "queued",
        "stage": "queued",
        "progress": 1,
        "message": "链接已接收，等待读取公开视频…",
        "template_id": "clean-green",
        "merchant": {},
        "benchmark_source_url": share_url,
        "request_base_url": request_base_url,
        "source_name": "",
        "source_url": "",
        "source_size": 0,
        "created_at": now,
        "updated_at": now,
        "error": "",
    }
    job_file(job_id).write_text(json.dumps(job, ensure_ascii=False, indent=2), "utf-8")
    TRANSCRIPTION_EXECUTOR.submit(process_douyin_transcription_job, job_id)
    return {**job, "status_url": request_base_url + f"/v1/jobs/{job_id}"}


@app.post("/v1/jobs")
async def create_job(
    request: Request,
    video: UploadFile = File(...),
    template_id: str = Form("clean-green"),
    title: str = Form(""),
    merchant_json: str = Form("{}"),
    captions_json: str = Form("[]"),
    include_sfx: str = Form("true"),
    include_bgm: str = Form("false"),
) -> dict[str, Any]:
    refresh_remote_template_registry()
    content_type = (video.content_type or "").lower()
    if not content_type.startswith("video/"):
        raise HTTPException(status_code=400, detail="请上传视频文件。")
    if template_id not in TEMPLATES and template_id not in TEMPLATE_PACKAGES:
        raise HTTPException(status_code=400, detail="网感模板无效。")
    job_id = uuid.uuid4().hex
    folder = job_dir(job_id)
    folder.mkdir(parents=True, exist_ok=False)
    suffix = Path(video.filename or "source.mp4").suffix.lower()
    if suffix not in {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"}:
        suffix = ".mp4"
    source_name = f"source{suffix}"
    source = folder / source_name
    size = 0
    try:
        with source.open("wb") as target:
            while chunk := await video.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="原片超过当前允许的上传大小。")
                target.write(chunk)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    try:
        merchant = json.loads(merchant_json)
    except json.JSONDecodeError:
        merchant = {}
    try:
        edited_captions = json.loads(captions_json)
    except json.JSONDecodeError:
        edited_captions = []
    now = int(time.time() * 1000)
    job = {
        "id": job_id,
        "state": "queued",
        "stage": "queued",
        "progress": 1,
        "message": "原片已接收，等待后台处理…",
        "template_id": template_id,
        "title": title.strip()[:40],
        "merchant": merchant if isinstance(merchant, dict) else {},
        "edited_captions": edited_captions if isinstance(edited_captions, list) else [],
        "include_sfx": form_boolean(include_sfx, True),
        "include_bgm": form_boolean(include_bgm, False),
        "source_name": source_name,
        "source_size": size,
        "created_at": now,
        "updated_at": now,
        "result_url": "",
        "cover_url": "",
        "error": "",
    }
    job_file(job_id).write_text(json.dumps(job, ensure_ascii=False, indent=2), "utf-8")
    EXECUTOR.submit(process_job, job_id)
    return {
        **job,
        "status_url": str(request.base_url).rstrip("/") + f"/v1/jobs/{job_id}",
    }


@app.get("/v1/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    if not job_id.isalnum() or len(job_id) != 32:
        raise HTTPException(status_code=400, detail="视频任务编号无效。")
    return read_job(job_id)


@app.api_route("/media/{job_id}/{name}", methods=["GET", "HEAD"])
def get_media(job_id: str, name: str) -> FileResponse:
    if not job_id.isalnum() or len(job_id) != 32:
        raise HTTPException(status_code=400, detail="视频任务编号无效。")
    job = read_job(job_id)
    source_name = str(job.get("source_name") or "")
    if name not in {"output.mp4", "cover.jpg", source_name}:
        raise HTTPException(status_code=404, detail="文件不存在。")
    target = job_dir(job_id) / name
    if not target.exists():
        raise HTTPException(status_code=404, detail="文件尚未生成。")
    suffix = target.suffix.lower()
    media_type = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".m4v": "video/x-m4v",
    }.get(suffix, "video/mp4")
    return FileResponse(
        target,
        media_type=media_type,
        headers={
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
        },
    )
