import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './services/theme.service';
import { LanguageService } from './services/language.service';
@Component({
    selector: 'app-root',
    imports: [RouterOutlet],
    templateUrl: './app.component.html',
    styleUrl: './app.component.scss'
})
export class AppComponent {
    // Eagerly instantiate so their effects + listeners are live for the whole session.
    private readonly theme = inject(ThemeService);
    private readonly language = inject(LanguageService);
}
