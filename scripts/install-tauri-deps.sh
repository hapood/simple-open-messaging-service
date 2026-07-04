#!/usr/bin/env bash
#
# Installs the system libraries needed to build a Tauri desktop app on this machine.
# Run with sudo:   sudo bash scripts/install-tauri-deps.sh
#
# Proxy (192.168.88.8:8080) is baked in for both apt and the live shell, so this works behind the
# local proxy without any extra setup. Rust/cargo are NOT installed here — they go into the conda
# `easy-chart` env separately (no sudo needed for that).
#
# Verdict logic: Tauri v2 needs libwebkit2gtk-4.1, which only ships on Ubuntu 22.04+ / Kylin V10
# SP2. This box is Kylin V10 SP1 (20.04-based) where 4.1 is absent. The script detects which
# webkit dev package is reachable and installs the matching one, then prints a clear verdict so
# you know whether to target Tauri v2 (build elsewhere) or Tauri v1 (builds here).
set -euo pipefail

PROXY="http://192.168.88.8:8080"

# --- 1. Proxy for this session (apt honors http_proxy/https_proxy env vars) -------------------
export http_proxy="${PROXY}"
export https_proxy="${PROXY}"
export HTTP_PROXY="${PROXY}"
export HTTPS_PROXY="${PROXY}"
export no_proxy="localhost,127.0.0.1,::1"
export NO_PROXY="localhost,127.0.0.1,::1"

# Persist an apt conf drop-in so subsequent `apt-get` calls also go through the proxy (env vars
# alone are sometimes ignored by apt workers). Removed again at the end.
APT_PROXY_CONF="/etc/apt/apt.conf.d/95tauri-proxy"
trap 'rm -f "$APT_PROXY_CONF"' EXIT
cat > "$APT_PROXY_CONF" <<EOF
Acquire::http::Proxy "${PROXY}";
Acquire::https::Proxy "${PROXY}";
EOF

echo "==> Proxy set to ${PROXY}"
echo "==> apt-get update"
apt-get update

# --- 2. Common Tauri build deps (these exist on 20.04 and are needed by both v1 and v2) --------
COMMON_DEPS=(
  build-essential
  curl
  wget
  file
  pkg-config
  libssl-dev
  libxdo-dev
  libayatana-appindicator3-dev
  librsvg2-dev
  librsvg2-bin
  libglib2.0-dev
  libgtk-3-dev
  libsoup2.4-dev
)
echo "==> Installing common deps: ${COMMON_DEPS[*]}"
apt-get install -y "${COMMON_DEPS[@]}"

# --- 3. Webkit dev headers — prefer 4.1 (Tauri v2), fall back to 4.0 (Tauri v1) ----------------
echo
echo "==> Probing for libwebkit2gtk-4.1-dev (Tauri v2)…"
if apt-cache show libwebkit2gtk-4.1-dev > /dev/null 2>&1; then
  echo "    4.1 is available — installing (Tauri v2 will build here)."
  apt-get install -y libwebkit2gtk-4.1-dev libsoup-3.0-dev
  WEBKIT=41
else
  echo "    libwebkit2gtk-4.1-dev NOT found in your repos."
  echo "==> Probing for libwebkit2gtk-4.0-dev (Tauri v1 fallback)…"
  if apt-cache show libwebkit2gtk-4.0-dev > /dev/null 2>&1; then
    echo "    4.0 is available — installing (Tauri v1 desktop will build here; v2 needs a 22.04+ box)."
    apt-get install -y libwebkit2gtk-4.0-dev
    WEBKIT=40
  else
    echo "    Neither webkit dev package is available — cannot build Tauri on this OS."
    WEBKIT=none
  fi
fi

# --- 4. Verdict --------------------------------------------------------------------------------
echo
echo "==================== TAURI BUILD ENVIRONMENT VERDICT ===================="
case "$WEBKIT" in
  41) echo "webkit2gtk-4.1 installed  → Tauri v2 desktop: BUILDABLE on this machine." ;;
  40) echo "webkit2gtk-4.0 installed  → Tauri v1 desktop: BUILDABLE here."
      echo "                            → Tauri v2 desktop: NOT buildable here (needs Ubuntu 22.04+)." ;;
  *)  echo "No webkit dev headers     → Tauri desktop: NOT buildable on this OS version." ;;
esac
echo "------------------------------------------------------------------------"
echo "Next: Rust toolchain goes into the conda easy-chart env (no sudo)."
echo "========================================================================"
