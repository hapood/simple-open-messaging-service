import type { NativeComposerService } from '../../services/native-composer.service';

type Bounds = { left: number; top: number; width: number; height: number };

/** Owns observation, animation-frame coalescing and native composer bounds publication. */
export class NativeComposerBoundsController {
  private observer?: ResizeObserver;
  private frame = 0;
  private pending = false;
  private target?: HTMLElement;
  private last?: Bounds;

  constructor(
    private readonly nativeComposer: NativeComposerService,
    private readonly contextId: () => number | null,
    private readonly reflowFrozen: () => boolean,
  ) {}

  observe(container: HTMLElement | undefined, contextId: number): void {
    const target = container?.closest<HTMLElement>('.chat-slot');
    if (!target) return;
    this.target = target;
    this.observer = new ResizeObserver(() => {
      if (contextId === this.contextId()) this.schedule();
    });
    this.observer.observe(target);
    this.schedule();
  }

  schedule(): void {
    this.pending = true;
    if (this.reflowFrozen() || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.reflowFrozen()) return;
      const contextId = this.contextId();
      if (!this.target || contextId === null) return;
      const rect = this.target.getBoundingClientRect();
      const next = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
      this.pending = false;
      if (this.last && sameBounds(this.last, next)) return;
      this.last = next;
      this.nativeComposer.setBounds(
        contextId,
        new DOMRectReadOnly(next.left, next.top, next.width, next.height),
      );
    });
  }

  flush(): void {
    if (this.pending) this.schedule();
  }

  reset(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pending = false;
    this.target = undefined;
    this.last = undefined;
  }
}

function sameBounds(previous: Bounds, next: Bounds): boolean {
  return (
    Math.abs(previous.left - next.left) < 0.5 &&
    Math.abs(previous.top - next.top) < 0.5 &&
    Math.abs(previous.width - next.width) < 0.5 &&
    Math.abs(previous.height - next.height) < 0.5
  );
}
