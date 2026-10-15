import {
  ChangeDetectorRef,
  Component,
  inject,
  OnDestroy,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import {
  pickStickyDateLabel,
  stickyDateRowOpacity,
  STICKY_DATE_COLLISION_BOTTOM_PX,
  STICKY_DATE_COLLISION_TOP_PX,
  STICKY_DATE_PICK_FUZZ_PX,
  unreadDividerOverlapsStickyDate,
  UNREAD_DIVIDER_HEIGHT_PX,
  DATE_SEPARATOR_TOP_INSET_PX,
} from '../../../lib/sticky-date';
import {
  resolveStickyAvatar,
  type StickyAvatarResolution,
  type StickyAvatarView,
} from '../../../lib/sticky-avatar';
import type { ScrollerApi } from '../../../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from '../chat-item';
import { StickyAvatarOverlayComponent } from '../sticky-avatar-overlay/sticky-avatar-overlay.component';
import { StickyDateOverlayComponent } from '../sticky-date-overlay/sticky-date-overlay.component';

export interface ChatboxStickyOverlayElements {
  readonly viewport: HTMLElement;
  readonly content: HTMLElement;
  readonly header?: HTMLElement;
  readonly container: HTMLElement;
  readonly scroller: ScrollerApi<ChatItemData>;
}

/**
 * The single sticky-overlay controller used by every chatbox host. It owns both DOM measurements and both
 * paints, leaving production and playground responsible only for supplying their shell elements.
 */
@Component({
  selector: 'app-chatbox-sticky-overlays',
  standalone: true,
  imports: [StickyDateOverlayComponent, StickyAvatarOverlayComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-sticky-date-overlay [label]="date()" />
    <app-sticky-avatar-overlay [avatar]="avatar()" />
  `,
})
export class ChatboxStickyOverlaysComponent implements OnDestroy {
  private readonly cdr = inject(ChangeDetectorRef);
  readonly date = signal<string | null>(null);
  readonly avatar = signal<StickyAvatarView | null>(null);
  private content?: HTMLElement;
  private hiddenAvatarHead?: HTMLElement;
  private visibleAvatarTail?: HTMLElement;
  private observed?: ChatboxStickyOverlayElements;
  private layout?: {
    visibleTop: number;
    viewportTop: number;
    containerTop: number;
  };
  private readonly layoutObserver = new ResizeObserver(() => {
    this.layout = undefined;
  });

  refresh(
    elements: ChatboxStickyOverlayElements,
    showSelfAvatar: boolean,
  ): void {
    const { viewport, content, header, container, scroller } = elements;
    this.content = content;
    this.observeLayout(elements);
    const { visibleTop, viewportTop, containerTop } =
      this.layout ?? this.measureLayout(elements);
    const rows: import('../../../lib/sticky-avatar').StickyAvatarMeasuredRow[] =
      [];
    const dates: Array<{
      element: HTMLElement;
      top: number;
      label: string | null;
    }> = [];
    let unreadDividerInterval: { top: number; bottom: number } | null = null;
    let ghostBottom: number | null = null;
    scroller.visitMountedGeometry((geometry) => {
      const host = geometry.el;
      const top = viewportTop + geometry.top;
      const bottom = viewportTop + geometry.bottom;
      const naturalAvatar = host.querySelector<HTMLElement>(
        '.msg-has-avatar > .msg-avatar:not(.msg-avatar-tail)',
      );
      const tailAvatar = host.querySelector<HTMLElement>('.msg-avatar-tail');
      const identity = host.dataset['messageAvatarIdentity'];
      if (host.dataset['messageCreator'] !== undefined) {
        const naturalOffset = Number(
          host.dataset['messageNaturalAvatarOffset'] ?? '0',
        );
        rows.push({
          creator: host.dataset['messageCreator'] ?? '',
          side: host.dataset['messageSide'] === 'self' ? 'self' : 'other',
          top,
          bottom,
          hasNaturalAvatar: naturalAvatar !== null,
          naturalAvatarTop: naturalAvatar ? top + naturalOffset : undefined,
          naturalAvatar: naturalAvatar ?? undefined,
          tailAvatar: tailAvatar ?? undefined,
          name: host.dataset['messageAvatarName'] ?? '',
          avatarProfile: host.dataset['messageAvatarEvidence']
            ? JSON.parse(host.dataset['messageAvatarEvidence'])
            : undefined,
          snapshotAvatarUrl: host.dataset['messageSnapshotAvatarUrl'],
          account: host.dataset['messageAvatarAccount'] || undefined,
          identityId: identity,
          domain: host.dataset['messageAvatarDomain'] || undefined,
          domainSource: host.dataset['messageAvatarDomainSource']
            ? JSON.parse(host.dataset['messageAvatarDomainSource'])
            : undefined,
        });
      }
      const date = host.querySelector<HTMLElement>('.msg-date');
      if (date)
        dates.push({
          element: date,
          top:
            top +
            (host.classList.contains('cb-unread-entry')
              ? UNREAD_DIVIDER_HEIGHT_PX
              : 0) +
            DATE_SEPARATOR_TOP_INSET_PX,
          label: date.textContent?.trim() ?? null,
        });
      if (host.classList.contains('cb-unread-entry'))
        unreadDividerInterval = {
          top,
          bottom: top + UNREAD_DIVIDER_HEIGHT_PX,
        };
      if (host.classList.contains('cb-ghost-loading')) ghostBottom = bottom;
    });
    this.refreshDate(dates, visibleTop, unreadDividerInterval, ghostBottom);
    const resolution = resolveStickyAvatar(
      rows,
      visibleTop + 12,
      containerTop,
      showSelfAvatar,
    );
    const nextAvatar = resolution.view;
    const currentAvatar = this.avatar();
    if (!sameStickyAvatar(currentAvatar, nextAvatar)) {
      this.avatar.set(nextAvatar);
      // The natural head/tail classes below are direct, synchronous DOM writes. Commit the overlay input
      // first as well; otherwise head→fixed hides the natural avatar one Angular render before the fixed
      // copy appears (the reverse direction merely overlaps, which is why the bug was direction-specific).
      this.cdr.detectChanges();
    }
    this.applyAvatarHandoff(resolution);
  }

  clear(): void {
    this.date.set(null);
    this.avatar.set(null);
    this.content
      ?.querySelectorAll<HTMLElement>('.msg-date')
      .forEach((element) => (element.style.opacity = '1'));
    this.hiddenAvatarHead?.classList.remove('cb-sticky-avatar-source');
    this.visibleAvatarTail?.classList.remove('cb-sticky-avatar-tail-visible');
    this.hiddenAvatarHead = undefined;
    this.visibleAvatarTail = undefined;
    this.content = undefined;
    this.observed = undefined;
    this.layout = undefined;
    this.layoutObserver.disconnect();
  }

  invalidateLayout(): void {
    this.layout = undefined;
  }

  ngOnDestroy(): void {
    this.hiddenAvatarHead?.classList.remove('cb-sticky-avatar-source');
    this.visibleAvatarTail?.classList.remove('cb-sticky-avatar-tail-visible');
    this.layoutObserver.disconnect();
  }

  private applyAvatarHandoff(resolution: StickyAvatarResolution): void {
    const nextHead = resolution.hiddenHead;
    const nextTail = resolution.visibleTail;
    if (nextHead !== this.hiddenAvatarHead) {
      nextHead?.classList.add('cb-sticky-avatar-source');
      this.hiddenAvatarHead?.classList.remove('cb-sticky-avatar-source');
      this.hiddenAvatarHead = nextHead;
    }
    if (nextTail !== this.visibleAvatarTail) {
      nextTail?.classList.add('cb-sticky-avatar-tail-visible');
      this.visibleAvatarTail?.classList.remove('cb-sticky-avatar-tail-visible');
      this.visibleAvatarTail = nextTail;
    }
  }

  private observeLayout(elements: ChatboxStickyOverlayElements): void {
    if (
      this.observed?.viewport === elements.viewport &&
      this.observed?.container === elements.container &&
      this.observed?.header === elements.header
    )
      return;
    this.layoutObserver.disconnect();
    this.layoutObserver.observe(elements.viewport);
    this.layoutObserver.observe(elements.container);
    if (elements.header) this.layoutObserver.observe(elements.header);
    this.observed = elements;
    this.layout = undefined;
  }

  private measureLayout(elements: ChatboxStickyOverlayElements): {
    visibleTop: number;
    viewportTop: number;
    containerTop: number;
  } {
    const viewportTop = elements.viewport.getBoundingClientRect().top;
    const measured = {
      visibleTop:
        elements.header?.getBoundingClientRect().bottom ?? viewportTop,
      viewportTop,
      containerTop: elements.container.getBoundingClientRect().top,
    };
    this.layout = measured;
    return measured;
  }

  private refreshDate(
    rows: Array<{ element: HTMLElement; top: number; label: string | null }>,
    visibleTop: number,
    unreadDivider: { top: number; bottom: number } | null,
    ghostBottom: number | null,
  ): void {
    const obstructed =
      unreadDividerOverlapsStickyDate(unreadDivider, visibleTop) ||
      (ghostBottom ?? -Infinity) > visibleTop;
    const current = obstructed
      ? null
      : pickStickyDateLabel(rows, visibleTop, STICKY_DATE_PICK_FUZZ_PX);
    this.date.set(current);
    const fadeLo = visibleTop + STICKY_DATE_COLLISION_TOP_PX;
    const fadeHi = visibleTop + STICKY_DATE_COLLISION_BOTTOM_PX;
    for (const { element, top } of rows) {
      element.style.opacity = stickyDateRowOpacity(
        top,
        fadeLo,
        fadeHi,
        current !== null,
      ).toFixed(2);
    }
  }
}

function sameStickyAvatar(
  a: StickyAvatarView | null,
  b: StickyAvatarView | null,
): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.name === b.name &&
      JSON.stringify(a.avatarProfile) === JSON.stringify(b.avatarProfile) &&
      a.snapshotAvatarUrl === b.snapshotAvatarUrl &&
      a.identityId === b.identityId &&
      a.account === b.account &&
      a.domain === b.domain &&
      JSON.stringify(a.domainSource) === JSON.stringify(b.domainSource) &&
      a.side === b.side &&
      a.top === b.top)
  );
}
