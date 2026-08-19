import {
  Component,
  computed,
  input,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import type { LinkCardContent } from '../../../services/link-card-generation.service';
import { assetUrl } from '../../../services/runtime';

/** Shared production rendering for the body of a delivered LINK card and its generation preview. */
@Component({
  selector: 'app-link-card-content',
  standalone: true,
  templateUrl: './link-card-content.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './link-card-content.component.scss',
})
export class LinkCardContentComponent {
  readonly content = input<LinkCardContent>();
  readonly loading = input(false);

  readonly imageFailed = signal(false);
  readonly imageSrc = computed(() => assetUrl(this.content()?.image));

  onImageError(): void {
    this.imageFailed.set(true);
  }
}
