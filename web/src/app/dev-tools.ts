import { Routes } from '@angular/router';

/**
 * Dev-only entry points: the eruda in-page console and the chatbox playground test rig.
 *
 * This whole file is swapped for `dev-tools.prod.ts` in the production build via angular.json
 * `fileReplacements`. Because the prod replacement contains NO `import('eruda')` and NO playground
 * `loadComponent`, the bundler never sees those dynamic imports — so the eruda chunk (505 KB) and the
 * playground + MockItemSource chunk are NOT emitted to the prod bundle at all (not merely
 * lazy-unloaded, and therefore never prefetched by the ngsw app-shell group, which matches `/*.js`).
 *
 * Why fileReplacements instead of a runtime flag: `isDevMode()` is a runtime function AOT/esbuild do
 * not fold, and a cross-module `environment.production` property access is not folded either, so
 * neither can drop a dynamic `import()` from the output. Only omitting the import statement entirely
 * (via this whole-file swap) guarantees the chunk is absent. This is the mechanism Angular offers for
 * build-time file exclusion; Angular does not auto-detect an `environment.ts` — the swap is explicit.
 */

// Kernel test rig (count/latency/edge/threshold knobs driving the real chat kernel against MockItemSource).
// `loadComponent` keeps the playground + MockItemSource out of the main bundle even in dev.
export const devRoutes: Routes = [
  {
    path: 'playground/chatbox-a',
    loadComponent: () =>
      import('./pages/chatbox-playground/chatbox-playground.component').then((m) => m.ChatboxPlaygroundComponent),
    data: { useNativeAnchor: true },
  },
  {
    path: 'playground/chatbox-b',
    loadComponent: () =>
      import('./pages/chatbox-playground/chatbox-playground.component').then((m) => m.ChatboxPlaygroundComponent),
  },
];

/**
 * Dev-only in-page web inspector (eruda). Adds a floating gear button that opens Console / Elements /
 * Network panels inside the page — essential for reproducing issues on mobile, where browser devtools
 * are unavailable. The Console tool surfaces the kernel's `[SIGNAL]` diagnostic snapshots in-page;
 * Elements lets you inspect a rendered row's real offsetHeight/scrollHeight without desktop DevTools.
 * Call before bootstrap so it captures every console line from app startup.
 */
export async function initEruda(): Promise<void> {
  const { default: eruda } = await import('eruda');
  eruda.init({ tool: ['console', 'elements', 'network', 'resources', 'sources', 'info'] });
}
