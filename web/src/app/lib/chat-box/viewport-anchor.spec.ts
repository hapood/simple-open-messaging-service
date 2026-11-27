import {
  alignedItemOffset,
  clampScrollTop,
  distanceToViewportCenter,
  findViewportCenterItem,
} from './viewport-anchor';

describe('viewport-anchor', () => {
  it('computes distance to viewport center (0 when straddling center)', () => {
    // Viewport [200, 800], center = 500
    expect(distanceToViewportCenter(450, 100, 200, 600)).toBe(0);
    expect(distanceToViewportCenter(100, 100, 200, 600)).toBe(300);
    expect(distanceToViewportCenter(700, 100, 200, 600)).toBe(200);
  });

  it('finds the item straddling or closest to viewport center', () => {
    const heights = [100, 100, 100, 100, 100];
    const tops = [0, 100, 200, 300, 400];
    // Viewport [50, 350], center = 200 -> boundary between idx 1 [100,200] and idx 2 [200,300]; ties prefer newer (idx 2).
    expect(
      findViewportCenterItem(
        heights.length,
        (i) => tops[i],
        (i) => heights[i],
        50,
        300,
      ),
    ).toEqual({
      index: 2,
      top: 200,
      height: 100,
      offset: 150,
      distance: 0,
    });

    // Empty list returns null
    expect(
      findViewportCenterItem(0, () => 0, () => 0, 0, 600),
    ).toBeNull();
  });

  it('aligns item offsets and clamps scrollTop', () => {
    expect(alignedItemOffset(100, 600, 'top')).toBe(0);
    expect(alignedItemOffset(100, 600, 'center')).toBe(-250);
    expect(alignedItemOffset(100, 600, 'bottom')).toBe(-500);
    expect(clampScrollTop(-10, 1000, 600)).toBe(0);
    expect(clampScrollTop(500, 1000, 600)).toBe(400);
    expect(clampScrollTop(100, 300, 600)).toBe(0);
  });
});
