import { createChatEdgeStatus } from './chat-edge-status';

export type GhostState = 'inactive' | 'loading' | 'failed';

/** Decorate an existing row without owning its message renderer or demand lifetime. */
export function renderGhostState(
  el: HTMLElement,
  state: GhostState,
  retry: () => void,
  direction: 'older' | 'newer' | 'both' = 'older',
): void {
  el.classList.toggle('cb-ghost', state !== 'inactive');
  el.classList.toggle('cb-edge-failed', state === 'failed');
  if (state !== 'inactive' && !el.querySelector('.cb-load-status'))
    el.appendChild(createChatEdgeStatus());
  el.onclick = state === 'failed' ? retry : null;
  el.tabIndex = state === 'failed' ? 0 : -1;
  if (state === 'failed') {
    el.setAttribute('role', 'button');
    el.setAttribute(
      'aria-label',
      direction === 'both'
        ? 'Retry loading messages'
        : `Retry loading ${direction} messages`,
    );
  } else {
    el.removeAttribute('role');
    el.removeAttribute('aria-label');
  }
  el.onkeydown =
    state === 'failed'
      ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            retry();
          }
        }
      : null;
}
