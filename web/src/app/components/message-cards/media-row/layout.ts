/**
 * 相册布局纯函数（tg 式：尺寸/比例已知 → 渲染前算定高）。
 *
 * 返回每个 cell 的 { xPct, yPx, wPct, hPx }：
 * - xPct/wPct 相对 grid 容器宽（%）→ 窄屏 bubble<320 时 cell 宽自适应、不溢出；
 * - yPx/hPx 绝对像素（按 baseW=320 算）→ 高度恒定，bg 加载/解码绝不改变高度。
 *
 * cell 用 absolute + 这些值 inline 定位，不依赖 CSS grid/aspect-ratio 收敛。
 * totalH 作为虚拟滚动 estimateHeight，与 onHeightChange 实测同口径。
 */

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
  /** grid 总高（px），= estimateHeight。 */
  totalH: number;
  /** >6 张时末格叠 "+moreCount" 角标；0 表示无。 */
  moreCount: number;
}

const ALBUM_W = 320;
const ALBUM_GAP = 2;

/** 把基于 baseW 的 px 宽换算成相对容器宽的百分比。 */
function pct(px: number, baseW: number): number {
  return (px / baseW) * 100;
}

/**
 * 按图片数算相册布局。images 仅用 length（比例统一 4:3 / 1:1，与占位图一致）；
 * 真实不同比例图的裁剪由 background-size:cover 处理。
 */
export function layoutAlbum(images: { w: number; h: number }[], baseW = ALBUM_W): AlbumLayout {
  const n = images.length;
  const gap = ALBUM_GAP;
  const shown = Math.min(n, 6);
  const rects: AlbumRect[] = [];
  let totalH: number;

  if (n <= 1) {
    // 1 张：4:3，cell 宽满，高 = baseW*3/4
    totalH = Math.round((baseW * 3) / 4);
    rects.push({ xPct: 0, yPx: 0, wPct: 100, hPx: totalH });
  } else if (n === 2) {
    // 2 张：1×2 正方形，cell 宽 (baseW-gap)/2
    const cw = (baseW - gap) / 2;
    totalH = Math.round(cw);
    rects.push({ xPct: 0, yPx: 0, wPct: pct(cw, baseW), hPx: totalH });
    rects.push({ xPct: pct(cw + gap, baseW), yPx: 0, wPct: pct(cw, baseW), hPx: totalH });
  } else if (n === 3) {
    // 3 张：左大跨满高（1:2）+ 右两小（1:1）
    const cw = (baseW - gap) / 2;
    totalH = baseW; // 左大 = 2*cw + gap = baseW
    rects.push({ xPct: 0, yPx: 0, wPct: pct(cw, baseW), hPx: totalH });
    rects.push({ xPct: pct(cw + gap, baseW), yPx: 0, wPct: pct(cw, baseW), hPx: Math.round(cw) });
    rects.push({ xPct: pct(cw + gap, baseW), yPx: Math.round(cw + gap), wPct: pct(cw, baseW), hPx: Math.round(cw) });
  } else if (n === 4) {
    // 4 张：2×2 正方形
    const cw = (baseW - gap) / 2;
    totalH = baseW;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        rects.push({ xPct: pct(c * (cw + gap), baseW), yPx: Math.round(r * (cw + gap)), wPct: pct(cw, baseW), hPx: Math.round(cw) });
      }
    }
  } else {
    // 5/6 张：3 列正方形
    const cols = 3;
    const cw = (baseW - 2 * gap) / cols;
    const rows = Math.ceil(shown / cols);
    totalH = Math.round(cw * rows + (rows - 1) * gap);
    for (let i = 0; i < shown; i++) {
      const r = Math.floor(i / cols), c = i % cols;
      rects.push({ xPct: pct(c * (cw + gap), baseW), yPx: Math.round(r * (cw + gap)), wPct: pct(cw, baseW), hPx: Math.round(cw) });
    }
  }

  return { rects, totalH, moreCount: n > 6 ? n - 6 : 0 };
}
