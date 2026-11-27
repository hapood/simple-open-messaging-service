import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { OutboxIndicatorComponent } from '../message-header/outbox-indicator.component';
import { DemandAvatarComponent } from '../user-avatar/demand-avatar.component';
import { UserAvatarType, type AvatarDomainSource } from '../user-avatar/model';
import type { AvatarProfileRef } from '../../services/avatar-profile-ref';

export interface TailOverlapPeerAvatar {
  readonly key: string;
  readonly account: string;
  readonly namespaceId: number;
  readonly domainSource?: AvatarDomainSource;
  readonly profile?: AvatarProfileRef;
}

/**
 * Shared live-tail activity row hosting peer-side incoming 3dots and self-side
 * sending/incoming 3dots on one horizontal line. Adding a second side never
 * adds a second row height.
 */
@Component({
  selector: 'app-tail-activity-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OutboxIndicatorComponent, DemandAvatarComponent, TranslocoPipe],
  template: `
    @if (visible()) {
      <div class="tail-activity-row">
        <div class="tail-side tail-peer">
          @if (peerVisible()) {
            <div class="tail-avatar-slot">
              @if (!peerContinuation()) {
                <app-demand-avatar
                  [profile]="primaryPeerProfile()"
                  [account]="primaryPeerAccount()"
                  [domainSource]="effectivePrimaryPeerDomainSource()"
                  [type]="otherType"
                />
              }
            </div>
            <div
              class="msg-bubble msg-peer tail-bubble"
              [class.msg-tail]="peerContinuation()"
              [class.msg-single]="!peerContinuation()"
            >
              <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
            </div>
            @if (overlapPeers().length > 0 || hasOverflow()) {
              <div class="overlap-avatars" aria-hidden="true">
                @for (peer of overlapPeers(); track peer.key) {
                  <span class="overlap-avatar">
                    <app-demand-avatar
                      [profile]="peer.profile"
                      [account]="peer.account"
                      [domainSource]="overlapPeerDomainSource(peer)"
                      [type]="otherType"
                    />
                  </span>
                }
                @if (hasOverflow()) {
                  <span class="overlap-more">…</span>
                }
              </div>
            }
          }
        </div>

        <div class="tail-side tail-self">
          @if (selfVisible()) {
            <div
              class="msg-bubble msg-self tail-bubble"
              [class.msg-tail]="selfContinuation()"
              [class.msg-single]="!selfContinuation()"
            >
              <div class="cue-content">
                @if (selfDotsVisible()) {
                  <button
                    type="button"
                    class="dots"
                    [attr.aria-label]="'transfer.openDetails' | transloco"
                    (click)="openPanel.emit()"
                  >
                    <i></i><i></i><i></i>
                  </button>
                }
                <app-outbox-indicator
                  [messageCount]="showOutboxIndicator() ? summary().messageCount : 0"
                  [uploadCount]="showOutboxIndicator() ? summary().uploadCount : 0"
                  [failedCount]="summary().failedCount"
                  (openPanel)="openPanel.emit()"
                />
              </div>
            </div>
            <div class="tail-avatar-slot">
              @if (!selfContinuation()) {
                <app-demand-avatar [type]="selfType" />
              }
            </div>
          }
        </div>
      </div>
    }
  `,
  styles: `
    @use '../message-cards/row-base';
    :host {
      display: block;
    }
    .tail-activity-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      height: 40px;
      min-height: 40px;
      line-height: 20px;
      padding: 0 12px;
      box-sizing: border-box;
    }
    .tail-side {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 40px;
      min-width: 0;
    }
    .tail-self {
      margin-left: auto;
      justify-content: flex-end;
    }
    .tail-avatar-slot {
      width: 36px;
      height: 36px;
      flex: 0 0 36px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .tail-bubble {
      width: max-content;
      overflow: hidden;
      box-sizing: border-box;
      height: 40px;
      padding: 10px 12px;
      line-height: 20px;
    }
    .cue-content {
      display: flex;
      align-items: center;
      gap: 12px;
      width: max-content;
      height: 20px;
      line-height: 20px;
    }
    .dots {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 20px;
      border: 0;
      padding: 0;
      background: transparent;
      color: inherit;
    }
    button.dots {
      cursor: pointer;
    }
    .dots i {
      display: block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      animation: tail-dot-pulse 1100ms ease-in-out infinite;
    }
    .dots i:nth-child(2) {
      animation-delay: 140ms;
    }
    .dots i:nth-child(3) {
      animation-delay: 280ms;
    }
    .overlap-avatars {
      display: inline-flex;
      align-items: center;
      height: 24px;
      line-height: 24px;
    }
    .overlap-avatar {
      display: inline-flex;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      overflow: hidden;
      flex: 0 0 24px;
      animation: tail-avatar-fade 160ms ease-out;
    }
    .overlap-avatar + .overlap-avatar {
      margin-left: -8px;
    }
    .overlap-more {
      margin-left: 4px;
      height: 24px;
      line-height: 24px;
      font-size: 14px;
      opacity: 0.72;
    }
    @keyframes tail-dot-pulse {
      0%,
      100% {
        transform: scale(0.65);
        opacity: 0.45;
      }
      50% {
        transform: scale(1);
        opacity: 1;
      }
    }
    @keyframes tail-avatar-fade {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .dots i,
      .overlap-avatar {
        animation: none;
      }
    }
  `,
})
export class TailActivityRowComponent {
  readonly enabled = input(false);
  readonly selfVisible = input(false);
  readonly selfDotsVisible = input(false);
  readonly selfContinuation = input(false);
  readonly summary = input({ messageCount: 0, uploadCount: 0, failedCount: 0 });
  readonly peerVisible = input(false);
  readonly peerContinuation = input(false);
  readonly primaryPeerProfile = input<AvatarProfileRef | undefined>(undefined);
  readonly primaryPeerAccount = input<string | null>(null);
  readonly primaryPeerNamespaceId = input<number | null>(null);
  readonly primaryPeerDomainSource = input<AvatarDomainSource | undefined>(
    undefined,
  );
  readonly overlapPeers = input<readonly TailOverlapPeerAvatar[]>([]);
  readonly hasOverflow = input(false);
  readonly openPanel = output<void>();

  protected readonly selfType = UserAvatarType.SELF;
  protected readonly otherType = UserAvatarType.OTHER;

  protected readonly effectivePrimaryPeerDomainSource = computed<
    AvatarDomainSource | undefined
  >(() => {
    const explicit = this.primaryPeerDomainSource();
    if (explicit) return explicit;
    const namespaceId = this.primaryPeerNamespaceId();
    return namespaceId === null
      ? undefined
      : { type: 'namespace', namespaceId };
  });

  protected overlapPeerDomainSource(
    peer: TailOverlapPeerAvatar,
  ): AvatarDomainSource {
    return (
      peer.domainSource ?? {
        type: 'namespace',
        namespaceId: peer.namespaceId,
      }
    );
  }

  protected readonly visible = computed(
    () => this.enabled() && (this.selfVisible() || this.peerVisible()),
  );

  protected readonly activeCount = computed(
    () => this.summary().messageCount + this.summary().uploadCount,
  );

  protected readonly showOutboxIndicator = computed(
    () =>
      this.activeCount() > (this.selfDotsVisible() ? 1 : 0) ||
      (this.activeCount() === 0 && this.summary().failedCount > 0),
  );
}
