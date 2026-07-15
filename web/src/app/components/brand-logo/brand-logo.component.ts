import { Component, input } from '@angular/core';

/**
 * Brand logo: "SOMS" wordmark + optional tagline, with the mark rendered from
 * the single shared asset web/public/logo.svg (the same source the favicon /
 * PWA / Tauri icons are generated from), so there is exactly one mark SVG.
 *
 * The mark's background is the fixed brand blue baked into logo.svg (#2196f3 —
 * not a theme variable). Text color/size are exposed via CSS variables
 * (--bl-word / --bl-tag / --bl-*-color); overriding them on the brand-gradient
 * panel (auth-brand white text) only requires setting these variables on the
 * host — no ::ng-deep needed.
 */
@Component({
  selector: 'app-brand-logo',
  imports: [],
  templateUrl: './brand-logo.component.html',
  styleUrl: './brand-logo.component.scss',
})
export class BrandLogoComponent {
  /** Size of the logo mark in px */
  readonly size = input(64)
  /** Whether to show the "SOMS" wordmark */
  readonly wordmark = input(true)
  /** Subtitle below the wordmark (plain text) */
  readonly tagline = input('')
}
