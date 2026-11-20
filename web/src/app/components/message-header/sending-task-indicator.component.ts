import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  signal,
  input,
  output,
} from '@angular/core';
import { OutboxIndicatorComponent } from './outbox-indicator.component';

/** Bio/preview flip container. Task graphics and count animation belong to its child. */
@Component({
  selector: 'app-sending-task-indicator',
  standalone: true,
  imports: [OutboxIndicatorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="faces" [class.tasks-visible]="visible()">
      <span class="bio" [attr.title]="bio()" [attr.aria-hidden]="visible()">{{ bio() }}</span>
      <app-outbox-indicator class="tasks"
        [interactive]="interactive()"
        [active]="visible()"
        [animate]="countsAnimate()"
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
  private readonly settledFace = signal<boolean | null>(null);
  readonly countsAnimate = computed(
    () => this.visible() && this.settledFace() === this.visible(),
  );

  constructor() {
    effect((onCleanup) => {
      const face = this.visible();
      this.settledFace.set(null);
      const timer = setTimeout(() => this.settledFace.set(face), 240);
      onCleanup(() => clearTimeout(timer));
    });
  }

  readonly interactive = input(true);
  readonly suppressed = input(false);
  readonly bio = input('');
  readonly composerActive = input(false);
  readonly messageCount = input(0);
  readonly uploadCount = input(0);
  readonly failedCount = input(0);
  readonly openPanel = output<void>();
  readonly visible = computed(
    () => !this.suppressed() && (
      this.composerActive() ||
      this.messageCount() > 0 ||
      this.uploadCount() > 0 ||
      this.failedCount() > 0),
  );
}
