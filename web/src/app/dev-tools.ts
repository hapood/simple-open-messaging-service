import { Routes } from '@angular/router';

/**
 * Dev-only route entry points: the chatbox playground test rig.
 *
 * This whole file is swapped for `dev-tools.prod.ts` in the production build via angular.json
 * `fileReplacements`. Because the prod replacement exports an EMPTY `devRoutes`, the playground +
 * MockItemSource lazy chunks are neither emitted to the prod bundle nor exposed as reachable routes —
 * not merely lazy-unloaded, and therefore never prefetched by the ngsw app-shell group, which matches
 * `/*.js`. The `loadComponent` calls below keep the playground + MockItemSource out of the main bundle
 * even in dev.
 */
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
