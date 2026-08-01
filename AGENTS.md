# Repository Guidelines

## Project Structure & Module Organization

The NestJS API lives in `src/`. Keep domain logic in feature directories such as
`src/message/` or `src/auth/`, HTTP handlers in `src/controller/`, and shared
types/utilities in `src/common/` and `src/dto/`. Drizzle schema and relations are
under `src/database/`; SQL migrations are under `database/migrations/`. Unit tests sit beside source files as
`*.spec.ts`; PostgreSQL-backed end-to-end tests live in `test/` as
`*.e2e-spec.ts`.

The Angular user client is in `web/`, the Vite administration console in
`admin-web/`, and Tauri/native code in `src-tauri/`. Deployment templates are
under `deploy/`; architecture and protocol documentation belongs in `docs/`.

## Build, Test, and Development Commands

- `npm install` installs backend dependencies.
- `npm install --prefix web && npm install --prefix admin-web` installs both UIs.
- `npm run dev` starts the API, bundle watcher, Angular client, and admin console.
- `npm run build` compiles the API; run it with `--prefix web` or
  `--prefix admin-web` to build a UI.
- `npm run db:migrate` applies existing database migrations; `npm run db:status`
  reports their state.
- `npm test` runs backend unit tests; `npm run test:e2e` runs integration tests
  against PostgreSQL.
- `npm run lint` fixes lint issues; `npm run format` applies Prettier.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, single quotes, and trailing commas,
as enforced by Prettier and ESLint. Follow NestJS suffixes such as
`*.controller.ts`, `*.service.ts`, `*.module.ts`, and `*.guard.ts`. Use
PascalCase for classes/types, camelCase for variables and functions, and
kebab-case for filenames and Angular component directories. Prefer focused
feature modules.

## Testing Guidelines

Vitest is the backend and admin test runner; Angular uses `ng test`. Add or
update tests with behavior changes. E2E tests use the isolated database
configured by `test/global-setup.ts`; ensure PostgreSQL is reachable. No fixed
coverage threshold is enforced; use `npm run test:cov` for substantial changes.

## Commit & Pull Request Guidelines

History follows Conventional Commit-style subjects, commonly
`feat(scope):`, `fix(scope):`, `test(scope):`, `docs(scope):`, and `chore(scope):`.
Write imperative, narrowly scoped commits. Pull requests should explain the
solution, list verification commands, link issues, call out migrations or
configuration changes, and include screenshots for visible UI changes.

## Security & Configuration

Copy `.env.example` to `.env` and never commit credentials. Treat
`DATABASE_URL`, bootstrap passwords, signing keys, and DNS provider tokens as
secrets. Keep `src/database/schema.ts` and SQL migrations in sync. Add deployed
schema changes through a new SQL migration; never rewrite one that may already be deployed.
