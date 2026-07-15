#!/usr/bin/env bash
# Render the Android adaptive-icon foreground (ic_launcher_foreground.png) for
# every density from android-ic-launcher-foreground.svg.
#
# The glyph is centered in the 66dp safe zone on a transparent canvas, so no
# launcher mask can clip it. `cargo tauri icon` does not know about the adaptive
# safe zone — it writes a full-bleed foreground straight from the source SVG,
# leaving the white bubble spilling past the maskable area — so re-run this
# after `cargo tauri icon` to restore the safe, padded foreground.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/android-ic-launcher-foreground.svg"
RES="$HERE/../gen/android/app/src/main/res"

command -v rsvg-convert >/dev/null || { echo "rsvg-convert is required (librsvg)" >&2; exit 1; }

# density -> px (108dp at 1x; xxxhdpi = 4x = 432)
render() {
  local density="$1" px="$2"
  rsvg-convert -w "$px" -h "$px" -f png \
    -o "$RES/mipmap-$density/ic_launcher_foreground.png" "$SRC"
  echo "  mipmap-$density: ${px}x${px}"
}

echo "Rendering adaptive-icon foreground from $(basename "$SRC")"
render mdpi    108
render hdpi    162
render xhdpi   216
render xxhdpi  324
render xxxhdpi 432
echo "done."
