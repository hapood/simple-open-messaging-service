import { describe, expect, it } from 'vitest';
import { shouldFollowArrival } from './arrival-follow';

describe('measured arrival following', () => {
  it('includes exactly seventy percent and rejects larger deliveries', () => {
    expect(shouldFollowArrival(true, 420, 600)).toBe(true);
    expect(shouldFollowArrival(true, 421, 600)).toBe(false);
  });
  it('never pulls a reader down or follows in an unmeasurable viewport', () => {
    expect(shouldFollowArrival(false, 20, 600)).toBe(false);
    expect(shouldFollowArrival(true, 0, 0)).toBe(false);
  });
  it('does not latch a suppressed delivery', () => {
    expect(shouldFollowArrival(true, 500, 600)).toBe(false);
    expect(shouldFollowArrival(true, 100, 600)).toBe(true);
  });
});
