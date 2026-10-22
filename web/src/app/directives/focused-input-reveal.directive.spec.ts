import { focusedInputScrollDelta } from './focused-input-reveal.directive';

describe('focusedInputScrollDelta', () => {
  it('moves a keyboard-covered input above the keyboard with the requested gap', () => {
    expect(focusedInputScrollDelta(680, 716, 56, 700)).toBe(40);
  });

  it('does not move an input that is already comfortably visible', () => {
    expect(focusedInputScrollDelta(320, 356, 56, 700)).toBe(0);
  });

  it('moves an input down when it is hidden above the scroll panel', () => {
    expect(focusedInputScrollDelta(60, 96, 56, 700)).toBe(-20);
  });

  it('rounds scroll movement to integer pixels', () => {
    expect(focusedInputScrollDelta(680.2, 716.4, 56, 700)).toBe(41);
  });
});
