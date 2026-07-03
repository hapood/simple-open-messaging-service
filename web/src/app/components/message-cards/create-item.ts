import { createComponent, EnvironmentInjector, InputSignal, Type } from '@angular/core';
import type { CbElement, CbItem } from '../../lib/chat-box/chat-box-scroller';
import { classifyGroupFlags, type GroupCtx } from '../../lib/chat-box/group-logic';
import { shouldShowDateSeparator, formatDateSeparator } from './date-format';
import type { ChatItemData, ChatMsgData, AlbumImage } from './chat-item';
import { FileRowComponent } from './file-row/file-row.component';
import { InviteRowComponent } from './invite-row/invite-row.component';
import { MediaRowComponent } from './media-row/media-row.component';
import { TextRowComponent } from './text-row/text-row.component';

/**
 * Common shape of the three row components (text/media/invite): they all bind the same 4 signal inputs. Used to type
 * the dynamically-selected component so createComponent infers one C — the components differ in extra members (invite
 * state, album logic, the text row's retry output), which otherwise breaks union inference at the createComponent call.
 */
interface RowComponent {
  data: InputSignal<ChatMsgData>;
  isShowHead: InputSignal<boolean>;
  isGroupStart: InputSignal<boolean>;
  dateLabel: InputSignal<string | null>;
}

/**
 * Compute a message row's grouping + date-separator inputs from its older neighbor `prev` — the shared logic behind
 * both createMsgCbElement's initial mount and CbElement.update's in-place re-render. Centralized here (previously
 * duplicated inline in the playground and friend-message createItem hooks) so the mount path and the in-place update
 * path derive identical flags. A reconcilePending reorder changes an optimistic entry's prev, and update() must
 * recompute grouping (isShowHead/isGroupStart) + dateLabel against the NEW prev on the same DOM node — without
 * recreating it (which would break a FLIP move). Returns head-shown / no-group-start / no-date by default for non-msg.
 */
export function computeRowFlags(item: CbItem<ChatItemData>, prev: CbItem<ChatItemData> | null): {
  isShowHead: boolean;
  isGroupStart: boolean;
  dateLabel: string | null;
} {
  let isShowHead = true;
  let isGroupStart = false;
  let dateLabel: string | null = null;
  if (item.data.type === 'msg') {
    const msg = item.data;
    const prevMsg = prev?.data.type === 'msg' ? prev.data : null;
    const curCtx: GroupCtx = { creator: msg.creator };
    const prevCtx: GroupCtx | null = prevMsg ? { creator: prevMsg.creator } : null;
    isShowHead = classifyGroupFlags(prevCtx, curCtx, null).isShowHead;
    isGroupStart = isShowHead && !!prevMsg; // a sender-change group start adds inter-group spacing
    // date separator: derived per-window from the prev message's createdAtMs (date lives outside the source). The
    // oldest boundary always shows date above; a non-oldest prev==null (trim re-mount) does not (anti-flicker).
    dateLabel = shouldShowDateSeparator(prevMsg?.createdAtMs ?? null, msg.createdAtMs, item.boundary === 'oldest')
      ? formatDateSeparator(msg.createdAtMs)
      : null;
  }
  return { isShowHead, isGroupStart, dateLabel };
}

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
  onRetry?: (msgId: string) => void,
  onOpenImage?: (images: AlbumImage[], index: number) => void,
): CbElement<ChatItemData> {
  const data = item.data as ChatMsgData; // source returns only messages; date is derived at the render layer

  const comp: Type<RowComponent> =
    data.contentType === 'IMAGE'
      ? MediaRowComponent
      : data.contentType === 'INVITE'
        ? InviteRowComponent
        : data.contentType === 'FILE'
          ? FileRowComponent
          : TextRowComponent;

  const ref = createComponent(comp, { environmentInjector: envInjector });
  ref.setInput('data', data);
  ref.setInput('isShowHead', isShowHead);
  ref.setInput('isGroupStart', isGroupStart);
  ref.setInput('dateLabel', dateLabel);
  ref.changeDetectorRef.detectChanges(); // zoneless: drive the first render manually (triggers ngOnInit)

  // In-place re-render (CbElement.update): recompute grouping + date from the (possibly new) prev and re-apply all four
  // signal inputs on the SAME component instance + DOM node, then drive change detection synchronously so the kernel's
  // immediate offsetHeight read reflects the new content. Used by reconcilePending to morph a pending send's status
  // (sending→failed) and to re-group after a reorder — without remounting (which would break a FLIP move animation).
  const update = (nextItem: CbItem<ChatItemData>, nextPrev: CbItem<ChatItemData> | null): void => {
    const flags = computeRowFlags(nextItem, nextPrev);
    ref.setInput('data', nextItem.data as ChatMsgData);
    ref.setInput('isShowHead', flags.isShowHead);
    ref.setInput('isGroupStart', flags.isGroupStart);
    ref.setInput('dateLabel', flags.dateLabel);
    ref.changeDetectorRef.detectChanges();
  };

  const el = wrapEl(ref, update);
  // Wire optional row outputs (failed-send retry on TextRow; open-image on MediaRow). Each subscription is released on
  // destroy so re-rendering the row (rebuildEntry) or unmounting it does not leak a handler. Several outputs may compose
  // on one entry — wrapDestroy chains them LIFO into a single destroy().
  const wrapDestroy = (extra: () => void): void => { const base = el.destroy; el.destroy = () => { extra(); base(); }; };
  if (onRetry) {
    const inst = ref.instance as { retry?: { subscribe: (fn: (id: string) => void) => { unsubscribe(): void } } };
    const sub = inst.retry?.subscribe(id => onRetry(id));
    if (sub) wrapDestroy(() => sub.unsubscribe());
  }
  if (onOpenImage) {
    const inst = ref.instance as { openImage?: { subscribe: (fn: (p: { images: AlbumImage[]; index: number }) => void) => { unsubscribe(): void } } };
    const sub = inst.openImage?.subscribe(p => onOpenImage(p.images, p.index));
    if (sub) wrapDestroy(() => sub.unsubscribe());
  }
  return el;
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
    update: () => {}, // ghosts are placeholders, never morphed in place (no optimistic send is ever a ghost)
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
function wrapEl<T>(ref: { location: { nativeElement: HTMLElement }; destroy: () => void }, update: (item: CbItem<T>, prev: CbItem<T> | null) => void): CbElement<T> {
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
    update,
    destroy: () => {
      ro?.disconnect();
      ro = null;
      live = null;
      ref.destroy();
    },
  };
}
