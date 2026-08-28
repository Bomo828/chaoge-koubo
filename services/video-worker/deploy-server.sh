#!/usr/bin/env bash
set -euo pipefail

# Non-interactive sudo sessions on Ubuntu may omit administrative paths.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SOURCE_DIR/../.." 2>/dev/null && pwd || true)"
AUTHORING_SKILL_SOURCE=""
if [ -d "$SOURCE_DIR/authoring-skill" ]; then
  AUTHORING_SKILL_SOURCE="$SOURCE_DIR/authoring-skill"
elif [ -n "$PROJECT_ROOT" ] && [ -d "$PROJECT_ROOT/skills/distill-viral-video-template" ]; then
  AUTHORING_SKILL_SOURCE="$PROJECT_ROOT/skills/distill-viral-video-template"
fi
INSTALL_DIR="/opt/merchant-studio/video-worker"
REMOTION_INSTALL_DIR="/opt/merchant-studio/remotion-worker"
DATA_DIR="/var/lib/merchant-studio/video"
REMOTION_RUNTIME_DIR="/var/lib/merchant-studio/remotion"
SERVICE_USER="merchant-studio"
PYTHON_BIN="python3"
EXISTING_AI_KEY=""
EXISTING_TEMPLATE_REGISTRY_URL=""
EXISTING_ADMIN_TOKEN=""
EXISTING_TENCENT_APP_ID=""
EXISTING_TENCENT_SECRET_ID=""
EXISTING_TENCENT_SECRET_KEY=""
EXISTING_MPS_COS_BUCKET=""
EXISTING_MPS_COS_REGION="ap-guangzhou"
VIDEO_WORKER_CORS_ORIGINS_VALUE="${VIDEO_WORKER_CORS_ORIGINS:-http://localhost:3000,http://localhost:3001,http://localhost:3012,http://127.0.0.1:3000,http://127.0.0.1:3001,http://127.0.0.1:3012,https://studio.example.com}"
VIDEO_WORKER_PUBLIC_BASE_URL_VALUE="${VIDEO_WORKER_PUBLIC_BASE_URL:-https://studio.example.com/video-worker}"
if [ -f "$INSTALL_DIR/.env" ]; then
  EXISTING_AI_KEY="$($SUDO sed -n 's/^LK888_API_KEY=//p' "$INSTALL_DIR/.env" | head -n 1)"
  EXISTING_TEMPLATE_REGISTRY_URL="$($SUDO sed -n 's/^VIDEO_TEMPLATE_REGISTRY_URL=//p' "$INSTALL_DIR/.env" | head -n 1)"
  EXISTING_ADMIN_TOKEN="$($SUDO sed -n 's/^VIDEO_WORKER_ADMIN_TOKEN=//p' "$INSTALL_DIR/.env" | head -n 1)"
  EXISTING_TENCENT_APP_ID="$($SUDO sed -n 's/^TENCENT_CLOUD_APP_ID=//p' "$INSTALL_DIR/.env" | head -n 1)"
  EXISTING_TENCENT_SECRET_ID="$($SUDO sed -n 's/^TENCENT_CLOUD_SECRET_ID=//p' "$INSTALL_DIR/.env" | head -n 1)"
  EXISTING_TENCENT_SECRET_KEY="$($SUDO sed -n 's/^TENCENT_CLOUD_SECRET_KEY=//p' "$INSTALL_DIR/.env" | head -n 1)"
  EXISTING_MPS_COS_BUCKET="$($SUDO sed -n 's/^TENCENT_MPS_COS_BUCKET=//p' "$INSTALL_DIR/.env" | head -n 1)"
  EXISTING_MPS_COS_REGION="$($SUDO sed -n 's/^TENCENT_MPS_COS_REGION=//p' "$INSTALL_DIR/.env" | head -n 1)"
fi
if [ -z "$EXISTING_MPS_COS_REGION" ]; then
  EXISTING_MPS_COS_REGION="ap-guangzhou"
fi
if [ -z "$EXISTING_ADMIN_TOKEN" ]; then
  EXISTING_ADMIN_TOKEN="$(openssl rand -hex 32)"
fi

if command -v apt-get >/dev/null 2>&1; then
  $SUDO apt-get update
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates \
    curl \
    ffmpeg \
    fonts-noto-cjk \
    nginx \
    openssl \
    python3 \
    python3-pip \
    python3-venv \
    rsync \
    xz-utils
elif command -v dnf >/dev/null 2>&1; then
  # OpenCloudOS images may already carry an RPM Fusion FFmpeg build that
  # conflicts with the distribution package. Avoid reinstalling a working
  # binary; only ask dnf for components that are actually missing.
  if ! command -v ffmpeg >/dev/null 2>&1; then
    $SUDO dnf install -y ffmpeg
  fi
  if ! command -v python3.12 >/dev/null 2>&1; then
    $SUDO dnf install -y python3.12 python3.12-pip
  fi

  # Font packages differ across RPM distributions. They improve Chinese
  # subtitle rendering, but the worker must still be deployable if a
  # particular OpenCloudOS image does not publish them.
  $SUDO dnf install -y google-noto-sans-cjk-fonts \
    || $SUDO dnf install -y google-noto-cjk-fonts \
    || true
else
  echo "Unsupported Linux distribution: apt-get or dnf is required." >&2
  exit 1
fi

if command -v python3.12 >/dev/null 2>&1; then
  PYTHON_BIN="python3.12"
fi

REMOTION_BROWSER_EXECUTABLE_VALUE="${REMOTION_BROWSER_EXECUTABLE:-}"
if [ -z "$REMOTION_BROWSER_EXECUTABLE_VALUE" ]; then
  for browser_candidate in \
    /usr/bin/google-chrome-stable \
    /usr/bin/google-chrome \
    /usr/bin/chromium \
    /usr/bin/chromium-browser \
    /usr/lib64/chromium-browser/headless_shell; do
    if [ -x "$browser_candidate" ]; then
      REMOTION_BROWSER_EXECUTABLE_VALUE="$browser_candidate"
      break
    fi
  done
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  $SUDO useradd \
    --system \
    --home /var/lib/merchant-studio \
    --shell /usr/sbin/nologin \
    "$SERVICE_USER"
fi

$SUDO mkdir -p "$INSTALL_DIR" "$REMOTION_INSTALL_DIR" "$DATA_DIR" "$REMOTION_RUNTIME_DIR"
$SUDO cp -R "$SOURCE_DIR"/. "$INSTALL_DIR"/
if [ -d "$SOURCE_DIR/../remotion-worker" ]; then
  $SUDO cp -R "$SOURCE_DIR/../remotion-worker"/. "$REMOTION_INSTALL_DIR"/
fi
if [ -n "$AUTHORING_SKILL_SOURCE" ]; then
  $SUDO rm -rf "$INSTALL_DIR/authoring-skill"
  $SUDO cp -R "$AUTHORING_SKILL_SOURCE" "$INSTALL_DIR/authoring-skill"
fi
$SUDO "$PYTHON_BIN" -m venv "$INSTALL_DIR/.venv"
$SUDO "$INSTALL_DIR/.venv/bin/python" -m pip install --upgrade pip wheel
$SUDO "$INSTALL_DIR/.venv/bin/python" -m pip install -r "$INSTALL_DIR/requirements.txt"

if [ -f "$REMOTION_INSTALL_DIR/package.json" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "服务器缺少 Node.js，无法启用 Remotion 视频包装引擎。" >&2
    exit 1
  fi
  if command -v corepack >/dev/null 2>&1; then
    $SUDO corepack enable
    # Pin the package manager so unattended cloud deployments never pause at
    # Corepack's first-download confirmation prompt.
    $SUDO env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare pnpm@11.18.0 --activate
  fi
  if command -v pnpm >/dev/null 2>&1; then
    $SUDO sh -c "cd '$REMOTION_INSTALL_DIR' && pnpm install --prod --frozen-lockfile"
  else
    echo "服务器缺少 pnpm，请先启用 corepack/pnpm。" >&2
    exit 1
  fi
  $SUDO mkdir -p \
    "$REMOTION_INSTALL_DIR/node_modules/.cache" \
    "$REMOTION_INSTALL_DIR/node_modules/.remotion"
  $SUDO chown -R "$SERVICE_USER:$SERVICE_USER" \
    "$REMOTION_INSTALL_DIR/node_modules/.cache" \
    "$REMOTION_INSTALL_DIR/node_modules/.remotion"
  # Keep the renderer available at both supported layouts. The first cloud
  # bootstrap uses the sibling directory; later atomic GitHub releases carry
  # it inside the video worker release.
  if [ ! -e "$INSTALL_DIR/remotion-worker" ]; then
    $SUDO ln -s "$REMOTION_INSTALL_DIR" "$INSTALL_DIR/remotion-worker"
  fi
fi

$SUDO tee "$INSTALL_DIR/.env" >/dev/null <<EOF
VIDEO_WORKER_DATA_DIR=/var/lib/merchant-studio/video
VIDEO_WORKER_MAX_UPLOAD_MB=500
VIDEO_WORKER_CONCURRENCY=1
VIDEO_WORKER_TRANSCRIPTION_CONCURRENCY=1
VIDEO_WORKER_CORS_ORIGINS=$VIDEO_WORKER_CORS_ORIGINS_VALUE
VIDEO_WORKER_PUBLIC_BASE_URL=$VIDEO_WORKER_PUBLIC_BASE_URL_VALUE
VIDEO_WORKER_X264_PRESET=fast
VIDEO_WORKER_CRF=18
LK888_API_BASE_URL=https://api.lk888.ai
LK888_API_KEY=$EXISTING_AI_KEY
VIDEO_WORKER_TITLE_MODEL=gpt-5.5
VIDEO_WORKER_VIDEO_ANALYSIS_MODEL=gemini-3.5-flash
TENCENT_CLOUD_APP_ID=$EXISTING_TENCENT_APP_ID
TENCENT_CLOUD_SECRET_ID=$EXISTING_TENCENT_SECRET_ID
TENCENT_CLOUD_SECRET_KEY=$EXISTING_TENCENT_SECRET_KEY
TENCENT_MPS_COS_BUCKET=$EXISTING_MPS_COS_BUCKET
TENCENT_MPS_COS_REGION=$EXISTING_MPS_COS_REGION
VIDEO_WORKER_COS_OUTPUT_PREFIX=video-worker/outputs
TENCENT_ASR_ENGINE_TYPE=16k_zh_en
TENCENT_ASR_TIMEOUT_SECONDS=90
VIDEO_WORKER_JOB_RETENTION_HOURS=24
VIDEO_WORKER_CLEANUP_INTERVAL_SECONDS=1800
VIDEO_WORKER_RENDERER=remotion
REMOTION_RUNTIME_DIR=/var/lib/merchant-studio/remotion
REMOTION_BROWSER_EXECUTABLE=$REMOTION_BROWSER_EXECUTABLE_VALUE
REMOTION_RENDER_MODE=web-standard
REMOTION_SUPERSAMPLE=1
REMOTION_CONCURRENCY=4
REMOTION_CRF=18
REMOTION_X264_PRESET=fast
VIDEO_TEMPLATE_REGISTRY_URL=$EXISTING_TEMPLATE_REGISTRY_URL
VIDEO_TEMPLATE_REGISTRY_CACHE_SECONDS=300
VIDEO_WORKER_ADMIN_TOKEN=$EXISTING_ADMIN_TOKEN
EOF

$SUDO mkdir -p \
  /var/lib/merchant-studio/video \
  /var/lib/merchant-studio/remotion \
  /var/lib/merchant-studio/cache \
  /var/lib/merchant-studio/.cache
$SUDO chown -R "$SERVICE_USER:$SERVICE_USER" \
  /var/lib/merchant-studio/video \
  /var/lib/merchant-studio/remotion \
  /var/lib/merchant-studio/cache \
  /var/lib/merchant-studio/.cache
if [ -f /var/lib/merchant-studio/swapfile ]; then
  $SUDO chown root:root /var/lib/merchant-studio/swapfile
  $SUDO chmod 600 /var/lib/merchant-studio/swapfile
fi
$SUDO chmod -R a+rX "$INSTALL_DIR"
$SUDO chmod -R a+rX "$REMOTION_INSTALL_DIR"

$SUDO tee /etc/systemd/system/merchant-video-worker.service >/dev/null <<'EOF'
[Unit]
Description=Merchant Studio Video Worker
After=network.target

[Service]
Type=simple
User=merchant-studio
Group=merchant-studio
WorkingDirectory=/opt/merchant-studio/video-worker
EnvironmentFile=/opt/merchant-studio/video-worker/.env
Environment=HF_HOME=/var/lib/merchant-studio/.cache/huggingface
Environment=REMOTION_RUNTIME_DIR=/var/lib/merchant-studio/remotion
ExecStart=/opt/merchant-studio/video-worker/.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8790
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable merchant-video-worker
$SUDO systemctl restart merchant-video-worker

sleep 3
echo
echo "===== VIDEO WORKER HEALTH ====="
curl -fsS http://127.0.0.1:8790/health
echo
echo "===== SERVICE STATUS ====="
$SUDO systemctl --no-pager --full status merchant-video-worker | sed -n '1,22p'
