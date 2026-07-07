import { isDevMode } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

/**
 * Dev-only in-page web inspector (eruda). Adds a floating gear button that opens Console / Elements / Network panels
 * inside the page — essential for reproducing issues on mobile, where browser devtools are unavailable. The Console tool
 * surfaces the kernel's `[SIGNAL]` diagnostic snapshots directly in-page; Elements lets you inspect a rendered row's
 * real offsetHeight/scrollHeight without a desktop DevTools connection.
 *
 * Gated by `isDevMode()` so production builds tree-shake the dynamic import (eruda becomes a separate chunk the prod
 * bundle never references), and initialized before bootstrap so it captures every console line from app startup.
 */
async function setupEruda(): Promise<void> {
  if (!isDevMode()) return;
  const eruda = (await import('eruda')).default;
  eruda.init({ tool: ['console', 'elements', 'network', 'resources', 'sources', 'info'] });
}

/**
 * Normalize a browser/desktop deep-link into a 2-layer history. If the tab is launched (or refreshed)
 * directly on a non-home route — e.g. a pasted `/chat/2` — capture that route and rewrite the address bar
 * to `/` BEFORE Angular boots, so the app boots on the conversation list (history layer 1). The back-exit
 * guard (BackExitGuardService) then PUSHES the captured route once home has mounted (layer 2), yielding
 * the same `[home, route]` stack as a normal list→chat drill-in — so back returns to the list instead of
 * falling out of the app, and the chat kernel mounts only once (no boot→chat→home-flicker→chat).
 *
 * Skipped on Android: deep-links arrive via `__SOMS_PENDING_THREAD_ID__` + PushService, hardware back is
 * native, and the guard self-disables there. Auth/config/nav paths are left alone (they are not drills).
 */
function normalizeBootRoute(): void {
  if (typeof window === 'undefined' || typeof location === 'undefined' || typeof navigator === 'undefined') return;
  const isAndroidTauri = window.__TAURI_INTERNALS__ !== undefined && /Android/i.test(navigator.userAgent);
  if (isAndroidTauri) return;
  const path = location.pathname + location.search + location.hash;
  if (!path || path === '/' || path.startsWith('/auth/') || path.startsWith('/config') || path.startsWith('/nav')) return;
  window.__SOMS_BOOT_ROUTE__ = path;
  history.replaceState(null, '', '/');
}

normalizeBootRoute();
setupEruda().finally(() => {
  bootstrapApplication(AppComponent, appConfig)
    .catch((err) => console.error(err));
});
