import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';

/** Task-only presentation shared by header, conversation list and tail cue. */
@Component({
  selector: 'app-outbox-indicator',
  imports: [NgTemplateOutlet, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (interactive()) {
      <button
        type="button"
        class="status"
        [attr.tabindex]="active() ? 0 : -1"
        [attr.aria-hidden]="!active()"
        [attr.aria-label]="'transfer.openDetails' | transloco"
        (click)="activate($event)"
      >
        <ng-container [ngTemplateOutlet]="graphic" />
      </button>
    } @else {
      <span class="status" [attr.aria-hidden]="!active()">
        <ng-container [ngTemplateOutlet]="graphic" />
      </span>
    }
    <ng-template #graphic>
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        [class.unavailable]="showError()"
      >
        <circle class="ring" cx="12" cy="12" r="9" />
        <g class="spinner"><circle cx="12" cy="12" r="9" /></g>
        <path class="cross" d="m8 8 8 8M16 8l-8 8" />
      </svg>
    </ng-template>
  `,
  styleUrl: './outbox-indicator.component.scss',
})
export class OutboxIndicatorComponent {
  readonly messageCount = input(0);
  readonly uploadCount = input(0);
  readonly failedCount = input(0);
  readonly unavailable = input(false);
  readonly interactive = input(true);
  readonly active = input(true);
  readonly openPanel = output<void>();
  readonly showError = computed(
    () =>
      this.unavailable() ||
      (this.failedCount() > 0 &&
        this.messageCount() + this.uploadCount() === 0),
  );

  activate(event: Event): void {
    if (!this.interactive() || !this.active()) return;
    event.stopPropagation();
    this.openPanel.emit();
  }
}
