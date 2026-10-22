import { Component, ChangeDetectionStrategy } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { BrandLogoComponent } from '../brand-logo/brand-logo.component';

/**
 * Decorative brand panel shared by the login & register split-screen shells.
 * Renders only branding (mark + wordmark + tagline) and hides itself below the
 * auth breakpoint, so it carries no behaviour and is safe to mark aria-hidden.
 * The logo itself comes from <app-brand-logo>; this component only provides the brand
 * page's gradient background and white-text overlay.
 */
@Component({
  selector: 'app-auth-brand',
  imports: [BrandLogoComponent, TranslocoPipe],
  templateUrl: './auth-brand.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './auth-brand.component.scss',
})
export class AuthBrandComponent {}
