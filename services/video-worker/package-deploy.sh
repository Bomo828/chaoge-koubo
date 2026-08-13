#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SOURCE_DIR/../.." && pwd)"
PACKAGE_DIR="$(mktemp -d)"
TARGET="$SOURCE_DIR/merchant-video-worker-deploy.tar.gz"

cleanup() {
  rm -rf "$PACKAGE_DIR"
}
trap cleanup EXIT

mkdir -p "$PACKAGE_DIR/video-worker/authoring-skill" "$PACKAGE_DIR/remotion-worker"
cp "$SOURCE_DIR"/*.py "$PACKAGE_DIR/video-worker/"
cp "$SOURCE_DIR"/*.json "$PACKAGE_DIR/video-worker/"
cp "$SOURCE_DIR"/*.txt "$PACKAGE_DIR/video-worker/"
cp "$SOURCE_DIR"/*.md "$PACKAGE_DIR/video-worker/"
cp "$SOURCE_DIR"/*.sh "$PACKAGE_DIR/video-worker/"
cp "$SOURCE_DIR"/*.command "$PACKAGE_DIR/video-worker/"
cp "$SOURCE_DIR"/*.example "$PACKAGE_DIR/video-worker/"
cp -R "$SOURCE_DIR/templates-v2" "$PACKAGE_DIR/video-worker/templates-v2"
python3 -m pip install --disable-pip-version-check --no-deps \
  --target "$PACKAGE_DIR/video-worker/vendor" \
  'https://github.com/JNHFlow21/social-media-toolkit/archive/139525c35ae55f090003fdb243e78ca22c1f402a.tar.gz'
python3 -m pip install --disable-pip-version-check \
  --target "$PACKAGE_DIR/video-worker/vendor" 'requests>=2.33.0,<3'
printf '%s\n' '"""Bundled public Douyin adapter (Apache-2.0)."""' \
  > "$PACKAGE_DIR/video-worker/vendor/social_media_toolkit/__init__.py"
printf '%s\n' '"""Bundled platform adapters."""' \
  > "$PACKAGE_DIR/video-worker/vendor/social_media_toolkit/platforms/__init__.py"
cp -R "$PROJECT_ROOT/skills/distill-viral-video-template"/. "$PACKAGE_DIR/video-worker/authoring-skill/"
find "$PACKAGE_DIR/video-worker/authoring-skill" -type d -name __pycache__ -prune -exec rm -rf {} +
find "$PACKAGE_DIR/video-worker/authoring-skill" -type f \( -name '*.pyc' -o -name '.DS_Store' \) -delete
cp "$PROJECT_ROOT/services/remotion-worker/package.json" "$PACKAGE_DIR/remotion-worker/"
cp "$PROJECT_ROOT/services/remotion-worker/pnpm-lock.yaml" "$PACKAGE_DIR/remotion-worker/"
cp "$PROJECT_ROOT/services/remotion-worker/pnpm-workspace.yaml" "$PACKAGE_DIR/remotion-worker/"
cp "$PROJECT_ROOT/services/remotion-worker/tsconfig.json" "$PACKAGE_DIR/remotion-worker/"
cp "$PROJECT_ROOT/services/remotion-worker/README.md" "$PACKAGE_DIR/remotion-worker/"
cp "$PROJECT_ROOT/services/remotion-worker/THIRD_PARTY_ASSETS.md" "$PACKAGE_DIR/remotion-worker/"
cp -R "$PROJECT_ROOT/services/remotion-worker/src" "$PACKAGE_DIR/remotion-worker/src"
cp -R "$PROJECT_ROOT/services/remotion-worker/scripts" "$PACKAGE_DIR/remotion-worker/scripts"
cp -R "$PROJECT_ROOT/services/remotion-worker/public" "$PACKAGE_DIR/remotion-worker/public"
chmod +x "$PACKAGE_DIR/video-worker"/*.sh "$PACKAGE_DIR/video-worker"/*.command
tar -C "$PACKAGE_DIR" -czf "$TARGET" video-worker remotion-worker
echo "$TARGET"
