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

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "缺少 FFmpeg。macOS 请先执行：brew install ffmpeg"
  exit 1
fi

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi

source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
exec uvicorn main:app --host 127.0.0.1 --port 8790
