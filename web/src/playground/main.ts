import { bootstrapApplication } from '@angular/platform-browser';
import { playgroundConfig } from './playground.config';
import { PlaygroundShellComponent } from './playground-shell.component';

const projectOverview =
  document.querySelector<HTMLDetailsElement>('.project-overview');
if (projectOverview) {
  document.addEventListener('click', (event) => {
    if (
      event.target instanceof Node &&
      !projectOverview.contains(event.target)
    ) {
      projectOverview.open = false;
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && projectOverview.open) {
      projectOverview.open = false;
      projectOverview.querySelector('summary')?.focus();
    }
  });
}

bootstrapApplication(PlaygroundShellComponent, playgroundConfig).catch(
  (error) => console.error('[playground] bootstrap failed:', error),
);
