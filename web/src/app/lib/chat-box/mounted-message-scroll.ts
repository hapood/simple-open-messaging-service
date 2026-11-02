/** Owns only a viewport's programmatic scroll animation, not message data.
 * Starting another animation or receiving user scroll input ends the old one. */
export class MountedMessageScroll {
  private active = false;
  private readonly interrupt = () => this.cancel();
  private readonly finished = () => this.detach();
  private readonly keydown = (event: KeyboardEvent) => {
    if (
      [
        'ArrowUp',
        'ArrowDown',
        'PageUp',
        'PageDown',
        'Home',
        'End',
        ' ',
      ].includes(event.key)
    )
      this.cancel();
  };

  constructor(private readonly viewport: HTMLElement) {}

  start(top: number, smooth: boolean): void {
    this.cancel();
    if (smooth) {
      this.active = true;
      this.viewport.addEventListener('wheel', this.interrupt, {
        passive: true,
      });
      this.viewport.addEventListener('touchstart', this.interrupt, {
        passive: true,
      });
      this.viewport.addEventListener('pointerdown', this.interrupt, {
        passive: true,
      });
      this.viewport.addEventListener('keydown', this.keydown);
      this.viewport.addEventListener('scrollend', this.finished);
    }
    this.viewport.scrollTo({ top, behavior: smooth ? 'smooth' : 'instant' });
  }

  cancel(): void {
    if (!this.active) return;
    this.detach();
    // Stop at the current position; do not prevent the user's wheel/touch/key action.
    this.viewport.scrollTo({
      top: this.viewport.scrollTop,
      behavior: 'instant',
    });
  }

  private detach(): void {
    this.active = false;
    this.viewport.removeEventListener('wheel', this.interrupt);
    this.viewport.removeEventListener('touchstart', this.interrupt);
    this.viewport.removeEventListener('pointerdown', this.interrupt);
    this.viewport.removeEventListener('keydown', this.keydown);
    this.viewport.removeEventListener('scrollend', this.finished);
  }
}
