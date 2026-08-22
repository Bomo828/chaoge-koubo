#!/usr/bin/env bash
set -euo pipefail

SOURCE="/var/lib/merchant-studio/video/smoke-render/source-input.mp4"
CAPTIONS='[{"start":0,"end":2,"text":"新服务器已经就绪"},{"start":2,"end":4,"text":"网感渲染速度提升"}]'

for template_id in template-9 template-10 template-11 template-12; do
  response="$(curl -fsS \
    -F "video=@${SOURCE};type=video/mp4" \
    -F "template_id=${template_id}" \
    -F "title=渲染服务器正式启用" \
    -F "captions_json=${CAPTIONS}" \
    -F "include_sfx=true" \
    -F "include_bgm=true" \
    http://127.0.0.1:8790/v1/jobs)"
  job_id="$(printf '%s' "$response" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
  started="$(date +%s)"

  for _ in $(seq 1 120); do
    status="$(curl -fsS "http://127.0.0.1:8790/v1/jobs/${job_id}")"
    state="$(printf '%s' "$status" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state", ""))')"
    if [ "$state" = "success" ] || [ "$state" = "completed" ]; then
      elapsed="$(( $(date +%s) - started ))"
      printf '%s\n' "${template_id} completed ${elapsed}s ${job_id}"
      break
    fi
    if [ "$state" = "failed" ]; then
      printf '%s' "$status" | python3 -c 'import json,sys; value=json.load(sys.stdin); print(value.get("template_id"), "failed", value.get("error"))'
      exit 1
    fi
    sleep 2
  done
done
