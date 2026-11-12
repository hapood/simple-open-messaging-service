import { describe, expect, it } from 'vitest';
import { threadListWindow, THREAD_ROW_HEIGHT } from './thread-list-window';

describe('threadListWindow', () => {
  it('bounds a 5000-row list to the viewport and six buffer rows on either side', () => {
    const window = threadListWindow(5000, 720, 2000 * THREAD_ROW_HEIGHT);
    expect(window).toEqual({
      start: 1994,
      end: 2016,
      scrollTop: 144000,
      translateY: 143568,
      totalHeight: 360000,
    });
    expect(window.end - window.start).toBe(22);
  });

  it('includes partially visible boundary rows using integer positions', () => {
    const window = threadListWindow(5000, 721, 144001.5);
    expect(window.start).toBe(1994);
    expect(window.end).toBe(2017);
    expect(Number.isInteger(window.translateY)).toBe(true);
    expect(Number.isInteger(window.scrollTop)).toBe(true);
  });

  it('clamps stale scroll offsets when filtering or removing rows', () => {
    expect(threadListWindow(3, 720, 300000)).toEqual({
      start: 0,
      end: 3,
      scrollTop: 0,
      translateY: 0,
      totalHeight: 216,
    });
    expect(threadListWindow(0, 720, 300000)).toEqual({
      start: 0,
      end: 0,
      scrollTop: 0,
      translateY: 0,
      totalHeight: 0,
    });
  });

  it('clamps at both ends without mounting the full list', () => {
    expect(threadListWindow(5000, 720, -10).start).toBe(0);
    const window = threadListWindow(5000, 720, 500000);
    expect(window.scrollTop).toBe(359280);
    expect(window.end).toBe(5000);
    expect(window.end - window.start).toBe(16);
  });

  it('keeps only a small bootstrap buffer while a viewport is hidden', () => {
    const window = threadListWindow(5000, 0, 0);
    expect(window.end - window.start).toBe(6);
  });
});
