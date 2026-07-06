import { Injectable, ApplicationRef, ComponentRef, inject } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { Router } from '@angular/router';
import { animate } from 'motion';
import { ChatTransitionHostComponent } from '../components/chat-transition/chat-transition-host.component';
import { LayoutService } from './layout.service';
import { prefersReducedMotion } from '../lib/motion-utils';
import type { ConversationItem } from './model';
// NOTE: the hero animation uses the native WAAPI (Element.animate) rather than motion.dev — its
// keyframes are plain CSS (transform/border-radius/opacity) and WAAPI is fully typed, sidestepping
// Motion's strict intersection keyframe type. The kernel's flipMove uses the same WAAPI/CSS basis.

/** App-wide ENTER timing (matches overlaySlide / dialogAnim) so the hero sits in the same rhythm. */
const ENTER_MS = 300;
const EASING: number[] = [0.32, 0.72, 0, 1];
/** Starting scale — small enough to read as a centered disc before it grows to full size. */
const START_SCALE = 0.06;

/**
 * Hero transition into a just-joined group: mounts a SECOND, real chat (a `MessageThreadComponent`
 * via {@link ChatTransitionHostComponent}) in a CDK overlay positioned over `.chat-slot`, clips it to
 * a small circle at center, then grows it to full size over the app's ENTER timing.
 *
 * Why a CDK overlay and not a routed second `ChatPane`: chat is a single route-reused instance
 * (`ChatReuseStrategy`), and `ChatPaneComponent` reads the global `ConversationListService.
 * openThreadId` — a second routed instance would mirror the same thread. The overlay's host takes
 * `threadId`/`userMsgTrd` as explicit inputs, so it renders the joining group independently.
 *
 * Sequence: freeze the immunity frame → mount overlay (sized to `.chat-slot`) → drive a CD tick so
 * the zoneless kernel inits → animate scale 0.06→1, border-radius 50%→0, opacity 0→1, navigating
 * the URL to the target thread at the start so the primary ChatPane swaps its kernel UNDER the
 * overlay (no flicker) and the conversation-list row activates + FLIPs in → on complete, dispose the
 * overlay and thaw. `prefers-reduced-motion` skips the overlay and just navigates.
 *
 * The overlay is created with `disposeOnNavigation: false` so the mid-transition URL change doesn't
 * tear it down prematurely; we dispose it ourselves on completion.
 */
@Injectable({ providedIn: 'root' })
export class ChatTransitionService {
  private readonly overlay = inject(Overlay);
  private readonly router = inject(Router);
  private readonly layout = inject(LayoutService);
  private readonly appRef = inject(ApplicationRef);

  private current?: { ref: OverlayRef; cmp: ComponentRef<ChatTransitionHostComponent> };

  async transitionToThread(
    threadId: number,
    item?: ConversationItem,
    opts: { replaceUrl?: boolean } = {},
  ): Promise<void> {
    // Drop any in-flight transition before starting a new one.
    this.disposeCurrent();
    const navOpts = opts.replaceUrl ? { replaceUrl: true } : undefined;

    // No item to mount the overlay against, or reduced motion: skip the flourish — straight to the
    // target route (the list FLIP honors reduced motion separately and snaps).
    if (!item || prefersReducedMotion()) {
      await this.router.navigate(['chat', threadId], navOpts);
      return;
    }

    const rect = this.chatSlotRect();
    this.layout.freezeReflow();

    const ref = this.overlay.create({
      // Global strategy; we pin the pane to the chat-slot rect with explicit styles after attach.
      positionStrategy: this.overlay.position().global().top('0').left('0'),
      scrollStrategy: this.overlay.scrollStrategies.block(),
      disposeOnNavigation: false,
    });
    const portal = new ComponentPortal(ChatTransitionHostComponent);
    const cmp = ref.attach(portal);
    cmp.setInput('threadId', threadId);
    cmp.setInput('userMsgTrd', item);

    const pane = ref.overlayElement;
    this.stylePane(pane, rect, /*start*/ true);

    // Drive the zoneless viewChild effect so MessageThreadComponent's kernel inits inside the pane.
    cmp.changeDetectorRef.detectChanges();
    this.appRef.tick();

    this.current = { ref, cmp };

    // Navigate at the start so the primary ChatPane swaps its kernel under the overlay and the row
    // activates; the overlay hides the reinit flicker. `replaceUrl` (used by the join flow) overwrites
    // the P2P invite thread's history entry so back from the group lands on the conversation list.
    void this.router.navigate(['chat', threadId], navOpts);

    // Let the kernel paint one frame, then grow. WAAPI animates plain CSS (transform / border-radius
    // / opacity); the inline transform above covers the pre-rAF frame so the small circle is first.
    requestAnimationFrame(() => {
      const anim = pane.animate(
        [
          { transform: `scale(${START_SCALE})`, borderRadius: '50%', opacity: 0 },
          { transform: 'scale(1)', borderRadius: '0%', opacity: 1 },
        ],
        { duration: ENTER_MS, easing: `cubic-bezier(${EASING.join(',')})`, fill: 'forwards' },
      );
      anim.onfinish = () => {
        this.disposeCurrent();
        this.layout.thawReflow();
      };
    });
  }

  /** Size/position the overlay pane over `.chat-slot` (full viewport on mobile, where chat-slot is
   *  already full-screen). `start=true` seeds the small-circle initial state; false clears it. */
  private stylePane(pane: HTMLElement, rect: DOMRect, start: boolean): void {
    Object.assign(pane.style, {
      position: 'absolute',
      top: rect.top + 'px',
      left: rect.left + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
      overflow: 'hidden',
      background: 'var(--app-surface)',
      transformOrigin: 'center center',
      // Will-change for the duration of the animation; cleared on dispose via the inline style reset.
      willChange: 'transform, opacity',
    } satisfies Partial<CSSStyleDeclaration>);
    if (start) {
      pane.style.transform = `scale(${START_SCALE})`;
      pane.style.borderRadius = '50%';
      pane.style.opacity = '0';
    }
  }

  /** The `.chat-slot` element's viewport rect (where the real chat lives); falls back to the full
   *  viewport if the slot can't be found (e.g. a non-standard layout). */
  private chatSlotRect(): DOMRect {
    const slot = document.querySelector<HTMLElement>('.chat-slot');
    return slot ? slot.getBoundingClientRect() : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  }

  private disposeCurrent(): void {
    if (!this.current) return;
    const { ref } = this.current;
    this.current = undefined;
    // Reset the pane's inline styles so a later overlay/portal isn't affected, then dispose.
    try {
      ref.overlayElement.style.cssText = '';
    } catch { /* overlay already gone */ }
    ref.dispose();
  }
}
