import { positionMessageContextMenu } from './message-context-menu-position';

describe('positionMessageContextMenu', () => {
  const bounds = { left: 100, top: 50, right: 500, bottom: 600 };
  const size = { width: 192, height: 174 };

  it('keeps an in-bounds anchor unchanged', () => {
    expect(
      positionMessageContextMenu({ x: 110, y: 60 }, bounds, size, 8),
    ).toEqual({
      x: 110,
      y: 60,
    });
  });

  it('flips above and toward the start edge near the composer corner', () => {
    expect(
      positionMessageContextMenu({ x: 490, y: 590 }, bounds, size, 8),
    ).toEqual({
      x: 298,
      y: 416,
    });
  });

  it('clamps an off-screen anchor to the safe inset', () => {
    expect(
      positionMessageContextMenu({ x: -20, y: -20 }, bounds, size, 8),
    ).toEqual({
      x: 108,
      y: 58,
    });
  });
});
