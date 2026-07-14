import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { initEruda } from './app/dev-tools';
import { applySafeInsets } from './app/services/runtime';

// Apply native system-bar insets (Android WebView: status-bar height from the Kotlin SomsShell bridge)
// to :root BEFORE bootstrap, so the first paint already has --soms-safe-top (FOUC-free). No-op in the
// browser build (no SomsShell → the CSS default env() applies there).
applySafeInsets();

// Dev-only tools (eruda in-page console) initialize before bootstrap so they capture every startup
// console line. In the production build `dev-tools.ts` is replaced by `dev-tools.prod.ts`
// (initEruda is a no-op there), so this call contributes no code and no bytes to the prod bundle —
// eruda is not imported, not emitted, and not prefetched by ngsw.
initEruda().finally(() => {
  bootstrapApplication(AppComponent, appConfig)
    .catch((err) => console.error(err));
});
