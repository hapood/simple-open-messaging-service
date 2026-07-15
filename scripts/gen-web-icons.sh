#!/usr/bin/env bash
# Regenerate the web app icon set from web/public/logo.svg.
# Requires rsvg-convert (librsvg) and ImageMagick.
#
# logo.svg is the ONE shared mark (rounded blue square + bubble + M, mark @85%)
# — also used directly by the in-app <app-brand-logo>. Three render variants:
#
#   * rounded   (logo.svg as-is)          -> favicon, icon-192/512 ("any")
#   * full-bleed (rx stripped)            -> apple-touch-icon (iOS needs a solid bg)
#   * maskable  (rx stripped + mark @78%) -> icon-*-maskable (inside the 80% safe zone)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
SRC="$ROOT/web/public/logo.svg"
ICONS="$ROOT/web/public/icons"
PUBLIC="$ROOT/web/public"

command -v rsvg-convert >/dev/null || { echo "rsvg-convert (librsvg) is required" >&2; exit 1; }
command -v convert      >/dev/null || { echo "ImageMagick 'convert' is required" >&2; exit 1; }

render() { rsvg-convert -w "$1" -h "$1" -f png -o "$2" "$3"; }

# Derive the full-bleed (no rounded corners) and maskable (full-bleed + smaller mark) variants.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FB="$TMP/fullbleed.svg"
sed 's/ rx="24"//' "$SRC" > "$FB"
MASK="$TMP/maskable.svg"
sed -e 's/ rx="24"//' -e 's/scale(1\.24)/scale(1.14)/' "$SRC" > "$MASK"

echo "Rendering web icons from $(basename "$SRC")"
render 192 "$ICONS/icon-192.png"        "$SRC"   # rounded
render 512 "$ICONS/icon-512.png"        "$SRC"   # rounded
render 180 "$ICONS/apple-touch-icon.png" "$FB"   # full-bleed (iOS solid bg)
echo "  icon-192 / icon-512 (rounded) · apple-touch-icon (full-bleed)"

# favicon.ico — multi-resolution (16/32/48), rounded
render 16 "$TMP/16.png" "$SRC"
render 32 "$TMP/32.png" "$SRC"
render 48 "$TMP/48.png" "$SRC"
convert "$TMP/16.png" "$TMP/32.png" "$TMP/48.png" "$PUBLIC/favicon.ico"
echo "  favicon.ico (16/32/48, rounded)"

render 192 "$ICONS/icon-192-maskable.png" "$MASK"   # full-bleed + mark @78%
render 512 "$ICONS/icon-512-maskable.png" "$MASK"
echo "  icon-192-maskable / icon-512-maskable (full-bleed, mark @78% inside 80% safe zone)"
echo "done."
