import { Injectable } from '@angular/core';
import { isTauri } from './runtime';

const WIDE_BREAKPOINT_PX = 720;
const COMPACT_HEIGHT_PX = 74;
const WIDE_HEIGHT_PX = 82;

/** Single global writer for the floating composer's CSS height. */
@Injectable({ providedIn: 'root' })
export class ComposerGeometryService {
  private readonly tauri = isTauri();
  private lastHeight = -1;
  private activeContainer?: HTMLElement;

  constructor() {
    this.syncForWidth(document.documentElement.clientWidth);
  }

  /** Browser/PWA observes the real chat width. Tauri accepts shell geometry only after the boot seed. */
  observe(container: HTMLElement): () => void {
    if (this.tauri) return () => {};
    let observedComposer: HTMLElement | null = null;
    const sync = (): void => {
      const composer = container.querySelector<HTMLElement>('app-chat-input');
      if (composer)
        this.syncHeight(this.composerLayoutHeight(composer), container);
      else if (container.classList.contains('msg-container--friendship-ended'))
        this.syncHeight(0, container);
      else this.syncForWidth(container.clientWidth, container);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(container);
    const mutations = new MutationObserver(() => {
      const composer = container.querySelector<HTMLElement>('app-chat-input');
      if (composer && composer !== observedComposer) {
        observedComposer = composer;
        observer.observe(composer);
      }
      sync();
    });
    mutations.observe(container, { childList: true, subtree: true });
    const composer = container.querySelector<HTMLElement>('app-chat-input');
    if (composer) {
      observedComposer = composer;
      observer.observe(composer);
    }
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }

  /** Promote one chatbox's owned geometry to the global notification channel. */
  setActive(container: HTMLElement, active: boolean): void {
    if (this.tauri) return;
    if (active) {
      this.activeContainer = container;
      const ownedHeight = Number.parseFloat(
        container.style.getPropertyValue('--soms-composer-height'),
      );
      if (Number.isFinite(ownedHeight)) this.publishGlobal(ownedHeight);
      return;
    }
    if (this.activeContainer !== container) return;
    this.activeContainer = undefined;
    this.publishGlobal(0);
  }

  /** The Web bar carries the safe-area padding inside its border box, while the shared geometry contract
   * publishes composer and safe-area heights separately. */
  private composerLayoutHeight(composer: HTMLElement): number {
    const bar = composer.querySelector<HTMLElement>('.ci-input-bar');
    const bottomPadding = bar
      ? Number.parseFloat(getComputedStyle(bar).paddingBottom)
      : 8;
    // .ci-input-bar owns 8px base padding plus the safe-area inset. Reading the resolved padding avoids
    // trying to parse a computed custom property whose value may still contain env(safe-area-inset-bottom).
    const safeBottom = Number.isFinite(bottomPadding)
      ? Math.max(0, bottomPadding - 8)
      : 0;
    return composer.offsetHeight - safeBottom;
  }

  private syncHeight(height: number, container?: HTMLElement): void {
    const next = Math.max(0, Math.round(height));
    // Each chatbox owns its geometry. Desktop keeps two fully laid-out panes mounted during a switch, so a
    // root-only value would let the hidden pane overwrite the foreground pane's scroll-tail reserve.
    container?.style.setProperty('--soms-composer-height', `${next}px`);
    if (container) {
      if (this.activeContainer === container) this.publishGlobal(next);
      return;
    }
    this.publishGlobal(next);
  }

  /** The root custom property is a notification for consumers outside the active chatbox, not its source
   * of truth. Only the active container may publish here after its locally owned value has been updated. */
  private publishGlobal(height: number): void {
    const next = Math.max(0, Math.round(height));
    if (next === this.lastHeight) return;
    this.lastHeight = next;
    document.documentElement.style.setProperty(
      '--soms-composer-height',
      `${next}px`,
    );
  }

  /** Shared by global initialization and every browser width notification. */
  private syncForWidth(width: number, container?: HTMLElement): void {
    const height =
      width >= WIDE_BREAKPOINT_PX ? WIDE_HEIGHT_PX : COMPACT_HEIGHT_PX;
    this.syncHeight(height, container);
  }
}
