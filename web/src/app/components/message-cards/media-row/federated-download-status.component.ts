import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  viewChild,
} from '@angular/core';
import { MEDIA_STATUS } from '../chat-item';

/** Paint-only server localization feedback; never participates in history geometry. */
@Component({
  selector: 'app-federated-download-status',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span
    #icon
    aria-hidden="true"
    [class.downloading]="status() === downloading"
  >
    <svg viewBox="0 0 24 24">
      <circle #ring cx="12" cy="12" r="9" />
      <path #check d="M5 12l4 4L19 6" />
    </svg>
  </span>`,
  styles: `
    :host {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 16px;
      height: 16px;
      pointer-events: none;
      z-index: 3;
    }
    span,
    svg {
      display: block;
      width: 16px;
      height: 16px;
    }
    span {
      opacity: 0;
      color: var(--app-text-muted);
    }
    svg {
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
    }
    path {
      opacity: 0;
    }
    .downloading {
      opacity: 1;
    }
    .downloading circle {
      stroke-dasharray: 42 15;
      transform-origin: center;
      animation: spin 800ms linear infinite;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .downloading circle {
        animation: none;
      }
    }
  `,
})
export class FederatedDownloadStatusComponent {
  readonly status = input.required<string>();
  readonly messageId = input.required<number>();
  readonly downloading = MEDIA_STATUS.DOWNLOADING;
  private readonly icon = viewChild<ElementRef<HTMLElement>>('icon');
  private readonly ring = viewChild<ElementRef<SVGElement>>('ring');
  private readonly check = viewChild<ElementRef<SVGElement>>('check');
  private previous: { id: number; status: string } | undefined;

  constructor() {
    effect((onCleanup) => {
      const status = this.status();
      const id = this.messageId();
      const icon = this.icon()?.nativeElement;
      const ring = this.ring()?.nativeElement;
      const check = this.check()?.nativeElement;
      if (!icon || !ring || !check) return;
      const complete =
        this.previous !== undefined &&
        this.previous.id === id &&
        this.previous.status === MEDIA_STATUS.DOWNLOADING &&
        status === MEDIA_STATUS.READY;
      this.previous = { id, status };
      if (!complete) return;
      const motion = matchMedia('(prefers-reduced-motion: reduce)');
      if (motion.matches) return;
      const animations = [
        icon.animate([{ opacity: 1 }, { opacity: 1 }], { duration: 1200 }),
        ring.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 400,
          fill: 'forwards',
        }),
        check.animate(
          [{ opacity: 0 }, { opacity: 1, offset: 1 / 3 }, { opacity: 0 }],
          { duration: 1200, easing: 'ease-out' },
        ),
      ];
      const cancel = () =>
        animations.forEach((animation) => animation.cancel());
      animations[0].onfinish = cancel;
      motion.addEventListener('change', cancel);
      onCleanup(() => {
        motion.removeEventListener('change', cancel);
        animations[0].onfinish = null;
        cancel();
      });
    });
  }
}
