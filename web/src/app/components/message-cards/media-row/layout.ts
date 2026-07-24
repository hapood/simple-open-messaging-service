/**
 * Album layout pure function (row-wise justified: every image in a row shares one height, laid out
 * horizontally by true aspect ratio, preserving ratio within the row as much as possible).
 *
 * Returns each cell's { xPct, yPx, wPct, hPx }:
 * - xPct/wPct are relative to the grid container width (%) → the cell width adapts on narrow screens where the
 *   bubble is narrower than baseW, without overflowing;
 * - yPx/hPx are absolute pixels (computed from baseW) → the height is constant; background load/decode never
 *   changes the height.
 *
 * Row-wise core: a row of k images has width W = baseW − (k−1)*gap, each image has aspect ratio r = h/w.
 * The equal-height row height rawH = W / Σ(1/r_i) (preserves ratio within the row and fills W horizontally).
 * - rawH within [minH, maxH] → justified: cell width = rawH/r_i (preserves ratio, fills, no cropping).
 * - rawH out of range (an all-landscape row too short / an all-portrait row too tall) → clamp the row height
 *   to [minH, maxH], cells become equal-width, and the residual ratio mismatch is absorbed by the existing
 *   background-size: cover cropping. For a normal ratio pool (16:9..9:16) most rows land in the justified
 *   branch and render with preserved ratio; only extreme combinations clamp.
 *   (Note: you cannot "rescale the row back to W after clamp" — that would equal rawH and undo the clamp, so a
 *   branch is used.)
 *
 * Bad w/h (NaN/0/negative) → fall back to 4:3 (DEFAULT_R), so corrupt data can't poison totalH and ripple into
 * the virtual scroll. totalH is the grid height the kernel measures (same basis as onHeightChange), and it is
 * Math.rounded so an album row's offsetHeight is always a whole number (see the integer-height contract in
 * _row-base.scss → the kernel's Σ offsetHeight equals content.scrollHeight exactly).
 */

export interface AlbumImageLike {
  w: number;
  h: number;
  /** Media kind — present on real AlbumMedia cells. layoutAlbum special-cases audio (a fixed slim bar that
   *  bypasses image aspect math); image/video fall through to the aspect-ratio regimes. */
  kind?: 'image' | 'video' | 'audio';
}

export interface AlbumRect {
  /** left/width: percentage relative to the grid container width (adapts on narrow screens). */
  xPct: number;
  wPct: number;
  /** top/height: absolute pixels (computed from baseW, fixed regardless of screen). */
  yPx: number;
  hPx: number;
}

export interface AlbumLayout {
  rects: AlbumRect[];
  /** Grid total height (px) — the rendered row height the kernel measures. */
  totalH: number;
  /** Container width (px). For a single media item the bubble narrows to the cell's computed width
   *  (so a 1:1 image is 240px wide, not the full baseW); for an album it is the full baseW. */
  containerW: number;
  /** When >6 images, the last cell shows a "+moreCount" badge; 0 means none. */
  moreCount: number;
}

export const ALBUM_W = 280;

/** Voice-message bar dims — the AUDIO cell's fixed slim rect (see layoutAlbum's audio branch). Single source
 *  of truth: the optimistic send (sendVoice) and the receive-side parse (http-item-source.parseAudioContent)
 *  both render at exactly this size, so the optimistic↔real swap never jumps height (which would break the
 *  virtual-scroll anchor). Integer px per the project's CSS integer-pixel rule. */
export const VOICE_BAR_W = 220;
export const VOICE_BAR_H = 52;

const ALBUM_GAP = 2;
/** Fallback aspect ratio (h/w) for bad w/h, 4:3 (matches historical data). */
const DEFAULT_R = 3 / 4;
/** Row-height clamp range (relative to baseW): minH prevents extreme flat strips, maxH prevents tall portraits from blowing up the message. */
export const ALBUM_MIN_ROW_H_RATIO = 0.35;
export const ALBUM_MAX_ROW_H_RATIO = 0.8;
/** Single-media (1 image/video) absolute height cap (px) — tighter than the album row max so a 1:1
 * image doesn't fill the whole bubble. WhatsApp-style. */
export const ALBUM_SINGLE_MAX_H = 240;

/** Convert a baseW-relative px width to a percentage of the container width. */
function pct(px: number, baseW: number): number {
  return (px / baseW) * 100;
}

/** Take the aspect ratio r=h/w; on bad data (non-finite/≤0/NaN) → fallback 4:3 to avoid poisoning totalH. */
function ratio(img: AlbumImageLike): number {
  const r = img.h / img.w;
  return Number.isFinite(r) && r > 0 ? r : DEFAULT_R;
}

interface RowCell {
  leftPx: number;
  widthPx: number;
  heightPx: number;
}

/**
 * Lay out one row of cells (equal height).
 * rawH ∈ [minH,maxH] → justified (ratio preserved, fills, no crop); otherwise clamp the row height + equal widths (cover crop).
 */
function layoutRow(items: AlbumImageLike[], W: number, gap: number, baseW: number): { cells: RowCell[]; rowH: number } {
  const minH = baseW * ALBUM_MIN_ROW_H_RATIO;
  const maxH = baseW * ALBUM_MAX_ROW_H_RATIO;
  const count = items.length;
  const rs = items.map(ratio);
  const rawH = W / rs.reduce((s, r) => s + 1 / r, 0);

  let rowH: number;
  let widths: number[];
  if (rawH >= minH && rawH <= maxH) {
    // justified: preserve true ratio within the row, width = rowH/r
    rowH = rawH;
    widths = rs.map((r) => rowH / r);
  } else {
    // out of range: clamp the row height, cells become equal-width, the ratio gap is cover-cropped
    rowH = Math.max(minH, Math.min(maxH, rawH));
    const eqW = (W - (count - 1) * gap) / count;
    widths = rs.map(() => eqW);
  }

  const cells: RowCell[] = [];
  let left = 0;
  for (let i = 0; i < count; i++) {
    cells.push({ leftPx: left, widthPx: widths[i], heightPx: rowH });
    left += widths[i] + gap;
  }
  return { cells, rowH };
}

/** Pick a fixed row split by image count (shown=min(n,6)). Returns the image count per row. */
function rowPlan(shown: number): number[] {
  switch (shown) {
    case 1:
      return [1];
    case 2:
      return [2];
    case 3:
      return [2, 1];
    case 4:
      return [2, 2];
    case 5:
      return [2, 3];
    default:
      return [3, 3]; // 6 (and >6 truncated to 6)
  }
}

export function layoutAlbum(images: AlbumImageLike[], baseW = ALBUM_W): AlbumLayout {
  const n = images.length;
  if (n === 0) return { rects: [], totalH: 0, containerW: baseW, moreCount: 0 };

  // Audio — a fixed slim horizontal voice bar (play btn + progress + duration), NOT an image aspect.
  // Audio is never album-aggregated (merge-items excludes it), so this is always a single cell. Fixed
  // integer-px height, and playback only animates a WIDTH fill (never a height change), so the kernel's
  // height-model invariant (totalH === Σ offsetHeight) holds during play.
  if (n === 1 && images[0].kind === 'audio') {
    const totalH = VOICE_BAR_H;
    const widthPx = Math.min(baseW, VOICE_BAR_W);
    return {
      rects: [{ xPct: 0, wPct: 100, yPx: 0, hPx: totalH }],
      totalH,
      containerW: widthPx,
      moreCount: 0,
    };
  }

  const gap = ALBUM_GAP;

  // Single media — three regimes:
  //  (a) portrait rawH > SINGLE_MAX → cap height at SINGLE_MAX, narrow width to preserve ratio (bubble
  //      shrinks below baseW; e.g. 1:1 → 240×240, 9:16 → 135×240).
  //  (b) normal rawH ∈ [minH, SINGLE_MAX] → full baseW width, justified height (e.g. 4:3 → 280×210).
  //  (c) extreme panorama rawH < minH → clamp height at minH, keep full baseW width (cover crop; avoids
  //      the width explosion that pure justified would produce for a near-zero ratio).
  if (n === 1) {
    const r = ratio(images[0]);
    const minH = baseW * ALBUM_MIN_ROW_H_RATIO;
    const rawH = baseW * r; // height if the image filled the full baseW
    let rowH: number, widthPx: number;
    if (rawH > ALBUM_SINGLE_MAX_H) {
      rowH = ALBUM_SINGLE_MAX_H;
      widthPx = rowH / r; // portrait: shrink width, preserve ratio
    } else if (rawH < minH) {
      rowH = minH;
      widthPx = baseW; // panorama: clamp height, full width, cover crop
    } else {
      rowH = rawH;
      widthPx = baseW; // normal: full width, justified height
    }
    const totalH = Math.round(rowH);
    return {
      rects: [{ xPct: 0, wPct: 100, yPx: 0, hPx: totalH }],
      totalH,
      containerW: Math.round(widthPx),
      moreCount: 0,
    };
  }

  const shown = Math.min(n, 6);
  const plan = rowPlan(shown);
  const rects: AlbumRect[] = [];

  let topPx = 0;
  let idx = 0;
  for (let row = 0; row < plan.length; row++) {
    const count = plan[row];
    const items = images.slice(idx, idx + count);
    idx += count;
    const W = baseW - (count - 1) * gap;
    const { cells, rowH } = layoutRow(items, W, gap, baseW);
    const yPx = Math.round(topPx);
    const hPx = Math.round(rowH);
    for (const c of cells) {
      rects.push({ xPct: pct(c.leftPx, baseW), wPct: pct(c.widthPx, baseW), yPx, hPx });
    }
    topPx += rowH + gap;
  }

  // totalH = round(ΣrowH + (rows-1)*gap) (topPx added one extra gap at the end, subtract it back).
  const totalH = Math.round(topPx - gap);

  // Last-row hPx fixup: make the last cell's yPx+hPx === totalH (eliminates the 1px gap from round accumulation).
  if (rects.length > 0) {
    const last = rects[rects.length - 1];
    last.hPx = totalH - last.yPx;
  }

  return { rects, totalH, containerW: baseW, moreCount: n > 6 ? n - 6 : 0 };
}
