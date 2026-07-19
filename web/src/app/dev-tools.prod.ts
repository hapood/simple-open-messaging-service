import { Routes } from '@angular/router';

/**
 * Production replacement for dev-tools.ts, swapped in by angular.json `fileReplacements`. Exports an
 * EMPTY `devRoutes` so the playground + MockItemSource lazy chunks are neither emitted to the prod
 * bundle nor exposed as routes. See dev-tools.ts.
 */
export const devRoutes: Routes = [];
