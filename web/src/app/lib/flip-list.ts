import { prefersReducedMotion } from './motion-utils';

/**
 * First-Last-Invert-Play for a reordered DOM list, mirroring the kernel's `cb-move` technique
 * (chat-box-scroller.ts flipMove): compute each moved row's old→new delta, set it as a CSS var
 * synchronously, then on the next rAF add a class whose @keyframes animate `translateY(var)` →
 * `translateY(0)`. A row with no previous rect (a newly-inserted row) gets the enter class instead
 * (opacity + downward slide). The @keyframes / classes live in the host component's SCSS
 * (`.tl-flip-move` / `.tl-flip-enter`) so the animation is pure CSS — no Motion/WAAPI typing — and
 * rAF timing means the `from` keyframe applies on the first painted frame after the reorder (no
 * flash, no forced reflow).
 *
 * Rows are matched by a `data-flip-key` attribute (the threadId, kept stable across updates by the
 * `@for … track` in the host template, so Angular reuses — not recreates — moved DOM nodes; that is
 * what makes the translate delta meaningful). Returns the fresh rect map (the new "before" snapshot
 * for the next insert). `prefers-reduced-motion` skips the class adds (rows snap) but still refreshes
 * the rect map.
 */
export function playFlipList(
  container: HTMLElement,
  prevRects: Map<string, DOMRect>,
): Map<string, DOMRect> {
  const reduced = prefersReducedMotion();
  const next = new Map<string, DOMRect>();
  // INVERT + queue PLAY for each row.
  for (const el of Array.from(container.querySelectorAll<HTMLElement>('[data-flip-key]'))) {
    const key = el.dataset['flipKey'];
    if (!key) continue;
    const rect = el.getBoundingClientRect();
    next.set(key, rect);
    if (reduced) continue;
    const prev = prevRects.get(key);
    if (prev) {
      const dy = prev.top - rect.top;
      if (Math.abs(dy) > 1) queueMove(el, dy);
    } else {
      queueEnter(el);
    }
  }
  return next;
}

/** FLIP a moved row: set the delta var now, add the @keyframes class on the next frame so the
 *  `from` (translateY(dy) = old position) paints first; clear on animationend. */
function queueMove(el: HTMLElement, dy: number): void {
  el.style.setProperty('--tl-flip-dy', `${dy}px`);
  // Restart-safe: clear a stale class so re-adding actually restarts the animation.
  el.classList.remove('tl-flip-move');
  requestAnimationFrame(() => {
    el.classList.add('tl-flip-move');
    el.addEventListener(
      'animationend',
      () => {
        el.classList.remove('tl-flip-move');
        el.style.removeProperty('--tl-flip-dy');
      },
      { once: true },
    );
  });
}

/** Enter animation for a newly-inserted row: opacity + downward slide, cleared on animationend. */
function queueEnter(el: HTMLElement): void {
  el.classList.remove('tl-flip-enter');
  requestAnimationFrame(() => {
    el.classList.add('tl-flip-enter');
    el.addEventListener('animationend', () => el.classList.remove('tl-flip-enter'), { once: true });
  });
}

/** Snapshot the current rects of every keyed row, with no animation. Use to keep the "before" map
 *  fresh across renders that should NOT animate (initial load, normal message bumps, filter changes). */
export function snapshotFlipRects(container: HTMLElement): Map<string, DOMRect> {
  const map = new Map<string, DOMRect>();
  for (const el of Array.from(container.querySelectorAll<HTMLElement>('[data-flip-key]'))) {
    const key = el.dataset['flipKey'];
    if (key) map.set(key, el.getBoundingClientRect());
  }
  return map;
}
