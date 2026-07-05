import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './services/theme.service';
import { LanguageService } from './services/language.service';
import { UpdateService } from './services/update.service';
import { PushService } from './services/push.service';
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
    // UpdateService subscribes to SwUpdate.versionUpdates (a hot stream) — eagerly constructed so a
    // VERSION_READY emitted before the home shell mounts is not missed.
    private readonly updates = inject(UpdateService);
    // PushService.init() registers the FCM token-handoff hooks + recovers any cold-start deep link. Runs
    // once at boot; a no-op outside the Tauri shell (the hooks are never triggered by the browser).
    private readonly push = inject(PushService);
    constructor() {
        this.push.init();
    }
}
