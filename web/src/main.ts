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

setupEruda().finally(() => {
  bootstrapApplication(AppComponent, appConfig)
    .catch((err) => console.error(err));
});
