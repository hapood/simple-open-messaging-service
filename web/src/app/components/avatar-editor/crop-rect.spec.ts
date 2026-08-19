import {
  computeCropRect,
  clampOffset,
  minCoverScale,
  clamp,
} from './crop-rect';

/**
 * Pure-math tests for the avatar cropper's transform model (no Angular/DOM):
 * cover-min-scale, pan clamping, and the inverse transform back to source px.
 * Frame F = 288 (the component's backing-store side).
 */
describe('avatar-editor crop-rect', () => {
  const F = 288;

  describe('minCoverScale', () => {
    it('is set by the shorter side so the image covers the square', () => {
      // 1000×2000 portrait: the 1000px width must span the frame
      expect(minCoverScale(1000, 2000, F)).toBeCloseTo(F / 1000, 10);
      // 2000×1000 landscape: same, driven by height
      expect(minCoverScale(2000, 1000, F)).toBeCloseTo(F / 1000, 10);
    });
    it('is 1 for a square image exactly the frame size', () => {
      expect(minCoverScale(F, F, F)).toBe(1);
    });
  });

  describe('clampOffset', () => {
    it('keeps a centered cover crop centered (offsets at the valid midpoint)', () => {
      const s = minCoverScale(1000, 2000, F); // width fills frame, height overflows
      const { ox, oy } = clampOffset(0, 0, 1000, 2000, F, s);
      // width is exactly covered → no horizontal slack → ox pinned to 0
      expect(ox).toBe(0);
      // height has slack → centered offset is negative (image shifted up to center)
      expect(oy).toBeLessThanOrEqual(0);
      expect(oy).toBeGreaterThanOrEqual(F - 2000 * s);
    });
    it('rejects offsets that would expose a gap', () => {
      const s = minCoverScale(1000, 1000, F) * 2; // zoomed in, slack on both axes
      const { ox, oy } = clampOffset(500, -500, 1000, 1000, F, s);
      expect(ox).toBeLessThanOrEqual(0);
      expect(ox).toBeGreaterThanOrEqual(F - 1000 * s);
      expect(oy).toBeLessThanOrEqual(0);
      expect(oy).toBeGreaterThanOrEqual(F - 1000 * s);
    });
  });

  describe('computeCropRect', () => {
    it('at min cover scale the visible square spans the full shorter side', () => {
      const s = minCoverScale(1000, 2000, F);
      const r = computeCropRect(1000, 2000, F, s, 0, 0);
      expect(r.sw).toBeCloseTo(1000, 6); // full width visible
      expect(r.sh).toBeCloseTo(1000, 6); // square region
      expect(r.sx).toBeCloseTo(0, 6);
    });
    it('crops the centered region (sy centered on the overflowing axis)', () => {
      const s = minCoverScale(1000, 2000, F);
      // centered offset: oy = (F - ih*scale)/2
      const oy = (F - 2000 * s) / 2;
      const r = computeCropRect(1000, 2000, F, s, 0, oy);
      expect(r.sy).toBeCloseTo((2000 - r.sh) / 2, 4); // vertically centered
    });
    it('zooming in shrinks the visible source region', () => {
      const sMin = minCoverScale(1000, 1000, F);
      const rOut = computeCropRect(1000, 1000, F, sMin, 0, 0);
      const rIn = computeCropRect(1000, 1000, F, sMin * 2, 0, 0);
      expect(rIn.sw).toBeCloseTo(rOut.sw / 2, 6);
    });
    it('caps the output side at maxOut and never upscales beyond the source region', () => {
      // huge source: visible region ~4000px → capped to 1024
      const s = minCoverScale(4000, 4000, F);
      const r = computeCropRect(4000, 4000, F, s, 0, 0, 1024);
      expect(r.out).toBe(1024);
    });
    it('keeps a small image at native resolution (no upscale of output)', () => {
      const s = minCoverScale(80, 80, F); // upscaled in preview, but output stays native
      const r = computeCropRect(80, 80, F, s, 0, 0, 1024);
      expect(r.out).toBe(80);
    });
    it('clamp helper pins values inside the bounds', () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-1, 0, 10)).toBe(0);
      expect(clamp(11, 0, 10)).toBe(10);
    });
  });
});
