#!/bin/zsh
set -e

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"

worker_pid=""
web_pid=""

cleanup() {
  if [ -n "$web_pid" ]; then
    kill "$web_pid" >/dev/null 2>&1 || true
  fi
  if [ -n "$worker_pid" ]; then
    kill "$worker_pid" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

if ! curl -fsS --max-time 2 http://127.0.0.1:8790/health >/dev/null 2>&1; then
  (
    cd services/video-worker
    exec ./start.command
  ) &
  worker_pid=$!

  worker_ready=0
  for _ in {1..30}; do
    if curl -fsS --max-time 2 http://127.0.0.1:8790/health >/dev/null 2>&1; then
      worker_ready=1
      break
    fi
    sleep 1
  done

  if [ "$worker_ready" -ne 1 ]; then
    echo "本地视频处理服务启动失败，请检查上方错误。"
    exit 1
  fi
fi

./node_modules/.bin/next dev "$@" &
web_pid=$!
wait "$web_pid"
