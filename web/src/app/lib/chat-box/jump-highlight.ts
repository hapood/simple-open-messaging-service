/** Paint a one-shot jump cue on a mounted message and, for aggregated media, its exact member cell. */
export function applyJumpHighlight(
  host: HTMLElement,
  targetId?: number,
): void {
  host.classList.remove('cb-jump-highlight');
  host.querySelectorAll('.cb-jump-highlight-target').forEach((target) =>
    target.classList.remove('cb-jump-highlight-target'),
  );
  void host.offsetWidth;
  host.classList.add('cb-jump-highlight');

  const mediaTarget =
    targetId === undefined
      ? null
      : host.querySelector<HTMLElement>(
          `[data-media-message-id="${targetId}"]`,
        );
  mediaTarget?.classList.add('cb-jump-highlight-target');

  host.addEventListener(
    'animationend',
    () => host.classList.remove('cb-jump-highlight'),
    { once: true },
  );
  mediaTarget?.addEventListener(
    'animationend',
    (event) => {
      event.stopPropagation();
      mediaTarget.classList.remove('cb-jump-highlight-target');
    },
    { once: true },
  );
}
