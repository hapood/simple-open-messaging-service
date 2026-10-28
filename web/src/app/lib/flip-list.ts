import { prefersReducedMotion } from './motion-utils';

export type FlipListRow = {
  /** Position in the complete list, independent of the rendered window. */
  top: number;
  /** Changes only when the owning row may have actively changed order. */
  revision: string;
};

export type FlipListLayout = ReadonlyMap<string, FlipListRow>;

type RowSnapshot = {
  top: number;
  left: number;
  width: number;
  height: number;
  ghost?: HTMLElement;
};

/** Animates a fixed-height virtual window against the complete keyed layout.
 * Scrolling/recycling is not an insertion. Only visible rows retain visual clones;
 * the full layout contains data only. The virtual window owns its outer transform,
 * while these animations affect the inner rows without changing layout height.
 */
export class FlipListAnimator {
  private previous = new Map<string, RowSnapshot>();
  private previousLayout?: FlipListLayout;
  private previousScrollTop = 0;
  private cleanups: (() => void)[] = [];

  play(container: HTMLElement, layout: FlipListLayout): void {
    const scrollTop = container.scrollTop;
    const scrolled = scrollTop !== this.previousScrollTop;
    const changed = layout !== this.previousLayout;
    if (changed || scrolled) this.cancel();
    const next = new Map<string, RowSnapshot>();
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-flip-key]'),
    );
    // Read all layout before writing animations or inserting outgoing overlays.
    for (const row of rows) {
      const key = row.dataset['flipKey'];
      const position = key ? layout.get(key) : undefined;
      if (!key || !position) continue;
      const top = position.top;
      const height = row.offsetHeight;
      const visible =
        top + height > scrollTop && top < scrollTop + container.clientHeight;
      next.set(key, {
        top,
        left: row.offsetLeft,
        width: row.offsetWidth,
        height,
        ghost: visible ? (row.cloneNode(true) as HTMLElement) : undefined,
      });
    }
    if (
      this.previousLayout &&
      changed &&
      !scrolled &&
      !prefersReducedMotion()
    ) {
      // A row can leave the rendered window because it was promoted out of view.
      // Preserve its visible exit, but do not mistake ordinary recycling for removal.
      for (const [key, old] of this.previous) {
        const before = this.previousLayout.get(key);
        const after = layout.get(key);
        const outgoing =
          !after ||
          (before?.top !== after.top && before?.revision !== after.revision);
        if (outgoing && old.ghost && typeof old.ghost.animate === 'function')
          this.fadeOutgoing(container, old);
      }
      for (const row of rows) {
        const key = row.dataset['flipKey']!;
        const current = next.get(key);
        if (!current || typeof row.animate !== 'function') continue;
        // Look up the old position even if the row was previously off screen.
        const before = this.previousLayout.get(key);
        const after = layout.get(key)!;
        const dy = before ? before.top - current.top : 0;
        const incoming =
          !before || (dy !== 0 && before.revision !== after.revision);
        if (incoming) {
          if (current.ghost) {
            this.animate(row, [
              { opacity: 0, transform: 'translateX(-32px)' },
              { opacity: 1, transform: 'translateX(0)' },
            ]);
          }
        } else if (
          dy !== 0 &&
          Math.abs(dy) <= container.clientHeight &&
          (this.previous.get(key)?.ghost || current.ghost)
        ) {
          this.animate(row, [
            { transform: `translateY(${dy}px)` },
            { transform: 'translateY(0)' },
          ]);
        }
      }
    }
    this.previous = next;
    this.previousLayout = layout;
    this.previousScrollTop = scrollTop;
  }

  destroy(): void {
    this.cancel();
    this.previous.clear();
    this.previousLayout = undefined;
    this.previousScrollTop = 0;
  }

  private cancel(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  private animate(row: HTMLElement, frames: Keyframe[]): void {
    const animation = row.animate(frames, {
      duration: 300,
      easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
    });
    this.cleanups.push(() => animation.cancel());
  }

  private fadeOutgoing(container: HTMLElement, old: RowSnapshot): void {
    const ghost = old.ghost!;
    ghost.removeAttribute('data-flip-key');
    ghost.removeAttribute('id');
    ghost
      .querySelectorAll('[id]')
      .forEach((node) => node.removeAttribute('id'));
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    Object.assign(ghost.style, {
      position: 'absolute',
      top: `${old.top}px`,
      left: `${old.left}px`,
      width: `${old.width}px`,
      height: `${old.height}px`,
      pointerEvents: 'none',
      zIndex: '1',
    });
    container.append(ghost);
    const animation = ghost.animate(
      [
        { opacity: 1, transform: 'translateX(0)' },
        { opacity: 0, transform: 'translateX(32px)' },
      ],
      {
        duration: 300,
        easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
        fill: 'forwards',
      },
    );
    animation.onfinish = () => ghost.remove();
    this.cleanups.push(() => {
      animation.cancel();
      ghost.remove();
    });
  }
}
