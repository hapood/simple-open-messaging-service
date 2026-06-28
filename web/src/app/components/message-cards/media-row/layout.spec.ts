import { layoutAlbum } from './layout';

describe('layoutAlbum', () => {
  const mk = (n: number) => Array.from({ length: n }, () => ({ w: 400, h: 300 }));

  it('1 张：4:3，totalH=240，单 rect 满宽满高', () => {
    const { rects, totalH, moreCount } = layoutAlbum(mk(1));
    expect(rects.length).toBe(1);
    expect(totalH).toBe(240);
    expect(moreCount).toBe(0);
    expect(rects[0]).toEqual({ xPct: 0, yPx: 0, wPct: 100, hPx: 240 });
  });

  it('2 张：1×2 正方形，totalH=159，两 rect 并排不重叠', () => {
    const { rects, totalH } = layoutAlbum(mk(2));
    expect(rects.length).toBe(2);
    expect(totalH).toBe(159);
    expect(rects[0].xPct).toBe(0);
    expect(rects[1].xPct).toBeGreaterThan(rects[0].xPct);
    expect(rects[0].hPx).toBe(159);
  });

  it('3 张：左大跨满高 + 右两小，totalH=320', () => {
    const { rects, totalH } = layoutAlbum(mk(3));
    expect(rects.length).toBe(3);
    expect(totalH).toBe(320);
    expect(rects[0].hPx).toBe(320); // 左大满高
    // 右两小纵向排布、不溢出
    expect(rects[1].yPx).toBe(0);
    expect(rects[2].yPx).toBeGreaterThan(0);
    expect(rects[2].yPx + rects[2].hPx).toBeLessThanOrEqual(320);
  });

  it('4 张：2×2 正方形，totalH=320，4 rect', () => {
    const { rects, totalH } = layoutAlbum(mk(4));
    expect(rects.length).toBe(4);
    expect(totalH).toBe(320);
  });

  it('5/6 张：3 列正方形，totalH=213', () => {
    expect(layoutAlbum(mk(5)).totalH).toBe(213);
    const six = layoutAlbum(mk(6));
    expect(six.totalH).toBe(213);
    expect(six.rects.length).toBe(6);
  });

  it('>6 张：rects 截断到 6，moreCount = N-6', () => {
    const { rects, moreCount } = layoutAlbum(mk(8));
    expect(rects.length).toBe(6);
    expect(moreCount).toBe(2);
  });

  it('所有 cell 在 totalH 内、彼此不重叠（n=2..6）', () => {
    for (const n of [2, 3, 4, 5, 6]) {
      const { rects, totalH } = layoutAlbum(mk(n));
      for (const r of rects) {
        expect(r.yPx + r.hPx).toBeLessThanOrEqual(totalH);
        expect(r.xPct).toBeGreaterThanOrEqual(0);
        expect(r.xPct + r.wPct).toBeLessThanOrEqual(100 + 1e-6);
      }
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], b = rects[j];
          const overlapX = a.xPct < b.xPct + b.wPct - 1e-6 && b.xPct < a.xPct + a.wPct - 1e-6;
          const overlapY = a.yPx < b.yPx + b.hPx - 1e-6 && b.yPx < a.yPx + a.hPx - 1e-6;
          expect(overlapX && overlapY).toBe(false);
        }
      }
    }
  });
});
