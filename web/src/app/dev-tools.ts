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
  liftErudaAboveNavBar();
}

/**
 * Lift eruda's overlay clear of the Android system navigation bar. The native shell is edge-to-edge
 * (`enableEdgeToEdge`), so the WebView renders behind the 3-button nav bar; eruda docks its panel and
 * entry button to the viewport bottom and has no way to learn the nav-bar inset — Android WebView returns
 * `env(safe-area-inset-bottom): 0`. The shell measures the real inset and exposes it as `--soms-safe-bottom`
 * on `:root` (see MainActivity.installInsetsListener + _tokens.scss); CSS custom properties inherit across
 * the shadow boundary (eruda's `:host{all:initial}` does not reset them), so `var(--soms-safe-bottom)`
 * resolves inside eruda's shadow root:
 *
 *  - `.eruda-container` is the fixed full-viewport root (`top:0; height:100%`); shrink its height by the
 *    inset so the docked `.eruda-dev-tools` panel (`bottom:0; height:100%` of the container) lifts above
 *    the system bar. This is what stops the opened console/panel from being occluded.
 *  - `.eruda-entry-btn` is positioned via frozen `top`/`left` px (eruda.position()), so it does NOT follow
 *    the shrunk container — translate it up by the same inset so the gear stays tappable above the bar.
 *
 * The style is injected into eruda's OPEN shadow root (a `document.head` rule cannot reach shadow-scoped
 * elements). `!important` wins over eruda's own runtime-injected styles regardless of order (eruda re-applies
 * them on theme/scale change). A pure no-op where `--soms-safe-bottom` is 0 (desktop / web / gesture nav),
 * and dev-only — this file is swapped for dev-tools.prod.ts in production builds, so the override never ships.
 */
function liftErudaAboveNavBar(): void {
  if (document.getElementById('eruda-safe-area-inset')) return;
  const style = document.createElement('style');
  style.id = 'eruda-safe-area-inset';
  style.textContent = `
    .eruda-container {
      bottom: var(--soms-safe-bottom, 0px) !important;
      height: calc(100% - var(--soms-safe-bottom, 0px)) !important;
    }
    .eruda-entry-btn {
      transform: translateY(calc(-1 * var(--soms-safe-bottom, 0px))) !important;
    }
  `;
  // eruda mounts at <div id="eruda"> on <html> with an open shadow root; fall back to scanning
  // documentElement's children for whichever host's shadow root holds .eruda-container (survives an
  // eruda id change), then to document.head for the legacy no-shadow-DOM branch.
  const root = erudaStyleRoot();
  root.appendChild(style);
}

/** The node that owns eruda's `.eruda-container` — its open shadow root, or document.head as a fallback. */
function erudaStyleRoot(): Node {
  const byId = document.getElementById('eruda')?.shadowRoot;
  if (byId) return byId;
  for (const child of Array.from(document.documentElement.children)) {
    const shadow = (child as HTMLElement).shadowRoot;
    if (shadow?.querySelector('.eruda-container')) return shadow;
  }
  return document.head;
}
