import {
  ApplicationRef,
  ComponentRef,
  createComponent,
  EnvironmentInjector,
  InputSignal,
  Injector,
  Type,
  signal,
} from '@angular/core';
import { BehaviorSubject, distinctUntilChanged, switchMap } from 'rxjs';
import { messageSenderKey } from './message-sender';
import type { CbElement, CbItem } from '../../lib/chat-box/chat-box-scroller';
import {
  classifyGroupFlags,
  type GroupCtx,
} from '../../lib/chat-box/group-logic';
import { shouldShowDateSeparator } from './date-format';
import type { ChatItemData, ChatMsgData, AlbumMedia } from './chat-item';
import { FileRowComponent } from './file-row/file-row.component';
import { LinkRowComponent } from './link-row/link-row.component';
import { ContactCardRowComponent } from './contact-card-row/contact-card-row.component';
import { ForwardRowComponent } from './forward-row/forward-row.component';
import { MediaRowComponent } from './media-row/media-row.component';
import { TextRowComponent } from './text-row/text-row.component';
import { SystemRowComponent } from './system-row/system-row.component';
import { MessagePressGesture } from './message-press-gesture';
import { parseForwardCard } from './forward-row/forward-card';
import { writeStickyAvatarIdentity } from '../../lib/sticky-avatar';
import { AvatarComponent } from '../user-avatar/avatar.component';
import { UserAvatarType } from '../user-avatar/model';
import type { AvatarView } from '../user-avatar/avatar-view';
import { MessageSenderService } from './message-sender.service';
import { AvatarPresentationService } from '../user-avatar/avatar-presentation.service';
import { CbItemLifetime } from '../../lib/chat-box/cb-item-lifetime';

/**
 * Read-only shape shared by dynamically selected rows. Each row may accept a narrower
 * message input; consumers here only read it, while Angular owns input binding.
 */
interface RowComponent {
  data: () => ChatMsgData;
  isShowHead: InputSignal<boolean>;
  isGroupStart: InputSignal<boolean>;
  showDate: InputSignal<boolean>;
  quoteJump?: import('@angular/core').OutputEmitterRef<
    import('../../services/history-anchor').HistoryAnchor
  >;
}

interface BoundRow {
  ref: ComponentRef<RowComponent>;
  bindData(message: ChatMsgData): void;
}

/** Keep Angular's string-keyed input write behind a checked, typed boundary. */
function createBoundRow<D extends ChatMsgData>(
  component: Type<RowComponent & { data: InputSignal<D> }>,
  decode: (message: ChatMsgData) => NoInfer<D>,
  initial: ChatMsgData,
  environmentInjector: EnvironmentInjector,
  elementInjector: Injector,
): BoundRow {
  const value = decode(initial);
  const ref = createComponent(component, { environmentInjector, elementInjector });
  const bindData = (message: ChatMsgData) =>
    ref.setInput('data', decode(message));
  ref.setInput('data', value);
  return { ref, bindData };
}

function createMessageRow(
  data: ChatMsgData,
  injector: EnvironmentInjector,
  elementInjector: Injector,
): BoundRow {
  switch (data.contentType) {
    case 'IMAGE':
    case 'VIDEO':
    case 'AUDIO':
    case 'GALLERY':
      return createBoundRow(
        MediaRowComponent,
        (message) => {
          if (message.images === null)
            throw new Error('Media row requires media content');
          return message;
        },
        data,
        injector,
        elementInjector,
      );
    case 'FILE':
      return createBoundRow(
        FileRowComponent,
        (message) => {
          if (message.contentType !== 'FILE')
            throw new Error('File row requires FILE content');
          return message;
        },
        data,
        injector,
        elementInjector,
      );
    case 'PURE_TEXT':
      return createBoundRow(
        TextRowComponent,
        (message) => {
          if (message.contentType !== 'PURE_TEXT')
            throw new Error('Message row content type changed');
          return message;
        },
        data,
        injector,
        elementInjector,
      );
    case 'LINK':
      return createBoundRow(
        LinkRowComponent,
        (message) => {
          if (message.contentType !== 'LINK')
            throw new Error('Link row requires LINK content');
          return message;
        },
        data,
        injector,
        elementInjector,
      );
    case 'CONTACT_CARD':
      return createBoundRow(
        ContactCardRowComponent,
        (message) => {
          if (message.contentType !== 'CONTACT_CARD')
            throw new Error('Contact row requires CONTACT_CARD content');
          return message;
        },
        data,
        injector,
        elementInjector,
      );
    case 'FORWARD':
      return createBoundRow(
        ForwardRowComponent,
        (message) => {
          if (message.contentType !== 'FORWARD')
            throw new Error('Forward row requires FORWARD content');
          return message;
        },
        data,
        injector,
        elementInjector,
      );
    case 'SYSTEM':
      return createBoundRow(
        SystemRowComponent,
        (message) => {
          if (message.contentType !== 'SYSTEM')
            throw new Error('System row requires SYSTEM content');
          return message;
        },
        data,
        injector,
        elementInjector,
      );
  }
}

const DATE_SEPARATOR_HEIGHT_PX = 47;
const MESSAGE_ITEM_TOP_GAP_PX = 6;
const MESSAGE_GROUP_TOP_GAP_PX = 14;
const UNREAD_DIVIDER_HEIGHT_PX = 38;

/** Only plain text participates in a compact run; every non-text message is a standalone timeline block. */
function participatesInSenderGroup(message: ChatMsgData): boolean {
  return message.contentType === 'PURE_TEXT';
}

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
  let isShowHead = item.data.type === 'msg';
  let isGroupStart = false;
  let showDate = false;
  let groupPosition: 'single' | 'head' | 'body' | 'tail' = 'single';
  if (item.data.type === 'msg') {
    const msg = item.data;
    // A SYSTEM row is timeline chrome, not part of a sender's message run. Treat it as a hard grouping
    // boundary so the first real message after a fresh-chat notice renders its avatar and sender name,
    // even when the system event happens to carry the same creator id.
    const prevMsg = prev?.data.type === 'msg' ? prev.data : null;
    const curCtx: GroupCtx = { creator: msg.creator };
    const prevCtx: GroupCtx | null =
      prevMsg &&
      !item.groupingBreakBefore &&
      participatesInSenderGroup(prevMsg) &&
      participatesInSenderGroup(msg)
        ? { creator: prevMsg.creator }
        : null;
    const nextMsg = next?.data.type === 'msg' ? next.data : null;
    const nextCtx: GroupCtx | null =
      nextMsg &&
      !next?.groupingBreakBefore &&
      participatesInSenderGroup(msg) &&
      participatesInSenderGroup(nextMsg)
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
  }
  // Date context survives a mounted message's anonymous deletion replacement.
  // It uses only that original message's timestamp, never persisted deletion stubs.
  if (item.data.type !== 'serverGap') {
    showDate = shouldShowDateSeparator(
      prev && prev.data.type !== 'serverGap' ? prev.data.createdAtMs : null,
      item.data.createdAtMs,
      item.boundary === 'oldest' || item.boundary === 'both',
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
    participatesInSenderGroup(item.data) &&
    next?.data.type === 'msg' &&
    !next.groupingBreakBefore &&
    participatesInSenderGroup(next.data) &&
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
 * date was moved out of the data source: the source returns timeline rows; the date separator is derived
 * per-day by the createItem factory and passed in as dateLabel, rendered conditionally at the top of the
 * message component template (see date-format.ts).
 *
 * Height contract (cb-element-border-box memory): components must be border-box with vertical spacing via
 * padding (offsetHeight excludes margin). This factory does NOT estimate height — the kernel's createEntry
 * mounts with height=0 (hidden for one frame via .cb-pending), and measurePending reads the real
 * el.offsetHeight synchronously to settle it. Later layout changes must be submitted through
 * the active layout-request contract before mutating the rendered content.
 */
export function createMsgCbElement(
  item: CbItem<ChatItemData>,
  isShowHead: boolean,
  isGroupStart: boolean,
  showDate: boolean,
  envInjector: EnvironmentInjector,
  onOpenImage?: (images: AlbumMedia[], index: number) => void,
  onOpenFile?: (data: ChatMsgData) => void,
  unreadDividerLabel?: string,
  onInteraction?: (
    intent: 'select' | 'open-menu',
    item: CbItem<ChatItemData>,
    pointer?: { x: number; y: number },
    memberId?: number,
  ) => void,
  onOpenForward?: (bundleId: string) => void,
  onQuoteJump?: (
    anchor: import('../../services/history-anchor').HistoryAnchor,
  ) => void,
  onOpenMemberProfile?: (
    profile:
      | import('../../services/avatar-profile-ref').AvatarProfileRef
      | undefined,
    anchor: DOMRect,
  ) => void,
): CbElement<ChatItemData> {
  if (item.data.type === 'serverGap')
    throw new Error('server-gap item must use createServerGapCbElement');
  const data = item.data;
  const lifetime = new CbItemLifetime();
  const elementInjector = Injector.create({
    providers: [{ provide: CbItemLifetime, useValue: lifetime }],
    parent: envInjector,
  });
  const { ref, bindData } = createMessageRow(data, envInjector, elementInjector);
  lifetime.onDestroy(() => ref.destroy());
  lifetime.onDestroy(() => elementInjector.destroy());
  lifetime.onPredestory(() => ref.changeDetectorRef.detach());
  // createComponent() only constructs the view; it does not enroll it in Angular's application view
  // tree. Message rows contain async, signal-driven children (including sender presentation, whose profile
  // bytes resolve after the first render), so leaving the host view detached freezes those children at
  // their initial fallback until some unrelated scroller update happens to call detectChanges().
  const appRef = envInjector.get(ApplicationRef);
  appRef.attachView(ref.hostView);
  ref.setInput('isShowHead', isShowHead);
  ref.setInput('isGroupStart', isGroupStart);
  ref.setInput('showDate', showDate);
  ref.changeDetectorRef.detectChanges(); // zoneless: drive the first render manually (triggers ngOnInit)
  applyGroupPosition(
    ref.location.nativeElement,
    isShowHead ? 'single' : 'tail',
  );

  // Every message keeps a pre-mounted tail avatar. The sticky controller reveals only the tail of the
  // active sender group at the exact fixed-avatar handoff; keeping the image component alive makes the
  // reverse (above→viewport) handoff synchronous as well.
  const tailAvatarRef = createComponent(AvatarComponent, {
    environmentInjector: envInjector,
    elementInjector,
  });
  lifetime.onDestroy(() => tailAvatarRef.destroy());
  lifetime.onPredestory(() => tailAvatarRef.changeDetectorRef.detach());
  appRef.attachView(tailAvatarRef.hostView);
  const tailAvatar = document.createElement('div');
  tailAvatar.className = 'msg-avatar msg-avatar-tail';
  tailAvatar.appendChild(tailAvatarRef.location.nativeElement);
  (ref.location.nativeElement as HTMLElement)
    .querySelector<HTMLElement>('.msg-row')
    ?.appendChild(tailAvatar);
  const senderView = signal<AvatarView>({
    name: data.name,
    imageUrl: null,
    type: data.isSelf ? UserAvatarType.SELF : UserAvatarType.OTHER,
  });
  const senderMessages = new BehaviorSubject(data);
  const updateSenderView = (view: AvatarView): void => {
    if (!lifetime.active) return;
    senderView.set(view);
    if (data.type !== 'system') ref.setInput('senderView', view);
    tailAvatarRef.setInput('view', view);
    ref.changeDetectorRef.detectChanges();
    tailAvatarRef.changeDetectorRef.detectChanges();
  };
  updateSenderView(senderView());

  // In-place re-render (CbElement.update): recompute grouping + date from the (possibly new) prev and re-apply all four
  // signal inputs on the SAME component instance + DOM node, then drive change detection synchronously so the kernel's
  // immediate offsetHeight read reflects the new content. Regroup after a reorder without remounting,
  // which would break an active FLIP move animation.
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
        presentation: senderView,
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
    if (!lifetime.active) return;
    if (nextItem.data.type === 'serverGap')
      throw new Error('message renderer cannot update to a server-gap item');
    const flags = computeRowFlags(nextItem, nextPrev, interactionNext);
    bindData(nextItem.data);
    ref.setInput('isShowHead', flags.isShowHead);
    ref.setInput('isGroupStart', flags.isGroupStart);
    ref.setInput('showDate', flags.showDate);
    senderMessages.next(nextItem.data as ChatMsgData);
    ref.changeDetectorRef.detectChanges();
    applyGroupPosition(ref.location.nativeElement, flags.groupPosition);
    interactionItem = nextItem;
    interactionIsShowHead = flags.isShowHead;
    if (selectionHost) {
      applySelectionMetadata(selectionHost, nextItem);
      applyAvatarOffset(selectionHost, flags.showDate, flags.isGroupStart);
    }
  };

  const updateNext = (nextItem: CbItem<ChatItemData> | null): void => {
    if (!lifetime.active) return;
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
  const senderSubscription = senderMessages
    .pipe(
      distinctUntilChanged(
        (previous, next) =>
          messageSenderKey(previous) === messageSenderKey(next),
      ),
      switchMap((message) => {
        // A new subject clears the old presentation synchronously, even while resolution is pending.
        updateSenderView({
          name: message.name,
          imageUrl: null,
          type: message.isSelf ? UserAvatarType.SELF : UserAvatarType.OTHER,
        });
        return envInjector.get(MessageSenderService).resolve(message);
      }),
    )
    .subscribe(updateSenderView);
  lifetime.onPredestory(() => {
    // Live avatar observation owns its URL lease. Retain only the painted bytes
    // before releasing that observer; no profile transport stays alive for exit.
    lifetime.onDestroy(
      envInjector.get(AvatarPresentationService).retainImage(senderView()),
    );
  });
  lifetime.onPredestory(() => senderSubscription.unsubscribe());
  lifetime.onPredestory(() => senderMessages.complete());
  const el = wrapEl(ref, lifetime, update, updateNext, measuredHost);
  selectionHost = el.el;
  applySelectionMetadata(el.el, item);
  applyAvatarOffset(el.el, showDate, isGroupStart);
  if (onOpenMemberProfile) {
    const openMemberProfile = (event: MouseEvent): void => {
      const avatar = (event.target as Element | null)?.closest<HTMLElement>(
        '.msg-avatar:not(.msg-avatar-tail)',
      );
      const current = interactionItem.data as ChatMsgData;
      if (!avatar || current.type !== 'msg') return;
      event.preventDefault();
      event.stopPropagation();
      onOpenMemberProfile(
        current.sender?.kind === 'demand' ? current.sender.profile : undefined,
        avatar.getBoundingClientRect(),
      );
    };
    el.el.addEventListener('click', openMemberProfile);
    lifetime.onPredestory(() => {
      el.el.removeEventListener('click', openMemberProfile);
    });
  }
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
    lifetime.onPredestory(() => {
      el.el.removeEventListener('click', openForward);
    });
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
    lifetime.onPredestory(() => {
      clearPressVisual();
      el.el.removeEventListener('pointerdown', onPointerDown);
      el.el.removeEventListener('pointerup', onPointerEnd);
      el.el.removeEventListener('pointercancel', onPointerEnd);
      el.el.removeEventListener('pointermove', onPointerMove);
      el.el.removeEventListener('click', onClick, true);
      el.el.removeEventListener('contextmenu', onContextMenu);
    });
  }
  // Row navigation ends before exit, not when Angular finally removes the view.
  const wrapDestroy = (extra: () => void): void => {
    lifetime.onPredestory(extra);
  };
  if (ref.instance.quoteJump && onQuoteJump) {
    const sub = ref.instance.quoteJump.subscribe(onQuoteJump);
    wrapDestroy(() => sub.unsubscribe());
  }
  if (onOpenImage) {
    const inst = ref.instance as {
      openImage?: {
        subscribe: (
          fn: (p: { images: AlbumMedia[]; index: number }) => void,
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
    const sub = inst.openFile?.subscribe(() => onOpenFile(data as ChatMsgData));
    if (sub) wrapDestroy(() => sub.unsubscribe());
  }
  return el;
}

/**
 * Own the rendered component lifetime. Initial and explicit updates are measured synchronously.
 * Subsequent layout mutations must request a kernel transaction before changing the DOM;
 * there is deliberately no passive height-observation fallback.
 */
function wrapEl<T>(
  ref: { location: { nativeElement: HTMLElement }; destroy: () => void },
  lifetime: CbItemLifetime,
  update: (item: CbItem<T>, prev: CbItem<T> | null) => void,
  updateNext: (next: CbItem<T> | null) => void,
  measuredHost?: HTMLElement,
): CbElement<T> {
  const el = measuredHost ?? ref.location.nativeElement;
  applyMessageListItemSemantics(el);
  lifetime.onPredestory(() => {
    el.inert = true;
    el.setAttribute('aria-hidden', 'true');
  });
  lifetime.onDestroy(() => el.remove());
  return {
    el,
    update,
    updateNext,
    predestory: () => lifetime.predestory(),
    destroy: () => lifetime.destroy(),
  };
}

/** Message rows are virtualized, so expose the mounted window as a plain list rather than a live log.
 *  A live region would re-announce historical rows whenever the window remounts while scrolling. */
export function applyMessageListItemSemantics(el: HTMLElement): void {
  el.setAttribute('role', 'listitem');
}

/** Render a persisted server-gap range as one non-message timeline row. The jagged center seam is
 * CSS-only; the range remains repository state and this DOM projection is intentionally transient. */
export function createServerGapCbElement(
  item: CbItem<ChatItemData>,
  label: string,
): CbElement<ChatItemData> {
  if (item.data.type !== 'serverGap')
    throw new Error('server-gap renderer received a message item');
  const host = document.createElement('div');
  host.className = `cb-server-gap cb-server-gap--${item.data.state === 'SERVER_PENDING' ? 'pending' : 'unavailable'}`;
  const rule = document.createElement('span');
  rule.className = 'cb-server-gap__rule';
  const text = document.createElement('span');
  text.className = 'cb-server-gap__label';
  text.textContent = label;
  host.append(rule, text);
  applyMessageListItemSemantics(host);
  return {
    el: host,
    update: () => {},
    updateNext: () => {},
    predestory: () => {},
    destroy: () => {},
  };
}
