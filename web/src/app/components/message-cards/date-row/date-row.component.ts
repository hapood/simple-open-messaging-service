import {
  ChangeDetectorRef,
  Component,
  computed,
  effect,
  inject,
  input,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { LanguageService } from '../../../services/language.service';
import { formatDateSeparator } from '../date-format';

/**
 * Date separator row (centered pill).
 *
 * Receives the message timestamp (`ms`) and computes the localized label itself. Owning the formatting here —
 * rather than receiving a precomputed string from the createItem factory — is what makes the pill reactive to a
 * runtime language switch: the `label` computed reads the {@link LanguageService} language signal.
 *
 * The chatbox kernel mounts this row imperatively (createComponent + detectChanges) outside Angular's template
 * change-detection tree, so the {@link effect} below explicitly marks this view dirty + drives a synchronous
 * detectChanges on a language change — a guarantee that does NOT depend on whether a detached host view is in the
 * zoneless scheduler's flush set.
 *
 * Vertical spacing is padding, not margin (offsetHeight excludes margin, otherwise the next bubble stacks up —
 * see the cb-element-border-box memory).
 */
@Component({
  selector: 'app-msg-date-row',
  standalone: true,
  template: `
    <div class="msg-date">
      <span>{{ label() }}</span>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './date-row.component.scss',
})
export class DateRowComponent {
  /** The message timestamp the pill labels. */
  readonly ms = input.required<number>();

  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);
  private readonly cdr = inject(ChangeDetectorRef);

  /** Localized label; re-evaluates on a language switch via the tracked language signal. */
  readonly label = computed(() => {
    this.language.lang(); // track → recompute on language change
    return formatDateSeparator(this.ms(), this.transloco);
  });

  constructor() {
    // Self-refresh on a language switch. Imperatively-mounted rows (chatbox kernel) live outside the
    // template CD tree, so we can't rely on the zoneless scheduler to flush them — force it.
    effect(() => {
      this.language.lang();
      this.cdr.markForCheck();
      this.cdr.detectChanges();
    });
  }
}
