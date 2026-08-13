"""Compatibility resolver for public Douyin video detail pages.

Douyin's mobile share page stopped embedding ``videoInfoRes`` in
``window._ROUTER_DATA`` in August 2026.  The public desktop preview still
exposes the same work through its read-only detail endpoint to crawler user
agents.  This module is deliberately small and only resolves public video
metadata; it does not use account cookies or private APIs.
"""

from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from typing import Any, Callable


DOUYIN_PREVIEW_USER_AGENT = (
    "Mozilla/5.0 (compatible; Googlebot/2.1; "
    "+http://www.google.com/bot.html)"
)
MAX_DETAIL_RESPONSE_BYTES = 3 * 1024 * 1024


def _is_douyin_host(host: str) -> bool:
    normalized = str(host or "").lower().rstrip(".")
    return normalized == "douyin.com" or normalized.endswith(".douyin.com") or normalized == "iesdouyin.com" or normalized.endswith(".iesdouyin.com")


def _video_id_from_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    match = re.search(r"/(?:video|note)/(\d+)(?:/|$)", parsed.path)
    if match:
        return match.group(1)
    return ""


def _read_json_response(response: Any) -> dict[str, Any]:
    payload = response.read(MAX_DETAIL_RESPONSE_BYTES + 1)
    if len(payload) > MAX_DETAIL_RESPONSE_BYTES:
        raise ValueError("抖音公开视频信息响应过大。")
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("抖音公开视频信息格式无效。") from error
    if not isinstance(value, dict):
        raise ValueError("抖音公开视频信息格式无效。")
    return value


def resolve_public_douyin_video(
    share_url: str,
    *,
    open_url: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    """Return the public ``aweme_detail`` for a Douyin video share URL."""

    share_request = urllib.request.Request(
        share_url,
        headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "User-Agent": DOUYIN_PREVIEW_USER_AGENT,
        },
    )
    with open_url(share_request, timeout=30) as response:
        resolved_url = str(response.geturl() or share_url)

    parsed_resolved = urllib.parse.urlparse(resolved_url)
    if not _is_douyin_host(parsed_resolved.hostname or ""):
        raise ValueError("抖音分享链接跳转到了非抖音地址。")
    video_id = _video_id_from_url(resolved_url) or _video_id_from_url(share_url)
    if not video_id:
        raise ValueError("无法从抖音分享链接中识别视频编号。")

    page_url = f"https://www.douyin.com/video/{video_id}"
    common_query = {
        "device_platform": "webapp",
        "channel": "channel_pc_web",
        "pc_client_type": "1",
        "version_code": "290100",
        "version_name": "29.1.0",
        "aweme_id": video_id,
    }
    last_status = ""
    for aid in ("6383", "1128"):
        query = urllib.parse.urlencode({**common_query, "aid": aid})
        detail_url = f"https://www.douyin.com/aweme/v1/web/aweme/detail/?{query}"
        detail_request = urllib.request.Request(
            detail_url,
            headers={
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "Referer": page_url,
                "User-Agent": DOUYIN_PREVIEW_USER_AGENT,
            },
        )
        with open_url(detail_request, timeout=30) as response:
            payload = _read_json_response(response)
        detail = payload.get("aweme_detail")
        if isinstance(detail, dict) and detail:
            return {
                "video_id": video_id,
                "resolved_url": resolved_url,
                "page_url": page_url,
                "detail": detail,
            }
        last_status = str(payload.get("status_msg") or payload.get("status_code") or "")

    suffix = f"（{last_status}）" if last_status else ""
    raise ValueError(f"该抖音作品暂时无法公开读取{suffix}。")


def first_media_url(*candidates: Any) -> str:
    """Select the first HTTP(S) URL from Douyin media address objects."""

    for candidate in candidates:
        if isinstance(candidate, dict):
            values = candidate.get("url_list") if isinstance(candidate.get("url_list"), list) else []
        elif isinstance(candidate, list):
            values = candidate
        else:
            values = []
        for value in values:
            url = str(value or "").strip()
            if url.startswith("http://") or url.startswith("https://"):
                return url.replace("http://", "https://", 1)
    return ""
