import { describe, expect, it } from 'vitest';
import { DownloadSpeed } from './download-speed.js';

describe('server download speed', () => {
  it('excludes resumed bytes and expires a stalled transfer rate', () => {
    const speed = new DownloadSpeed();
    speed.report(8192, 0);
    expect(speed.value(0)).toBe(0);
    speed.report(9216, 1000);
    expect(speed.value(1000)).toBe(1024);
    expect(speed.value(2000)).toBe(512);
    expect(speed.value(3000)).toBe(0);
  });

  it('starts a fresh baseline after a writer resets its offset', () => {
    const speed = new DownloadSpeed();
    speed.report(4096, 0);
    speed.report(8192, 1000);
    speed.report(0, 1100);
    expect(speed.value(1100)).toBe(0);
    speed.report(1024, 2100);
    expect(speed.value(2100)).toBe(1024);
  });
});
