import { Component, signal } from '@angular/core';
import {
  pickStickyDateLabel,
  stickyDateRowOpacity,
  STICKY_DATE_COLLISION_BOTTOM_PX,
  STICKY_DATE_COLLISION_TOP_PX,
  STICKY_DATE_PICK_FUZZ_PX,
  unreadDividerOverlapsStickyDate,
} from '../../../lib/sticky-date';
import {
  resolveStickyAvatar,
  type StickyAvatarView,
} from '../../../lib/sticky-avatar';
import { StickyAvatarOverlayComponent } from '../sticky-avatar-overlay/sticky-avatar-overlay.component';
import { StickyDateOverlayComponent } from '../sticky-date-overlay/sticky-date-overlay.component';

export interface ChatboxStickyOverlayElements {
  readonly viewport: HTMLElement;
  readonly content: HTMLElement;
  readonly header?: HTMLElement;
  readonly container: HTMLElement;
}

/**
 * The single sticky-overlay controller used by every chatbox host. It owns both DOM measurements and both
 * paints, leaving production and playground responsible only for supplying their shell elements.
 */
@Component({
  selector: 'app-chatbox-sticky-overlays',
  standalone: true,
  imports: [StickyDateOverlayComponent, StickyAvatarOverlayComponent],
  template: `
    <app-sticky-date-overlay [label]="date()" />
    <app-sticky-avatar-overlay [avatar]="avatar()" />
  `,
})
export class ChatboxStickyOverlaysComponent {
  readonly date = signal<string | null>(null);
  readonly avatar = signal<StickyAvatarView | null>(null);
  private content?: HTMLElement;

  refresh(
    elements: ChatboxStickyOverlayElements,
    showSelfAvatar: boolean,
  ): void {
    const { viewport, content, header, container } = elements;
    this.content = content;
    const visibleTop =
      header?.getBoundingClientRect().bottom ??
      viewport.getBoundingClientRect().top;
    this.refreshDate(content, visibleTop);
    this.avatar.set(
      resolveStickyAvatar(
        content,
        visibleTop,
        container.getBoundingClientRect().top,
        showSelfAvatar,
      ),
    );
  }

  clear(): void {
    this.date.set(null);
    this.avatar.set(null);
    this.content
      ?.querySelectorAll<HTMLElement>('.msg-date')
      .forEach((element) => (element.style.opacity = '1'));
    this.content
      ?.querySelectorAll<HTMLElement>('.cb-sticky-avatar-source')
      .forEach((avatar) => avatar.classList.remove('cb-sticky-avatar-source'));
    this.content = undefined;
  }

  private refreshDate(content: HTMLElement, visibleTop: number): void {
    const rows = Array.from(
      content.querySelectorAll<HTMLElement>('.msg-date'),
    ).map((element) => ({
      element,
      top: element.getBoundingClientRect().top,
      label: element.textContent?.trim() ?? null,
    }));
    const unreadDivider =
      content.querySelector<HTMLElement>('.cb-unread-divider');
    const ghost = content.querySelector<HTMLElement>('.cb-ghost-loading');
    const obstructed =
      unreadDividerOverlapsStickyDate(
        unreadDivider?.getBoundingClientRect() ?? null,
        visibleTop,
      ) || (ghost?.getBoundingClientRect().bottom ?? -Infinity) > visibleTop;
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
