import { Injectable } from '@angular/core';
import { TransientOverlayService } from '../../services/transient-overlay.service';
import { InviteDetailComponent } from './invite-detail.component';

/**
 * Opens the group-invite detail view as a transient overlay (CDK Overlay + a sentinel history entry
 * so system-back closes it; router navigation disposes it) — the same back-button/overlay mechanism
 * as the image gallery and file-detail sheet, contributed by the shared
 * {@link TransientOverlayService} base. This subclass adds only the history tag, the hosted
 * component, and the `open()` / {@link closeForReplace} API.
 *
 * The detail view is a transient overlay (NOT a deep-linkable route): an invite token isn't worth
 * bookmarking, so it owns a sentinel history entry for back-button support rather than a real route.
 *
 * {@link closeForReplace} is the Join-flow-specific close: it disposes the overlay AND pops the
 * sentinel via history.back, resolving once that popstate has fired — so the hero transition that
 * follows can `replaceUrl` OVER the invite thread's entry (clean back→list stack). Without popping
 * the sentinel first, the replace would target it instead of the P2P route.
 */
@Injectable({ providedIn: 'root' })
export class InviteDetailService extends TransientOverlayService<{ raw: string }> {
  protected readonly historyTag = 'soms-invite-detail';
  protected readonly component = InviteDetailComponent;

  /** True between open() and closeForReplace(); guards against a hanging closeForReplace when the
   *  dialog was already dismissed (system-back / external close). */
  private opened = false;

  /** Show the detail view for an invite message whose raw JSON body is `raw`. */
  open(raw: string): void {
    this.opened = true;
    this.present({ raw });
  }

  /**
   * Close the dialog and pop its sentinel history entry, resolving once the resulting popstate has
   * fired (so a follow-up replaceUrl navigation targets the invite thread's entry, not the sentinel).
   * Resolves immediately if the dialog isn't open; races a 300ms timeout in case the popstate never
   * arrives (defensive — the base close() always pushes exactly one sentinel per open()).
   */
  async closeForReplace(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    const pop = new Promise<void>((resolve) => {
      const onPop = (): void => {
        window.removeEventListener('popstate', onPop);
        resolve();
      };
      window.addEventListener('popstate', onPop);
    });
    this.close(); // base: clear entryActive + dispose overlay + history.back() (popstate caught above)
    await Promise.race([pop, new Promise((r) => setTimeout(r, 300))]);
  }
}
