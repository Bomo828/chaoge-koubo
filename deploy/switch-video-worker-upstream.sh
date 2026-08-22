#!/usr/bin/env bash
set -euo pipefail

CONFIG="/etc/nginx/conf.d/merchant-studio-api.conf"
OLD_UPSTREAM="proxy_pass http://127.0.0.1:8790/;"
NEW_UPSTREAM="proxy_pass http://129.204.151.78/video-worker/;"
HEALTH_URL="http://129.204.151.78/video-worker/health"

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

curl --fail --silent --show-error --max-time 15 \
  -H 'Host: api.chaogeai.top' \
  http://127.0.0.1/video-worker/health >/dev/null

trap - ERR
echo "Video worker upstream switched to 129.204.151.78 successfully."
echo "Rollback copy: ${backup}"
