import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  signal,
} from '@angular/core';
import { UserAvatarType } from './model';
import {
  avatarBackground,
  avatarGroupFill,
  avatarInitial,
  type AvatarView,
} from './avatar-view';

/** Pure paint layer: images, initials and explicit badges. Never resolves identities. */
@Component({
  selector: 'app-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './avatar.component.html',
  styleUrl: './avatar.component.scss',
})
export class AvatarComponent {
  readonly view = input.required<AvatarView>();
  readonly loading = computed(() => this.view().loading ?? false);
  readonly effectiveName = computed(() => this.view().name);
  readonly imgSrc = computed(() => this.view().imageUrl ?? '');
  readonly federatedMarkerDomain = computed(() => this.view().federatedDomain);
  readonly isGroup = computed(() => this.view().type === UserAvatarType.GROUP);
  readonly initial = computed(() => avatarInitial(this.view().name));
  readonly bg = computed(() => avatarBackground(this.view()));
  readonly groupFill = computed(() => avatarGroupFill(this.view()));
  readonly imgFailed = signal(false);
  readonly showImage = computed(() => !!this.imgSrc() && !this.imgFailed());

  constructor() {
    effect(() => {
      this.imgSrc();
      this.view().colorKey;
      this.imgFailed.set(false);
    });
  }
}
