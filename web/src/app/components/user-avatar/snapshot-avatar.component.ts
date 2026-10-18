import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { AvatarComponent } from './avatar.component';
import { avatarPresentation } from './avatar-presentation';
import { UserAvatarType, type AvatarDomainSource } from './model';
import type { AvatarSource } from './avatar-source';

/** Fixed display data and local previews. No profile fallback or profile demand. */
@Component({
  selector: 'app-snapshot-avatar',
  imports: [AvatarComponent],
  template: '<app-avatar [view]="view()" />',
  styles: ':host { display: block; width: 100%; height: 100%; }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SnapshotAvatarComponent {
  readonly name = input<string | null | undefined>();
  readonly src = input<string | null | undefined>();
  readonly account = input<string | null | undefined>();
  readonly type = input(UserAvatarType.OTHER);
  readonly domainSource = input<AvatarDomainSource | undefined>();
  readonly loading = input(false);
  private readonly source = computed<AvatarSource>(() => ({
    kind: 'snapshot',
    name: this.name() ?? '',
    imageUrl: this.src() || null,
    account: this.account(),
    type: this.type(),
    domainSource: this.domainSource(),
    loading: this.loading(),
  }));
  readonly view = avatarPresentation(this.source);
}
