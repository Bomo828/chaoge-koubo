#!/usr/bin/env bash
set -euo pipefail

ARCHIVE="${1:-/root/merchant-studio-web-production.tar.gz}"
APP_ROOT="/opt/merchant-studio"
APP_DIR="${APP_ROOT}/web"
RELEASE_DIR="${APP_ROOT}/web-new"
BACKUP_DIR="${APP_ROOT}/web-backup"

if [[ ! -f "${ARCHIVE}" ]]; then
  echo "Deployment archive not found: ${ARCHIVE}" >&2
  exit 1
fi

if ! id merchantstudio >/dev/null 2>&1; then
  useradd --system --home-dir "${APP_DIR}" --shell /sbin/nologin merchantstudio
fi

rm -rf "${RELEASE_DIR}"
mkdir -p "${RELEASE_DIR}"
tar -xzf "${ARCHIVE}" -C "${RELEASE_DIR}"

if [[ ! -f "${RELEASE_DIR}/server.js" ]]; then
  echo "Invalid deployment archive: server.js is missing" >&2
  exit 1
fi

systemctl stop merchant-studio-web.service 2>/dev/null || true
rm -rf "${BACKUP_DIR}"
if [[ -d "${APP_DIR}" ]]; then
  mv "${APP_DIR}" "${BACKUP_DIR}"
fi
mv "${RELEASE_DIR}" "${APP_DIR}"

# Keep production member accounts, points, templates and generated assets when
# the application bundle is upgraded. A fresh installation may still seed its
# own .data directory from the archive.
if [[ -d "${BACKUP_DIR}/.data" ]]; then
  rm -rf "${APP_DIR}/.data"
  mv "${BACKUP_DIR}/.data" "${APP_DIR}/.data"
fi
mkdir -p "${APP_DIR}/.data"

# Production credentials can be newer than the local deployment bundle.
if [[ -f "${BACKUP_DIR}/.env.local" ]]; then
  cp -f "${BACKUP_DIR}/.env.local" "${APP_DIR}/.env.local"
fi

chown -R merchantstudio:merchantstudio "${APP_DIR}"
if [[ -f "${APP_DIR}/.env.local" ]]; then
  chmod 600 "${APP_DIR}/.env.local"
fi
install -m 0644 "${APP_DIR}/deploy/merchant-studio-web.service" /etc/systemd/system/merchant-studio-web.service

systemctl daemon-reload
systemctl enable --now merchant-studio-web.service

for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:3100/api/health >/dev/null; then
    systemctl is-active --quiet merchant-studio-web.service
    echo "Merchant Studio Web is running."
    exit 0
  fi
  sleep 1
done

systemctl status merchant-studio-web.service --no-pager -l || true
journalctl -u merchant-studio-web.service -n 80 --no-pager || true
exit 1
