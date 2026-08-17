import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { CallAdapterService } from '../../services/call-adapter';
import { CallEventService } from '../../services/call-event.service';
import { CallPresentationService } from '../../services/call-presentation.service';
import { AppIconType, IconComponent } from '../icon/icon.component';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';

@Component({
  selector: 'app-call-banner',
  imports: [IconComponent, TranslocoModule, UserAvatarComponent],
  template: `
    @if (visible()) {
      <div class="call-banner" role="status">
        <button class="call-summary" type="button" (click)="presentation.restore()" [attr.aria-label]="'call.returnToCall' | transloco">
          <span class="avatar"><app-user-avatar [type]="UserAvatarType.OTHER" [name]="state().peerName || '?'" [identityId]="state().peerUserId" [src]="state().peerAvatar"></app-user-avatar></span>
          <span class="copy"><strong>{{ state().peerName || ('call.audioCall' | transloco) }}</strong><span>{{ status() }}</span></span>
        </button>
        @if (state().phase === 'incoming') {
          <button class="action decline" type="button" (click)="decline()" [attr.aria-label]="'call.decline' | transloco"><app-icon [type]="AppIconType.PHONE_END" [style]="iconSize"></app-icon></button>
          <button class="action accept" type="button" (click)="accept()" [attr.aria-label]="'call.accept' | transloco"><app-icon [type]="AppIconType.PHONE" [style]="iconSize"></app-icon></button>
        } @else if (state().phase !== 'ended') {
          <button class="action end" type="button" (click)="hangUp()" [attr.aria-label]="'call.end' | transloco"><app-icon [type]="AppIconType.PHONE_END" [style]="iconSize"></app-icon></button>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: block; flex: 0 0 auto; background: var(--app-surface); }
    .call-banner { min-height: 48px; box-sizing: border-box; display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--app-border); color: var(--app-text); background: color-mix(in srgb, var(--app-brand) 9%, var(--app-surface)); }
    .call-summary { min-width: 0; flex: 1; display: flex; align-items: center; gap: 8px; padding: 0; border: 0; color: inherit; text-align: left; background: transparent; }
    .avatar { width: 36px; height: 36px; flex: 0 0 36px; overflow: hidden; border-radius: 18px; }
    .copy { min-width: 0; display: flex; flex-direction: column; }
    .copy strong { overflow: hidden; font-size: 14px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
    .copy span { overflow: hidden; font-size: 12px; line-height: 16px; color: var(--app-text-muted); text-overflow: ellipsis; white-space: nowrap; }
    .action { width: 36px; height: 36px; flex: 0 0 36px; display: grid; place-items: center; border: 0; border-radius: 18px; color: #fff; background: var(--app-danger, #dc2626); }
    .accept { background: var(--app-success, #16a34a); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallBannerComponent {
  readonly events = inject(CallEventService);
  readonly adapter = inject(CallAdapterService);
  readonly presentation = inject(CallPresentationService);
  private readonly transloco = inject(TranslocoService);
  readonly state = computed(() => this.events.callState());
  readonly visible = computed(() => this.presentation.minimized() && this.state().phase !== 'idle');
  readonly AppIconType = AppIconType;
  readonly UserAvatarType = UserAvatarType;
  readonly iconSize = { width: '20px', height: '20px' };
  readonly status = computed(() => this.transloco.translate(`call.${this.state().phase}`));

  accept(): void { const sid = this.state().callSid; if (sid) this.adapter.accept(sid); }
  decline(): void { const sid = this.state().callSid; if (sid) { this.events.markLocalTermination(sid); this.adapter.decline(sid); } }
  hangUp(): void {
    const state = this.state();
    const sid = state.callSid;
    if (!sid) return;
    this.events.markLocalTermination(sid);
    if (state.phase === 'starting' || state.phase === 'calling' || state.phase === 'ringing') this.adapter.cancel(sid);
    else this.adapter.end(sid, 'completed');
  }
}
