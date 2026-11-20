/** Non-message layout region. Owns DOM/observation, never scroll policy. */
export class MeasuredRegionView {
  readonly el = document.createElement('div');
  private readonly observer: ResizeObserver;
  private disposed = false;

  constructor(className: string, changed: (height: number) => void) {
    this.el.className = className;
    this.observer = new ResizeObserver(() => {
      if (!this.disposed) changed(this.measure());
    });
  }

  mount(parent: HTMLElement): number {
    parent.appendChild(this.el);
    this.observer.observe(this.el);
    return this.measure();
  }

  measure(): number {
    return this.el.offsetHeight;
  }

  destroy(): void {
    this.disposed = true;
    this.observer.disconnect();
    this.el.remove();
  }
}
