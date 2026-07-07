import { inject, Injectable } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';

/**
 * Closes the `aside` auxiliary outlet (peer-profile / group-info / settings) by POPPING the history
 * entry that opening it pushed — not by pushing a "panel-closed" sibling.
 *
 * Why pop, not push: opening the panel is a normal router navigation, which PUSHES a history entry
 * (`/chat/23` → `/chat/23(aside:group-info)`). That push is intentional — it is what lets hardware-back /
 * browser-back dismiss the panel (the mobile drill-in contract). Closing must therefore pop that same
 * entry. A push-on-close leaves the panel-open URL orphaned one step down the stack; combined with
 * chat-open's `replaceUrl` (which consumes the top entry), the next back then re-opens the panel on
 * whichever thread that orphan referenced — e.g. back from `/chat/23` re-opened `/chat/24(aside:group-info)`.
 * Popping via {@link Location.back} makes the scrim, the in-panel back arrow, and the title toggle behave
 * identically to hardware-back, and leaves no orphan. Consistent with the overlay-dismiss convention used
 * by TransientOverlayService / SearchService / RouteService (push sentinel → history.back).
 *
 * `history.state.navigationId` is the Angular Router's per-entry sequence id (the initial navigation is 1).
 * When the panel URL was loaded cold (deep-linked directly, id 1) there is no prior in-app entry to pop, so
 * we clear the outlet in place with `replaceUrl` rather than back-navigating out of the app.
 */
@Injectable({ providedIn: 'root' })
export class AsideOutletService {
  private readonly router = inject(Router);
  private readonly location = inject(Location);

  close(): void {
    const navId = (history.state as { navigationId?: number } | null)?.navigationId;
    if (navId && navId > 1) {
      this.location.back();
    } else {
      void this.router.navigate([{ outlets: { aside: null } }], { replaceUrl: true });
    }
  }
}
