import { describe, expect, it } from 'vitest';
import { TransferSpeedMeter } from './transfer-speed-meter';

describe('TransferSpeedMeter', () => {
  it('samples byte deltas and expires a stalled transfer', () => {
    const meter = new TransferSpeedMeter();
    expect(meter.update('a', 100, 0)).toBe(0);
    expect(meter.update('a', 1100, 1000)).toBe(1000);
    expect(meter.update('a', 1100, 2000)).toBe(1000);
    expect(meter.read('a', 4000)).toBe(0);
  });
  it('resets on retry and removes completed or dismissed tasks', () => {
    const meter = new TransferSpeedMeter();
    meter.update('a', 100, 0);
    meter.update('a', 1100, 1000);
    expect(meter.update('a', 0, 1100)).toBe(0);
    expect(meter.update('a', 500, 2100)).toBe(500);
    meter.retain(new Set());
    expect(meter.read('a', 2200)).toBe(0);
  });
  it('does not divide by zero for progress in the same clock tick', () => {
    const meter = new TransferSpeedMeter();
    meter.update('a', 0, 100);
    expect(meter.update('a', 100, 100)).toBe(0);
  });
});
