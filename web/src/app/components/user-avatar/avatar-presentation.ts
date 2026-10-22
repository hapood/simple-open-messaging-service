import { computed, inject, type Signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { map, switchMap } from 'rxjs';
import type { AvatarSource } from './avatar-source';
import {
  AvatarPresentationService,
  initialAvatarView,
} from './avatar-presentation.service';

/** Input changes replace stale presentation synchronously; async results belong only to their source. */
export function avatarPresentation(source: Signal<AvatarSource>) {
  const presentations = inject(AvatarPresentationService);
  const resolved = toSignal(
    toObservable(source).pipe(
      switchMap((selected) =>
        presentations
          .resolve(selected)
          .pipe(map((view) => ({ source: selected, view }))),
      ),
    ),
  );
  return computed(() => {
    const selected = source();
    const result = resolved();
    return result?.source === selected
      ? result.view
      : initialAvatarView(selected);
  });
}
