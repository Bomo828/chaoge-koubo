#!/usr/bin/env bash
set -euo pipefail

CONFIG="${NGINX_CONFIG_PATH:-/etc/nginx/conf.d/merchant-studio-api.conf}"
OLD_UPSTREAM="${OLD_VIDEO_WORKER_PROXY_PASS:-proxy_pass http://127.0.0.1:8790/;}"
: "${VIDEO_WORKER_UPSTREAM_URL:?Set VIDEO_WORKER_UPSTREAM_URL, for example http://10.0.0.20/video-worker}"
upstream_base="${VIDEO_WORKER_UPSTREAM_URL%/}"
NEW_UPSTREAM="proxy_pass ${upstream_base}/;"
HEALTH_URL="${VIDEO_WORKER_HEALTH_URL:-${upstream_base}/health}"
PUBLIC_HOST_HEADER="${PUBLIC_HOST_HEADER:-}"

fail() {
  echo "Video worker upstream switch failed: $*" >&2
  exit 1
}

[[ "$(id -u)" -eq 0 ]] || fail "run this script as root"
[[ -f "${CONFIG}" ]] || fail "Nginx config is missing: ${CONFIG}"

curl --fail --silent --show-error --max-time 15 "${HEALTH_URL}" >/dev/null \
  || fail "new render node health check failed"

if grep -Fq "${NEW_UPSTREAM}" "${CONFIG}"; then
  echo "New render node is already active."
  exit 0
fi

[[ "$(grep -Fc "${OLD_UPSTREAM}" "${CONFIG}")" -eq 1 ]] \
  || fail "expected exactly one old video worker upstream"

backup="${CONFIG}.bak-render-switch-$(date +%Y%m%d%H%M%S)"
cp -a "${CONFIG}" "${backup}"

rollback() {
  local exit_code=$?
  trap - ERR
  cp -a "${backup}" "${CONFIG}"
  nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  echo "Switch failed; the original Nginx config was restored from ${backup}." >&2
  exit "${exit_code}"
}
trap rollback ERR

python3 - "${CONFIG}" "${OLD_UPSTREAM}" "${NEW_UPSTREAM}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
old = sys.argv[2]
new = sys.argv[3]
text = path.read_text(encoding="utf-8")
if text.count(old) != 1:
    raise SystemExit("old upstream no longer matches")
path.write_text(text.replace(old, new), encoding="utf-8")
PY

nginx -t
systemctl reload nginx

if [[ -n "${PUBLIC_HOST_HEADER}" ]]; then
  curl --fail --silent --show-error --max-time 15 \
    -H "Host: ${PUBLIC_HOST_HEADER}" \
    http://127.0.0.1/video-worker/health >/dev/null
else
  curl --fail --silent --show-error --max-time 15 \
    http://127.0.0.1/video-worker/health >/dev/null
fi

trap - ERR
echo "Video worker upstream switched successfully."
echo "Rollback copy: ${backup}"
