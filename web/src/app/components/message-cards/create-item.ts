import { createComponent, EnvironmentInjector } from '@angular/core';
import type { CbElement, CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData, ChatMsgData } from './chat-item';
import { InviteRowComponent } from './invite-row/invite-row.component';
import { MediaRowComponent } from './media-row/media-row.component';
import { TextRowComponent } from './text-row/text-row.component';

/**
 * Wraps a ChatMsgData into a CbElement: pick the component by contentType, create it dynamically via
 * createComponent, inject data + grouping flags + dateLabel via setInput, and drive the first render
 * manually with detectChanges (zoneless has no automatic change detection).
 *
 * Shared by the real thread and the playground so both render identical cards + wrapping logic.
 *
 * date was moved out of the data source: the source returns only messages; the date separator is derived
 * per-day by the createItem factory and passed in as dateLabel, rendered conditionally at the top of the
 * message component template (see date-format.ts).
 *
 * Height contract (cb-element-border-box memory): components must be border-box with vertical spacing via
 * padding (offsetHeight excludes margin). This factory does NOT estimate height — the kernel's createEntry
 * mounts with height=0 (hidden for one frame via .cb-pending), and measurePending reads the real
 * el.offsetHeight synchronously to settle it; the onHeightChange ResizeObserver only captures post-render
 * async changes (font/image/data updates). Do not use the RO's contentRect.height — content-box would miss
 * the padding.
 */
export function createMsgCbElement(
  item: CbItem<ChatItemData>,
  isShowHead: boolean,
  isGroupStart: boolean,
  dateLabel: string | null,
  envInjector: EnvironmentInjector,
): CbElement<ChatItemData> {
  const data = item.data as ChatMsgData; // source returns only messages; date is derived at the render layer

  const comp =
    data.contentType === 'IMAGE'
      ? MediaRowComponent
      : data.contentType === 'INVITE'
        ? InviteRowComponent
        : TextRowComponent;

  const ref = createComponent(comp, { environmentInjector: envInjector });
  ref.setInput('data', data);
  ref.setInput('isShowHead', isShowHead);
  ref.setInput('isGroupStart', isGroupStart);
  ref.setInput('dateLabel', dateLabel);
  ref.changeDetectorRef.detectChanges(); // zoneless: drive the first render manually (triggers ngOnInit)

  return wrapEl(ref);
}

/**
 * Ghost loading-indicator CbElement: when the kernel mounts the window's top item (the oldest slot, not yet
 * at the global oldest), its group-head/avatar/date depend on an older neighbor that isn't loaded yet — so
 * instead of rendering the real component, render a centered spinner placeholder (.cb-ghost-loading,
 * WhatsApp-style, see _cb.scss). Once loadOlder loads the older neighbor, the kernel's rebuildEntry rebuilds
 * it as the real component (prev becomes non-null → the caller no longer takes this branch).
 *
 * **Fixed height**: eliminates jitter from "the ghost height being stretched by real content / an async image
 * load changing the height" — the spinner host height is constant; rebuildDelta (real height − GHOST_H) is
 * compensated in one shot by the kernel's loadOlder via compensateAbove (the viewport doesn't jump). No
 * Angular component is built, no image/typography rendered — an empty host + a ::before ring (CSS-driven),
 * zero render cost.
 */
export function createGhostCbElement(): CbElement<ChatItemData> {
  const GHOST_H = 48; // fixed spinner row height (compact, WhatsApp-style), not stretched by content
  const el = document.createElement('div');
  el.className = 'cb-ghost-loading'; // the kernel's updateGhost still adds cb-ghost (visual marker, no functional dependency)
  el.style.height = `${GHOST_H}px`;
  return {
    el,
    onHeightChange: () => () => {}, // fixed height never changes (no ResizeObserver); settled by the kernel's measurePending reading offsetHeight
    destroy: () => {},
  };
}

/**
 * Generic CbElement wrapper: onHeightChange reports the real el.offsetHeight via ResizeObserver (border-box,
 * same basis as the kernel's measurePending — do not use the RO's contentRect.height, content-box would miss
 * the padding); destroy disconnects the RO and destroys the component ref. Factored out to avoid duplicating
 * the RO + destroy boilerplate across text/media/invite.
 *
 * No estimateHeight: the kernel never estimates height (see the CbElement doc). createEntry mounts with
 * height=0 and measurePending reads the real offsetHeight synchronously to settle it; this RO only captures
 * post-render async changes (secondary height changes from font/image/data updates).
 */
function wrapEl<T>(ref: { location: { nativeElement: HTMLElement }; destroy: () => void }): CbElement<T> {
  const el = ref.location.nativeElement;
  let ro: ResizeObserver | null = null;
  let live: ((h: number) => void) | null = null;
  return {
    el,
    onHeightChange: (cb) => {
      live = cb;
      if (!ro) {
        ro = new ResizeObserver(() => {
          const h = el.offsetHeight; // border-box, same basis as the kernel's measurePending
          if (h > 0) live?.(h);
        });
        ro.observe(el);
      }
      return () => {
        live = null;
      };
    },
    destroy: () => {
      ro?.disconnect();
      ro = null;
      live = null;
      ref.destroy();
    },
  };
}
