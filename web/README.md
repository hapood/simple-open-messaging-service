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

Run `ng test` to execute the unit tests via [Vitest](https://vitest.dev/).

## Running end-to-end tests

Run `ng e2e` to execute the end-to-end tests via a platform of your choice. To use this command, you need to first add a package that implements end-to-end testing capabilities.

## Further help

To get more help on the Angular CLI use `ng help` or go check out the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
