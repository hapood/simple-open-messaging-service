import { Component, input } from '@angular/core';

/**
 * Single source of truth for the brand logo: mark (blue-background white-bubble SVG) + "SOMS" wordmark + optional tagline.
 * Extracted from auth-brand and shared by the auth-page brand panel and the chat-pane empty state, so the two
 * SVG copies cannot drift.
 *
 * The mark's background color is hardcoded #2196f3 (matches the favicon — an intentional fixed brand color, not a
 * theme variable). Text color/size are exposed via CSS variables (--bl-word / --bl-tag / --bl-*-color); overriding
 * them on the brand-gradient panel (auth-brand white text) only requires setting these variables on the host — no
 * ::ng-deep needed.
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
