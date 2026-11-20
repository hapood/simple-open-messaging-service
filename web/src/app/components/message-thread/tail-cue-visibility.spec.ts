import { describe, expect, it } from 'vitest';
import { isTailCueVisible } from './tail-cue-visibility';

describe('tail cue visibility', () => {
  it('enters at the exact viewport bottom', () => {
    expect(isTailCueVisible(560, 600, 0, 600, false)).toBe(true);
  });
  it('does not hide the header for a partially visible or empty cue', () => {
    expect(isTailCueVisible(560, 601, 0, 600, false)).toBe(false);
    expect(isTailCueVisible(-1, 39, 0, 600, false)).toBe(false);
    expect(isTailCueVisible(0, 0, 0, 600, false)).toBe(false);
  });
  it('uses exit hysteresis without blocking bottom entry', () => {
    expect(isTailCueVisible(560, 602, 0, 600, true)).toBe(true);
    expect(isTailCueVisible(560, 603, 0, 600, true)).toBe(false);
  });
});
