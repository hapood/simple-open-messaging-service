import { ComponentRef, inject, Injectable, OnDestroy, Type } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';

/**
 * Base class for "transient overlay" services — fullscreen overlays mounted imperatively via the CDK Overlay
 * (decoupled from any host template, escaping ancestor stacking contexts) that own ONE sentinel history entry so
 * the system-back button (browser / Android) closes them, while the router's own navigation disposes them cleanly.
 *
 * Two consumers today: the image gallery (GalleryViewerService) and the file-detail sheet (FileDetailService).
 * Extracted so the three-piece mechanism — the CDK Overlay lifecycle, the sentinel history.pushState, and the
 * popstate / selfBackPending / entryActive dance — exists once instead of being copy-pasted per overlay kind.
 *
 * A subclass declares its unique history tag and the standalone component to mount, then calls {@link present} to
 * show and {@link close} to dismiss. The hosted component exposes a `close` output the base wires to `close()`
 * automatically (Esc / × button / backdrop-tap handlers in the component just `close.emit()`).
 *
 * Back-button semantics (mirrors the original gallery implementation):
 *  - open:          push one sentinel entry; entryActive = true.
 *  - user-dismiss:  clear entryActive, dispose the overlay, then ONE suppressed history.back (selfBackPending
 *                   swallows the popstate it fires) so we don't yank the user further back than our own entry.
 *  - system-back:   a popstate arrives with entryActive still set → the browser already left our entry, so just
 *                   dispose; no history.back (that would drop a second, unrelated page).
 *  - router nav:    disposeOnNavigation detaches the overlay → clear entryActive, NO history.back (the router has
 *                   pushed a new URL on top of our entry, so back would discard that page).
 *
 * Generic in the inputs record handed to {@link present}; subclasses pick the concrete shape.
 */
@Injectable() // abstract base: never provided directly (subclasses are providedIn:'root'), but @Injectable is required
              // because inject() counts as an Angular feature (NG2007). Subclasses inherit this decorator.
export abstract class TransientOverlayService<TInputs> implements OnDestroy {
  private readonly overlay = inject(Overlay);
  private ref: OverlayRef | null = null;
  private closeSub?: { unsubscribe(): void };
  private detachSub?: { unsubscribe(): void };

  /** True while we own an outstanding sentinel history entry for the currently-open overlay. */
  private entryActive = false;
  /** Whether this overlay is currently open. Readable so callers (e.g. an openChat that consumes the
   *  sentinel via replaceState) can close the overlay WITHOUT a history.back (see {@link closeSilent}). */
  get isOpen(): boolean { return this.entryActive; }
  /** Count of history traversals we initiated whose resulting popstate must be ignored (1:1 per traversal). */
  private selfBackPending = 0;

  /** Unique sentinel tag for this overlay kind (carried in pushState state so concurrent overlays don't clash). */
  protected abstract readonly historyTag: string;
  /** The standalone component to mount inside the overlay. */
  protected abstract readonly component: Type<unknown>;

  protected constructor() {
    window.addEventListener('popstate', this.onPopState);
  }

  /** Show the overlay with `inputs` applied to the hosted component. Replaces any overlay already open. */
  protected present(inputs: TInputs): void {
    this.disposeOverlay();
    if (!this.entryActive) {
      history.pushState({ tag: this.historyTag }, '');
      this.entryActive = true;
    }
    const ref = this.overlay.create({
      positionStrategy: this.overlay.position().global().top('0').left('0'),
      scrollStrategy: this.overlay.scrollStrategies.block(),
      disposeOnNavigation: true,
    });
    const cmp = ref.attach(new ComponentPortal(this.component));
    this.applyInputs(cmp, inputs);
    const inst = cmp.instance as { close?: { subscribe: (fn: () => void) => { unsubscribe(): void } } };
    if (inst.close) this.closeSub = inst.close.subscribe(() => this.close());
    this.detachSub = ref.detachments().subscribe(() => this.onDetached());
    cmp.changeDetectorRef.detectChanges(); // zoneless: drive the first render manually
    this.ref = ref;
  }

  /** Apply inputs to the attached component. Default: spread the record onto the component via setInput. Override
   *  for custom/typed input wiring. */
  protected applyInputs(cmp: ComponentRef<unknown>, inputs: TInputs): void {
    for (const [k, v] of Object.entries(inputs as Record<string, unknown>)) cmp.setInput(k, v);
  }

  /** Dismiss the overlay as if the user closed it. */
  close(): void {
    const hadEntry = this.entryActive;
    this.entryActive = false;
    this.disposeOverlay();
    if (hadEntry) {
      this.selfBackPending++;
      history.back();
    }
  }

  /** Dismiss the overlay WITHOUT touching history — for the case where the caller's own navigation
   *  (e.g. NavStateMachineService.openChat's `replaceState`) already consumed our sentinel entry, so a
   *  `history.back` here would pop the wrong (post-replace) entry. Clears state + disposes the CDK overlay. */
  closeSilent(): void {
    this.entryActive = false;
    this.disposeOverlay();
  }

  ngOnDestroy(): void {
    window.removeEventListener('popstate', this.onPopState);
    this.disposeOverlay();
  }

  private readonly onPopState = (): void => {
    if (this.selfBackPending > 0) { this.selfBackPending--; return; }
    if (this.entryActive) {
      this.entryActive = false;
      this.disposeOverlay();
    }
  };

  private onDetached(): void {
    this.entryActive = false;
    this.closeSub?.unsubscribe(); this.closeSub = undefined;
    this.detachSub?.unsubscribe(); this.detachSub = undefined;
    this.ref = null;
  }

  private disposeOverlay(): void {
    this.closeSub?.unsubscribe(); this.closeSub = undefined;
    this.detachSub?.unsubscribe(); this.detachSub = undefined;
    this.ref?.dispose();
    this.ref = null;
  }
}
