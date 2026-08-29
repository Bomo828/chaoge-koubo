from __future__ import annotations

import base64
import hashlib
import hmac
import json
import http.client
import ipaddress
import math
import os
import random
import re
import shutil
import socket
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
HIGHLIGHT_AI_TIMEOUT_SECONDS = max(
    15,
    int(os.getenv("VIDEO_WORKER_HIGHLIGHT_AI_TIMEOUT_SECONDS", "75")),
)
HIGHLIGHT_AI_MAX_ATTEMPTS = max(
    1,
    min(3, int(os.getenv("VIDEO_WORKER_HIGHLIGHT_AI_MAX_ATTEMPTS", "2"))),
)
DIRECTOR_AI_TIMEOUT_SECONDS = max(
    4,
    min(30, int(os.getenv("VIDEO_WORKER_DIRECTOR_AI_TIMEOUT_SECONDS", "12"))),
)
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
TENCENT_MPS_COS_BUCKET = os.getenv("TENCENT_MPS_COS_BUCKET", "").strip()
TENCENT_MPS_COS_REGION = os.getenv("TENCENT_MPS_COS_REGION", "ap-guangzhou").strip() or "ap-guangzhou"
VIDEO_WORKER_COS_OUTPUT_PREFIX = os.getenv("VIDEO_WORKER_COS_OUTPUT_PREFIX", "video-worker/outputs").strip().strip("/") or "video-worker/outputs"
PUBLIC_BASE_URL = os.getenv("VIDEO_WORKER_PUBLIC_BASE_URL", "").strip().rstrip("/")
WORKERS = max(1, int(os.getenv("VIDEO_WORKER_CONCURRENCY", "1")))
TRANSCRIPTION_WORKERS = max(1, int(os.getenv("VIDEO_WORKER_TRANSCRIPTION_CONCURRENCY", "1")))
JOB_RETENTION_HOURS = max(1, int(os.getenv("VIDEO_WORKER_JOB_RETENTION_HOURS", "24")))
CLEANUP_INTERVAL_SECONDS = max(300, int(os.getenv("VIDEO_WORKER_CLEANUP_INTERVAL_SECONDS", "1800")))
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
PUBLISHED_TEMPLATE_IDS = ("template-9", "template-10", "template-11", "template-12")
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
CLEANUP_STATE: dict[str, Any] = {"last_run_at": 0, "removed_jobs": 0, "last_error": ""}
DIRECTOR_PLAN_CACHE: dict[str, list[dict[str, Any]]] = {}
DIRECTOR_PLAN_CACHE_LOCK = threading.Lock()


def load_templates() -> dict[str, dict[str, Any]]:
    try:
        value = json.loads(TEMPLATE_MANIFEST.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"视频模板清单读取失败：{error}") from error
    if not isinstance(value, dict) or "template-9" not in value:
        raise RuntimeError("视频模板清单缺少默认模板 template-9。")
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
        for pool_name, pool_value in sfx.items():
            if not str(pool_name).endswith("_pool"):
                continue
            pool = pool_value if isinstance(pool_value, list) else []
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
        if not template_id or template_id not in PUBLISHED_TEMPLATE_IDS:
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
    # Isolated v2 packages render their visible typography in Remotion, but
    # the worker still writes an ASS fallback before starting that renderer.
    # Keep the fallback geometry complete so a compact templates.json entry
    # cannot fail a valid job with a missing legacy-only field.
    "panel": "&H00000000",
    "align": "center",
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
        "template-9": ("#210c12", "#fffdf9", "#9f2538"),
        "template-10": ("#15110d", "#fffdf8", "#fff300"),
        "template-11": ("#111515", "#ffffff", "#79f4e4"),
        "template-12": ("#050505", "#ffffff", "#fff000"),
    }
    profile = template_profile(template_id)
    background, default_foreground, default_accent = themes.get(template_id, themes["template-9"])
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
    elif template_id in {"viral-pulse", "template-2", "template-3", "template-4", "template-5", "template-6", "template-7", "template-8", "template-9", "template-10", "template-11", "template-12"}:
        package = profile.get("package") if isinstance(profile.get("package"), dict) else {}
        opening = package.get("opening") if isinstance(package.get("opening"), dict) else {}
        theme.update({
            "rendererKey": str(profile.get("renderer_key") or f"{template_id}-studio-v1"),
            "captionMode": "kinetic-studio-series",
            "keywordColor": str(profile.get("keyword_color") or accent),
            "headlineDuration": float(opening.get("max_seconds") or 2.6),
            "headlineTop": int(opening.get("safe_top_px") or 154),
            "headlinePersistent": bool(opening.get("title_mode") == "persistent") if template_id in {"template-11", "template-12"} else False,
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
        confirmed_node = str(caption.get("contentNode") or "").strip()
        if confirmed_node in route_by_node:
            node = confirmed_node
        elif is_final and any(marker in text for marker in ("欢迎", "咨询", "预约", "点击", "联系", "了解", "开始", "留言", "关注")):
            node = "cta"
        elif index == 0 or any(marker in text for marker in ("你知道", "为什么", "千万", "别再", "很多人", "最重要", "想不想", "是不是")):
            node = "hook"
        elif any(marker in text for marker in ("但是", "不过", "其实", "相反", "没想到", "结果却", "真正", "而是", "不是", "痛点", "难", "不会", "不知道", "担心", "问题")):
            node = "pain_reversal"
        elif any(marker in text for marker in ("比如", "例如", "举个例子", "第一", "第二", "第三", "首先", "其次", "下一步", "最后一步", "步骤", "怎么做", "如何")):
            node = "example_step"
        elif re.search(r"\d|\d+(?:\.\d+)?[%折元万+]|[一二三四五六七八九十百千万]+(?:个|类|项|种)|第[一二三四五六七八九十]", text) or any(marker in text for marker in ("省", "提升", "增长", "效率", "收益", "优惠", "免费", "实用", "帮你", "打扎实", "练熟", "竞争力")):
            node = "number_benefit"
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
        camera_intent = str(caption.get("cameraIntent") or "").strip()
        transition_intent = str(caption.get("transitionIntent") or "").strip()
        sfx_role = str(caption.get("sfxRole") or "").strip()
        if camera_intent in {"hold", "push-in", "pull-back", "reframe", "close-up", "wide"}:
            route["camera"] = camera_intent
        if transition_intent in {"none", "cut", "matched-reframe", "focus-bridge", "foreground-occlusion"}:
            route["transition"] = transition_intent
        if sfx_role in {"none", "hook", "reversal", "viewpoint", "number", "step", "brand", "cta"}:
            route["sfx"] = sfx_role
        caption_style = select_caption_material(content_director, node, title, text, index, str(route["caption"]))
        route["caption"] = caption_style
        caption["contentNode"] = node
        caption["semanticRole"] = {
            "pain_reversal": "reversal", "core_viewpoint": "conclusion", "number_benefit": "number",
            "example_step": "step", "brand_entity": "brand", "supporting": "steady",
        }.get(node, node)
        if sfx_role and sfx_role != "none":
            caption["semanticRole"] = "conclusion" if sfx_role == "viewpoint" else sfx_role
        caption["animation"] = route["animation"]
        caption["captionStyle"] = caption_style
        if effect_level == "subtle" and sfx_role not in {"hook", "reversal", "viewpoint", "number", "step", "brand", "cta"}:
            route["sfx"] = "none"
            route["transition"] = "none"
        caption["effectLevel"] = effect_level
        caption["materialRoute"] = route
        caption["role"] = "focus" if node not in {"supporting", "brand_entity"} else "anchor"
        semantic_keyword_decided = bool(caption.get("keywordLocked")) or str(caption.get("keywordOrigin") or "") in {
            "ai", "local", "none",
        }
        if not semantic_keyword_decided:
            # Semantic emphasis is owned by the one-shot AI plan.  The worker
            # validates and renders that decision, but never invents a second
            # keyword when the plan is missing or rejected.
            caption["keyword"] = ""
            caption["keywordOrigin"] = "none"
            caption["keywordLocked"] = True
    step_number = 0
    for caption in planned:
        if caption.get("contentNode") == "example_step" and caption.get("animation") == "step-card":
            step_number += 1
            caption["stepNumber"] = step_number
        else:
            caption.pop("stepNumber", None)
    return planned


KEYWORD_SFX_NODE_SCORE = {
    "hook": 4.2,
    "pain_reversal": 4.0,
    "core_viewpoint": 3.8,
    "number_benefit": 4.6,
    "example_step": 3.4,
    "brand_entity": 3.2,
    "cta": 3.9,
    "supporting": 1.2,
}


def mark_keyword_sfx_emphasis(captions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Mark a sparse subset of visual keywords as audible key words.

    Visual highlighting and sound emphasis are intentionally separate layers:
    every grounded keyword may keep its template styling, while only a few
    semantically important, well-spaced words receive a sound effect.
    Explicit True/False values coming from the confirmation UI are respected.
    """
    planned = [dict(item) for item in captions]
    if not planned:
        return planned
    duration = max((float(item.get("end") or 0.0) for item in planned), default=1.0)
    maximum = max(1, min(5, math.ceil(max(1.0, duration) / 14.0)))
    minimum_gap = 4.2
    candidates: list[dict[str, Any]] = []
    for index, caption in enumerate(planned):
        keyword = str(caption.get("keyword") or "").strip()
        text = re.sub(r"\s+", "", str(caption.get("text") or ""))
        if not keyword or re.sub(r"\s+", "", keyword) not in text:
            continue
        if caption.get("keywordSfx") is False:
            continue
        node = str(caption.get("contentNode") or "supporting")
        try:
            weight = max(0.0, min(1.0, float(caption.get("contentWeight") or 0.45)))
        except (TypeError, ValueError):
            weight = 0.45
        explicit = caption.get("keywordSfx") is True
        score = KEYWORD_SFX_NODE_SCORE.get(node, 1.2) + weight * 2.0 + (100.0 if explicit else 0.0)
        candidates.append({
            "index": index,
            "start": float(caption.get("start") or 0.0),
            "score": score,
            "reason": "人工确认" if explicit else f"{node}·{weight:.2f}",
        })
    selected: list[dict[str, Any]] = []
    for candidate in sorted(candidates, key=lambda item: (-float(item["score"]), float(item["start"]))):
        if len(selected) >= maximum:
            break
        start = float(candidate["start"])
        if start < 1.15 or start > duration - 1.0:
            continue
        if any(abs(float(item["start"]) - start) < minimum_gap for item in selected):
            continue
        selected.append(candidate)
    if not selected and candidates:
        selected.append(max(candidates, key=lambda item: float(item["score"])))
    selected_by_index = {int(item["index"]): item for item in selected}
    for index, caption in enumerate(planned):
        selected_item = selected_by_index.get(index)
        caption["keywordSfx"] = selected_item is not None
        caption["keywordImportance"] = "primary" if selected_item is not None else "regular"
        if selected_item is not None:
            caption["keywordSfxReason"] = str(selected_item["reason"])
        else:
            caption.pop("keywordSfxReason", None)
    return planned


def finalize_template10_director_plan(captions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Apply the reference's restrained yellow-white bilingual direction.

    The spoken wording and timing remain immutable.  Large top callouts are
    sparse semantic beats, while every normal caption replaces the previous
    one instead of accumulating into a stack.
    """
    prepared = semantic_caption_plan(captions)
    duration = max((float(item.get("end") or 0.0) for item in prepared), default=0.0)
    maximum_callouts = max(1, math.ceil(duration / 60 * 7))
    callout_nodes = {"brand_entity", "core_viewpoint", "number_benefit", "example_step"}
    last_callout = -100.0
    callout_count = 0
    for index, caption in enumerate(prepared):
        text = re.sub(r"\s+", "", str(caption.get("text") or ""))
        node = str(caption.get("contentNode") or "supporting")
        keyword_locked = bool(caption.get("keywordLocked")) or str(caption.get("keywordOrigin") or "") in {
            "ai", "local", "none",
        }
        keyword = (
            str(caption.get("keyword") or "")
            if keyword_locked
            else ""
        )
        start = float(caption.get("start") or 0.0)
        strong = node in {"hook", "pain_reversal", "core_viewpoint", "number_benefit", "cta"}
        use_callout = bool(
            index > 1
            and node in callout_nodes
            and callout_count < maximum_callouts
            and start - last_callout >= 4.6
        )
        if use_callout:
            last_callout = start
            callout_count += 1
        caption.update({
            "keyword": keyword,
            "keywordLocked": keyword_locked,
            "role": "focus" if strong else "anchor",
            "emphasis": "strong" if strong else "normal",
            "layout": "center",
            "animation": "fade-rise",
            "captionStyle": "yellow-white-bilingual-anchor",
            "sectionEmphasis": use_callout,
            "displayEnd": round(float(caption.get("end") or start), 3),
        })
    return prepared


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


LOCAL_KEYWORD_CANDIDATES = (
    "商家入驻机会", "商家入驻", "酒店景区", "体育场馆", "激励翻倍", "首批类目", "第一批类目",
    "终端设备", "华为生态", "华为激励", "旅行社", "入驻机会", "华为", "生态",
    "效率提升", "岗位技能", "职场技能", "实用技能", "核心观点", "关键步骤", "解决问题",
    "人工智能", "数字化", "竞争力", "转化率", "获客", "成交", "利润", "成本",
    "效率", "提升", "增长", "收益", "优惠", "免费", "方法", "步骤", "重点",
    "结论", "价值", "专业", "真实", "服务", "品牌", "产品", "客户", "课程",
    "培训", "技能", "岗位", "基础", "实用", "咨询", "预约", "联系", "关注",
    "模板生成", "从哪开始", "下一步", "中智联", "钟智联", "一键网感", "AI超级剪辑",
    "AI剪辑", "口播视频工具", "口播视频",
)

KEYWORD_STOPWORDS = {
    "这个", "那个", "这些", "那些", "然后", "就是", "我们", "大家", "自己",
    "一个", "一些", "可以", "可能", "其实", "所以", "但是", "因为", "如果",
    "以及", "还是", "已经", "现在", "进行", "通过", "需要", "觉得", "感觉",
    "大家好", "你好", "我是", "我叫", "来自",
}

WEAK_STANDALONE_KEYWORDS = {
    "ai", "视频", "工具", "剪辑", "内容", "功能", "素材", "文案", "字幕", "codex",
}


def grounded_local_keyword(text: str, content_node: str = "supporting") -> str:
    """Return only a complete, grounded phrase; never slice the sentence midpoint."""
    compact = re.sub(r"[\s，。！？；：、,.!?;:]", "", text)
    if not compact:
        return ""
    if re.match(r"^(?:大家好|你好|我是|我叫|来自)", compact):
        return ""
    number = re.search(
        r"(?:(?:提升|增长|节省|降低|超过|达到)?\d+(?:\.\d+)?(?:%|％|折|元|万|倍|个|类|步|天|小时|分钟|项|种)|第[一二三四五六七八九十]+|[一二三四五六七八九十百千万]+(?:个|类|步|项|种))",
        compact,
    )
    if number and re.search(r"\d", number.group(0)):
        return number.group(0)
    for candidate in LOCAL_KEYWORD_CANDIDATES:
        if candidate in compact:
            return candidate
    if number and content_node in {"number_benefit", "example_step"}:
        return number.group(0)
    if (
        content_node in {"hook", "pain_reversal", "core_viewpoint", "number_benefit", "brand_entity", "cta"}
        and 2 <= len(compact) <= 4
        and compact not in KEYWORD_STOPWORDS
    ):
        return compact
    return ""


def validated_ai_keyword(
    text: str,
    keyword: str,
    content_node: str = "supporting",
    importance: float = 0.5,
) -> str:
    """Accept only an exact, informative span from the confirmed caption."""
    compact = re.sub(r"[\s，。！？；：、,.!?;:]", "", text)
    selected = re.sub(r"[\s，。！？；：、,.!?;:]", "", keyword)
    if not selected:
        return ""
    if selected not in compact or len(selected) > 8:
        return ""
    if len(selected) == 1 and not selected.isdigit():
        return ""
    if selected in KEYWORD_STOPWORDS:
        return ""
    if selected.lower() in WEAK_STANDALONE_KEYWORDS:
        return ""
    if selected[0] in "的了呢吗吧啊把被和与或就都也很在从" or selected[-1] in "的了呢吗吧啊着过和与或":
        return ""
    if len(selected) > 6 and content_node != "brand_entity":
        return ""
    if selected == compact and len(compact) > 5 and content_node != "brand_entity":
        return ""
    if re.search(r"大家好|你好|我是|我叫|来自", compact) and content_node == "brand_entity":
        return ""
    if content_node == "supporting" and max(0.0, min(1.0, importance)) < 0.72:
        return ""
    return selected


def safe_director_keyword(text: str, keyword: str, content_node: str = "supporting") -> str:
    """Keep AI emphasis visually selective instead of painting a whole line.

    The director may correctly identify a complete phrase semantically, but the
    red-white editorial template needs a much smaller accent span.  Long or
    four-character whole-line selections are therefore reduced to the local,
    deterministic core word while preserving the confirmed caption verbatim.
    """
    compact = re.sub(r"[\s，。！？；：、,.!?;:]", "", text)
    selected = re.sub(r"[\s，。！？；：、,.!?;:]", "", keyword)
    if not selected or len(selected) > 8 or selected not in compact:
        return ""
    selected = validated_ai_keyword(compact, selected, content_node, 1.0)
    if not selected:
        return ""
    covers_whole_line = selected == compact and len(compact) > 5
    if covers_whole_line:
        return ""
    return selected


def ai_select_caption_highlights(
    captions: list[dict[str, Any]],
    title: str = "",
) -> tuple[list[dict[str, Any]], str]:
    """Select one grounded emphasis phrase for every confirmed caption beat.

    The selected phrase must come from the user's confirmed caption verbatim;
    each visual template decides whether it is rendered in yellow, burgundy or
    another accent. Generation remains available when the upstream model is
    unavailable, so a deterministic local selector is retained as fallback.
    """
    prepared = [dict(item) for item in captions]
    for item in prepared:
        item["keyword"] = grounded_local_keyword(
            str(item.get("text") or ""),
            str(item.get("contentNode") or "supporting"),
        )
        item["keywordLocked"] = True
    if not AI_API_KEY or not prepared:
        return prepared, "grounded-local-keyword"

    source = [
        {
            "id": index,
            "text": str(item.get("text") or "").strip(),
            "content_node": str(item.get("contentNode") or "supporting"),
            "semantic_role": str(item.get("semanticRole") or "steady"),
        }
        for index, item in enumerate(prepared)
    ]
    prompt = f"""你是短视频字幕语义导演。请先理解整条口播的标题、上下文和内容节点，再判断每段是否需要提亮关键词。
标题：{title}
要求：
1. 只提亮真正承载信息的完整词组：核心观点、利益点、动作结果、数字、反差、品牌/产品名或行动号召。
2. keyword 必须是该段 text 中原样连续出现的文字，不能改写、补字或创造新词。
3. 通常选择2到5个字，品牌/产品名最多8个字；超过5字的普通句子禁止整句提亮，必须收缩到核心词组。
4. 禁止截取没有完整含义的半截词，例如“板生成”“升办公”；也不要把“不知道从哪开始”“模板生成检查”这种完整长句整句变色，应分别提取“从哪开始”“模板生成”一类核心短语。
5. 不要选择“这个、那个、然后、就是、我们、大家”等无信息量词语。
6. 普通过渡句、语气句、问候、自我介绍、工具来源和信息量不足的句子应返回空字符串，不要为了有颜色而强行提亮；整条视频通常只有约15%至35%的字幕出现提亮词。
7. “大家好、我是、codex、AI、视频、工具、剪辑”单独出现都不是关键词。像“我用codex做了一款”应返回空字符串，“AI剪辑口播视频的工具”可选择“AI剪辑”或“口播视频工具”。
8. 相邻字幕不要重复提亮同一个泛化词；品牌名、产品名确需连续强调时除外。
9. confidence 为0到1；只有你确信这是完整语义词组时才应高于0.62。
10. id、数量和顺序必须与输入完全一致。
11. 只返回JSON：{{"items":[{{"id":0,"keyword":"原文中的词组或空字符串","confidence":0.86,"category":"benefit/action/number/contrast/entity/cta/none"}}]}}。

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
        payload: dict[str, Any] | None = None
        last_request_error: Exception | None = None
        for attempt in range(HIGHLIGHT_AI_MAX_ATTEMPTS):
            try:
                with urllib.request.urlopen(request, timeout=HIGHLIGHT_AI_TIMEOUT_SECONDS) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                break
            except (
                urllib.error.URLError,
                http.client.RemoteDisconnected,
                ConnectionError,
                TimeoutError,
                OSError,
                json.JSONDecodeError,
            ) as request_error:
                last_request_error = request_error
                if attempt + 1 < HIGHLIGHT_AI_MAX_ATTEMPTS:
                    time.sleep(min(2.0, 0.5 * (2 ** attempt)))
        if payload is None:
            raise last_request_error or TimeoutError("字幕关键词 AI 请求未返回结果")
        raw = extract_provider_text(payload)
        cleaned = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        parsed = json.loads(cleaned)
        values = parsed.get("items") if isinstance(parsed, dict) else None
        if not isinstance(values, list):
            raise ValueError("标黄词结果格式无效")
        values_by_id = {
            int(value.get("id")): value
            for value in values
            if isinstance(value, dict) and str(value.get("id", "")).lstrip("-").isdigit()
        }
        selected_count = 0
        maximum_highlights = max(1, math.ceil(len(prepared) * 0.35))
        previous_keyword = ""
        for index, item in enumerate(prepared):
            value = values_by_id.get(index, {})
            text = re.sub(r"\s+", "", str(item.get("text") or ""))
            node = str(item.get("contentNode") or "supporting")
            raw_keyword = str(value.get("keyword") or "")
            raw_confidence = value.get("confidence")
            confidence = max(
                0.0,
                min(1.0, float(raw_confidence if raw_confidence is not None else (0.75 if raw_keyword else 0.0))),
            )
            keyword = validated_ai_keyword(text, raw_keyword, node, confidence)
            keyword_origin = "ai"
            if confidence < 0.62:
                keyword = ""
            if keyword and selected_count >= maximum_highlights:
                keyword = ""
            if keyword and keyword == previous_keyword and node not in {"brand_entity", "number_benefit"}:
                keyword = ""
            if keyword:
                selected_count += 1
                previous_keyword = keyword
            item["keyword"] = keyword
            item["keywordLocked"] = True
            item["keywordCategory"] = str(value.get("category") or "")[:24]
            item["keywordConfidence"] = round(confidence, 3)
            item["keywordOrigin"] = keyword_origin if keyword else "none"
        return prepared, f"ai-highlight:{AI_TITLE_MODEL}"
    except (urllib.error.URLError, http.client.RemoteDisconnected, ConnectionError, TimeoutError, OSError, json.JSONDecodeError, ValueError, TypeError) as error:
        print(
            f"caption highlight fallback: {type(error).__name__}: {error}",
            file=sys.stderr,
            flush=True,
        )
        return prepared, "grounded-local-keyword-fallback"


DIRECTOR_ALLOWED_NODES = {
    "hook", "pain_reversal", "core_viewpoint", "number_benefit",
    "example_step", "brand_entity", "cta", "supporting",
}
DIRECTOR_CATEGORY_BY_NODE = {
    "hook": "none",
    "pain_reversal": "contrast",
    "core_viewpoint": "none",
    "number_benefit": "number",
    "example_step": "action",
    "brand_entity": "entity",
    "cta": "cta",
    "supporting": "none",
}


def apply_shared_director_items(
    captions: list[dict[str, Any]],
    directed_items: list[dict[str, Any]] | None,
    title: str = "",
    content_director: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Ground one whole-video director plan back onto immutable captions.

    AI is only allowed to classify meaning and select a phrase already present
    in the confirmed transcript.  Template-specific caption, SFX, transition
    and camera implementations are applied afterwards by the local routers.
    """
    baseline = semantic_caption_plan(captions, title, content_director)
    values = (
        directed_items
        if isinstance(directed_items, list) and len(directed_items) == len(baseline)
        else []
    )
    maximum_highlights = max(1, math.ceil(len(baseline) * 0.35))
    enriched: list[dict[str, Any]] = []
    for index, source_caption in enumerate(baseline):
        caption = dict(source_caption)
        value = values[index] if values and isinstance(values[index], dict) else {}
        text = re.sub(r"\s+", "", str(caption.get("text") or ""))
        local_node = str(caption.get("contentNode") or "supporting")
        node = str(value.get("content_node") or local_node)
        if node not in DIRECTOR_ALLOWED_NODES:
            node = local_node
        if node == "number_benefit" and not (
            re.search(r"\d|[%％折元万倍]", text)
            or any(marker in text for marker in ("省", "提升", "增长", "效率", "收益", "优惠", "免费", "竞争力"))
        ):
            node = local_node
        raw_keyword = str(value.get("keyword") or "")
        try:
            confidence = max(0.0, min(1.0, float(value.get("confidence", 0.0))))
        except (TypeError, ValueError):
            confidence = 0.0
        try:
            importance = max(0.0, min(1.0, float(value.get("importance", 0.0))))
        except (TypeError, ValueError):
            importance = 0.0
        keyword = validated_ai_keyword(text, raw_keyword, node, importance) if raw_keyword else ""
        keyword_origin = "ai"
        if not values:
            keyword = ""
            confidence = 0.0
            keyword_origin = "none"
        if confidence < 0.62:
            keyword = ""
        if not values:
            importance = 0.82 if node in {"hook", "pain_reversal", "core_viewpoint", "number_benefit", "cta"} else 0.45
        requested_category = str(value.get("category") or "").strip().lower()
        compatible_categories = {
            "hook": {"none"},
            "pain_reversal": {"contrast"},
            "core_viewpoint": {"none"},
            "number_benefit": {"number", "benefit"},
            "example_step": {"action"},
            "brand_entity": {"entity"},
            "cta": {"cta"},
            "supporting": {"none"},
        }
        category = (
            requested_category
            if requested_category in compatible_categories[node]
            else DIRECTOR_CATEGORY_BY_NODE[node]
        )
        caption.update({
            "contentNode": node,
            "contentWeight": round(importance, 3),
            "keyword": keyword,
            "keywordLocked": True,
            "keywordCategory": category,
            "keywordConfidence": round(confidence, 3),
            "keywordOrigin": keyword_origin if keyword else "none",
        })
        if str(value.get("layout") or "") in {"center", "stack-left", "stack-right", "impact"}:
            caption["directorLayout"] = str(value["layout"])
        enriched.append(caption)
    node_priority = {
        "number_benefit": 8, "pain_reversal": 7, "core_viewpoint": 6,
        "cta": 5, "hook": 4, "example_step": 3, "brand_entity": 2, "supporting": 1,
    }
    highlighted = [index for index, item in enumerate(enriched) if str(item.get("keyword") or "").strip()]
    keep = set(sorted(
        highlighted,
        key=lambda index: (
            -float(enriched[index].get("contentWeight") or 0.0),
            -node_priority.get(str(enriched[index].get("contentNode") or "supporting"), 0),
            index,
        ),
    )[:maximum_highlights])
    previous_keyword = ""
    for index, item in enumerate(enriched):
        keyword = str(item.get("keyword") or "").strip()
        if index not in keep or (keyword and keyword == previous_keyword and str(item.get("contentNode") or "") not in {"brand_entity", "number_benefit"}):
            item["keyword"] = ""
            item["keywordOrigin"] = "none"
        elif keyword:
            previous_keyword = keyword
    return mark_keyword_sfx_emphasis(semantic_caption_plan(enriched, title, content_director))


def ai_direct_shared_captions(
    captions: list[dict[str, Any]],
    title: str = "",
    content_director: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], str]:
    """Classify the whole video once for all four published templates.

    One cached request replaces the former template-9 director request plus a
    second keyword request.  A short timeout and deterministic local fallback
    keep AI planning from blocking rendering.
    """
    fallback = apply_shared_director_items(captions, None, title, content_director)
    if not AI_API_KEY or not fallback:
        return fallback, "shared-local-director"
    source = [
        {
            "id": index,
            "start": round(float(item.get("start") or 0.0), 3),
            "end": round(float(item.get("end") or 0.0), 3),
            "text": str(item.get("text") or "").strip(),
        }
        for index, item in enumerate(fallback)
    ]
    cache_key = hashlib.sha256(json.dumps({
        "version": "shared-content-director-v3-semantic-sparse",
        "model": AI_TITLE_MODEL,
        "title": title,
        "captions": source,
    }, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    with DIRECTOR_PLAN_CACHE_LOCK:
        cached = DIRECTOR_PLAN_CACHE.get(cache_key)
    if cached is not None:
        return apply_shared_director_items(captions, cached, title, content_director), "shared-ai-director-cache"

    prompt = f"""你是竖屏口播短视频的内容导演。一次性理解整条口播，只输出可供模板引擎执行的语义方案。
禁止改写、删减、新增原文，禁止更改时间。AI不选择具体音效文件，也不决定字体和最终音量。

标题：{title}
字幕：{json.dumps(source, ensure_ascii=False)}

每段输出：
- id：与输入完全一致；
- content_node：hook/pain_reversal/core_viewpoint/number_benefit/example_step/brand_entity/cta/supporting；
- keyword：该段原文中连续出现的完整词组，通常2至5字，品牌最多8字；不重要则为空；
- confidence：0到1；
- category：benefit/action/number/contrast/entity/cta/none；
- importance：0到1，只有钩子、反差、结论、数字利益和行动号召适合高于0.72；
- layout：center/stack-left/stack-right/impact，仅是构图建议。

问候、自我介绍、工具来源和普通承接句不要提亮；“大家好、我是、codex、AI、视频、工具、剪辑”单独出现都不是关键词。
不要为了热闹而强行强调，整条视频通常仅15%至35%的字幕有关键词，允许只有1到3个。只返回JSON：
{{"items":[{{"id":0,"content_node":"hook","keyword":"原文词组","confidence":0.86,"category":"contrast","importance":0.9,"layout":"impact"}}]}}。"""
    request = urllib.request.Request(
        f"{AI_API_BASE_URL}/v1/chat/completions",
        data=json.dumps({
            "model": AI_TITLE_MODEL,
            "temperature": 0.1,
            "max_tokens": max(520, len(fallback) * 64),
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": "你只依据已确认口播输出严格、可验证的短视频语义导演JSON。"},
                {"role": "user", "content": prompt},
            ],
        }, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {AI_API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=DIRECTOR_AI_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
        raw = extract_provider_text(payload)
        cleaned = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        parsed = json.loads(cleaned)
        values = parsed.get("items") if isinstance(parsed, dict) else None
        if not isinstance(values, list) or len(values) != len(fallback):
            raise ValueError("共享导演结果数量不一致")
        for index, value in enumerate(values):
            if not isinstance(value, dict) or int(value.get("id", -1)) != index:
                raise ValueError("共享导演结果顺序不一致")
        with DIRECTOR_PLAN_CACHE_LOCK:
            if len(DIRECTOR_PLAN_CACHE) >= 128:
                DIRECTOR_PLAN_CACHE.pop(next(iter(DIRECTOR_PLAN_CACHE)))
            DIRECTOR_PLAN_CACHE[cache_key] = [dict(value) for value in values]
        return (
            apply_shared_director_items(captions, values, title, content_director),
            f"shared-ai-director:{AI_TITLE_MODEL}",
        )
    except (
        urllib.error.URLError, http.client.RemoteDisconnected, ConnectionError,
        TimeoutError, OSError, json.JSONDecodeError, ValueError, TypeError,
    ) as error:
        print(
            f"shared director fallback: {type(error).__name__}: {error}",
            file=sys.stderr,
            flush=True,
        )
        return fallback, "shared-local-director-fallback"


def finalize_template9_director_plan(
    captions: list[dict[str, Any]],
    directed_items: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Turn semantic decisions into a safe, deterministic visual timeline.

    AI may decide meaning, grouping and emphasis, but it never changes the
    user's wording or timing. This finalizer also makes the local fallback and
    the AI path obey the same visual contract.
    """
    prepared = semantic_caption_plan(captions)
    allowed_nodes = {
        "hook", "pain_reversal", "core_viewpoint", "number_benefit",
        "example_step", "brand_entity", "cta", "supporting",
    }
    allowed_layouts = {"center", "stack-left", "stack-right", "impact"}
    values = directed_items if isinstance(directed_items, list) and len(directed_items) == len(prepared) else []
    current_block = 0
    block_size = 0
    previous_node = ""
    for index, caption in enumerate(prepared):
        value = values[index] if values and isinstance(values[index], dict) else {}
        text = re.sub(r"\s+", "", str(caption.get("text") or ""))
        node = str(value.get("content_node") or caption.get("contentNode") or "supporting")
        if node not in allowed_nodes:
            node = str(caption.get("contentNode") or "supporting")
        if node == "number_benefit":
            explicit_number_or_benefit = bool(
                re.search(r"\d|\d+(?:\.\d+)?[%折元万+]|[一二三四五六七八九十百千万]+个|第[一二三四五六七八九十]", text)
                or any(marker in text for marker in ("省", "提升", "增长", "效率", "收益", "优惠", "免费", "竞争力"))
            )
            if not explicit_number_or_benefit:
                node = "supporting"
        requested_block = value.get("block_id")
        should_break = bool(
            index == 0
            or block_size >= 3
            or node in {"hook", "cta"}
            or previous_node in {"hook", "cta"}
            or (previous_node and node != previous_node and node not in {"supporting", "brand_entity"})
        )
        if requested_block is not None and index > 0:
            try:
                should_break = should_break or int(requested_block) > current_block
            except (TypeError, ValueError):
                pass
        if should_break:
            current_block = 0 if index == 0 else current_block + 1
            block_size = 0
        layout = str(value.get("layout") or "")
        if layout not in allowed_layouts:
            layout = "center" if node in {"hook", "core_viewpoint", "number_benefit", "cta"} else ("stack-left" if current_block % 2 == 0 else "stack-right")
        requested_keyword = str(value.get("keyword") or caption.get("keyword") or "")
        semantic_keyword_decided = bool(caption.get("keywordLocked")) or str(caption.get("keywordOrigin") or "") in {
            "ai", "local", "none",
        }
        keyword = (
            safe_director_keyword(text, requested_keyword, node)
            if requested_keyword
            else "" if semantic_keyword_decided else grounded_local_keyword(text, node)
        )
        strong = str(value.get("emphasis") or "") == "strong" or node in {"hook", "pain_reversal", "core_viewpoint", "number_benefit", "cta"}
        caption.update({
            "contentNode": node,
            "semanticRole": {
                "pain_reversal": "reversal", "core_viewpoint": "conclusion",
                "number_benefit": "number", "example_step": "step",
                "brand_entity": "brand", "supporting": "steady",
            }.get(node, node),
            "keyword": keyword,
            "keywordLocked": True,
            "blockId": current_block,
            "blockSlot": block_size,
            "layout": layout,
            "emphasis": "strong" if strong else "normal",
            "role": "focus" if strong else "anchor",
            "captionStyle": "red-white-editorial-stack",
            "animation": "keyword-hit" if strong else "fade-rise",
        })
        block_size += 1
        previous_node = node

    blocks: dict[int, list[dict[str, Any]]] = {}
    for caption in prepared:
        blocks.setdefault(int(caption.get("blockId") or 0), []).append(caption)
    for block_id, block in blocks.items():
        lead = block[0]
        lead_node = str(lead.get("contentNode") or "supporting")
        block_layout = (
            "impact"
            if lead_node in {"hook", "cta"}
            else "center"
            if lead.get("emphasis") == "strong" or lead_node in {"pain_reversal", "core_viewpoint", "number_benefit"}
            else ("stack-left" if block_id % 2 == 0 else "stack-right")
        )
        for item in block:
            # Template 9 is directed as a sequence of semantic beats rather
            # than a growing subtitle stack. Keeping old lines on screen made
            # three-cue groups visually congested and weakened the spoken
            # rhythm. Each cue now owns its exact speech window while the
            # shared block still controls the visual family.
            item["displayEnd"] = round(float(item.get("end") or 0.0), 3)
            item["blockSlot"] = 0
            item["blockSize"] = 1
            item["layout"] = block_layout
    return prepared


def ai_direct_template9_captions(
    captions: list[dict[str, Any]],
    title: str = "",
    content_director: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], str]:
    """Backward-compatible template-9 wrapper over the shared director."""
    directed, source = ai_direct_shared_captions(captions, title, content_director)
    items = [
        {
            "content_node": item.get("contentNode"),
            "keyword": item.get("keyword"),
            "layout": item.get("directorLayout"),
            "emphasis": "strong" if float(item.get("contentWeight") or 0.0) >= 0.72 else "normal",
        }
        for item in directed
    ]
    return finalize_template9_director_plan(directed, items), source


def build_input_adaptation_profile(
    metadata: dict[str, Any],
    scene_changes: list[float],
) -> dict[str, Any]:
    """Describe how strongly a template may reshape the supplied footage.

    A static talking-head source benefits from editorial reframing, while a
    source that already contains frequent cuts should keep its own visual
    grammar.  Non-portrait footage is fitted without destructive centre crops.
    The returned profile is written into the timeline so the render and review
    report can explain the decision instead of treating every upload alike.
    """
    width = max(1, int(metadata.get("width") or 1))
    height = max(1, int(metadata.get("height") or 1))
    duration = max(0.1, float(metadata.get("duration") or 0.1))
    aspect_ratio = width / height
    cuts_per_minute = len(scene_changes) / duration * 60
    if cuts_per_minute >= 9:
        activity = "dynamic-source"
        camera_strength = 0.32
        transition_density = 0.48
    elif cuts_per_minute >= 4:
        activity = "balanced-source"
        camera_strength = 0.66
        transition_density = 0.74
    else:
        activity = "static-talking-head"
        camera_strength = 1.0
        transition_density = 1.0
    source_fit = "cover" if aspect_ratio <= 0.72 else "contain-blur"
    return {
        "activity": activity,
        "sourceFit": source_fit,
        "aspectRatio": round(aspect_ratio, 4),
        "sceneChangeCount": len(scene_changes),
        "sceneChangesPerMinute": round(cuts_per_minute, 2),
        "cameraStrength": camera_strength,
        "transitionDensity": transition_density,
        "preserveSourceCuts": activity != "static-talking-head",
    }


def plan_semantic_transition_cues(
    captions: list[dict[str, Any]],
    scene_changes: list[float],
    pause_candidates: list[float],
    rhythm_candidates: list[float],
    duration: float,
    template: dict[str, Any],
    adaptation: dict[str, Any],
) -> list[dict[str, Any]]:
    """Direct a mixed camera language from the spoken structure.

    A transition is a change of shot intention, not a coloured overlay.  Each
    semantic role therefore owns a camera action and a long video deliberately
    alternates several actions.  Low-value phrase starts only fill large dead
    zones, so the result stays alive without changing framing on every caption.
    """
    source_activity = str(adaptation.get("activity") or "legacy")
    source_scene_count = int(adaptation.get("sceneChangeCount") or len(scene_changes))
    transition_direction = template.get("transition_direction")
    transition_direction = transition_direction if isinstance(transition_direction, dict) else {}
    # A page turn only makes editorial sense when there is an actual visual
    # chapter to reveal.  For a single-camera talking head it merely folds the
    # same face over itself, so route that beat to a deliberate reframe cut.
    # Page turns are opt-in.  They only read as an editorial transition when
    # there are two genuinely different scenes to connect; folding one frame
    # of a talking head over another is visually false and has been removed
    # from the published 9-12 template language.
    allow_page_turn = (
        bool(transition_direction.get("allow_page_turn", False))
        and source_activity != "static-talking-head"
        and source_scene_count > 0
    )
    default_node_rules = {
        "pain_reversal": ("jump-reframe", "观点反转·跳切换构图", 94, 0.30, 0.82),
        "core_viewpoint": ("focus-rack", "核心观点·焦点由虚到实", 92, 0.46, 0.78),
        "number_benefit": ("camera-punch-in", "数字利益点·短促推近", 88, 0.42, 0.82),
        "example_step": (
            "page-turn" if allow_page_turn else "jump-reframe",
            "举例步骤·翻页换章" if allow_page_turn else "举例步骤·换构图进入下一章",
            86, 0.52 if allow_page_turn else 0.34, 0.76,
        ),
        "brand_entity": ("focus-lock", "品牌主体·重新居中锁焦", 80, 0.40, 0.70),
        "cta": ("closing-push", "行动号召·缓慢推近收束", 90, 0.56, 0.82),
    }
    transition_profile = template.get("transition_profile")
    transition_profile = transition_profile if isinstance(transition_profile, list) else []
    reason_by_node = {
        "hook": "开场钩子·建立主镜头",
        "pain_reversal": "观点反转·切换构图",
        "core_viewpoint": "核心观点·重新锁定焦点",
        "number_benefit": "数字利益点·短促强调",
        "example_step": "举例步骤·进入下一章节",
        "brand_entity": "品牌主体·居中确认",
        "cta": "行动号召·收束镜头",
        "supporting": "补充信息·恢复呼吸",
    }
    priority_by_node = {
        "hook": 96, "pain_reversal": 94, "core_viewpoint": 92,
        "number_benefit": 88, "example_step": 86, "brand_entity": 80,
        "cta": 90, "supporting": 48,
    }
    node_rules = dict(default_node_rules)
    for configured in transition_profile:
        if not isinstance(configured, dict):
            continue
        style = str(configured.get("style") or "").strip()
        if style == "page-turn" and not allow_page_turn:
            style = "jump-reframe"
        nodes = configured.get("nodes") if isinstance(configured.get("nodes"), list) else []
        if not style:
            continue
        for node in nodes:
            node_name = str(node).strip()
            if not node_name:
                continue
            node_rules[node_name] = (
                style,
                reason_by_node.get(node_name, "语义节点·导演换镜"),
                priority_by_node.get(node_name, 72),
                max(.18, min(.72, float(configured.get("duration") or .42))),
                max(.05, min(1.0, float(configured.get("intensity") or .68))),
            )
    explicit_transition_styles = {
        "cut": ("jump-reframe", "AI导演·直接换构图", 98, .24, .78),
        "matched-reframe": ("reframe-cut", "AI导演·匹配重构图", 97, .30, .76),
        "focus-bridge": ("focus-rack", "AI导演·焦点桥接", 97, .46, .76),
        # The renderer has no fake brush/page overlay for this intent. A short
        # focus lock reads as an occluding foreground passing the lens without
        # covering the speaker with a decorative wipe.
        "foreground-occlusion": ("focus-lock", "AI导演·前景遮挡后锁焦", 96, .38, .72),
    }
    camera_intent_styles = {
        "push-in": ("camera-punch-in", "AI导演·推近重点", 93, .42, .76),
        "close-up": ("camera-punch-in", "AI导演·切入近景", 93, .38, .80),
        "pull-back": ("pullback-reset", "AI导演·拉远复位", 91, .44, .66),
        "wide": ("pullback-reset", "AI导演·建立宽景", 90, .44, .64),
        "reframe": ("jump-reframe", "AI导演·重新构图", 92, .30, .72),
    }
    candidates: list[dict[str, Any]] = []
    for point in scene_changes:
        candidates.append({
            "start": float(point), "style": "source-cut", "reason": "原片镜头切换",
            "trigger": "source-scene-change", "priority": 100, "duration": 0.20, "intensity": 0.28,
        })
    for caption in captions:
        node = str(caption.get("contentNode") or "")
        transition_intent = str(caption.get("transitionIntent") or "").strip()
        camera_intent = str(caption.get("cameraIntent") or "").strip()
        if transition_intent in explicit_transition_styles:
            style, reason, priority, cue_duration, intensity = explicit_transition_styles[transition_intent]
        elif transition_intent == "none" and camera_intent in {"", "hold"}:
            continue
        elif camera_intent in camera_intent_styles:
            style, reason, priority, cue_duration, intensity = camera_intent_styles[camera_intent]
        elif node in node_rules:
            style, reason, priority, cue_duration, intensity = node_rules[node]
        else:
            continue
        candidates.append({
            "start": float(caption.get("start") or 0.0), "style": style, "reason": reason,
            "trigger": transition_intent or camera_intent or node,
            "priority": priority, "duration": cue_duration, "intensity": intensity,
        })
    for point in pause_candidates:
        candidates.append({
            "start": float(point),
            "style": "page-turn" if allow_page_turn else "jump-reframe",
            "reason": "长停顿·翻页换章" if allow_page_turn else "长停顿·构图换章",
            "trigger": "long-pause", "priority": 64,
            "duration": 0.52 if allow_page_turn else 0.34, "intensity": 0.66,
        })
    for point in rhythm_candidates:
        candidates.append({
            "start": float(point), "style": "pullback-reset", "reason": "节奏补点·拉远复位",
            "trigger": "rhythm", "priority": 26, "duration": 0.44, "intensity": 0.50,
        })

    # Guarantee a complete shot arc even when AI labels only one or two strong
    # semantic nodes.  The points still snap to real phrase starts, never to a
    # word in progress.  These candidates lose to explicit editorial nodes.
    phrase_starts = sorted({
        round(float(caption.get("start") or 0.0), 3)
        for caption in captions
        if 0.8 <= float(caption.get("start") or 0.0) <= duration - 0.8
    })
    coverage_styles = [
        (0.20, "camera-punch-in", "导演补镜·建立近景", 0.40, 0.64),
        (0.40, "page-turn", "导演补镜·进入下一章", 0.50, 0.62),
        (0.60, "focus-rack", "导演补镜·重新锁定重点", 0.44, 0.60),
        (0.78, "pullback-reset", "导演补镜·拉远复位", 0.46, 0.56),
    ]
    configured_coverage = transition_direction.get("coverage_cycle")
    if isinstance(configured_coverage, list) and configured_coverage:
        rebuilt_coverage = []
        for index, configured in enumerate(configured_coverage[:4]):
            if not isinstance(configured, dict) or not str(configured.get("style") or "").strip():
                continue
            rebuilt_coverage.append((
                max(.12, min(.88, float(configured.get("ratio") or (.20 + index * .20)))),
                str(configured.get("style")),
                str(configured.get("reason") or "导演补镜·保持画面动态"),
                max(.18, min(.72, float(configured.get("duration") or .44))),
                max(.05, min(1.0, float(configured.get("intensity") or .60))),
            ))
        if rebuilt_coverage:
            coverage_styles = rebuilt_coverage
    for ratio, style, reason, cue_duration, intensity in coverage_styles:
        if not phrase_starts:
            break
        if style == "page-turn" and not allow_page_turn:
            style = "jump-reframe"
            reason = "导演补镜·换构图进入下一章"
            cue_duration = min(cue_duration, .34)
        target = duration * ratio
        point = min(phrase_starts, key=lambda value: abs(value - target))
        candidates.append({
            "start": point, "style": style, "reason": reason,
            "trigger": "director-coverage", "priority": 48,
            "duration": cue_duration, "intensity": intensity,
        })

    minimum_gap = max(2.4, float(template.get("minimum_transition_gap_seconds") or 4.8))
    density = max(0.35, min(1.0, float(adaptation.get("transitionDensity") or 1.0)))
    maximum = max(1, math.ceil(
        max(1.0, duration) / 60
        * float(template.get("maximum_effects_per_minute") or 7)
        * density
    ))
    target_minimum = min(maximum, 2 if duration < 12 else 3 if duration < 18 else 5 if duration < 45 else 8)
    usable = [item for item in candidates if 0.8 <= item["start"] <= duration - 0.8]
    selected: list[dict[str, Any]] = []
    # Higher-value editorial events claim a time slot first.  Source cuts win
    # collisions, so the template never stacks a synthetic wipe on an existing
    # edit from the uploaded video.
    for candidate in sorted(usable, key=lambda item: (-int(item["priority"]), float(item["start"]))):
        if any(abs(float(candidate["start"]) - float(item["start"])) < minimum_gap for item in selected):
            continue
        selected.append(candidate)
        if len(selected) >= maximum:
            break
    if len(selected) < target_minimum:
        for candidate in sorted(usable, key=lambda item: float(item["start"])):
            if candidate in selected:
                continue
            relaxed_gap = max(1.9, minimum_gap * .72)
            if any(abs(float(candidate["start"]) - float(item["start"])) < relaxed_gap for item in selected):
                continue
            selected.append(candidate)
            if len(selected) >= target_minimum:
                break

    # A speech-led piece longer than 18 seconds needs at least one clear
    # chapter change.  If the transcript contains no example/step label, use
    # the nearest real phrase start around the first third of the video.  This
    # keeps the edit varied without cutting through a spoken phrase.
    if allow_page_turn and duration >= 18 and not any(str(item.get("style")) == "page-turn" for item in selected):
        page_candidates = [item for item in usable if str(item.get("style")) == "page-turn" and item not in selected]
        for candidate in sorted(page_candidates, key=lambda item: abs(float(item["start"]) - duration * .36)):
            if any(abs(float(candidate["start"]) - float(item["start"])) < 1.9 for item in selected):
                continue
            if len(selected) < maximum:
                selected.append(candidate)
            else:
                replaceable = next((
                    item for item in selected
                    if str(item.get("style")) not in {"source-cut", "closing-push"}
                    and sum(str(peer.get("style")) == str(item.get("style")) for peer in selected) > 1
                ), None)
                if replaceable is None:
                    replaceable = min(
                        (
                            item for item in selected
                            if str(item.get("style")) not in {"source-cut", "closing-push"}
                            and abs(float(item.get("start") or 0.0) - float(candidate["start"])) >= 1.9
                        ),
                        key=lambda item: (int(item.get("priority") or 0), -abs(float(item["start"]) - duration * .36)),
                        default=None,
                    )
                if replaceable is not None:
                    selected.remove(replaceable)
                    selected.append(candidate)
            break

    selected = sorted(selected, key=lambda item: float(item["start"]))
    # Never repeat one synthetic camera action back-to-back.  Reframe/reset is
    # the neutral alternate when the transcript contains repeated node types.
    neutral_cycle = transition_direction.get("dedupe_cycle")
    if not isinstance(neutral_cycle, list) or not neutral_cycle:
        neutral_cycle = ["pullback-reset", "jump-reframe", "focus-rack"]
    neutral_cycle = [str(item) for item in neutral_cycle if str(item).strip()]
    previous_style = ""
    neutral_index = 0
    for item in selected:
        style = str(item["style"])
        if style == previous_style and style != "source-cut":
            replacement = neutral_cycle[neutral_index % len(neutral_cycle)]
            neutral_index += 1
            item["style"] = replacement
            item["reason"] = f"镜头节奏去重·{replacement}"
        previous_style = str(item["style"])
    # Five visible beats should not collapse into one repeated camera move.
    # Prefer an unused framing action while preserving source cuts and the
    # closing push.  This makes a static talking-head input feel directed
    # instead of mechanically zooming in and out on a loop.
    used_styles: set[str] = set()
    for item in selected:
        style = str(item["style"])
        if style in used_styles and style not in {"source-cut", "closing-push"}:
            replacement = next((
                candidate for candidate in neutral_cycle
                if candidate not in used_styles
                and candidate != "page-turn"
                and candidate != style
            ), "")
            if replacement:
                item["style"] = replacement
                item["reason"] = f"导演镜头去重·{replacement}"
                item["duration"] = min(float(item.get("duration") or .42), .34) \
                    if replacement in {"jump-reframe", "reframe-cut"} \
                    else max(float(item.get("duration") or .42), .44)
                style = replacement
        used_styles.add(style)
    if allow_page_turn and duration >= 18 and not any(str(item.get("style")) == "page-turn" for item in selected):
        chapter_item = min(
            (
                item for item in selected
                if str(item.get("style")) not in {"source-cut", "closing-push"}
                and duration * .28 <= float(item.get("start") or 0.0) <= duration * .68
            ),
            # Prefer a low-value supporting/coverage beat near the chapter
            # boundary.  Explicit source cuts and the final CTA stay intact.
            key=lambda item: (
                0 if str(item.get("trigger")) in {"director-coverage", "supporting", "rhythm"} else 1,
                int(item.get("priority") or 0),
                abs(float(item["start"]) - duration * .44),
            ),
            default=None,
        )
        if chapter_item is not None:
            chapter_item["style"] = "page-turn"
            chapter_item["duration"] = 0.52
            chapter_item["reason"] = "导演补镜·翻页换章"
    return [
        {
            "start": round(float(item["start"]), 3),
            "style": str(item["style"]),
            "reason": str(item["reason"]),
            "trigger": str(item["trigger"]),
            "duration": round(float(item["duration"]), 3),
            "intensity": round(float(item["intensity"]), 3),
        }
        for item in selected
    ]


def measure_integrated_loudness(source: Path, seconds: float = 20.0) -> float | None:
    """Quickly sample integrated loudness without adding a full decode pass."""
    if not source.is_file() or not shutil.which("ffmpeg"):
        return None
    try:
        completed = subprocess.run(
            [
                check_binary("ffmpeg"), "-hide_banner", "-nostats", "-t", f"{max(3.0, seconds):.2f}",
                "-i", str(source), "-vn",
                "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
                "-f", "null", "-",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=max(15.0, seconds * 2.0),
        )
        match = re.search(r'"input_i"\s*:\s*"([+-]?(?:\d+(?:\.\d+)?|inf))"', completed.stderr or "")
        if not match or "inf" in match.group(1).lower():
            return None
        return float(match.group(1))
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def build_audio_mix_profile(
    source: Path,
    sfx_file: Path,
    selected_bgm: dict[str, Any] | None,
    template: dict[str, Any],
) -> dict[str, Any]:
    """Create one speech-first loudness policy shared by templates 9-12."""
    mix_direction = template.get("mix_direction")
    mix_direction = mix_direction if isinstance(mix_direction, dict) else {}
    speech_lufs = measure_integrated_loudness(source)
    speech_target = max(-20.0, min(-14.0, float(mix_direction.get("speech_target_lufs") or -17.0)))
    speech_adjustment = 1.0 if speech_lufs is None else 10 ** ((speech_target - speech_lufs) / 20)
    source_volume = max(0.72, min(1.35, speech_adjustment * float(template.get("speech_gain") or 1.0)))
    music_file = str((selected_bgm or {}).get("file") or "").strip()
    music_path = (REMOTION_WORKER_DIR / "public" / music_file).resolve() if music_file else Path()
    music_lufs = measure_integrated_loudness(music_path) if music_file else None
    music_reference = max(-20.0, min(-10.0, float(mix_direction.get("music_reference_lufs") or -14.0)))
    music_adjustment = 1.0 if music_lufs is None else 10 ** ((music_reference - music_lufs) / 20)
    # All templates now share the same speech-safe bed.  Asset loudness only
    # contributes a bounded correction; a template may no longer be twice as
    # loud merely because its source MP3 was mastered differently.
    bgm_base = max(.04, min(.16, float(mix_direction.get("bgm_speech_volume") or .085)))
    bgm_speech_volume = max(0.055, min(0.115, bgm_base * music_adjustment))
    return {
        "standard": str(mix_direction.get("standard") or "speech-first-v2"),
        "speechTargetLufs": speech_target,
        "speechMeasuredLufs": speech_lufs,
        "sourceVolume": round(source_volume, 3),
        "bgmReferenceLufs": music_reference,
        "bgmMeasuredLufs": music_lufs,
        "bgmSpeechVolume": round(bgm_speech_volume, 3),
        "bgmGapVolume": round(min(0.13, bgm_speech_volume * max(1.0, min(1.35, float(mix_direction.get("gap_lift") or 1.18)))), 3),
        "truePeakCeilingDb": max(-3.0, min(-.5, float(mix_direction.get("true_peak_ceiling_db") or -1.5))),
        "sfxBusVolume": 1.0 if sfx_file.is_file() else 0.0,
    }


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
    transition_plan: list[dict[str, Any]] | None = None,
    input_adaptation: dict[str, Any] | None = None,
) -> Path:
    current_template = template_profile(template_id)
    usable_captions = [dict(item) for item in captions if str(item.get("text") or "").strip()]
    caption_mode = str(current_template.get("caption_mode") or "classic")
    if caption_mode in {"kinetic-red-white", "kinetic-yellow-white", "kinetic-mint-white", "kinetic-bold-yellow-white"} or bool(current_template.get("word_highlight")):
        for caption in usable_captions:
            text = str(caption.get("text") or "").strip()
            if not caption.get("keywordLocked"):
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
    elif template_id in {"viral-pulse", "template-2", "template-3", "template-4", "template-5", "template-6", "template-7", "template-8", "template-9", "template-10", "template-11", "template-12"}:
        if template_id == "template-9" and not all(item.get("blockId") is not None for item in usable_captions):
            # Rendering is deterministic: a missing block layout is repaired
            # locally from the already-confirmed director plan. The render
            # node never makes a late model request.
            shared_captions = apply_shared_director_items(
                usable_captions,
                None,
                title,
                current_template.get("content_director"),
            )
            directed_items = [
                {
                    "content_node": item.get("contentNode"),
                    "keyword": item.get("keyword"),
                    "layout": item.get("directorLayout"),
                    "emphasis": "strong" if float(item.get("contentWeight") or 0.0) >= .72 else "normal",
                }
                for item in shared_captions
            ]
            usable_captions = finalize_template9_director_plan(shared_captions, directed_items)
        elif template_id == "template-10":
            usable_captions = finalize_template10_director_plan(usable_captions)
        elif not all(str(item.get("contentNode") or "").strip() for item in usable_captions):
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
    if template_id in {"template-9", "template-10", "template-11", "template-12"}:
        # A transition must change the composition, not merely flash for a few
        # frames.  Keep one camera framing until the next semantic transition
        # and cut to a visibly different scale/origin at that exact timestamp.
        # This also gives templates 11 and 12 the camera cues they previously
        # never received.
        configured_scales = current_template.get("camera_scale_steps")
        configured_origins = current_template.get("camera_origin_steps")
        configured_camera_max = max(1.0, min(1.32, float(current_template.get("camera_scale_max") or 1.24)))
        camera_scales = (
            [max(1.0, min(configured_camera_max, float(value))) for value in configured_scales]
            if isinstance(configured_scales, list) and configured_scales
            else [1.0, 1.065, 1.025, 1.085]
        )
        camera_origins = (
            [str(value) for value in configured_origins if str(value).strip()]
            if isinstance(configured_origins, list) and configured_origins
            else ["50% 43%", "47% 42%", "53% 43%", "50% 41.5%"]
        )
        camera_strength = max(0.25, min(1.0, float((input_adaptation or {}).get("cameraStrength") or 1.0)))
        camera_scales = [round(1.0 + (value - 1.0) * camera_strength, 4) for value in camera_scales]
        section_points = sorted({
            max(0.0, min(duration, float(point)))
            for point in (
                [float(item.get("start") or 0.0) for item in transition_plan]
                if transition_plan
                else (transition_points or [])
            )
            if 0.18 < float(point) < duration - 0.18
        })
        transition_by_start = {
            round(float(item.get("start") or 0.0), 3): item
            for item in (transition_plan or [])
        }
        if not transition_by_start:
            configured_camera_transitions = current_template.get("transition_profile")
            configured_camera_transitions = (
                configured_camera_transitions
                if isinstance(configured_camera_transitions, list)
                else []
            )
            configured_camera_styles = [
                str(item.get("style") or "")
                for item in configured_camera_transitions
                if isinstance(item, dict) and str(item.get("style") or "").strip()
            ]
            if configured_camera_styles:
                transition_by_start = {
                    round(point, 3): {"style": configured_camera_styles[index % len(configured_camera_styles)]}
                    for index, point in enumerate(section_points)
                }
        section_starts = [0.0, *section_points]
        section_ends = [*section_points, duration]
        current_scale = camera_scales[0]
        current_origin = camera_origins[0]
        camera_language = current_template.get("camera_language")
        camera_language = camera_language if isinstance(camera_language, dict) else {}
        style_states = camera_language.get("style_states")
        style_states = style_states if isinstance(style_states, dict) else {}
        for section_index, (section_start, section_end) in enumerate(zip(section_starts, section_ends)):
            if section_end - section_start < 0.08:
                continue
            transition_item = transition_by_start.get(round(section_start, 3), {})
            transition_item = transition_item if isinstance(transition_item, dict) else {"style": str(transition_item)}
            transition_style = str(transition_item.get("style") or "")
            direction = -1 if section_index % 2 else 1
            configured_state = style_states.get(transition_style)
            camera_move = "snap"
            camera_ease = .14
            if isinstance(configured_state, dict):
                configured_scale = max(1.0, min(configured_camera_max, float(configured_state.get("scale") or current_scale)))
                current_scale = round(1.0 + (configured_scale - 1.0) * camera_strength, 4)
                origins = configured_state.get("origins")
                if isinstance(origins, list) and origins:
                    current_origin = str(origins[section_index % len(origins)])
                else:
                    current_origin = str(configured_state.get("origin") or current_origin)
                camera_move = str(configured_state.get("move") or "snap")
                if camera_move not in {"cut", "snap", "smooth"}:
                    camera_move = "snap"
                camera_ease = max(.04, min(.42, float(configured_state.get("ease_seconds") or (.06 if camera_move == "cut" else .14 if camera_move == "snap" else .30))))
            elif transition_style in {"camera-punch-in", "closing-push"}:
                current_scale = min(1.14, max(current_scale + .045, 1.065))
                current_origin = "50% 42%"
            elif transition_style == "focus-rack":
                current_scale = max(1.035, min(current_scale, 1.075))
                current_origin = "50% 42.5%"
            elif transition_style == "focus-lock":
                current_scale = 1.04
                current_origin = "50% 43%"
            elif transition_style == "page-turn":
                current_scale = 1.018 if current_scale > 1.055 else 1.065
                current_origin = "48% 42%" if direction < 0 else "52% 42%"
            elif transition_style in {"jump-reframe", "reframe-cut"}:
                current_scale = 1.045
                current_origin = "47% 42%" if direction < 0 else "53% 42%"
            elif transition_style == "pullback-reset":
                current_scale = 1.008
                current_origin = "50% 43%"
            elif transition_style == "source-cut":
                current_scale = min(current_scale, 1.025)
                current_origin = "50% 43%"
            camera_cues.append({
                "start": round(section_start, 3),
                "end": round(section_end, 3),
                "scale": round(current_scale, 4),
                "origin": current_origin,
                "style": transition_style or "wide-hold",
                "move": camera_move if transition_style else "cut",
                "easeDuration": round(camera_ease if transition_style else .04, 3),
                "reason": str(transition_item.get("reason") or "保持当前景别")[:40],
            })
    elif template_id == "viral-pulse":
        # Template 1 keeps the energetic caption treatment, but camera changes
        # happen per semantic pair instead of on every spoken line. This avoids
        # the mechanical push-in rhythm that made the previous version tiring.
        block_scales = [1.0, 1.014, 1.006, 1.018]
        block_origins = ["50% 43%", "49% 43%", "51% 43%", "50% 42.5%"]
        for block_index, caption in enumerate(usable_captions[::2]):
            end_caption = usable_captions[min(block_index * 2 + 1, len(usable_captions) - 1)]
            camera_cues.append({
                "start": round(max(0.0, float(caption.get("start") or 0.0)), 3),
                "end": round(min(duration, float(end_caption.get("end") or duration)), 3),
                "scale": block_scales[block_index % len(block_scales)],
                "origin": block_origins[block_index % len(block_origins)],
            })
    elif template_id in {"template-2", "template-3", "template-4", "template-5", "template-6", "template-7", "template-8"}:
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
        "editorial-cut", "editorial-wipe", "source-cut", "semantic-cut",
        "depth-push", "contrast-cut", "clean-wipe",
        "red-white-snap", "yellow-brush-wipe", "cyan-panel-slide", "focus-iris-cut",
        "camera-punch-in", "closing-push", "pullback-reset", "jump-reframe",
        "focus-rack", "focus-lock", "page-turn", "reframe-cut",
    }
    transition_cues: list[dict[str, Any]] = []
    if transition_plan:
        for cue in transition_plan:
            style = str(cue.get("style") or "semantic-cut")
            transition_cues.append({
                "start": round(float(cue.get("start") or 0.0), 3),
                "duration": round(max(.18, min(.56, float(cue.get("duration") or .26))), 3),
                "style": style if style in allowed_transition_styles else "semantic-cut",
                "intensity": round(max(.05, min(1.0, float(cue.get("intensity") or .55))), 3),
                "reason": str(cue.get("reason") or "语义换章")[:40],
                "trigger": str(cue.get("trigger") or "semantic")[:40],
            })
    else:
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
            minimum_intensity = .05 if template_id in {"template-9", "template-10", "template-11", "template-12", "viral-pulse"} else .3
            transition_cues.append({
                "start": round(float(point), 3),
                "duration": round(max(.18, min(.48, float(configured.get("duration") or .32))), 3),
                "style": style,
                "intensity": round(max(minimum_intensity, min(1.0, float(configured.get("intensity") or .7))), 3),
                "reason": "兼容模板节奏点",
                "trigger": content_node or semantic_role or "legacy",
            })
    bgm_tracks = current_template.get("bgm_tracks")
    if not isinstance(bgm_tracks, list):
        bgm_tracks = []
    selected_bgm = None
    if include_bgm:
        selected_bgm = select_content_music(bgm_tracks, title, usable_captions, f"{folder.name}:{duration:.3f}")
    audio_mix = build_audio_mix_profile(source, sfx_file, selected_bgm, current_template)
    focus_cues: list[dict[str, Any]] = []
    if template_id == "template-12" and usable_captions:
        semantic_candidates = [
            caption for caption in usable_captions
            if str(caption.get("contentNode") or "") in {"example_step", "core_viewpoint"}
            and duration * .48 <= float(caption.get("start") or 0.0) <= duration * .84
        ]
        anchor = semantic_candidates[0] if semantic_candidates else usable_captions[min(len(usable_captions) - 1, max(0, round(len(usable_captions) * .66)))]
        anchor_index = usable_captions.index(anchor)
        end_index = min(len(usable_captions) - 1, anchor_index + 2)
        focus_start = float(anchor.get("start") or 0.0)
        focus_end = min(duration - .35, max(focus_start + 3.2, float(usable_captions[end_index].get("end") or focus_start + 3.2)))
        focus_end = min(focus_end, focus_start + 4.5)
        if focus_end - focus_start >= 1.8:
            focus_cues.append({"start": round(focus_start, 3), "end": round(focus_end, 3), "style": "radial-spotlight", "radius": 31, "x": 50, "y": 52})
            for caption in usable_captions:
                if float(caption.get("start") or 0.0) < focus_end and float(caption.get("end") or 0.0) > focus_start:
                    caption["captionStyle"] = "focus-lower"
                    caption["emphasis"] = "normal"
                    caption["role"] = "anchor"
                    # The spotlight changes the composition, but it must not
                    # erase the content director's confirmed keyword accent.
    timeline = {
        "version": 2,
        "sourceFile": source.name,
        "sourceVolume": float(audio_mix["sourceVolume"]),
        "sourceLayout": input_adaptation or {"sourceFit": "cover", "activity": "legacy"},
        "audioMix": audio_mix,
        "bgmFile": str((selected_bgm or {}).get("file") or current_template.get("bgm_file") or "") if include_bgm else "",
        "bgmTrackId": str((selected_bgm or {}).get("id") or current_template.get("music_track_id") or "") if include_bgm else "",
        "bgmVolume": float(audio_mix["bgmSpeechVolume"]),
        "bgmGapVolume": float(audio_mix["bgmGapVolume"]),
        "bgmLoop": bool(current_template.get("bgm_loop", True)),
        # Use the mixed track assembled from the selected template sound pool.
        # This guarantees that effects reach the exported MP4 and also avoids
        # playing the same cue twice.
        "sfxFile": sfx_file.name if include_sfx and sfx_file.exists() else "",
        "sfxVolume": float(audio_mix["sfxBusVolume"]),
        "sfxCues": [],
        "duration": round(duration, 3),
        "fps": 30,
        "title": title,
        "merchantName": str(merchant.get("name") or "")[:24],
        "coverTime": float(current_template.get("cover_time_seconds") or 0.8),
        "captions": usable_captions,
        "cameraCues": camera_cues,
        "focusCues": focus_cues,
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
    now = int(time.time() * 1000)
    previous_stage = str(current.get("stage") or "")
    next_stage = str(updates.get("stage") or previous_stage)
    if next_stage and next_stage != previous_stage:
        started_at = int(current.get("stage_started_at") or current.get("updated_at") or now)
        timings = current.get("stage_timings") if isinstance(current.get("stage_timings"), dict) else {}
        if previous_stage:
            timings[previous_stage] = round(max(0, now - started_at) / 1000, 3)
        current["stage_timings"] = timings
        current["stage_started_at"] = now
    current.update(updates, updated_at=now)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(current, ensure_ascii=False, indent=2), "utf-8")
    temporary.replace(path)
    return current


def media_url(job_id: str, name: str) -> str:
    return f"/media/{job_id}/{name}"


def cos_configured() -> bool:
    return bool(
        TENCENT_CLOUD_SECRET_ID
        and TENCENT_CLOUD_SECRET_KEY
        and TENCENT_MPS_COS_BUCKET
        and TENCENT_MPS_COS_REGION
    )


def cos_host() -> str:
    return f"{TENCENT_MPS_COS_BUCKET}.cos.{TENCENT_MPS_COS_REGION}.myqcloud.com"


def cos_path(object_key: str) -> str:
    return "/" + "/".join(
        urllib.parse.quote(part, safe="-_.~")
        for part in str(object_key or "").lstrip("/").split("/")
    )


def cos_encode(value: str) -> str:
    return urllib.parse.quote(str(value), safe="-_.~")


def cos_authorization(method: str, pathname: str, headers: dict[str, str], expires_in: int = 3600) -> str:
    if not cos_configured():
        raise RuntimeError("腾讯云 COS 尚未配置。")
    now = int(time.time())
    key_time = f"{max(0, now - 60)};{now + max(300, expires_in)}"
    normalized = sorted((key.lower(), value.strip()) for key, value in headers.items())
    header_list = ";".join(key for key, _value in normalized)
    http_headers = "&".join(f"{cos_encode(key)}={cos_encode(value)}" for key, value in normalized)
    http_string = f"{method.lower()}\n{pathname}\n\n{http_headers}\n"
    sign_key = hmac.new(TENCENT_CLOUD_SECRET_KEY.encode(), key_time.encode(), hashlib.sha1).hexdigest()
    string_to_sign = f"sha1\n{key_time}\n{hashlib.sha1(http_string.encode()).hexdigest()}\n"
    signature = hmac.new(sign_key.encode(), string_to_sign.encode(), hashlib.sha1).hexdigest()
    return (
        "q-sign-algorithm=sha1"
        f"&q-ak={cos_encode(TENCENT_CLOUD_SECRET_ID)}"
        f"&q-sign-time={key_time}"
        f"&q-key-time={key_time}"
        f"&q-header-list={header_list}"
        "&q-url-param-list="
        f"&q-signature={signature}"
    )


def signed_cos_url(object_key: str, expires_in: int = 7200) -> str:
    host = cos_host()
    pathname = cos_path(object_key)
    return f"https://{host}{pathname}?{cos_authorization('GET', pathname, {'host': host}, expires_in)}"


def upload_file_to_cos(source: Path, object_key: str, content_type: str) -> None:
    if not source.is_file() or source.stat().st_size <= 0:
        raise RuntimeError("待上传的云端文件不存在。")
    digest = hashlib.md5()
    with source.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    content_md5 = base64.b64encode(digest.digest()).decode()
    host = cos_host()
    pathname = cos_path(object_key)
    signed_headers = {"host": host, "content-md5": content_md5, "content-type": content_type}
    connection = http.client.HTTPSConnection(host, timeout=600)
    try:
        connection.putrequest("PUT", pathname, skip_host=True, skip_accept_encoding=True)
        connection.putheader("Host", host)
        connection.putheader("Content-MD5", content_md5)
        connection.putheader("Content-Type", content_type)
        connection.putheader("Content-Length", str(source.stat().st_size))
        connection.putheader("Authorization", cos_authorization("PUT", pathname, signed_headers, 3600))
        connection.endheaders()
        with source.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                connection.send(chunk)
        response = connection.getresponse()
        detail = response.read(4096).decode("utf-8", "replace")
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"上传腾讯云 COS 失败（{response.status}）：{detail[:240]}")
    finally:
        connection.close()


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    result = {**job}
    # The immutable plan can be large and is an internal render contract. Keep
    # status polling lightweight; expose only the summary written by process_job.
    result.pop("director_plan", None)
    if cos_configured() and result.get("result_object_key"):
        result["result_url"] = signed_cos_url(str(result["result_object_key"]), 2 * 60 * 60)
    if cos_configured() and result.get("cover_object_key"):
        result["cover_url"] = signed_cos_url(str(result["cover_object_key"]), 2 * 60 * 60)
    return result


def cleanup_old_jobs() -> int:
    cutoff = time.time() - JOB_RETENTION_HOURS * 60 * 60
    removed = 0
    for candidate in DATA_DIR.iterdir():
        if not candidate.is_dir():
            continue
        metadata_file = candidate / "job.json"
        try:
            job = json.loads(metadata_file.read_text("utf-8")) if metadata_file.exists() else {}
            if str(job.get("state") or "") in {"queued", "running"}:
                continue
            timestamp = metadata_file.stat().st_mtime if metadata_file.exists() else candidate.stat().st_mtime
            if timestamp < cutoff:
                shutil.rmtree(candidate, ignore_errors=True)
                removed += 1
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    CLEANUP_STATE.update(last_run_at=int(time.time() * 1000), removed_jobs=removed, last_error="")
    return removed


def cleanup_loop() -> None:
    while True:
        try:
            cleanup_old_jobs()
        except Exception as error:
            CLEANUP_STATE.update(last_run_at=int(time.time() * 1000), last_error=str(error))
        time.sleep(CLEANUP_INTERVAL_SECONDS)


def validate_remote_video_url(value: str) -> str:
    """Allow cloud media URLs while rejecting credentials and private-network SSRF."""
    candidate = str(value or "").strip()
    if len(candidate) > 4_000:
        raise ValueError("视频来源地址过长。")
    parsed = urllib.parse.urlparse(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("视频来源地址无效。")
    if parsed.username or parsed.password:
        raise ValueError("视频来源地址不能包含账号信息。")
    # Tencent Cloud resolves a COS public endpoint to an RFC1918 address when
    # the worker and bucket are in the same region. That is expected and keeps
    # the transfer on Tencent's backbone. Only the exact configured bucket is
    # trusted; every other hostname still goes through the SSRF checks below.
    configured_cos_host = cos_host().lower() if TENCENT_MPS_COS_BUCKET and TENCENT_MPS_COS_REGION else ""
    if configured_cos_host and parsed.hostname.lower() == configured_cos_host:
        return candidate
    try:
        addresses = {
            result[4][0]
            for result in socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
        }
    except socket.gaierror as error:
        raise ValueError("视频来源域名暂时无法解析。") from error
    if not addresses:
        raise ValueError("视频来源域名暂时无法解析。")
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            raise ValueError("视频来源地址不能指向内部网络。")
    return candidate


class SafeVideoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, new_url):  # type: ignore[no-untyped-def]
        validate_remote_video_url(new_url)
        return super().redirect_request(request, fp, code, msg, headers, new_url)


def download_remote_video(source_url: str, destination: Path) -> int:
    safe_url = validate_remote_video_url(source_url)
    request = urllib.request.Request(
        safe_url,
        headers={
            "Accept": "video/*,application/octet-stream;q=0.8,*/*;q=0.2",
            "User-Agent": "merchant-video-worker/1.0",
        },
    )
    opener = urllib.request.build_opener(SafeVideoRedirectHandler())
    size = 0
    try:
        with opener.open(request, timeout=45) as response, destination.open("wb") as target:
            validate_remote_video_url(response.geturl())
            declared_size = int(response.headers.get("content-length") or 0)
            if declared_size > MAX_UPLOAD_BYTES:
                raise RuntimeError("原片超过当前允许的上传大小。")
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise RuntimeError("原片超过当前允许的上传大小。")
                target.write(chunk)
    except (urllib.error.URLError, TimeoutError) as error:
        destination.unlink(missing_ok=True)
        raise RuntimeError("云端原片读取失败，请重新进入一键网感。") from error
    if size <= 0:
        destination.unlink(missing_ok=True)
        raise RuntimeError("云端原片文件为空。")
    return size


def ensure_job_source(job_id: str, job: dict[str, Any]) -> Path:
    folder = job_dir(job_id)
    source = folder / str(job.get("source_name") or "source.mp4")
    if source.is_file() and source.stat().st_size > 0:
        return source
    remote_source_url = str(job.get("remote_source_url") or "").strip()
    if not remote_source_url:
        raise RuntimeError("任务没有可用的原片。")
    write_job(job_id, state="running", stage="download", progress=3, message="正在从云端读取对口型成片…")
    size = download_remote_video(remote_source_url, source)
    write_job(job_id, source_size=size, message="云端原片已就绪，正在读取内容…")
    return source


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
    profile = {
        **DEFAULT_TEMPLATE_VALUES,
        **TEMPLATES.get(template_id, TEMPLATES["template-9"]),
        "id": template_id,
    }
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
        "caption_long_text_mode": body.get("caption_long_text_mode", "single-line"),
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
        "camera_mode": body.get("camera_mode", ""),
        "camera_scale_steps": body.get("camera_scale_steps", []),
        "camera_origin_steps": body.get("camera_origin_steps", []),
        "camera_language": package.get("camera_language", {}) if isinstance(package.get("camera_language"), dict) else {},
        "transition_direction": package.get("transition_direction", {}) if isinstance(package.get("transition_direction"), dict) else {},
        "typography_direction": package.get("typography_direction", {}) if isinstance(package.get("typography_direction"), dict) else {},
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
        "mix_direction": audio.get("mix", {}) if isinstance(audio.get("mix"), dict) else {},
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
        "bgm_loop": bool(music.get("loop", True)),
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
    explicit_lines = [
        part.strip("，。！？、,.!?;: ")
        for part in re.split(r"[｜|]", text)
        if part.strip("，。！？、,.!?;: ")
    ]
    if len(explicit_lines) >= 2:
        separator = " " if speech_language("".join(explicit_lines)) == "en" else ""
        return [explicit_lines[0], separator.join(explicit_lines[1:])]
    if speech_language(text) == "en":
        words = text.split()
        if len(words) <= 5 and not (force_two_lines and len(words) >= 4):
            return [text]
        target = max(2, math.ceil(len(words) / 2))
        return [" ".join(words[:target]), " ".join(words[target:])]
    text = text[:max_chars]
    if len(text) <= 9 and not (force_two_lines and len(text) >= 6):
        return [text]
    target = len(text) / 2
    minimum_side = max(2, min(4, len(text) // 3))
    protected_phrases = (
        "商家入驻机会", "商家入驻", "开放入驻", "首批类目", "激励翻倍",
        "华为", "商家", "入驻", "机会", "小红书", "朋友圈", "直播间",
        "微信支付", "人工智能", "对口型", "一键网感", "超级剪辑",
        "市场动态", "会员中心", "短视频", "供应链", "创作平台",
        "酒店景区旅行社", "酒店", "景区", "旅行社", "体育场馆",
    )
    protected_ranges: list[tuple[int, int]] = []
    for phrase in protected_phrases:
        cursor = text.find(phrase)
        while cursor >= 0:
            protected_ranges.append((cursor, cursor + len(phrase)))
            cursor = text.find(phrase, cursor + 1)
    semantic_markers = (
        "商家入驻机会", "商家入驻", "开放入驻", "首批类目", "激励翻倍",
        "如果", "但是", "不过", "所以", "然后", "因为", "同时", "以及",
        "而且", "而是", "就是", "可以", "需要", "通过", "这样", "比如",
        "例如", "首先", "其次", "最后", "想要", "怎么", "如何", "为什么",
        "商家", "用户", "客户", "品牌", "平台", "机会", "政策", "活动",
    )
    semantic_positions: set[int] = set()
    for marker in semantic_markers:
        cursor = text.find(marker)
        while cursor >= 0:
            if cursor > 0:
                semantic_positions.add(cursor)
            if cursor + len(marker) < len(text):
                semantic_positions.add(cursor + len(marker))
            cursor = text.find(marker, cursor + 1)
    candidates = [
        position
        for position in range(minimum_side, len(text) - minimum_side + 1)
        if not any(start < position < end for start, end in protected_ranges)
    ]
    invalid_left = ("的", "和", "与", "就", "都", "也", "在", "让", "把", "被", "从", "向", "为", "及")
    invalid_right = ("的", "和", "与", "就", "都", "也", "才", "了", "着", "过")
    split_at = min(
        candidates or [max(1, min(len(text) - 1, round(target)))],
        key=lambda position: (
            max(0, position - max_chars) + max(0, len(text) - position - max_chars)
        ) * 12
        + abs(position - target)
        + (10 if text[:position].endswith(invalid_left) else 0)
        + (10 if text[position:].startswith(invalid_right) else 0)
        - (7 if position in semantic_positions else 0),
    )
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


def plan_adaptive_caption_lines(
    captions: list[dict[str, Any]],
    line_max_chars: int,
) -> list[dict[str, Any]]:
    """Keep short captions on one line and direct long captions into two semantic rows.

    This is visual metadata only: confirmed wording, punctuation and timing remain
    unchanged. Punctuation and common clause markers are preferred over a hard
    midpoint, while the selected keyword is never split across rows.
    """
    maximum = max(4, int(line_max_chars or 8))
    markers = (
        "但是", "不过", "所以", "然后", "因为", "如果", "同时", "以及",
        "而且", "而是", "就是", "可以", "需要", "通过", "这样", "比如",
        "例如", "首先", "其次", "最后", "想要", "怎么", "如何", "为什么",
    )
    punctuation = "，,。！？!?；;：:、"
    prepared: list[dict[str, Any]] = []
    for raw in captions:
        item = dict(raw)
        text = re.sub(r"\s+", "", str(item.get("text") or "")).strip()
        characters = list(text)
        directed_lines = [
            re.sub(r"\s+", "", str(line or "")).strip()
            for line in (item.get("captionLines") if isinstance(item.get("captionLines"), list) else [])[:2]
            if re.sub(r"\s+", "", str(line or "")).strip()
        ]
        if directed_lines and "".join(directed_lines) == text:
            item["captionLineMode"] = "two-line" if len(directed_lines) == 2 else "single"
            item["captionLines"] = directed_lines
            prepared.append(item)
            continue
        if len(characters) <= maximum:
            item["captionLineMode"] = "single"
            item["captionLines"] = [text] if text else []
            prepared.append(item)
            continue

        midpoint = len(characters) / 2
        minimum_side = max(2, min(4, len(characters) // 3))
        candidates: set[int] = set()
        for index, character in enumerate(characters[:-1], start=1):
            if character in punctuation and minimum_side <= index <= len(characters) - minimum_side:
                candidates.add(index)
        for marker in markers:
            cursor = text.find(marker)
            while cursor >= 0:
                before = cursor
                after = cursor + len(marker)
                if minimum_side <= before <= len(characters) - minimum_side:
                    candidates.add(before)
                if minimum_side <= after <= len(characters) - minimum_side:
                    candidates.add(after)
                cursor = text.find(marker, cursor + 1)

        keyword = re.sub(r"\s+", "", str(item.get("keyword") or ""))
        keyword_start = text.find(keyword) if keyword else -1
        keyword_end = keyword_start + len(keyword) if keyword_start >= 0 else -1

        protected_phrases = (
            "商家", "入驻", "新机会", "机会", "开放入驻", "首批类目", "激励翻倍",
            "华为", "酒店景区旅行社", "体育场馆",
            "小红书", "朋友圈", "直播间", "微信支付", "人工智能",
            "对口型", "一键网感", "超级剪辑", "市场动态", "会员中心",
            "网感", "口播视频", "AI剪辑", "AI超级剪辑",
            "短视频", "供应链", "用户", "客户", "品牌", "平台", "政策",
            "活动", "方案", "功能", "服务", "视频", "内容", "账号", "作品",
        )
        protected_ranges: list[tuple[int, int]] = []
        for phrase in protected_phrases:
            cursor = text.find(phrase)
            while cursor >= 0:
                protected_ranges.append((cursor, cursor + len(phrase)))
                cursor = text.find(phrase, cursor + 1)

        def split_is_safe(position: int) -> bool:
            return (
                not (keyword_start >= 0 and keyword_start < position < keyword_end)
                and not any(start < position < end for start, end in protected_ranges)
            )

        fallback_positions = range(minimum_side, len(characters) - minimum_side + 1)
        valid_candidates = [position for position in candidates if split_is_safe(position)]
        if not valid_candidates:
            valid_candidates = [position for position in fallback_positions if split_is_safe(position)]
        split_at = min(
            valid_candidates or [max(1, min(len(characters) - 1, round(midpoint)))],
            key=lambda position: (
                (
                    max(0, position - maximum)
                    + max(0, len(characters) - position - maximum)
                ) * 12
                + abs(position - midpoint)
                + (10 if text[:position].endswith(("的", "和", "与", "就", "都", "也", "在", "让", "把", "被", "从", "向", "为", "及")) else 0)
                + (10 if text[position:].startswith(("的", "和", "与", "就", "都", "也", "才", "了", "着", "过")) else 0)
                - (7 if position in candidates else 0)
            ),
        )
        item["captionLineMode"] = "two-line"
        item["captionLines"] = [text[:split_at], text[split_at:]]
        prepared.append(item)
    return prepared


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
    """Compile captions without inventing proportional timestamps.

    Word timestamps are the preferred evidence.  If a provider only returns
    segment timestamps, preserve those segments and merely join tiny adjacent
    fragments; never guess where a newly split phrase was spoken.
    """
    words: list[dict[str, Any]] = []
    for segment in segments:
        raw_words = segment.get("words")
        if isinstance(raw_words, list):
            words.extend(dict(word) for word in raw_words if isinstance(word, dict))
    visual_capacity = max(12, int(max_chars or 10) * 2)
    if words:
        return merge_short_caption_beats(
            word_timed_caption_segments(words, visual_capacity, 3.9, 0.48),
            min_chars,
            visual_capacity,
        )
    locked = [
        {
            **segment,
            "start": round(float(segment.get("start") or 0), 3),
            "end": round(max(float(segment.get("start") or 0) + 0.05, float(segment.get("end") or 0)), 3),
            "text": normalize_speech_text(str(segment.get("text") or "")).strip("，,。！？!?；;：:、 "),
        }
        for segment in segments
        if normalize_speech_text(str(segment.get("text") or "")).strip("，,。！？!?；;：:、 ")
    ]
    return merge_short_caption_beats(
        sorted(locked, key=lambda item: float(item.get("start") or 0)),
        min_chars,
        visual_capacity,
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
    filters = [color_filters.get(template_id, "eq=contrast=1.04:saturation=1.02")]
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
        normalized: dict[str, Any] = {
            "start": round(start, 3),
            "end": round(end, 3),
            "text": text[:180],
        }
        keyword = str(item.get("keyword") or "").strip()[:16]
        if keyword and re.sub(r"\s+", "", keyword) in re.sub(r"\s+", "", text):
            normalized["keyword"] = keyword
            normalized["keywordLocked"] = True
        translation = str(item.get("translation") or "").strip()[:240]
        if translation:
            normalized["translation"] = translation
        content_node = str(item.get("contentNode") or "").strip()
        if content_node in {
            "hook", "pain_reversal", "core_viewpoint", "number_benefit",
            "example_step", "brand_entity", "cta", "supporting",
        }:
            normalized["contentNode"] = content_node
        try:
            normalized["contentWeight"] = max(0.0, min(1.0, float(item.get("contentWeight") or 0.0)))
        except (TypeError, ValueError):
            pass
        keyword_origin = str(item.get("keywordOrigin") or "").strip()
        if keyword_origin in {"ai", "local", "none"}:
            normalized["keywordOrigin"] = keyword_origin
        if isinstance(item.get("keywordSfx"), bool):
            normalized["keywordSfx"] = bool(item["keywordSfx"])
            normalized["keywordImportance"] = "primary" if item["keywordSfx"] else "regular"
        caption_lines = [
            re.sub(r"\s+", "", str(line or "")).strip("，。！？；：、,.!?;: ")
            for line in (item.get("captionLines") if isinstance(item.get("captionLines"), list) else [])[:2]
            if re.sub(r"\s+", "", str(line or "")).strip("，。！？；：、,.!?;: ")
        ]
        if caption_lines and caption_plain_text("".join(caption_lines)) == caption_plain_text(text):
            normalized["captionLineMode"] = "two-line" if len(caption_lines) == 2 else "single"
            normalized["captionLines"] = caption_lines
        camera_intent = str(item.get("cameraIntent") or "").strip()
        if camera_intent in {"hold", "push-in", "pull-back", "reframe", "close-up", "wide"}:
            normalized["cameraIntent"] = camera_intent
        transition_intent = str(item.get("transitionIntent") or "").strip()
        if transition_intent in {"none", "cut", "matched-reframe", "focus-bridge", "foreground-occlusion"}:
            normalized["transitionIntent"] = transition_intent
        sfx_role = str(item.get("sfxRole") or "").strip()
        if sfx_role in {"none", "hook", "reversal", "viewpoint", "number", "step", "brand", "cta"}:
            normalized["sfxRole"] = sfx_role
        captions.append(normalized)
    return sorted(captions, key=lambda item: (float(item["start"]), float(item["end"])))


def normalized_director_plan(
    value: Any,
    duration: float,
    template_id: str,
    edited_captions: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Validate the immutable app-side director contract without executing it.

    The worker accepts semantic intent only. It still owns exact camera curves,
    transition implementations, sound files, loudness and render parameters.
    """
    if not isinstance(value, dict) or value.get("kind") != "viral-director-plan":
        return None
    if str(value.get("templateId") or "") != template_id:
        return None
    captions = normalized_edited_captions(value.get("captions"), duration)
    if not captions or len(captions) != len(edited_captions):
        return None
    for planned, confirmed in zip(captions, edited_captions):
        if abs(float(planned["start"]) - float(confirmed["start"])) > 0.08:
            return None
        if abs(float(planned["end"]) - float(confirmed["end"])) > 0.08:
            return None
        if caption_plain_text(str(planned["text"])) != caption_plain_text(str(confirmed["text"])):
            return None
    bgm_mood = str(value.get("bgmMood") or "professional")
    if bgm_mood not in {"calm", "warm", "professional", "uplifting", "neutral"}:
        bgm_mood = "professional"
    source = str(value.get("source") or "local-fallback")
    if source not in {"ai", "cache", "local-fallback", "user-confirmed"}:
        source = "local-fallback"
    return {
        "version": 1,
        "kind": "viral-director-plan",
        "promptVersion": str(value.get("promptVersion") or "viral-director-fast-v1")[:80],
        "templateId": template_id,
        "title": str(value.get("title") or "")[:40],
        "titleLines": [str(line).strip()[:40] for line in value.get("titleLines", [])[:2] if str(line).strip()]
        if isinstance(value.get("titleLines"), list) else [],
        "duration": round(max(0.1, min(600.0, duration)), 3),
        "captions": captions,
        "bgmMood": bgm_mood,
        "source": source,
        "model": str(value.get("model") or "local-director")[:80],
        "degraded": bool(value.get("degraded")),
        "plannedAt": max(0, int(value.get("plannedAt") or int(time.time() * 1000))),
    }


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
    audio = folder / "speech.wav"
    cover = folder / "cover.jpg"
    subtitle_file = folder / "captions.ass"
    sfx_file = folder / "opening.wav"
    output = folder / "output.mp4"
    try:
        source = ensure_job_source(job_id, job)
        write_job(job_id, state="running", stage="probe", progress=4, message="正在读取原片信息…")
        metadata = probe_video(source)
        if metadata["duration"] <= 0 or metadata["width"] <= 0 or metadata["height"] <= 0:
            raise RuntimeError("没有读取到有效的视频信息。")

        ffmpeg = check_binary("ffmpeg")
        write_job(job_id, stage="extract", progress=12, message="正在提取声音与首帧…", metadata=metadata)
        if metadata["has_audio"]:
            run([ffmpeg, "-y", "-i", str(source), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(audio)])
        current_template = template_profile(str(job.get("template_id") or "template-9"))
        extract_contentful_cover(
            source,
            cover,
            metadata["duration"],
            float(current_template.get("cover_time_seconds") or 0.8),
        )
        edited_captions = normalized_edited_captions(job.get("edited_captions"), metadata["duration"])
        template_id = str(job.get("template_id") or "template-9")
        director_plan = normalized_director_plan(
            job.get("director_plan"),
            metadata["duration"],
            template_id,
            edited_captions,
        )
        if director_plan:
            edited_captions = [{**item} for item in director_plan["captions"]]
        caption_plan_ready = bool(edited_captions) and (bool(job.get("caption_plan_ready")) or bool(director_plan))
        info: Any = None
        words: list[dict[str, Any]] = []
        if edited_captions:
            write_job(job_id, stage="transcribe", progress=24, message="正在读取已校对的口播文案与时间轴…")
            segments = [{**item} for item in edited_captions]
            if caption_plan_ready:
                caption_segments = [{**item} for item in edited_captions]
                caption_source = "lip-sync-manifest:precomputed-plan"
                analysis_mode = "precomputed_lip_sync_timeline"
            else:
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
            write_job(job_id, stage="script", progress=34, message="口播识别完成，正在按完整语义快速断句…")
            caption_segments = local_semantic_caption_segments(
                segments,
                int(current_template.get("caption_min_chars") or 4),
                int(current_template["caption_max_chars"]),
            )
            caption_source = "tencent-flash:local-semantic"
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
        if caption_plan_ready:
            title = confirmed_title if confirmed_title else derive_title(caption_segments, "")
            title_source = "precomputed-lip-sync-plan"
        elif title_is_valid(confirmed_title):
            title = confirmed_title
            title_source = "user-confirmed"
        else:
            title = derive_title(caption_segments, confirmed_title)
            title_source = "local-transcript"
        # Translation is optional in the immutable plan. A missing translation
        # renders as clean Chinese-only captions instead of blocking the job
        # behind another model request.
        highlight_source = "not-required"
        if caption_plan_ready and template_id == "template-9":
            directed_items = [
                {
                    "content_node": item.get("contentNode"),
                    "keyword": item.get("keyword"),
                    "emphasis": "strong" if float(item.get("contentWeight") or 0.0) >= 0.72 else "normal",
                }
                for item in caption_segments
            ]
            caption_segments = finalize_template9_director_plan(caption_segments, directed_items)
            highlight_source = "precomputed-lip-sync-plan"
        elif caption_plan_ready and template_id == "template-10":
            write_job(job_id, stage="director", progress=48, message="正在规划黄白双语字幕、语义大字与镜头节奏…")
            caption_segments = finalize_template10_director_plan(caption_segments)
            highlight_source = "precomputed-lip-sync-plan"
        elif caption_plan_ready and template_id in {"template-11", "template-12"}:
            caption_segments = semantic_caption_plan(
                caption_segments,
                title,
                current_template.get("content_director"),
            )
            highlight_source = "precomputed-lip-sync-plan"
        elif template_id in {"template-9", "template-10", "template-11", "template-12"}:
            write_job(
                job_id,
                stage="director",
                progress=48,
                message="正在应用已确认的导演规则与本地安全兜底…",
            )
            shared_captions = apply_shared_director_items(
                caption_segments, None, title, current_template.get("content_director")
            )
            highlight_source = "shared-local-director"
            if template_id == "template-9":
                directed_items = [
                    {
                        "content_node": item.get("contentNode"),
                        "keyword": item.get("keyword"),
                        "layout": item.get("directorLayout"),
                        "emphasis": "strong" if float(item.get("contentWeight") or 0.0) >= 0.72 else "normal",
                    }
                    for item in shared_captions
                ]
                caption_segments = finalize_template9_director_plan(shared_captions, directed_items)
            elif template_id == "template-10":
                caption_segments = finalize_template10_director_plan(shared_captions)
            else:
                caption_segments = shared_captions
        if not director_plan:
            director_plan = {
                "version": 1,
                "kind": "viral-director-plan",
                "promptVersion": "viral-director-fast-v1",
                "templateId": template_id,
                "title": title,
                "titleLines": [line for line in str(title).split("\n") if line][:2],
                "duration": round(float(metadata["duration"]), 3),
                "captions": [{**item} for item in caption_segments],
                "bgmMood": "professional",
                "source": "local-fallback",
                "model": "worker-local-director",
                "degraded": True,
                "plannedAt": int(time.time() * 1000),
            }
        director_plan_file = folder / "director-plan.json"
        if not director_plan_file.exists():
            director_plan_file.write_text(
                json.dumps(director_plan, ensure_ascii=False, indent=2),
                "utf-8",
            )
        if template_id in {"template-9", "template-10", "template-11", "template-12"} and current_template.get("caption_long_text_mode") == "adaptive-two-line":
            caption_segments = plan_adaptive_caption_lines(
                caption_segments,
                int(current_template.get("caption_line_max_chars") or 8),
            )
        if template_id in {"template-9", "template-10", "template-11", "template-12"}:
            caption_segments = mark_keyword_sfx_emphasis(caption_segments)
        highlighted_caption_count = sum(
            bool(str(item.get("keyword") or "").strip())
            for item in caption_segments
        )
        ai_highlighted_caption_count = sum(
            str(item.get("keywordOrigin") or "") == "ai"
            for item in caption_segments
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
            if template_id in {"template-9", "template-10", "template-11", "template-12"}
            else []
        )
        input_adaptation = build_input_adaptation_profile(metadata, scene_changes)
        transition_plan = plan_semantic_transition_cues(
            caption_segments,
            scene_changes,
            pause_candidates,
            [] if node_transition_candidates else rhythm_candidates,
            metadata["duration"],
            current_template,
            input_adaptation,
        )
        transition_points = [float(item["start"]) for item in transition_plan]
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
            transition_plan=transition_plan,
            input_adaptation=input_adaptation,
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
            highlighted_caption_count=highlighted_caption_count,
            ai_highlighted_caption_count=ai_highlighted_caption_count,
            caption_completeness=caption_completeness,
            word_count=len(words),
            scene_changes=scene_changes,
            transition_points=transition_points,
            transition_plan=transition_plan,
            input_adaptation=input_adaptation,
            director_plan_version=int(director_plan.get("version") or 1),
            director_plan_source=str(director_plan.get("source") or "local-fallback"),
            director_plan_model=str(director_plan.get("model") or "local-director"),
            director_plan_file="director-plan.json",
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
                str(job.get("template_id") or "template-9"),
                escaped_ass,
                transition_points if current_template.get("transition_trigger") != "fixed" else None,
                output_size,
            )
            filter_complex = video_graph
            if metadata["has_audio"] and include_sfx:
                # Keep the audio graph compatible with the production FFmpeg.
                # `amix=weights='1 0.2'` is accepted by some builds but is
                # parsed as an invalid global argument by others.  Normalize
                # both streams first and apply the SFX gain explicitly instead.
                sfx_gain = float(current_template.get("sfx_gain") or 0.14)
                filter_complex += (
                    ";[0:a:0]aresample=48000,"
                    "aformat=sample_fmts=fltp:channel_layouts=stereo[voice]"
                    ";[1:a:0]aresample=48000,"
                    "aformat=sample_fmts=fltp:channel_layouts=stereo,"
                    f"volume={sfx_gain:.3f}[effects]"
                    ";[voice][effects]amix=inputs=2:duration=first:dropout_transition=0[aout]"
                )
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
        result_object_key = ""
        cover_object_key = ""
        result_url = media_url(job_id, output.name)
        cover_url = media_url(job_id, cover.name)
        if cos_configured():
            write_job(job_id, stage="upload", progress=96, message="成片已导出，正在写入腾讯云存储…")
            date_path = time.strftime("%Y/%m/%d", time.localtime())
            result_object_key = f"{VIDEO_WORKER_COS_OUTPUT_PREFIX}/{date_path}/{job_id}/output.mp4"
            cover_object_key = f"{VIDEO_WORKER_COS_OUTPUT_PREFIX}/{date_path}/{job_id}/cover.jpg"
            upload_file_to_cos(output, result_object_key, "video/mp4")
            upload_file_to_cos(cover, cover_object_key, "image/jpeg")
            result_url = signed_cos_url(result_object_key, 2 * 60 * 60)
            cover_url = signed_cos_url(cover_object_key, 2 * 60 * 60)
        write_job(
            job_id,
            state="success",
            stage="complete",
            progress=100,
            message="处理完成，可预览或下载。",
            result_url=result_url,
            cover_url=cover_url,
            result_object_key=result_object_key,
            cover_object_key=cover_object_key,
            result_size=output.stat().st_size,
            cover_size=cover.stat().st_size,
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
    audio = folder / "speech.wav"
    try:
        source = ensure_job_source(job_id, job)
        write_job(job_id, state="running", stage="probe", progress=5, message="正在读取原片声音与画面信息…")
        metadata = probe_video(source)
        if metadata["duration"] <= 0 or not metadata["has_audio"]:
            raise RuntimeError("原片没有可识别的人声音轨。")
        if job.get("kind") == "douyin_transcription" and metadata["duration"] > BENCHMARK_MAX_DURATION_SECONDS:
            raise RuntimeError(f"对标视频最长支持 {BENCHMARK_MAX_DURATION_SECONDS // 60} 分钟，请选择更短的公开视频。")
        profile = template_profile(str(job.get("template_id") or "template-9"))
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
        if bool(job.get("fast_mode", True)):
            # The review screen performs one dedicated AI pass for correction,
            # title generation and semantic layout. Return Tencent's precise
            # sentence/word timeline now instead of repeating visual analysis
            # and two additional language-model calls in the worker.
            transcript = "。".join(
                str(item.get("text") or "").strip()
                for item in original_segments
                if str(item.get("text") or "").strip()
            )
            write_job(
                job_id,
                state="success",
                stage="complete",
                progress=100,
                message="语音时间轴已完成，正在进行智能断句…",
                title="",
                title_source="pending-app-semantic-layout",
                transcript=transcript,
                captions=original_segments,
                caption_source="tencent-flash:raw-timeline",
                caption_completeness=caption_completeness_report(original_segments, original_segments),
                language=speech_language(transcript),
                analysis_mode="tencent-flash-asr-fast",
                analysis_summary="腾讯云极速语音识别已生成原始字词时间轴。",
                asr_provider="tencent-flash",
                asr_engine=asr_metadata.get("engine_type", TENCENT_ASR_ENGINE_TYPE),
                asr_request_id=asr_metadata.get("request_id", ""),
                metadata=metadata,
            )
            return
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
    disk = shutil.disk_usage(DATA_DIR)
    memory_total = 0
    memory_available = 0
    try:
        values: dict[str, int] = {}
        for line in Path("/proc/meminfo").read_text("utf-8").splitlines():
            key, raw = line.split(":", 1)
            values[key] = int(raw.strip().split()[0]) * 1024
        memory_total = values.get("MemTotal", 0)
        memory_available = values.get("MemAvailable", 0)
    except (OSError, ValueError, IndexError):
        pass
    return {
        "ok": bool(shutil.which("ffmpeg") and shutil.which("ffprobe")),
        "ffmpeg": shutil.which("ffmpeg") or "",
        "ffprobe": shutil.which("ffprobe") or "",
        "video_analysis_model": AI_VIDEO_MODEL,
        "video_analysis_enabled": bool(AI_API_KEY and AI_VIDEO_MODEL and PUBLIC_BASE_URL),
        "content_ai_model": AI_TITLE_MODEL,
        "content_ai_enabled": bool(AI_API_KEY),
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
        "cos_output_enabled": cos_configured(),
        "queue": {
            "render_waiting": EXECUTOR._work_queue.qsize(),
            "transcription_waiting": TRANSCRIPTION_EXECUTOR._work_queue.qsize(),
            "render_concurrency": WORKERS,
            "transcription_concurrency": TRANSCRIPTION_WORKERS,
        },
        "runtime": {
            "load_average": list(os.getloadavg()) if hasattr(os, "getloadavg") else [],
            "memory_total_bytes": memory_total,
            "memory_available_bytes": memory_available,
            "disk_total_bytes": disk.total,
            "disk_free_bytes": disk.free,
            "job_retention_hours": JOB_RETENTION_HOURS,
            "cleanup": CLEANUP_STATE,
        },
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
            for template_id in PUBLISHED_TEMPLATE_IDS
            if template_id in TEMPLATES or template_id in TEMPLATE_PACKAGES
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
    video: UploadFile | None = File(None),
    source_url: str = Form(""),
    source_name: str = Form(""),
    template_id: str = Form("template-9"),
    merchant_json: str = Form("{}"),
    fast_mode: str = Form("1"),
) -> dict[str, Any]:
    refresh_remote_template_registry()
    remote_source_url = source_url.strip()
    if video is None and not remote_source_url:
        raise HTTPException(status_code=400, detail="请上传视频文件或提供云端视频地址。")
    content_type = (video.content_type or "").lower() if video else ""
    if video is not None and not content_type.startswith("video/"):
        raise HTTPException(status_code=400, detail="请上传视频文件。")
    if remote_source_url:
        try:
            remote_source_url = validate_remote_video_url(remote_source_url)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
    if template_id not in TEMPLATES and template_id not in TEMPLATE_PACKAGES:
        raise HTTPException(status_code=400, detail="网感模板无效。")
    job_id = uuid.uuid4().hex
    folder = job_dir(job_id)
    folder.mkdir(parents=True, exist_ok=False)
    filename_hint = (video.filename if video else source_name) or urllib.parse.urlparse(remote_source_url).path or "source.mp4"
    suffix = Path(filename_hint).suffix.lower()
    if suffix not in {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"}:
        suffix = ".mp4"
    stored_source_name = f"source{suffix}"
    source = folder / stored_source_name
    size = 0
    if video is not None:
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
    public_source_url = remote_source_url or f"{public_base_url}/media/{job_id}/{stored_source_name}"
    job = {
        "id": job_id,
        "kind": "transcription",
        "state": "queued",
        "stage": "queued",
        "progress": 1,
        "message": "云端原片地址已接收，等待后台读取…" if remote_source_url else "原片已接收，等待提取口播文案…",
        "template_id": template_id,
        "merchant": merchant if isinstance(merchant, dict) else {},
        "fast_mode": str(fast_mode).strip().lower() not in {"0", "false", "no", "off"},
        "source_name": stored_source_name,
        "source_url": public_source_url,
        "remote_source_url": remote_source_url,
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
        "template_id": "template-9",
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
    video: UploadFile | None = File(None),
    source_url: str = Form(""),
    source_name: str = Form(""),
    template_id: str = Form("template-9"),
    title: str = Form(""),
    merchant_json: str = Form("{}"),
    captions_json: str = Form("[]"),
    director_plan_json: str = Form("{}"),
    caption_plan_ready: str = Form("false"),
    include_sfx: str = Form("true"),
    include_bgm: str = Form("false"),
) -> dict[str, Any]:
    refresh_remote_template_registry()
    remote_source_url = source_url.strip()
    if video is None and not remote_source_url:
        raise HTTPException(status_code=400, detail="请上传视频文件或提供云端视频地址。")
    content_type = (video.content_type or "").lower() if video else ""
    if video is not None and not content_type.startswith("video/"):
        raise HTTPException(status_code=400, detail="请上传视频文件。")
    if remote_source_url:
        try:
            remote_source_url = validate_remote_video_url(remote_source_url)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
    if template_id not in TEMPLATES and template_id not in TEMPLATE_PACKAGES:
        raise HTTPException(status_code=400, detail="网感模板无效。")
    job_id = uuid.uuid4().hex
    folder = job_dir(job_id)
    folder.mkdir(parents=True, exist_ok=False)
    filename_hint = (video.filename if video else source_name) or urllib.parse.urlparse(remote_source_url).path or "source.mp4"
    suffix = Path(filename_hint).suffix.lower()
    if suffix not in {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"}:
        suffix = ".mp4"
    stored_source_name = f"source{suffix}"
    source = folder / stored_source_name
    size = 0
    if video is not None:
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
    try:
        director_plan = json.loads(director_plan_json)
    except json.JSONDecodeError:
        director_plan = {}
    now = int(time.time() * 1000)
    job = {
        "id": job_id,
        "state": "queued",
        "stage": "queued",
        "progress": 1,
        "message": "云端原片地址已接收，等待后台读取…" if remote_source_url else "原片已接收，等待后台处理…",
        "template_id": template_id,
        "title": title.strip()[:40],
        "merchant": merchant if isinstance(merchant, dict) else {},
        "edited_captions": edited_captions if isinstance(edited_captions, list) else [],
        "director_plan": director_plan if isinstance(director_plan, dict) else {},
        "caption_plan_ready": form_boolean(caption_plan_ready, False),
        "include_sfx": form_boolean(include_sfx, True),
        "include_bgm": form_boolean(include_bgm, False),
        "source_name": stored_source_name,
        "remote_source_url": remote_source_url,
        "source_size": size,
        "created_at": now,
        "updated_at": now,
        "result_url": "",
        "cover_url": "",
        "error": "",
    }
    job_file(job_id).write_text(json.dumps(job, ensure_ascii=False, indent=2), "utf-8")
    EXECUTOR.submit(process_job, job_id)
    return public_job({
        **job,
        "status_url": str(request.base_url).rstrip("/") + f"/v1/jobs/{job_id}",
    })


@app.get("/v1/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    if not job_id.isalnum() or len(job_id) != 32:
        raise HTTPException(status_code=400, detail="视频任务编号无效。")
    return public_job(read_job(job_id))


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


@app.on_event("startup")
def restore_background_work() -> None:
    cleanup_old_jobs()
    recovered = 0
    for candidate in DATA_DIR.iterdir():
        metadata_file = candidate / "job.json"
        if not candidate.is_dir() or not metadata_file.exists():
            continue
        try:
            job = json.loads(metadata_file.read_text("utf-8"))
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        if str(job.get("state") or "") not in {"queued", "running"}:
            continue
        job_id = str(job.get("id") or candidate.name)
        kind = str(job.get("kind") or "")
        write_job(job_id, state="queued", stage="recovered", progress=max(1, int(job.get("progress") or 1)), message="服务已恢复，任务重新进入处理队列…")
        if kind == "transcription":
            TRANSCRIPTION_EXECUTOR.submit(process_transcription_job, job_id)
        elif kind == "douyin_transcription":
            TRANSCRIPTION_EXECUTOR.submit(process_douyin_transcription_job, job_id)
        elif kind == "template_learning":
            EXECUTOR.submit(process_template_learning_job, job_id)
        else:
            EXECUTOR.submit(process_job, job_id)
        recovered += 1
    CLEANUP_STATE["recovered_jobs"] = recovered
    threading.Thread(target=cleanup_loop, name="video-worker-cleanup", daemon=True).start()
