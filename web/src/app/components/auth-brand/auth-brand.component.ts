import { Component } from '@angular/core';
import { BrandLogoComponent } from '../brand-logo/brand-logo.component';

/**
 * Decorative brand panel shared by the login & register split-screen shells.
 * Renders only branding (mark + wordmark + tagline) and hides itself below the
 * auth breakpoint, so it carries no behaviour and is safe to mark aria-hidden.
 * Logo 本体由 <app-brand-logo> 提供，此组件只负责品牌页的渐变背景与白字覆盖。
 */
@Component({
    selector: 'app-auth-brand',
    imports: [BrandLogoComponent],
    templateUrl: './auth-brand.component.html',
    styleUrl: './auth-brand.component.scss'
})
export class AuthBrandComponent {}
