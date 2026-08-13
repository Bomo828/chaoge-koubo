#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ffmpeg \
  fonts-noto-cjk \
  python3 \
  python3-pip \
  python3-venv

python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip wheel
.venv/bin/python -m pip install -r requirements.txt

mkdir -p data

echo
echo "视频处理环境安装完成。"
echo "启动命令："
echo "  .venv/bin/uvicorn main:app --host 127.0.0.1 --port 8790"
echo
echo "启动后检查："
echo "  curl http://127.0.0.1:8790/health"
