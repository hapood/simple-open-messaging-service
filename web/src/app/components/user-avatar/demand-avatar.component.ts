import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { UserService } from '../../services/user.service';
import type { AvatarProfileRef } from '../../services/avatar-profile-ref';
import { AvatarComponent } from './avatar.component';
import { avatarPresentation } from './avatar-presentation';
import { UserAvatarType, type AvatarDomainSource } from './model';
import type { AvatarSource } from './avatar-source';

/** Profile-backed avatar. Session selection belongs here, never in the paint layer. */
@Component({
  selector: 'app-demand-avatar',
  imports: [AvatarComponent],
  template: '<app-avatar [view]="view()" />',
  styles: ':host { display: block; width: 100%; height: 100%; }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DemandAvatarComponent {
  private readonly user = inject(UserService);
  readonly profile = input<AvatarProfileRef | undefined>();
  readonly name = input<string | null | undefined>();
  readonly account = input<string | null | undefined>();
  readonly type = input(UserAvatarType.OTHER);
  readonly domainSource = input<AvatarDomainSource | undefined>();
  readonly loading = input(false);
  private readonly source = computed<AvatarSource>(() => {
    const self =
      this.type() === UserAvatarType.SELF
        ? this.user.sessionProfile()
        : undefined;
    const profile =
      this.profile() ??
      (self && (self.profileRev ?? 0) > 0
        ? {
            account: self.account,
            publisherNamespaceId: 0,
            profileNamespaceId: 0,
            rev: self.profileRev!,
            linked: true,
          }
        : undefined);
    const appearance = {
      type: this.type(),
      account: this.account() ?? self?.account,
      domainSource: this.domainSource(),
      loading: this.loading(),
    };
    const name = this.name() || self?.name || appearance.account || '';
    return profile
      ? { ...appearance, kind: 'demand', profile, fallbackName: name }
      : { ...appearance, kind: 'snapshot', name, imageUrl: null };
  });
  readonly view = avatarPresentation(this.source);
}
