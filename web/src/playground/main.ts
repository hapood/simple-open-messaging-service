import { bootstrapApplication } from '@angular/platform-browser';
import { playgroundConfig } from './playground.config';
import { PlaygroundShellComponent } from './playground-shell.component';

bootstrapApplication(PlaygroundShellComponent, playgroundConfig).catch(
  (error) => console.error('[playground] bootstrap failed:', error),
);
