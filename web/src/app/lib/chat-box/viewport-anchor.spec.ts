import { alignedItemOffset, distanceToViewportCenter } from './viewport-anchor';

describe('viewport-anchor', () => {
  it('computes distance to viewport center (0 when straddling center)', () => {
    expect(distanceToViewportCenter(450, 100, 200, 600)).toBe(0);
    expect(distanceToViewportCenter(100, 100, 200, 600)).toBe(300);
    expect(distanceToViewportCenter(700, 100, 200, 600)).toBe(200);
  });

  it('aligns an item when placing a newly loaded window', () => {
    expect(alignedItemOffset(100, 600, 'top')).toBe(0);
    expect(alignedItemOffset(100, 600, 'center')).toBe(-250);
    expect(alignedItemOffset(100, 600, 'bottom')).toBe(-500);
  });
});
