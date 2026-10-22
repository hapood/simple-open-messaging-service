import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  OnInit,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  LinkCardGenerationService,
  type LinkCardContent,
  type LinkCardGenerationStatus,
} from '../../services/link-card-generation.service';
import { RouteService } from '../../services/route.service';
import { assetUrl } from '../../services/runtime';
import { linkCardSource } from '../../lib/link-card-display';
import { LinkCardContentComponent } from '../message-cards/link-card-content/link-card-content.component';

export type LinkCardGenerationMode = 'composer' | 'share';

export type LinkCardGenerationDialogResult =
  | { kind: 'link'; generationId: string; content: LinkCardContent }
  | { kind: 'text'; text: string }
  | { kind: 'retry' };

@Component({
  selector: 'app-link-card-generation-dialog',
  standalone: true,
  imports: [TranslocoPipe, LinkCardContentComponent],
  templateUrl: './link-card-generation-dialog.component.html',
  styleUrl: './link-card-generation-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LinkCardGenerationDialogComponent implements OnInit {
  readonly generationId = input.required<string>();
  readonly mode = input<LinkCardGenerationMode>('composer');
  readonly originalText = input('');

  private readonly generations = inject(LinkCardGenerationService);
  private readonly route = inject(RouteService);
  private readonly generation = computed(() =>
    this.generations.state(this.generationId())(),
  );

  readonly status = signal<LinkCardGenerationStatus>('pending');
  readonly content = signal<LinkCardContent | undefined>(undefined);
  /** A failed metadata fetch may still carry a safe default card. Render that card while retaining the
   * failed status for the retry action and the red composer affordance. */
  readonly displayStatus = computed<LinkCardGenerationStatus>(() =>
    this.content() ? 'succeeded' : this.status(),
  );
  readonly faviconSrc = computed(() => assetUrl(this.content()?.favicon));
  readonly source = computed(() =>
    linkCardSource(this.content()?.url ?? '', this.content()?.siteName),
  );
  readonly canConfirm = computed(
    () =>
      this.status() === 'succeeded' ||
      (this.status() === 'failed' &&
        (Boolean(this.content()) ||
          (this.mode() === 'share' && this.originalText().trim().length > 0))),
  );

  private readonly syncGeneration = effect(() => {
    const generation = this.generation();
    if (!generation) return;
    this.status.set(generation.status);
    this.content.set(generation.content);
  });

  ngOnInit(): void {
    if (!this.generation())
      this.generations.resume({
        generationId: this.generationId(),
        status: 'pending',
        expiresAt: Number.MAX_SAFE_INTEGER,
      });
  }

  cancel(): void {
    this.route.closeDlg();
  }

  retry(): void {
    this.route.closeDlg({
      kind: 'retry',
    } satisfies LinkCardGenerationDialogResult);
  }

  confirm(): void {
    const content = this.content();
    if (
      (this.status() === 'succeeded' || this.status() === 'failed') &&
      content
    ) {
      this.route.closeDlg({
        kind: 'link',
        generationId: this.generationId(),
        content,
      } satisfies LinkCardGenerationDialogResult);
      return;
    }
    if (
      this.status() === 'failed' &&
      this.mode() === 'share' &&
      this.originalText().trim()
    ) {
      this.route.closeDlg({
        kind: 'text',
        text: this.originalText(),
      } satisfies LinkCardGenerationDialogResult);
    }
  }
}
