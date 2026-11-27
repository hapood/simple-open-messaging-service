import { computed, DestroyRef, inject, untracked, type Signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { map, Subject, switchMap, takeUntil } from 'rxjs';
import { onCbItemPredestory } from '../../lib/chat-box/cb-item-activity';
import type { AvatarSource } from './avatar-source';
import {
  AvatarPresentationService,
  initialAvatarView,
} from './avatar-presentation.service';

/** Input changes replace stale presentation synchronously; async results belong only to their source. */
export function avatarPresentation(source: Signal<AvatarSource>) {
  const presentations = inject(AvatarPresentationService);
  const destroyRef = inject(DestroyRef);
  const stopped = new Subject<void>();
  let releaseImage: (() => void) | undefined;
  destroyRef.onDestroy(() => releaseImage?.());
  const resolved = toSignal(
    toObservable(source).pipe(
      switchMap((selected) =>
        presentations
          .resolve(selected)
          .pipe(map((view) => ({ source: selected, view }))),
      ),
      takeUntil(stopped),
    ),
  );
  onCbItemPredestory(() => {
    if (!destroyRef.destroyed) {
      const current = untracked(resolved);
      if (current) releaseImage = presentations.retainImage(current.view);
    }
    stopped.next();
    stopped.complete();
  });
  return computed(() => {
    const selected = source();
    const result = resolved();
    return result?.source === selected
      ? result.view
      : initialAvatarView(selected);
  });
}
