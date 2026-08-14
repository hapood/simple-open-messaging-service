#!/usr/bin/env bash
# Regenerate the web app icon set from web/public/logo.svg.
# Requires rsvg-convert (librsvg) and ImageMagick.
#
# logo.svg is the transparent Web H mark (bubble + connected M) and is also
# used directly by the in-app <app-brand-logo>. Android and Admin deliberately
# own separate sources under src-tauri/icons and admin-web/public respectively.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
SRC="$ROOT/web/public/logo.svg"
ICONS="$ROOT/web/public/icons"
PUBLIC="$ROOT/web/public"

command -v rsvg-convert >/dev/null || { echo "rsvg-convert (librsvg) is required" >&2; exit 1; }
command -v convert      >/dev/null || { echo "ImageMagick 'convert' is required" >&2; exit 1; }

render() { rsvg-convert -w "$1" -h "$1" -f png -o "$2" "$3"; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "Rendering web icons from $(basename "$SRC")"
render 192 "$ICONS/icon-192.png"         "$SRC"
render 512 "$ICONS/icon-512.png"         "$SRC"
render 180 "$ICONS/apple-touch-icon.png" "$SRC"
echo "  icon-192 / icon-512 / apple-touch-icon (transparent)"

# favicon.ico — multi-resolution (16/32/48), transparent
render 16 "$TMP/16.png" "$SRC"
render 32 "$TMP/32.png" "$SRC"
render 48 "$TMP/48.png" "$SRC"
convert "$TMP/16.png" "$TMP/32.png" "$TMP/48.png" "$PUBLIC/favicon.ico"
echo "  favicon.ico (16/32/48, transparent)"

render 192 "$ICONS/icon-192-maskable.png" "$SRC"
render 512 "$ICONS/icon-512-maskable.png" "$SRC"
echo "  icon-192-maskable / icon-512-maskable (transparent)"
echo "done."
