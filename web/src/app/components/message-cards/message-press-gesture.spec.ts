import { MessagePressGesture } from './message-press-gesture';

describe('MessagePressGesture', () => {
  it('suppresses click and contextmenu after a committed long press in either order', () => {
    const gesture = new MessagePressGesture();
    gesture.beginPointer(true);
    expect(gesture.commitLongPress()).toBe(true);
    gesture.endPointer();

    expect(gesture.shouldSuppressSynthetic()).toBe(true);
    expect(gesture.shouldSuppressSynthetic()).toBe(true);
    expect(gesture.state).toBe('suppressing-synthetic');
  });

  it('releases synthetic suppression only when a new real pointer gesture begins', () => {
    const gesture = new MessagePressGesture();
    gesture.beginPointer(true);
    gesture.commitLongPress();
    gesture.endPointer();
    expect(gesture.shouldSuppressSynthetic()).toBe(true);

    gesture.beginPointer(true);
    expect(gesture.shouldSuppressSynthetic()).toBe(false);
    expect(gesture.state).toBe('pressing');
  });

  it('does not suppress an ordinary tap or a movement-cancelled press', () => {
    const tap = new MessagePressGesture();
    tap.beginPointer(true);
    tap.endPointer();
    expect(tap.shouldSuppressSynthetic()).toBe(false);

    const moved = new MessagePressGesture();
    moved.beginPointer(true);
    moved.cancelPointer();
    expect(moved.commitLongPress()).toBe(false);
    expect(moved.shouldSuppressSynthetic()).toBe(false);
  });
});
