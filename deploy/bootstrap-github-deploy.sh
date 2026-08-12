#!/usr/bin/env bash
set -euo pipefail

PUBLIC_KEY_FILE="${1:-}"
PROJECT_DIR="${2:-}"
DEPLOY_USER="merchantdeploy"
DEPLOY_COMMAND="/usr/local/sbin/deploy-merchant-studio"
VIDEO_WORKER_DEPLOY_COMMAND="/usr/local/sbin/deploy-video-worker"
SUDOERS_FILE="/etc/sudoers.d/merchant-studio-deploy"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi
if [[ ! -f "${PUBLIC_KEY_FILE}" ]]; then
  echo "Public key file is missing." >&2
  exit 1
fi
if [[ ! -f "${PROJECT_DIR}/deploy/deploy-merchant-studio" ]]; then
  echo "Project deployment command is missing." >&2
  exit 1
fi

if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${DEPLOY_USER}"
fi

install -d -m 0700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh"
touch "/home/${DEPLOY_USER}/.ssh/authorized_keys"
chmod 0600 "/home/${DEPLOY_USER}/.ssh/authorized_keys"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh/authorized_keys"

public_key="$(tr -d '\r\n' < "${PUBLIC_KEY_FILE}")"
if ! grep -qxF "${public_key}" "/home/${DEPLOY_USER}/.ssh/authorized_keys"; then
  printf '%s\n' "${public_key}" >> "/home/${DEPLOY_USER}/.ssh/authorized_keys"
fi

install -m 0755 "${PROJECT_DIR}/deploy/deploy-merchant-studio" "${DEPLOY_COMMAND}"
install -m 0755 "${PROJECT_DIR}/deploy/deploy-video-worker" "${VIDEO_WORKER_DEPLOY_COMMAND}"
printf '%s ALL=(root) NOPASSWD: %s, %s\n' "${DEPLOY_USER}" "${DEPLOY_COMMAND}" "${VIDEO_WORKER_DEPLOY_COMMAND}" > "${SUDOERS_FILE}"
chmod 0440 "${SUDOERS_FILE}"
visudo -cf "${SUDOERS_FILE}"

echo "GitHub deployment user is ready."
