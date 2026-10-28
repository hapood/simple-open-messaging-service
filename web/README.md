# Web

This project was generated with [Angular CLI](https://github.com/angular/angular-cli) version 18.2.0.

## Development server

Run `ng serve` for a dev server. Navigate to `http://localhost:4200/`. The application will automatically reload if you change any of the source files.

## Code scaffolding

Run `ng generate component component-name` to generate a new component. You can also use `ng generate directive|pipe|service|class|guard|interface|enum|module`.

## Build

Run `ng build` to build the project. The build artifacts will be stored in the `dist/` directory.

## API types

With the backend serving `http://localhost:3000/api/v1/docs-json`, run `npm run gen:api`
from this directory to update `src/app/services/api-types.ts`. This command installs the
generator's locked dependencies on demand. They use TypeScript 5 in an isolated tool
directory because the frontend uses TypeScript 6. Normal frontend installation and
Docker builds use the checked-in generated types and do not install the generator.

## Running unit tests

Install the pinned frontend dependencies with `npm ci`, then run
`npm run test:browser:install` once to download Chromium. Linux CI also installs the
browser's system dependencies with `npm exec -- playwright install --with-deps chromium`.

- `npm test` runs Angular component/service tests through the Angular builder and Vitest
  Browser Mode in headless Chromium. Use `npm run test:watch` for continuous runs or
  `npm test -- --include src/app/services/layout.service.spec.ts` for a focused run.
- `npm run test:unit` runs the explicitly selected pure TypeScript tests in Node.js.
- `npm run test:build` runs Node.js build-script and static HTML contract tests. Static HTML
  is parsed with `parse5`; it does not need a simulated browser environment.

Component and storage tests use native browser APIs (including IndexedDB), not jsdom,
fake-indexeddb, or global DOM polyfills. Mock only
scenario-specific boundaries within each spec, and restore them after the test. Keep
layout/scroll/animation regressions in real-browser tests; native-host behavior still
requires testing in the relevant Tauri client. Failed-test screenshots and attachments
are written to the repository's ignored `test-results/web-unit/` directory.

## Running end-to-end tests

From the repository root, run `npm run test:browser:install`, then
`npm run test:playground` for standalone mock UI regression. Federation browser
projects require the running lab. See [browser testing architecture](../docs/development/browser-testing.md)
for project selection, Pi exploration, and isolated build outputs.

## Further help

To get more help on the Angular CLI use `ng help` or go check out the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
