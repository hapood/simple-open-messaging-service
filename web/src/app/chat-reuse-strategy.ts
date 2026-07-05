import { BaseRouteReuseStrategy, type ActivatedRouteSnapshot } from '@angular/router';

/**
 * Keeps ChatPane mounted across the home shell's two primary-outlet children — `''` (no chat selected, the
 * list) and `chat/:threadId` (an open chat) — so the chat surface is effectively always-mounted: navigating
 * list ↔ chat never destroys and recreates the kernel. Both children render the same `ChatPaneComponent`;
 * without this override the router treats them as different route configs and remounts on every transition
 * (the original exit-animation bug — the empty placeholder would slide out because the router had already
 * swapped ChatPane → ChatEmpty before the transform ran).
 *
 * The match is by PATH, not by component class, so `ChatPaneComponent` stays a lazy `loadComponent` chunk —
 * referencing the class here would eager-import it back into the initial bundle. Inherits
 * `BaseRouteReuseStrategy`'s safe defaults: never detaches/stores routes (no detached-DOM measurement
 * corruption — the chat view stays in the live outlet, attached, the whole time).
 */
export class ChatReuseStrategy extends BaseRouteReuseStrategy {
  override shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
    if (future.routeConfig === curr.routeConfig) return true;
    const fp = future.routeConfig?.path;
    const cp = curr.routeConfig?.path;
    // Reuse the chat surface across the list ('') and chat ('chat/:threadId') children of the home route.
    if ((fp === '' || fp === 'chat/:threadId') && (cp === '' || cp === 'chat/:threadId')) return true;
    return false;
  }
}
