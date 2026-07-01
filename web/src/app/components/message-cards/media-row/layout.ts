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
 * the virtual scroll. totalH is the grid height the kernel measures (same basis as onHeightChange).
 */

export interface AlbumImageLike {
  w: number;
  h: number;
}

export interface AlbumRect {
  /** 左/宽：相对 grid 容器宽的百分比（窄屏自适应）。 */
  xPct: number;
  wPct: number;
  /** 顶/高：绝对像素（按 baseW 算，固定不随屏变）。 */
  yPx: number;
  hPx: number;
}

export interface AlbumLayout {
  rects: AlbumRect[];
  /** Grid total height (px) — the rendered row height the kernel measures. */
  totalH: number;
  /** >6 张时末格叠 "+moreCount" 角标；0 表示无。 */
  moreCount: number;
}

export const ALBUM_W = 320;
const ALBUM_GAP = 2;
/** w/h 异常时的兜底纵横比（h/w），4:3（与历史数据一致）。 */
const DEFAULT_R = 3 / 4;
/** 行高 clamp 区间（相对 baseW）：minH 防极端扁条、maxH 防竖图撑爆消息。 */
export const ALBUM_MIN_ROW_H_RATIO = 0.35;
export const ALBUM_MAX_ROW_H_RATIO = 1;

/** 把基于 baseW 的 px 宽换算成相对容器宽的百分比。 */
function pct(px: number, baseW: number): number {
  return (px / baseW) * 100;
}

/** 取图纵横比 r=h/w；异常（非有限/≤0/NaN）→ fallback 4:3，防毒化 totalH。 */
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
 * 按真实比例排一行 cells（等高）。
 * rawH ∈ [minH,maxH] → justified（保比例、填满、不裁）；否则 clamp 行高 + 等宽（cover 裁）。
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
    // justified：行内保真实比例，宽 = 行高/r
    rowH = rawH;
    widths = rs.map((r) => rowH / r);
  } else {
    // 超界：clamp 行高，cell 改等宽，真实比例差由 cover 裁
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

/** 按张数选固定分行方案（shown=min(n,6)）。返回每行图片数。 */
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
      return [3, 3]; // 6（及 >6 截断到 6）
  }
}

export function layoutAlbum(images: AlbumImageLike[], baseW = ALBUM_W): AlbumLayout {
  const n = images.length;
  if (n === 0) return { rects: [], totalH: 0, moreCount: 0 };

  const gap = ALBUM_GAP;
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

  // totalH = round(ΣrowH + (rows-1)*gap)（topPx 末尾多加了一个 gap，扣回）。
  const totalH = Math.round(topPx - gap);

  // 末行 hPx 补差：使最后一格 yPx+hPx === totalH（消除 round 累积的 1px 缝）。
  if (rects.length > 0) {
    const last = rects[rects.length - 1];
    last.hPx = totalH - last.yPx;
  }

  return { rects, totalH, moreCount: n > 6 ? n - 6 : 0 };
}
