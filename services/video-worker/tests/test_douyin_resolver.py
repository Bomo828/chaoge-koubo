from __future__ import annotations

import io
import json
import unittest

from douyin_resolver import first_media_url, resolve_public_douyin_video


class FakeResponse:
    def __init__(self, url: str, payload: bytes = b"") -> None:
        self.url = url
        self.payload = io.BytesIO(payload)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def geturl(self) -> str:
        return self.url

    def read(self, size: int = -1) -> bytes:
        return self.payload.read(size)


class DouyinResolverTests(unittest.TestCase):
    def test_resolves_short_link_then_public_detail(self) -> None:
        calls = []

        def open_url(request, timeout=0):
            calls.append((request.full_url, timeout, dict(request.header_items())))
            if len(calls) == 1:
                return FakeResponse("https://www.iesdouyin.com/share/video/7673233660736195880/")
            payload = json.dumps(
                {"aweme_detail": {"aweme_id": "7673233660736195880", "desc": "公开口播"}}
            ).encode()
            return FakeResponse(request.full_url, payload)

        result = resolve_public_douyin_video("https://v.douyin.com/example/", open_url=open_url)

        self.assertEqual(result["video_id"], "7673233660736195880")
        self.assertEqual(result["detail"]["desc"], "公开口播")
        self.assertIn("aweme_id=7673233660736195880", calls[1][0])
        self.assertEqual(calls[1][2]["Referer"], "https://www.douyin.com/video/7673233660736195880")

    def test_rejects_non_douyin_redirect(self) -> None:
        def open_url(_request, timeout=0):
            return FakeResponse("https://example.com/video/7673233660736195880")

        with self.assertRaisesRegex(ValueError, "非抖音地址"):
            resolve_public_douyin_video("https://v.douyin.com/example/", open_url=open_url)

    def test_selects_first_https_media_url(self) -> None:
        self.assertEqual(
            first_media_url({"url_list": ["http://v.example/video.mp4"]}),
            "https://v.example/video.mp4",
        )


if __name__ == "__main__":
    unittest.main()
