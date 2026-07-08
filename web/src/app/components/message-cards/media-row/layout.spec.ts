import { layoutAlbum, ALBUM_W, ALBUM_MIN_ROW_H_RATIO, ALBUM_MAX_ROW_H_RATIO, ALBUM_SINGLE_MAX_H } from './layout';

describe('layoutAlbum', () => {
  const mkFixed = (n: number, w = 400, h = 300) => Array.from({ length: n }, () => ({ w, h }));
  const mkMixed = (wh: [number, number][]) => wh.map(([w, h]) => ({ w, h }));

  const MIN_H = ALBUM_W * ALBUM_MIN_ROW_H_RATIO; // 98
  const MAX_H = ALBUM_W * ALBUM_MAX_ROW_H_RATIO; // 224 (album row cap; single-media uses ALBUM_SINGLE_MAX_H=240)

  /** 不变量守卫：rect 数=min(n,6)、不越界、两两不重叠、末行底===totalH、cell 非零。 */
  const assertInvariants = (imgs: { w: number; h: number }[]) => {
    const { rects, totalH } = layoutAlbum(imgs);
    expect(rects.length).toBe(Math.min(imgs.length, 6));
    for (const r of rects) {
      expect(r.yPx).toBeGreaterThanOrEqual(0);
      expect(r.yPx + r.hPx).toBeLessThanOrEqual(totalH);
      expect(r.xPct).toBeGreaterThanOrEqual(-1e-6);
      expect(r.xPct + r.wPct).toBeLessThanOrEqual(100 + 1e-6);
      expect(r.hPx).toBeGreaterThan(0);
      expect(r.wPct).toBeGreaterThan(0);
    }
    // 末行底齐 totalH（无 1px 缝）
    expect(rects[rects.length - 1].yPx + rects[rects.length - 1].hPx).toBe(totalH);
    // 两两不重叠
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const overlapX = a.xPct < b.xPct + b.wPct - 1e-6 && b.xPct < a.xPct + a.wPct - 1e-6;
        const overlapY = a.yPx < b.yPx + b.hPx - 1e-6 && b.yPx < a.yPx + a.hPx - 1e-6;
        expect(overlapX && overlapY).toBe(false);
      }
    }
    return { rects, totalH };
  };

  it('n=1 单图 4:3：满宽、totalH=210（normal regime，full width）', () => {
    const { rects, totalH, moreCount, containerW } = layoutAlbum(mkFixed(1));
    expect(rects.length).toBe(1);
    expect(totalH).toBe(210); // rawH = 280*0.75 = 210 ∈ [98,240] → justified full width
    expect(moreCount).toBe(0);
    expect(rects[0]).toEqual({ xPct: 0, yPx: 0, wPct: 100, hPx: 210 });
    expect(containerW).toBe(280); // normal regime keeps full baseW
  });

  it('n=1 单图 1:1：portrait regime → cap 240、containerW 收窄到 240', () => {
    const { rects, totalH, containerW } = layoutAlbum(mkMixed([[1, 1]]));
    expect(totalH).toBe(240); // rawH=280 > 240 → cap
    expect(rects[0].hPx).toBe(240);
    expect(containerW).toBe(240); // width = 240/1 = 240 (narrowed)
  });

  it('n=2 两张 4:3：justified 保比例、等高、并排不重叠', () => {
    // rawH = (280-2)/(2/0.75) = 104.25 ∈ [98,224] → justified
    const { rects, totalH } = assertInvariants(mkFixed(2));
    expect(rects.length).toBe(2);
    expect(rects[0].hPx).toBe(rects[1].hPx); // 等高
    expect(rects[0].xPct).toBe(0);
    expect(rects[1].xPct).toBeGreaterThan(rects[0].xPct);
    expect(totalH).toBe(104); // round(104.25)
  });

  it('n=3 [2,1]：行1 两图、行2 单图满宽', () => {
    const { rects } = assertInvariants(mkFixed(3));
    expect(rects.length).toBe(3);
    expect(rects[0].yPx).toBe(0);
    expect(rects[1].yPx).toBe(0); // 与 rects[0] 同行
    expect(rects[2].yPx).toBeGreaterThan(0); // 行2
    expect(rects[2].xPct).toBe(0);
    expect(rects[2].wPct).toBeCloseTo(100, 5); // 单图满宽
  });

  it('n=4/5/6：rect 数正确', () => {
    expect(layoutAlbum(mkFixed(4)).rects.length).toBe(4);
    expect(layoutAlbum(mkFixed(5)).rects.length).toBe(5);
    expect(layoutAlbum(mkFixed(6)).rects.length).toBe(6);
  });

  it('>6 张：rects 截断到 6，moreCount = N-6', () => {
    const r8 = layoutAlbum(mkFixed(8));
    expect(r8.rects.length).toBe(6);
    expect(r8.moreCount).toBe(2);
    const r20 = layoutAlbum(mkFixed(20));
    expect(r20.rects.length).toBe(6);
    expect(r20.moreCount).toBe(14);
  });

  it('不重叠/不越界/末行齐不变量（n=1..6，4:3）', () => {
    for (let n = 1; n <= 6; n++) assertInvariants(mkFixed(n));
  });

  it('混合比例行（justified）：两 cell 等高、横图 cell 宽 > 竖图 cell 宽', () => {
    // 16:9 横图 (r=0.5625) + 9:16 竖图 (r=1.777...)：rawH≈136 ∈ [112,320] → justified
    const { rects } = assertInvariants(mkMixed([[16, 9], [9, 16]]));
    expect(rects.length).toBe(2);
    expect(rects[0].hPx).toBe(rects[1].hPx); // 等高（同一行）
    expect(rects[0].wPct).toBeGreaterThan(rects[1].wPct); // 横图宽、竖图窄
  });

  it('全竖图两图行：行高受 maxH 钳制不撑爆', () => {
    // 两张 3:16 (r=5.33)：rawH≈847 > 320 → clamp 320
    const { rects, totalH } = assertInvariants(mkMixed([[3, 16], [3, 16]]));
    expect(rects[0].hPx).toBeLessThanOrEqual(MAX_H);
    expect(totalH).toBeLessThanOrEqual(MAX_H);
  });

  it('单图超宽全景：行高受 minH 钳制不压扁、width 不爆炸', () => {
    // 32:1 全景 (r=0.03125)：rawH=8.75 < 98 → panorama regime, clamp 98, full width (no width explosion)
    const { rects, totalH, containerW } = layoutAlbum(mkMixed([[32, 1]]));
    expect(rects[0].hPx).toBeGreaterThanOrEqual(MIN_H);
    expect(totalH).toBeGreaterThanOrEqual(MIN_H);
    expect(rects[0].wPct).toBeCloseTo(100, 5); // 单图满宽
    expect(containerW).toBe(280); // panorama keeps full baseW (NOT 98/r ≈ 3136)
  });

  it('单图超竖：portrait regime → 行高受 SINGLE_MAX 钳制', () => {
    // 1:32 竖图 (r=32)：rawH=8960 > 240 → portrait regime, cap 240
    const { rects } = assertInvariants(mkMixed([[1, 32]]));
    expect(rects[0].hPx).toBeLessThanOrEqual(ALBUM_SINGLE_MAX_H);
    expect(rects[0].wPct).toBeCloseTo(100, 5);
  });

  it('w/h=0/负/NaN：fallback 4:3 不崩、totalH 有限正', () => {
    const cases: { w: number; h: number }[][] = [
      mkMixed([[0, 0]]),
      mkMixed([[-1, 200]]),
      mkMixed([[NaN, 300]]),
      mkMixed([[400, NaN]]),
      mkMixed([[0, 0], [400, 300]]), // 相册里混一张坏数据
      mkMixed([[400, 300], [0, 0], [9, 16]]),
    ];
    for (const imgs of cases) {
      const { rects, totalH } = layoutAlbum(imgs);
      expect(Number.isFinite(totalH)).toBe(true);
      expect(totalH).toBeGreaterThan(0);
      for (const r of rects) {
        expect(r.hPx).toBeGreaterThan(0);
        expect(r.wPct).toBeGreaterThan(0);
      }
    }
  });

  it('w/h=0 单图：fallback 4:3 → totalH=210（同正常 4:3 单图）', () => {
    expect(layoutAlbum(mkMixed([[0, 0]])).totalH).toBe(210);
  });

  it('空数组：返回空 rects、totalH=0、moreCount=0', () => {
    const { rects, totalH, moreCount } = layoutAlbum([]);
    expect(rects.length).toBe(0);
    expect(totalH).toBe(0);
    expect(moreCount).toBe(0);
  });
});
