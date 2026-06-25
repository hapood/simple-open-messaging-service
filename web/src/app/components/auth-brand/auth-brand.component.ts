import { Component } from '@angular/core';

/**
 * Decorative brand panel shared by the login & register split-screen shells.
 * Renders only branding (mark + wordmark + tagline) and hides itself below the
 * auth breakpoint, so it carries no behaviour and is safe to mark aria-hidden.
 */
@Component({
    selector: 'app-auth-brand',
    imports: [],
    templateUrl: './auth-brand.component.html',
    styleUrl: './auth-brand.component.scss'
})
export class AuthBrandComponent {}
