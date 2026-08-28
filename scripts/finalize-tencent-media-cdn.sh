#!/usr/bin/env bash
set -euo pipefail

env_file="${TENCENT_MEDIA_ENV_FILE:-/opt/merchant-studio/video-worker/.env}"
config_script="${TENCENT_MEDIA_CONFIG_SCRIPT:-/tmp/configure-tencent-media-cdn.mjs}"
interval_seconds="${TENCENT_MEDIA_CERT_POLL_SECONDS:-120}"
max_attempts="${TENCENT_MEDIA_CERT_MAX_ATTEMPTS:-360}"

if [[ ! -f "${env_file}" ]]; then
  echo "Tencent media environment file not found: ${env_file}" >&2
  exit 1
fi

if [[ ! -f "${config_script}" ]]; then
  echo "Tencent media CDN config script not found: ${config_script}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${env_file}"
set +a

for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
  result="$(node "${config_script}" --request-certificate)"
  printf '%s\n' "${result}"
  if grep -q '"result": "already-issued"' <<<"${result}"; then
    node "${config_script}" --apply
    echo "Tencent media CDN HTTPS finalization completed."
    exit 0
  fi
  sleep "${interval_seconds}"
done

echo "Tencent media CDN certificate was not issued within the polling window." >&2
exit 1
