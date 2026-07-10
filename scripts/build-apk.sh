#!/usr/bin/env bash
#
# build-apk.sh — build the release Android APK for the SOMS Tauri shell inside a self-contained
# docker image. Requires Docker. The frontend is built on the host first (Node), then the image
# (JDK + Android SDK/NDK + Rust toolchain + pre-fetched crates — NO build-time fetch) emits the APK.
#
# The image IS the persistence layer: the first run builds it once (~20 min — SDK/NDK are multi-GB),
# later runs skip straight to the APK. A local HTTP proxy (default 127.0.0.1:7892) is auto-detected
# and used ONLY to accelerate that one-time image build; disable with APK_BUILD_PROXY= .
#
#   ./scripts/build-apk.sh
#   APK_BUILD_PROXY=http://127.0.0.1:7892 ./scripts/build-apk.sh
#
set -euo pipefail

IMAGE="soms-android-build:24.04"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROXY="${APK_BUILD_PROXY:-http://127.0.0.1:7892}"

# 0) Docker is a hard requirement.
command -v docker >/dev/null 2>&1 || { echo "✗ docker not found (required). Install Docker first." >&2; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "✗ npm not found (host frontend build needs Node)." >&2; exit 1; }
cd "$REPO_ROOT"

# 1) Auto-detect the local proxy; build direct if it's down. --network host lets the build steps
#    reach 127.0.0.1 on the host.
PROXY_ARGS=()
if [ -n "$PROXY" ] && curl -x "$PROXY" -sS --connect-timeout 3 -o /dev/null https://static.rust-lang.org/ 2>/dev/null; then
  echo "• proxy $PROXY up — routing the image build through it."
  ph="${PROXY#http://}"; ph="${ph#https://}"
  PROXY_HOST="${ph%%[:/]*}"; PROXY_PORT="${ph#*:}"; PROXY_PORT="${PROXY_PORT%%/*}"
  JAVA_OPTS="-Dhttp.proxyHost=${PROXY_HOST} -Dhttp.proxyPort=${PROXY_PORT} -Dhttps.proxyHost=${PROXY_HOST} -Dhttps.proxyPort=${PROXY_PORT}"
  PROXY_ARGS=(--network host --build-arg "HTTP_PROXY=${PROXY}" --build-arg "HTTPS_PROXY=${PROXY}" --build-arg "JAVA_TOOL_OPTIONS=${JAVA_OPTS}")
else
  echo "• proxy unavailable — building the image with direct (standard) sources (slower)."
fi

# 2) Build the image if missing (rebuild only when Cargo.lock / SDK versions change).
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "• image $IMAGE exists — skipping build."
else
  echo "• building image $IMAGE (one-time; SDK/NDK + Rust toolchain + crates)…"
  docker build -t "$IMAGE" "${PROXY_ARGS[@]}" src-tauri
fi

# 3) Build the frontend on the host so the container needs no Node.
echo "• building frontend on host (npm --prefix web run build)…"
npm --prefix web run build

# 4) Build the APK inside the image. --config blanks beforeBuildCommand (frontend already built; the
#    container has no Node). soms-gradle caches gradle deps across runs. HOME=/tmp gives the non-root
#    uid a writable home.
echo "• building APK in $IMAGE…"
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$REPO_ROOT:/work" -v soms-gradle:/opt/gradle \
  "$IMAGE" \
  cargo tauri android build --apk --config '{"build":{"beforeBuildCommand":""}}'

echo "✓ done. APK under src-tauri/gen/android/app/build/outputs/apk/"
