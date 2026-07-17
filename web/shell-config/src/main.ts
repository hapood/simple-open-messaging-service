import { bootstrapApplication } from '@angular/platform-browser';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideTransloco } from '@jsverse/transloco';
import { AppComponent } from './app/app.component';
import { ScLoader } from './app/sc-loader';

/**
 * Bootstrap the shell-config `init` window — the bundled first-run / reconfigure UI. Material
 * (animations) + transloco (en/zh-CN inline) + HttpClient (withFetch, so the bootstrap's raw fetch to
 * the user-typed backend for a reachability probe rides the same fetch path). All hard work
 * (compat/cert/download/verify/install) lives in Rust via tauriInvoke — the bootstrap only orchestrates
 * the 3 steps + renders progress.
 */
function detectLang(): string {
  if (typeof navigator === 'undefined') return 'en';
  const n = (navigator.language || 'en').toLowerCase();
  return n.indexOf('zh') === 0 ? 'zh-CN' : 'en';
}

bootstrapApplication(AppComponent, {
  providers: [
    provideAnimationsAsync(),
    provideHttpClient(withFetch()),
    provideTransloco({
      config: {
        availableLangs: ['en', 'zh-CN'],
        defaultLang: detectLang(),
        reRenderOnLangChange: true,
        prodMode: true,
      },
      loader: ScLoader,
    }),
  ],
}).catch((err) => console.error('shell-config bootstrap failed', err));
