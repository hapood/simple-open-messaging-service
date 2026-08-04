import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { A11yModule } from '@angular/cdk/a11y';
import { TranslocoPipe } from '@jsverse/transloco';
import { RouteService } from '../../services/route.service';

/** Renders conversation-scoped dialogs inside the chatbox, leaving its composer visible below the scrim. */
@Component({
  selector: 'app-chatbox-popup',
  standalone: true,
  imports: [A11yModule, NgComponentOutlet, TranslocoPipe],
  templateUrl: './chatbox-popup.component.html',
  styleUrl: './chatbox-popup.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatboxPopupComponent {
  readonly threadId = input<number>();
  private readonly route = inject(RouteService);

  protected readonly dialogs = computed(() => {
    const threadId = this.threadId();
    if (threadId === undefined) return [];
    return this.route
      .dlgList()
      .filter(
        (dialog) =>
          dialog.presentation === 'chatbox' &&
          dialog.scopeThreadId === threadId,
      );
  });

  protected cancelTop(): void {
    if (this.dialogs().length) this.route.closeDlg();
  }
}
