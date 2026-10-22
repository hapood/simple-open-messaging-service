/**
 * Pure crop-rect math for the square avatar cropper, kept out of the component so
 * it is unit-testable with no Angular/DOM dependencies.
 *
 * Coordinate model: the source image (iw × ih, already EXIF-oriented) is drawn
 * into a square preview frame of side F (backing-store px) via an affine map
 *   canvas = source * scale + offset        (cx = sx*scale + ox,  cy = sy*scale + oy)
 * The image must COVER the frame (no gaps), which forces scale >= F/min(iw,ih)
 * and clamps the offset so every frame edge stays inside the image.
 */

export interface CropRect {
  /** top-left + size of the visible source region, in source px */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** square output side in px (<= maxOut, never upscaled above sw) */
  out: number;
}

/** Maximum avatar edge accepted by the profile upload endpoint. */
export const AVATAR_MAX_OUTPUT_EDGE = 512;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Smallest scale at which the image still fully covers the F×F frame. */
export function minCoverScale(iw: number, ih: number, F: number): number {
  return F / Math.min(iw, ih);
}

/**
 * Largest scale worth offering: zooming until ~48 source px span the frame.
 * Beyond this the preview is just a handful of blown-up pixels.
 */
export function maxZoomScale(iw: number, ih: number, F: number): number {
  return F / 48;
}

/**
 * Clamp a pan offset so the image keeps covering the frame at `scale`:
 * ox ∈ [F - iw*scale, 0], oy ∈ [F - ih*scale, 0].
 */
export function clampOffset(
  ox: number,
  oy: number,
  iw: number,
  ih: number,
  F: number,
  scale: number,
): { ox: number; oy: number } {
  return {
    ox: clamp(ox, F - iw * scale, 0),
    oy: clamp(oy, F - ih * scale, 0),
  };
}

/**
 * Convert the current live transform into the source-pixel rectangle visible in
 * the frame, plus the square output size (capped at maxOut, never upscaled).
 */
export function computeCropRect(
  iw: number,
  ih: number,
  F: number,
  scale: number,
  ox: number,
  oy: number,
  maxOut = AVATAR_MAX_OUTPUT_EDGE,
): CropRect {
  const sw = F / scale;
  const sh = F / scale;
  // visible-region top-left in source px; clamp defensively into image bounds
  const sx = clamp(-ox / scale, 0, Math.max(0, iw - sw));
  const sy = clamp(-oy / scale, 0, Math.max(0, ih - sh));
  const out = clamp(Math.round(sw), 1, maxOut);
  return { sx, sy, sw, sh, out };
}
