import { createChatEdgeStatus } from './chat-edge-status';

export type EntryGapState = 'idle' | 'loading' | 'failed';
export type EntryGapLabel = (state: EntryGapState) => string;

export interface EntryGapRenderer {
  readonly el: HTMLElement;
  update(state: EntryGapState): void;
  destroy(): void;
}

const defaultLabel: EntryGapLabel = (state) =>
  ({
    idle: 'Load skipped messages',
    loading: 'Loading skipped messages',
    failed: 'Retry loading skipped messages',
  })[state];

/** Presentation only. Destruction never cancels domain work or consumes an entry opportunity. */
export function createEntryGapRenderer(
  activate: () => void,
  label: EntryGapLabel = defaultLabel,
): EntryGapRenderer {
  const el = document.createElement('div');
  el.className = 'cb-entry-gap';
  el.dataset['entryGap'] = '';
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.appendChild(createChatEdgeStatus());
  let state: EntryGapState = 'idle';
  let destroyed = false;
  const invoke = () => {
    if (!destroyed && state !== 'loading') activate();
  };
  el.onclick = invoke;
  el.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      invoke();
    }
  };
  const update = (next: EntryGapState) => {
    if (destroyed) return;
    state = next;
    el.setAttribute('aria-label', label(state));
    el.classList.toggle('cb-edge-failed', state !== 'loading');
    if (state === 'loading') {
      el.setAttribute('aria-busy', 'true');
      el.setAttribute('aria-disabled', 'true');
    } else {
      el.removeAttribute('aria-busy');
      el.removeAttribute('aria-disabled');
    }
  };
  update('idle');
  return {
    el,
    update,
    destroy: () => {
      destroyed = true;
      el.onclick = null;
      el.onkeydown = null;
      el.remove();
    },
  };
}
