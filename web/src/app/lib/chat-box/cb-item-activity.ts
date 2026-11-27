import { DestroyRef, inject } from '@angular/core';
import { CbItemLifetime } from './cb-item-lifetime';

/** Register component-owned activity for early retirement and normal Angular
 * destruction. A child can disappear before its row; unregister it in that
 * case so the row does not retain dead components. Standalone renderers without
 * a row scope still release the activity through their own DestroyRef. */
export function onCbItemPredestory(cleanup: () => void): void {
  const destroyRef = inject(DestroyRef);
  const lifetime = inject(CbItemLifetime, { optional: true });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cleanup();
  };
  const unregister = lifetime?.onPredestory(stop);
  destroyRef.onDestroy(() => {
    unregister?.();
    stop();
  });
}
