#!/bin/zsh
set -e
cd "$(dirname "$0")"

# Local development shares the server-only configuration with the web app.
# This file is git-ignored and must never be shipped to the browser bundle.
if [ -f "../../.env.local" ]; then
  set -a
  source "../../.env.local"
  set +a
fi

# The Remotion compositor includes a reduced FFmpeg for its own internal use,
# but it does not provide the ASS subtitle and xfade filters required by the
# fallback renderer. Refuse to start with that binary: otherwise the service
# looks healthy and only fails after the user reaches the final render step.
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "缺少完整版 FFmpeg。macOS 请先执行：brew install ffmpeg"
  exit 1
fi
for required_filter in ass xfade amix; do
  if ! ffmpeg -hide_banner -filters 2>/dev/null \
    | awk -v required="$required_filter" '$2 == required { found = 1 } END { exit(found ? 0 : 1) }'; then
    echo "当前 FFmpeg 缺少 $required_filter 滤镜，请安装包含 libass 的完整版 FFmpeg。"
    exit 1
  fi
done

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi

source .venv/bin/activate
if ! python -c 'import fastapi, uvicorn, multipart, sys; sys.version_info >= (3, 10) or __import__("eval_type_backport")' >/dev/null 2>&1; then
  python -m pip install -r requirements.txt
fi
exec uvicorn main:app --host 127.0.0.1 --port 8790
