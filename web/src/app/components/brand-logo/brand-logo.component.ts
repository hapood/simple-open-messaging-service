import { Component, input, ChangeDetectionStrategy } from '@angular/core';

/**
 * Brand logo: "SOMS" wordmark + optional tagline, with the mark rendered from
 * the single shared asset web/public/logo.svg (the same source the favicon /
 * PWA / Tauri icons are generated from), so there is exactly one mark SVG.
 *
 * The mark's warm neutral bubble and accent are baked into logo.svg rather than
 * exposed as theme variables. Text color/size are exposed via CSS variables
 * (--bl-word / --bl-tag / --bl-*-color); overriding them on the brand-gradient
 * panel (auth-brand white text) only requires setting these variables on the
 * host — no ::ng-deep needed.
 */
@Component({
  selector: 'app-brand-logo',
  imports: [],
  templateUrl: './brand-logo.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './brand-logo.component.scss',
})
export class BrandLogoComponent {
  /** Size of the logo mark in px */
  readonly size = input(80);
  /** Whether to show the "SOMS" wordmark */
  readonly wordmark = input(true);
  /** Subtitle below the wordmark (plain text) */
  readonly tagline = input('');
}
