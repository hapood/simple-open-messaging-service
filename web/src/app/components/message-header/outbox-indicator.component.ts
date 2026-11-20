import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import { TaskCountGroupComponent } from './task-count-group.component';

/** Task-only presentation, shared by the header, conversation list, and tail cue. */
@Component({
  selector: 'app-outbox-indicator',
  imports: [NgTemplateOutlet, TranslocoPipe, TaskCountGroupComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (interactive()) {
      <button type="button" class="counts"
        [attr.tabindex]="active() ? 0 : -1"
        [attr.aria-hidden]="!active()"
        [attr.aria-label]="'transfer.openDetails' | transloco"
        (click)="activate($event)">
        <ng-container [ngTemplateOutlet]="counts" />
      </button>
    } @else {
      <span class="counts" [attr.aria-hidden]="!active()">
        <ng-container [ngTemplateOutlet]="counts" />
      </span>
    }
    <ng-template #counts>
      <app-task-count-group [count]="messageCount()" [animate]="animate()">
        <svg viewBox="0 0 24 24" aria-hidden="true" [class.messages-active]="messageCount() > 1">
          <path class="rear" d="M8 4h12v9l-3-2H8z" />
          <path d="M3 7h14v11H7l-4 3z" />
        </svg>
      </app-task-count-group>
      <app-task-count-group [separated]="messageCount() > 0" [count]="uploadCount()" [animate]="animate()">
        <svg viewBox="0 0 24 24" aria-hidden="true" [class.upload-active]="uploadCount() > 0">
          <path d="M4 17v4h16v-4" />
          <path class="arrow" d="M12 17V3m-5 5 5-5 5 5" />
        </svg>
      </app-task-count-group>
      <app-task-count-group class="failures" [count]="visibleFailureCount()" [animate]="animate()">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </app-task-count-group>
    </ng-template>
  `,
  styleUrl: './outbox-indicator.component.scss',
})
export class OutboxIndicatorComponent {
  readonly messageCount = input(0);
  readonly uploadCount = input(0);
  readonly failedCount = input(0);
  readonly interactive = input(true);
  readonly active = input(true);
  readonly animate = input(true);
  readonly openPanel = output<void>();
  readonly visibleFailureCount = computed(() =>
    this.messageCount() + this.uploadCount() === 0 ? this.failedCount() : 0,
  );

  activate(event: Event): void {
    if (!this.interactive() || !this.active()) return;
    event.stopPropagation();
    this.openPanel.emit();
  }
}
