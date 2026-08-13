#!/usr/bin/env python3
"""Create an evidence-only Tencent Flash ASR transcript for local template QA.

The script never prints or persists credentials. It writes the provider's timed
sentences and words so a reference and a generated video can be compared before
template code is changed or published.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--env", type=Path, default=Path(".env.local"))
    parser.add_argument("--ffmpeg", default="ffmpeg")
    return parser.parse_args()


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text("utf-8").splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def normalize(payload: dict) -> list[dict]:
    results = payload.get("flash_result")
    if not isinstance(results, list) or not results:
        return []
    channel = next((item for item in results if isinstance(item, dict)), {})
    sentences = channel.get("sentence_list")
    output: list[dict] = []
    if not isinstance(sentences, list):
        return output
    for sentence in sentences:
        if not isinstance(sentence, dict):
            continue
        text = "".join(str(sentence.get("text") or "").split()).strip()
        start = max(0.0, float(sentence.get("start_time") or 0) / 1000)
        end = max(start + 0.04, float(sentence.get("end_time") or 0) / 1000)
        if not text:
            continue
        words: list[dict] = []
        for word in sentence.get("word_list") or []:
            if not isinstance(word, dict) or not str(word.get("word") or "").strip():
                continue
            word_start = max(start, float(word.get("start_time") or 0) / 1000)
            word_end = max(word_start + 0.02, float(word.get("end_time") or 0) / 1000)
            words.append({
                "start": round(word_start, 3),
                "end": round(word_end, 3),
                "text": str(word.get("word") or "").strip(),
            })
        output.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "text": text,
            "words": words,
        })
    return output


def main() -> None:
    args = arguments()
    load_env(args.env)
    app_id = os.getenv("TENCENT_CLOUD_APP_ID", os.getenv("TENCENT_APP_ID", "")).strip()
    secret_id = os.getenv("TENCENT_CLOUD_SECRET_ID", os.getenv("TENCENT_SECRET_ID", "")).strip()
    secret_key = os.getenv("TENCENT_CLOUD_SECRET_KEY", os.getenv("TENCENT_SECRET_KEY", "")).strip()
    engine = os.getenv("TENCENT_ASR_ENGINE_TYPE", "16k_zh").strip() or "16k_zh"
    if not app_id or not secret_id or not secret_key:
        raise SystemExit("Tencent Flash ASR credentials are not configured.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    wav = args.output.with_suffix(".wav")
    subprocess.run([
        args.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(args.input),
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav),
    ], check=True)
    params = {
        "convert_num_mode": "1",
        "engine_type": engine,
        "filter_dirty": "0",
        "filter_modal": "0",
        "filter_punc": "0",
        "first_channel_only": "1",
        "secretid": secret_id,
        "speaker_diarization": "0",
        "timestamp": str(int(time.time())),
        "voice_format": "wav",
        "word_info": "3",
        "sentence_max_length": "18",
    }
    query = urllib.parse.urlencode(sorted(params.items()))
    path = f"/asr/flash/v1/{app_id}?{query}"
    signature = base64.b64encode(
        hmac.new(secret_key.encode(), f"POSTasr.cloud.tencent.com{path}".encode(), hashlib.sha1).digest()
    ).decode()
    audio = wav.read_bytes()
    request = urllib.request.Request(
        f"https://asr.cloud.tencent.com{path}",
        data=audio,
        headers={
            "Authorization": signature,
            "Content-Type": "application/octet-stream",
            "Content-Length": str(len(audio)),
            "Host": "asr.cloud.tencent.com",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if int(payload.get("code") or 0):
        raise SystemExit(f"Tencent Flash ASR failed ({payload.get('code')}): {payload.get('message')}")
    segments = normalize(payload)
    result = {
        "source": str(args.input.resolve()),
        "provider": "tencent-flash",
        "engine": engine,
        "request_id": str(payload.get("request_id") or ""),
        "audio_duration_ms": int(payload.get("audio_duration") or 0),
        "segments": segments,
        "transcript": "".join(item["text"] for item in segments),
    }
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", "utf-8")
    wav.unlink(missing_ok=True)
    print(json.dumps({
        "segments": len(segments),
        "audio_duration_ms": result["audio_duration_ms"],
        "transcript_chars": len(result["transcript"]),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
