import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { OutboxIndicatorComponent } from './outbox-indicator.component';

/** Interruptible bio/preview flip container; task status graphics belong to its child. */
@Component({
  selector: 'app-sending-task-indicator',
  standalone: true,
  imports: [OutboxIndicatorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.empty]': 'empty()',
  },
  template: `
    <div
      class="faces"
      [class.tasks-visible]="visible()"
      [class.fade-only]="!hasBio()"
    >
      <span class="bio" [attr.title]="bio()" [attr.aria-hidden]="visible()">{{
        bio()
      }}</span>
      <app-outbox-indicator
        class="tasks"
        [interactive]="interactive()"
        [active]="visible()"
        [unavailable]="unavailable()"
        [messageCount]="messageCount()"
        [uploadCount]="uploadCount()"
        [failedCount]="failedCount()"
        (openPanel)="openPanel.emit()"
      />
    </div>
  `,
  styleUrl: './sending-task-indicator.component.scss',
})
export class SendingTaskIndicatorComponent {
  readonly unavailable = input(false);
  readonly interactive = input(true);
  readonly suppressed = input(false);
  readonly bio = input('');
  readonly composerActive = input(false);
  readonly messageCount = input(0);
  readonly uploadCount = input(0);
  readonly failedCount = input(0);
  readonly openPanel = output<void>();
  readonly hasBio = computed(() => this.bio().trim().length > 0);
  readonly visible = computed(
    () =>
      !this.suppressed() &&
      (this.composerActive() ||
        this.messageCount() > 0 ||
        this.uploadCount() > 0 ||
        this.failedCount() > 0),
  );
  readonly empty = computed(() => !this.hasBio() && !this.visible());
}
