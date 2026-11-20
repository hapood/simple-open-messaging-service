import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterRenderEffect, computed, inject, input, output } from '@angular/core';
import { OutboxIndicatorComponent } from '../message-header/outbox-indicator.component';
import { DemandAvatarComponent } from '../user-avatar/demand-avatar.component';
import { UserAvatarType } from '../user-avatar/model';
import { TranslocoPipe } from '@jsverse/transloco';

@Component({
  selector: 'app-tail-sending-cue',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OutboxIndicatorComponent, DemandAvatarComponent, TranslocoPipe],
  template: `
    @if (enabled() && (activeCount() > 0 || summary().failedCount > 0)) {
      <div class="msg-row msg-self" [class.msg-has-avatar]="!continuation()" [class.msg-group-start]="!continuation()">
        <div class="msg-col">
          <div class="msg-bubble msg-self" [class.msg-tail]="continuation()" [class.msg-single]="!continuation()"><div class="cue-content">
            @if (activeCount() > 0) {
              <button type="button" class="dots" [attr.aria-label]="'transfer.openDetails' | transloco" (click)="openPanel.emit()"><i></i><i></i><i></i></button>
            }
            @if (activeCount() > 1 || activeCount() === 0) {
              <app-outbox-indicator
                [messageCount]="summary().messageCount"
                [uploadCount]="summary().uploadCount"
                [failedCount]="summary().failedCount"
                (openPanel)="openPanel.emit()"
              />
            }
          </div></div>
        </div>
        @if (!continuation()) {
          <div class="msg-avatar"><app-demand-avatar [type]="selfType" /></div>
        }
      </div>
    }
  `,
  styles: `
    @use '../message-cards/row-base';
    :host { display: block; }
    .msg-bubble { width: max-content; overflow: hidden;
      box-sizing: border-box; height: 40px; padding: 10px 12px; }
    .cue-content { display: flex; align-items: center; gap: 12px;
      width: max-content; height: 20px; line-height: 20px; }
    .dots { display: flex; align-items: center; gap: 4px; height: 20px;
      border: 0; padding: 0; background: transparent; color: inherit; cursor: pointer; }
    i { display: block; width: 6px; height: 6px; border-radius: 50%; background: currentColor;
      animation: pulse 1100ms ease-in-out infinite; }
    i:nth-child(2) { animation-delay: 140ms; }
    i:nth-child(3) { animation-delay: 280ms; }
    @keyframes pulse { 0%, 100% { transform: scale(.65); opacity: .45; }
      50% { transform: scale(1); opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { i { animation: none; } }
  `,
})
export class TailSendingCueComponent {
  constructor() {
    const host: HTMLElement = inject(ElementRef).nativeElement;
    let width: number | undefined;
    let animation: Animation | undefined;
    let observed: HTMLElement | null = null;
    const observer = new ResizeObserver(() => {
      if (!observed) return;
      const content = observed.querySelector<HTMLElement>('.cue-content');
      if (!content) return;
      const next = content.offsetWidth + 24;
      if (width !== undefined && next !== width && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const from = parseFloat(getComputedStyle(observed).width) || width;
        animation?.cancel();
        animation = observed.animate([{ width: `${from}px` }, { width: `${next}px` }],
          { duration: 180, easing: 'ease-out' });
      }
      width = next;
    });
    afterRenderEffect(() => {
      this.enabled();
      this.activeCount();
      this.summary();
      const bubble = host.querySelector<HTMLElement>('.msg-bubble');
      if (observed === bubble) return;
      observer.disconnect();
      animation?.cancel();
      observed = bubble;
      width = undefined;
      const content = bubble?.querySelector<HTMLElement>('.cue-content');
      if (content) observer.observe(content);
    });
    inject(DestroyRef).onDestroy(() => { observer.disconnect(); animation?.cancel(); });
  }

  readonly enabled = input(false);
  readonly continuation = input(false);
  readonly summary = input({ messageCount: 0, uploadCount: 0, failedCount: 0 });
  readonly openPanel = output<void>();
  readonly selfType = UserAvatarType.SELF;
  readonly activeCount = computed(() => this.summary().messageCount + this.summary().uploadCount);
}
