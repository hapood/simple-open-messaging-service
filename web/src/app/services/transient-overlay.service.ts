import { ComponentRef, effect, inject, Injectable, OnDestroy, Type } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { NavStateMachineService, type PaneKind } from './nav-state.service';

/**
 * Base class for "transient overlay" services — fullscreen overlays mounted imperatively via the CDK Overlay
 * (decoupled from any host template, escaping ancestor stacking contexts). Open/close is an entry on the
 * {@link NavStateMachineService.paneStack}; an effect here watches for this kind's entry and creates/disposes
 * the CDK overlay to match — so back / openChat / closeChat / going home (which clear the pane stack) all
 * dismiss it. The hosted component exposes a `close` output the base wires to {@link close} (X / Esc / backdrop).
 *
 * Replaces the old sentinel-history (`pushState` + `popstate` + `selfBackPending`) mechanism: the pane stack
 * is the single source of truth, no browser history is touched.
 *
 * Generic in the inputs record; subclasses declare `kind` + the standalone component and expose a typed
 * `open()` that calls {@link pushEntry}.
 */
@Injectable() // abstract base: never provided directly (subclasses are providedIn:'root'), but @Injectable is required
              // because inject() counts as an Angular feature (NG2007). Subclasses inherit this decorator.
export abstract class TransientOverlayService<TInputs> implements OnDestroy {
  private readonly overlay = inject(Overlay);
  private readonly nav = inject(NavStateMachineService);
  private ref: OverlayRef | null = null;
  private closeSub?: { unsubscribe(): void };
  private detachSub?: { unsubscribe(): void };
  /** The pane entry id currently rendered (null = no overlay). Guards the effect so an unrelated pane-stack
   *  change (a different kind pushed/removed) doesn't re-create our CDK overlay while our entry is unchanged. */
  private currentId: number | null = null;

  /** This overlay's kind on the nav pane stack (`'gallery'` / `'file-detail'` / `'invite-detail'`). */
  protected abstract readonly kind: PaneKind;
  /** The standalone component to mount inside the overlay. */
  protected abstract readonly component: Type<unknown>;

  protected constructor() {
    // Drive the CDK overlay from the pane stack: present when an entry of `kind` appears, dispose when it's
    // gone. present/disposeOverlay read only class fields (no signals), so this effect tracks ONLY paneStack
    // — no re-run loop (cf. the nav-drawer viewChild-tracking bug, where close() read a viewChild signal).
    effect(() => {
      const entry = this.nav.paneStack().find((p) => p.kind === this.kind);
      if (entry) {
        if (this.currentId !== entry.id) {
          this.present(entry.payload as TInputs);
          this.currentId = entry.id;
        }
      } else if (this.currentId !== null) {
        this.disposeOverlay();
        this.currentId = null;
      }
    });
  }

  /** Push an entry onto the pane stack; the effect above mounts the CDK overlay. */
  protected pushEntry(inputs: TInputs): void {
    this.nav.pushPane({ kind: this.kind, payload: inputs as Record<string, unknown> });
  }

  /** Dismiss — removes this kind's entry from the pane stack (the effect disposes the overlay). Wired to the
   *  hosted component's `close` output (X / Esc / backdrop tap in the component just `close.emit()`). */
  close(): void {
    if (this.currentId !== null) this.nav.closePane(this.currentId);
  }

  /** Create the CDK overlay with `inputs` applied to the hosted component (replaces any overlay already open). */
  private present(inputs: TInputs): void {
    this.disposeOverlay();
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

  ngOnDestroy(): void {
    this.disposeOverlay();
  }

  private onDetached(): void {
    this.currentId = null;
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
