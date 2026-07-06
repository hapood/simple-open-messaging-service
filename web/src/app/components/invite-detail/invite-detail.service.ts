import { Injectable, inject } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { filter, firstValueFrom } from 'rxjs';
import { TransientOverlayService } from '../../services/transient-overlay.service';
import { InviteDetailComponent } from './invite-detail.component';

/**
 * Opens the group-invite detail view as a transient overlay (CDK Overlay + a sentinel history entry so
 * system-back closes it; router navigation disposes it) — the same back-button/overlay mechanism as the
 * image gallery and file-detail sheet, contributed by the shared {@link TransientOverlayService} base.
 * This subclass adds the history tag, the hosted component, the `open()` API, and the Join-flow-specific
 * {@link closeForReplace}.
 *
 * The detail view is a transient overlay (NOT a deep-linkable route): an invite token isn't worth
 * bookmarking, so it owns a sentinel history entry for back-button support rather than a real route.
 */
@Injectable({ providedIn: 'root' })
export class InviteDetailService extends TransientOverlayService<{ raw: string }> {
  protected readonly historyTag = 'soms-invite-detail';
  protected readonly component = InviteDetailComponent;
  private readonly router = inject(Router);

  /** True between open() and closeForReplace(); guards against a hanging closeForReplace when the
   *  dialog was already dismissed (system-back / external close). */
  private opened = false;

  /** Show the detail view for an invite message whose raw JSON body is `raw`. */
  open(raw: string): void {
    this.opened = true;
    this.present({ raw });
  }

  /**
   * Close the dialog, pop its sentinel history entry, and resolve only AFTER the router has finished
   * processing the resulting popstate (its NavigationEnd). Waiting for the NavigationEnd — not just the
   * popstate event — is what prevents the join/open race: a follow-up `navigate(['chat', group])` would
   * otherwise have its NavigationEnd land BEFORE the popstate's, snapping openThreadId back to the P2P
   * thread once the group reveal completes. With the popstate's NavigationEnd awaited first, the order is
   * fixed (p2p no-op → group), and the caller's `replaceUrl` then overwrites the P2P entry so back from
   * the group lands on the conversation list. Races a 300ms timeout in case the router skips the
   * same-URL navigation (then it's already idle and the navigate is safe anyway).
   */
  async closeForReplace(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    const navEnd = firstValueFrom(
      this.router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd)),
    );
    this.close(); // base: dispose overlay + history.back() (pops sentinel → popstate → router navigation)
    await Promise.race([navEnd, new Promise((r) => setTimeout(r, 300))]);
  }
}
