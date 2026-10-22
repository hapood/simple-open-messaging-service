export type MessagePressState =
  | 'idle'
  | 'pressing'
  | 'long-pressed'
  | 'suppressing-synthetic';

/**
 * Deterministic state machine for a message long-press. Browsers disagree on whether a completed touch
 * long-press emits click, contextmenu, or both (and in which order), so suppression is gesture-based rather
 * than time-based: only the next real pointerdown starts a new gesture and releases the synthetic tail.
 */
export class MessagePressGesture {
  private current: MessagePressState = 'idle';

  get state(): MessagePressState {
    return this.current;
  }

  beginPointer(pressable: boolean): void {
    this.current = pressable ? 'pressing' : 'idle';
  }

  commitLongPress(): boolean {
    if (this.current !== 'pressing') return false;
    this.current = 'long-pressed';
    return true;
  }

  endPointer(): void {
    if (this.current === 'long-pressed')
      this.current = 'suppressing-synthetic';
    else if (this.current === 'pressing') this.current = 'idle';
  }

  cancelPointer(): void {
    this.endPointer();
  }

  shouldSuppressSynthetic(): boolean {
    return (
      this.current === 'long-pressed' ||
      this.current === 'suppressing-synthetic'
    );
  }
}
