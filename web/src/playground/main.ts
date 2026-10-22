import { bootstrapApplication } from '@angular/platform-browser';
import { playgroundConfig } from './playground.config';
import { PlaygroundRootComponent } from './playground-root.component';

bootstrapApplication(PlaygroundRootComponent, playgroundConfig).catch(
  (error) => console.error('[playground] bootstrap failed:', error),
);
