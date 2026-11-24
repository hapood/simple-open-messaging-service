import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Height-neutral circular progress shared by every thumbnail size. */
@Component({
  selector: 'app-thumbnail-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      viewBox="0 0 40 40"
      role="progressbar"
      [attr.aria-valuenow]="value()"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <circle class="track" cx="20" cy="20" r="18" />
      <circle
        class="value"
        cx="20"
        cy="20"
        r="18"
        pathLength="100"
        [class.indeterminate]="value() === null"
        [attr.stroke-dasharray]="(value() ?? 25) + ' 100'"
      />
    </svg>
  `,
  styles: `
    :host {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
      fill: none;
      stroke-width: 2;
    }
    .track {
      stroke: currentColor;
      opacity: 0.2;
    }
    .value {
      stroke: var(--app-brand, currentColor);
      transform: rotate(-90deg);
      transform-origin: center;
    }
    .indeterminate {
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      to {
        transform: rotate(270deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .indeterminate {
        animation: none;
      }
    }
  `,
})
export class ThumbnailProgressComponent {
  readonly value = input<number | null>(null);
}
