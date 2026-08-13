#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_COMMAND="/usr/local/sbin/deploy-video-worker"
SUDOERS_FILE="/etc/sudoers.d/merchant-video-worker-deploy"

[[ "$(id -u)" -eq 0 ]] || {
  echo "请使用 sudo 执行该初始化脚本。" >&2
  exit 1
}

install -o root -g root -m 0755 "${SOURCE_DIR}/deploy-video-worker" "${DEPLOY_COMMAND}"

tmp_sudoers="$(mktemp)"
trap 'rm -f "${tmp_sudoers}"' EXIT
printf 'merchantdeploy ALL=(root) NOPASSWD: %s\n' "${DEPLOY_COMMAND}" > "${tmp_sudoers}"
visudo -cf "${tmp_sudoers}"
install -o root -g root -m 0440 "${tmp_sudoers}" "${SUDOERS_FILE}"
visudo -cf "${SUDOERS_FILE}"

echo "视频服务自动发布入口初始化完成。"
