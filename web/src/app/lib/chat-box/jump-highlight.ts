/** Paint a one-shot jump cue on a mounted message and, for aggregated media, its exact member cell. */
export function applyJumpHighlight(host: HTMLElement, targetId?: number): void {
  host.classList.remove('cb-jump-highlight');
  host
    .querySelectorAll('.cb-jump-highlight-target')
    .forEach((target) => target.classList.remove('cb-jump-highlight-target'));
  const mediaTarget =
    targetId === undefined
      ? null
      : host.querySelector<HTMLElement>(
          `[data-media-message-id="${targetId}"]`,
        );
  void host.offsetWidth;

  if (mediaTarget) {
    // A jump to an exact member of a client-side album should identify that member only. Flashing the
    // enclosing bubble makes the whole presentation-only album look like the target message.
    mediaTarget.classList.add('cb-jump-highlight-target');
  } else {
    host.classList.add('cb-jump-highlight');
  }

  if (!mediaTarget) {
    host.addEventListener(
      'animationend',
      () => host.classList.remove('cb-jump-highlight'),
      { once: true },
    );
  }
  mediaTarget?.addEventListener(
    'animationend',
    (event) => {
      event.stopPropagation();
      mediaTarget.classList.remove('cb-jump-highlight-target');
    },
    { once: true },
  );
}
