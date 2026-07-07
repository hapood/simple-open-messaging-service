import { Injectable } from '@angular/core';
import { TransientOverlayService } from '../../services/transient-overlay.service';
import { InviteDetailComponent } from './invite-detail.component';

/**
 * Opens the group-invite detail view as a transient overlay (CDK Overlay). Open/close is an entry on the nav
 * pane stack (kind `'invite-detail'`); the shared {@link TransientOverlayService} base mounts/disposes the CDK
 * overlay from that entry, so a Join/Open (which calls `nav.openChat` → clears the pane stack) disposes it
 * automatically — no explicit close or history dance needed.
 *
 * The detail view is a transient overlay (NOT a deep-linkable route): an invite token isn't worth bookmarking.
 */
@Injectable({ providedIn: 'root' })
export class InviteDetailService extends TransientOverlayService<{ raw: string }> {
  protected readonly kind = 'invite-detail';
  protected readonly component = InviteDetailComponent;

  /** Show the detail view for an invite message whose raw JSON body is `raw`. */
  open(raw: string): void {
    this.pushEntry({ raw });
  }
}
