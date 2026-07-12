import { Routes } from '@angular/router';

/**
 * Production replacement for dev-tools.ts, swapped in by angular.json `fileReplacements`. It contains
 * NO dynamic imports of eruda or the playground, so those chunks are neither emitted to the prod
 * bundle nor prefetched by the ngsw app-shell. See dev-tools.ts for the full rationale.
 */
export const devRoutes: Routes = [];

/** No-op in production — see dev-tools.ts. */
export async function initEruda(): Promise<void> {
  // Intentionally empty.
}
