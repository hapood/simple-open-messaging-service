import {
  ApplicationRef,
  createComponent,
  EnvironmentInjector,
  InputSignal,
  Type,
} from '@angular/core';
import type { CbElement, CbItem } from '../../lib/chat-box/chat-box-scroller';
import {
  classifyGroupFlags,
  type GroupCtx,
} from '../../lib/chat-box/group-logic';
import { shouldShowDateSeparator } from './date-format';
import type { ChatItemData, ChatMsgData, AlbumImage } from './chat-item';
import { FileRowComponent } from './file-row/file-row.component';
import { InviteRowComponent } from './invite-row/invite-row.component';
import { LinkRowComponent } from './link-row/link-row.component';
import { CallRowComponent } from './call-row/call-row.component';
import { ForwardRowComponent } from './forward-row/forward-row.component';
import { MediaRowComponent } from './media-row/media-row.component';
import { TextRowComponent } from './text-row/text-row.component';
import { SystemRowComponent } from './system-row/system-row.component';
import { MessagePressGesture } from './message-press-gesture';
import { parseForwardCard } from './forward-row/forward-card';
import { writeStickyAvatarIdentity } from '../../lib/sticky-avatar';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';

/**
 * Common shape of the message-row components: they all bind the same 4 signal inputs. Used to type
 * the dynamically-selected component so createComponent infers one C — the components differ in extra members (invite
 * state, album logic, the text row's retry output), which otherwise breaks union inference at the createComponent call.
 */
interface RowComponent {
  data: InputSignal<ChatMsgData>;
  isShowHead: InputSignal<boolean>;
  isGroupStart: InputSignal<boolean>;
  showDate: InputSignal<boolean>;
}

const DATE_SEPARATOR_HEIGHT_PX = 47;
const MESSAGE_ITEM_TOP_GAP_PX = 6;
const MESSAGE_GROUP_TOP_GAP_PX = 14;
const UNREAD_DIVIDER_HEIGHT_PX = 38;

/**
 * Compute a message row's grouping + date-separator inputs from its older neighbor `prev` — the shared logic behind
 * both createMsgCbElement's initial mount and CbElement.update's in-place re-render. Centralized here (previously
 * duplicated inline in the playground and friend-message createItem hooks) so the mount path and the in-place update
 * path derive identical flags. A reconcilePending reorder changes an optimistic entry's prev, and update() must
 * recompute grouping (isShowHead/isGroupStart) + dateLabel against the NEW prev on the same DOM node — without
 * recreating it (which would break a FLIP move). Returns head-shown / no-group-start / no-date by default for non-msg.
 */
export function computeRowFlags(
  item: CbItem<ChatItemData>,
  prev: CbItem<ChatItemData> | null,
  next: CbItem<ChatItemData> | null = null,
): {
  isShowHead: boolean;
  isGroupStart: boolean;
  showDate: boolean;
  groupPosition: 'single' | 'head' | 'body' | 'tail';
} {
  let isShowHead = true;
  let isGroupStart = false;
  let showDate = false;
  let groupPosition: 'single' | 'head' | 'body' | 'tail' = 'single';
  if (item.data.type === 'msg') {
    const msg = item.data;
    // A SYSTEM row is timeline chrome, not part of a sender's message run. Treat it as a hard grouping
    // boundary so the first real message after a fresh-chat notice renders its avatar and sender name,
    // even when the system event happens to carry the same creator id.
    const prevMsg =
      prev?.data.type === 'msg' && prev.data.contentType !== 'SYSTEM'
        ? prev.data
        : null;
    const curCtx: GroupCtx = { creator: msg.creator };
    const prevCtx: GroupCtx | null = prevMsg
      ? { creator: prevMsg.creator }
      : null;
    const nextMsg =
      next?.data.type === 'msg' && next.data.contentType !== 'SYSTEM'
        ? next.data
        : null;
    const nextCtx: GroupCtx | null = nextMsg
      ? { creator: nextMsg.creator }
      : null;
    const groupFlags = classifyGroupFlags(prevCtx, curCtx, nextCtx);
    isShowHead = groupFlags.isShowHead;
    isGroupStart = isShowHead && !!prevMsg; // a sender-change group start adds inter-group spacing
    groupPosition = isShowHead
      ? groupFlags.isDateShrink
        ? 'head'
        : 'single'
      : groupFlags.isDateShrink
        ? 'body'
        : 'tail';
    // date separator: derived per-window from the prev message's createdAtMs (date lives outside the source). The
    // oldest boundary always shows date above; a non-oldest prev==null (trim re-mount) does not (anti-flicker).
    // The label text itself is computed by DateRowComponent from the timestamp + active language, so the factory
    // only needs the show/hide decision here.
    showDate = shouldShowDateSeparator(
      prevMsg?.createdAtMs ?? null,
      msg.createdAtMs,
      item.boundary === 'oldest',
    );
  }
  return { isShowHead, isGroupStart, showDate, groupPosition };
}

function applyGroupPosition(
  host: HTMLElement,
  position: 'single' | 'head' | 'body' | 'tail',
): void {
  const bubble = host.querySelector('.msg-bubble');
  if (!bubble) return;
  bubble.classList.remove('msg-single', 'msg-head', 'msg-body', 'msg-tail');
  bubble.classList.add(`msg-${position}`);
}

function groupPositionFrom(
  isShowHead: boolean,
  item: CbItem<ChatItemData>,
  next: CbItem<ChatItemData> | null,
): 'single' | 'head' | 'body' | 'tail' {
  const nextIsSameSender =
    item.data.type === 'msg' &&
    item.data.contentType !== 'SYSTEM' &&
    next?.data.type === 'msg' &&
    next.data.contentType !== 'SYSTEM' &&
    next.data.creator === item.data.creator;
  return isShowHead
    ? nextIsSameSender
      ? 'head'
      : 'single'
    : nextIsSameSender
      ? 'body'
      : 'tail';
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
  showDate: boolean,
  envInjector: EnvironmentInjector,
  onRetry?: (clientMessageId: string) => void,
  onOpenImage?: (images: AlbumImage[], index: number) => void,
  onOpenFile?: (data: ChatMsgData) => void,
  onCancel?: (clientMessageId: string) => void,
  unreadDividerLabel?: string,
  onInteraction?: (
    intent: 'select' | 'open-menu',
    item: CbItem<ChatItemData>,
    pointer?: { x: number; y: number },
    memberId?: number,
  ) => void,
  onOpenForward?: (bundleId: string) => void,
  onQuoteJump?: (seq: number) => void,
): CbElement<ChatItemData> {
  const data = item.data as ChatMsgData; // source returns only messages; date is derived at the render layer

  const comp: Type<RowComponent> =
    data.contentType === 'SYSTEM'
      ? SystemRowComponent
      : data.contentType === 'IMAGE' ||
          data.contentType === 'VIDEO' ||
          data.contentType === 'AUDIO' ||
          data.contentType === 'GALLERY'
        ? MediaRowComponent
        : data.contentType === 'INVITE'
          ? InviteRowComponent
          : data.contentType === 'LINK'
            ? LinkRowComponent
            : data.contentType === 'FILE'
              ? FileRowComponent
              : data.contentType === 'CALL'
                ? CallRowComponent
                : data.contentType === 'FORWARD'
                  ? ForwardRowComponent
                  : TextRowComponent;

  const ref = createComponent(comp, { environmentInjector: envInjector });
  // createComponent() only constructs the view; it does not enroll it in Angular's application view
  // tree. Message rows contain async, signal-driven children (notably UserAvatarComponent, whose IDB
  // blob resolves after the first render), so leaving the host view detached freezes those children at
  // their initial fallback until some unrelated scroller update happens to call detectChanges().
  const appRef = envInjector.get(ApplicationRef);
  appRef.attachView(ref.hostView);
  ref.setInput('data', data);
  ref.setInput('isShowHead', isShowHead);
  ref.setInput('isGroupStart', isGroupStart);
  ref.setInput('showDate', showDate);
  if (comp === MediaRowComponent) {
    ref.setInput('clientMessageId', item.clientMessageId ?? '');
  }
  ref.changeDetectorRef.detectChanges(); // zoneless: drive the first render manually (triggers ngOnInit)
  applyGroupPosition(
    ref.location.nativeElement,
    isShowHead ? 'single' : 'tail',
  );

  // Every message keeps a pre-mounted tail avatar. The sticky controller reveals only the tail of the
  // active sender group at the exact fixed-avatar handoff; keeping the image component alive makes the
  // reverse (above→viewport) handoff synchronous as well.
  const tailAvatarRef = createComponent(UserAvatarComponent, {
    environmentInjector: envInjector,
  });
  appRef.attachView(tailAvatarRef.hostView);
  const tailAvatar = document.createElement('div');
  tailAvatar.className = 'msg-avatar msg-avatar-tail';
  tailAvatar.appendChild(tailAvatarRef.location.nativeElement);
  (ref.location.nativeElement as HTMLElement)
    .querySelector<HTMLElement>('.msg-row')
    ?.appendChild(tailAvatar);
  const updateTailAvatar = (message: ChatMsgData): void => {
    tailAvatarRef.setInput(
      'type',
      message.isSelf ? UserAvatarType.SELF : UserAvatarType.OTHER,
    );
    tailAvatarRef.setInput('name', message.name);
    tailAvatarRef.setInput('identityId', message.avatarIdentityId);
    tailAvatarRef.setInput('src', message.avatar);
    tailAvatarRef.changeDetectorRef.detectChanges();
  };
  updateTailAvatar(data);

  // In-place re-render (CbElement.update): recompute grouping + date from the (possibly new) prev and re-apply all four
  // signal inputs on the SAME component instance + DOM node, then drive change detection synchronously so the kernel's
  // immediate offsetHeight read reflects the new content. Used by reconcilePending to morph a pending send's status
  // (sending→failed) and to re-group after a reorder — without remounting (which would break a FLIP move animation).
  let selectionHost: HTMLElement | undefined;
  let interactionItem = item;
  let interactionIsShowHead = isShowHead;
  let interactionNext: CbItem<ChatItemData> | null = null;
  const applySelectionMetadata = (
    host: HTMLElement,
    nextItem: CbItem<ChatItemData>,
  ): void => {
    host.dataset['messageId'] = String(nextItem.id);
    host.dataset['messageMemberIds'] = (
      nextItem.ids?.length ? nextItem.ids : [nextItem.id]
    ).join(',');
    host.classList.toggle('cb-message--album', (nextItem.ids?.length ?? 0) > 1);
    if (nextItem.data.type === 'msg') {
      const message = nextItem.data;
      host.dataset['messageCreator'] = String(message.creator);
      host.dataset['messageSide'] = message.isSelf ? 'self' : 'other';
      writeStickyAvatarIdentity(host, {
        name: message.name,
        src: message.avatar,
        identityId: message.avatarIdentityId,
      });
      const naturalAvatar = host.querySelector<HTMLElement>(
        '.msg-has-avatar > .msg-avatar:not(.msg-avatar-tail)',
      );
      host.dataset['messageHasNaturalAvatar'] = naturalAvatar
        ? 'true'
        : 'false';
      if (!naturalAvatar) {
        delete host.dataset['messageNaturalAvatarOffset'];
      }
    }
  };
  const applyAvatarOffset = (
    host: HTMLElement,
    nextShowDate: boolean,
    nextIsGroupStart: boolean,
  ): void => {
    if (host.dataset['messageHasNaturalAvatar'] !== 'true') return;
    host.dataset['messageNaturalAvatarOffset'] = String(
      (unreadDividerLabel ? UNREAD_DIVIDER_HEIGHT_PX : 0) +
        (nextShowDate ? DATE_SEPARATOR_HEIGHT_PX : 0) +
        (nextIsGroupStart ? MESSAGE_GROUP_TOP_GAP_PX : MESSAGE_ITEM_TOP_GAP_PX),
    );
  };
  const update = (
    nextItem: CbItem<ChatItemData>,
    nextPrev: CbItem<ChatItemData> | null,
  ): void => {
    const flags = computeRowFlags(nextItem, nextPrev, interactionNext);
    ref.setInput('data', nextItem.data as ChatMsgData);
    ref.setInput('isShowHead', flags.isShowHead);
    ref.setInput('isGroupStart', flags.isGroupStart);
    ref.setInput('showDate', flags.showDate);
    if (comp === MediaRowComponent) {
      ref.setInput('clientMessageId', nextItem.clientMessageId ?? '');
    }
    ref.changeDetectorRef.detectChanges();
    updateTailAvatar(nextItem.data as ChatMsgData);
    applyGroupPosition(ref.location.nativeElement, flags.groupPosition);
    interactionItem = nextItem;
    interactionIsShowHead = flags.isShowHead;
    if (selectionHost) {
      applySelectionMetadata(selectionHost, nextItem);
      applyAvatarOffset(selectionHost, flags.showDate, flags.isGroupStart);
    }
  };

  const updateNext = (nextItem: CbItem<ChatItemData> | null): void => {
    interactionNext = nextItem;
    applyGroupPosition(
      ref.location.nativeElement,
      groupPositionFrom(interactionIsShowHead, interactionItem, nextItem),
    );
  };

  let measuredHost: HTMLElement | undefined;
  if (unreadDividerLabel) {
    const wrapper = document.createElement('div');
    wrapper.className = 'cb-unread-entry';
    const divider = document.createElement('div');
    divider.className = 'cb-unread-divider';
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-label', unreadDividerLabel);
    const label = document.createElement('span');
    label.textContent = unreadDividerLabel;
    divider.appendChild(label);
    wrapper.append(divider, ref.location.nativeElement);
    measuredHost = wrapper;
  }
  const el = wrapEl(ref, update, updateNext, measuredHost, () => {
    appRef.detachView(tailAvatarRef.hostView);
    tailAvatarRef.destroy();
    appRef.detachView(ref.hostView);
  });
  selectionHost = el.el;
  applySelectionMetadata(el.el, item);
  applyAvatarOffset(el.el, showDate, isGroupStart);
  if (data.contentType === 'FORWARD' && onOpenForward) {
    const openForward = (event: MouseEvent): void => {
      if (
        el.el.classList.contains('cb-message--selection-mode') ||
        !(event.target as Element | null)?.closest(
          '.forward-card:not(:disabled)',
        )
      )
        return;
      const current = interactionItem.data as ChatMsgData;
      const bundleId = parseForwardCard(current.text)?.bundleId;
      if (bundleId) onOpenForward(bundleId);
    };
    el.el.addEventListener('click', openForward);
    const baseDestroy = el.destroy;
    el.destroy = () => {
      el.el.removeEventListener('click', openForward);
      baseDestroy();
    };
  }
  if (onInteraction) {
    let longPressTimer: ReturnType<typeof setTimeout> | undefined;
    const pressGesture = new MessagePressGesture();
    let pointerStart: { x: number; y: number } | undefined;
    let pressedMemberId: number | undefined;
    const mediaMemberIdAt = (
      target: EventTarget | null,
    ): number | undefined => {
      if ((interactionItem.ids?.length ?? 0) < 2) return undefined;
      const cell = (target as Element | null)?.closest<HTMLElement>(
        '.msg-media-cell[data-media-message-id]',
      );
      const memberId = cell ? Number(cell.dataset['mediaMessageId']) : NaN;
      return Number.isFinite(memberId) ? memberId : undefined;
    };
    const clearPressVisual = (): void => {
      if (longPressTimer !== undefined) clearTimeout(longPressTimer);
      longPressTimer = undefined;
      el.el.classList.remove('cb-message--pressing');
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target as Element | null)?.closest('.msg-bubble')) return;
      pressGesture.beginPointer(event.button === 0);
      if (event.button !== 0) {
        if (event.button === 2) el.el.classList.add('cb-message--pressing');
        return;
      }
      pointerStart = { x: event.clientX, y: event.clientY };
      pressedMemberId = mediaMemberIdAt(event.target);
      el.el.classList.add('cb-message--pressing');
      if (event.pointerType === 'mouse') return;
      longPressTimer = setTimeout(() => {
        longPressTimer = undefined;
        if (pressGesture.commitLongPress())
          onInteraction(
            'open-menu',
            interactionItem,
            pointerStart,
            pressedMemberId,
          );
      }, 500);
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (
        pointerStart &&
        Math.hypot(
          event.clientX - pointerStart.x,
          event.clientY - pointerStart.y,
        ) > 8
      ) {
        clearPressVisual();
        pressGesture.cancelPointer();
      }
    };
    const onPointerEnd = (): void => {
      clearPressVisual();
      pressGesture.endPointer();
    };
    const onClick = (event: MouseEvent): void => {
      if (pressGesture.shouldSuppressSynthetic()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (el.el.classList.contains('cb-message--selection-mode')) {
        event.preventDefault();
        event.stopPropagation();
        const cell = (event.target as Element | null)?.closest<HTMLElement>(
          '.msg-media-cell[data-media-message-id]',
        );
        const memberId =
          (interactionItem.ids?.length ?? 0) > 1 && cell
            ? Number(cell.dataset['mediaMessageId'])
            : undefined;
        onInteraction('select', interactionItem, undefined, memberId);
      }
    };
    const onContextMenu = (event: MouseEvent): void => {
      clearPressVisual();
      if (!(event.target as Element | null)?.closest('.msg-bubble')) return;
      event.preventDefault();
      if (pressGesture.shouldSuppressSynthetic()) {
        event.stopPropagation();
        return;
      }
      onInteraction(
        'open-menu',
        interactionItem,
        { x: event.clientX, y: event.clientY },
        mediaMemberIdAt(event.target),
      );
    };
    el.el.addEventListener('pointerdown', onPointerDown);
    el.el.addEventListener('pointerup', onPointerEnd);
    el.el.addEventListener('pointercancel', onPointerEnd);
    el.el.addEventListener('pointermove', onPointerMove);
    el.el.addEventListener('click', onClick, true);
    el.el.addEventListener('contextmenu', onContextMenu);
    const baseDestroy = el.destroy;
    el.destroy = () => {
      clearPressVisual();
      el.el.removeEventListener('pointerdown', onPointerDown);
      el.el.removeEventListener('pointerup', onPointerEnd);
      el.el.removeEventListener('pointercancel', onPointerEnd);
      el.el.removeEventListener('pointermove', onPointerMove);
      el.el.removeEventListener('click', onClick, true);
      el.el.removeEventListener('contextmenu', onContextMenu);
      baseDestroy();
    };
  }
  // Wire optional row outputs (failed-send retry on TextRow; open-image on MediaRow). Each subscription is released on
  // destroy so re-rendering the row (rebuildEntry) or unmounting it does not leak a handler. Several outputs may compose
  // on one entry — wrapDestroy chains them LIFO into a single destroy().
  const wrapDestroy = (extra: () => void): void => {
    const base = el.destroy;
    el.destroy = () => {
      extra();
      base();
    };
  };
  if (comp === TextRowComponent && onQuoteJump) {
    const sub = (ref.instance as TextRowComponent).quoteJump.subscribe(
      onQuoteJump,
    );
    wrapDestroy(() => sub.unsubscribe());
  }
  if (onRetry) {
    // The row's retry output is a click SIGNAL only (its emitted value is the numeric msgId, which for a failed
    // optimistic bubble is a placeholder — not the correlation key). The kernel reconciles retries by the stable
    // clientMessageId on the CbItem (retryPending matches on it), so map the click to item.clientMessageId, which
    // is stable across the failed→sending in-place morph.
    const inst = ref.instance as {
      retry?: {
        subscribe: (fn: (id: number) => void) => { unsubscribe(): void };
      };
    };
    const cid = item.clientMessageId;
    const sub = inst.retry?.subscribe(() => {
      if (cid !== undefined) onRetry(cid);
    });
    if (sub) wrapDestroy(() => sub.unsubscribe());
  }
  if (onCancel) {
    const inst = ref.instance as {
      cancel?: {
        subscribe: (fn: (id: number) => void) => { unsubscribe(): void };
      };
    };
    const cid = item.clientMessageId;
    const sub = inst.cancel?.subscribe(() => {
      if (cid !== undefined) onCancel(cid);
    });
    if (sub) wrapDestroy(() => sub.unsubscribe());
  }
  if (onOpenImage) {
    const inst = ref.instance as {
      openImage?: {
        subscribe: (
          fn: (p: { images: AlbumImage[]; index: number }) => void,
        ) => { unsubscribe(): void };
      };
    };
    const sub = inst.openImage?.subscribe((p) =>
      onOpenImage(p.images, p.index),
    );
    if (sub) wrapDestroy(() => sub.unsubscribe());
  }
  if (onOpenFile) {
    const inst = ref.instance as {
      openFile?: { subscribe: (fn: () => void) => { unsubscribe(): void } };
    };
    const sub = inst.openFile?.subscribe(() => onOpenFile(data));
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
function wrapEl<T>(
  ref: { location: { nativeElement: HTMLElement }; destroy: () => void },
  update: (item: CbItem<T>, prev: CbItem<T> | null) => void,
  updateNext: (next: CbItem<T> | null) => void,
  measuredHost?: HTMLElement,
  beforeDestroy?: () => void,
): CbElement<T> {
  const el = measuredHost ?? ref.location.nativeElement;
  applyMessageListItemSemantics(el);
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
    updateNext,
    destroy: () => {
      ro?.disconnect();
      ro = null;
      live = null;
      beforeDestroy?.();
      ref.destroy();
    },
  };
}

/** Message rows are virtualized, so expose the mounted window as a plain list rather than a live log.
 *  A live region would re-announce historical rows whenever the window remounts while scrolling. */
export function applyMessageListItemSemantics(el: HTMLElement): void {
  el.setAttribute('role', 'listitem');
}
