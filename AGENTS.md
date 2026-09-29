# Repository Guidelines

## Guiding Principle

Make technical decisions according to the best practice for the scenario rather
than development cost. Do not trade correctness, security, maintainability, or
architectural cleanliness for faster delivery, fewer changes, or lower
regression risk. This does not imply rewriting by default: make the smallest
change when that is the best solution, and accept a larger change when it is
necessary.

## Project Structure & Module Organization

The NestJS API lives in `src/`. Keep domain logic in feature directories such as
`src/message/` or `src/auth/`, HTTP handlers in `src/controller/`, and shared
types/utilities in `src/common/` and `src/dto/`. Drizzle schema and relations are
under `src/database/`; SQL migrations are under `database/migrations/`. Unit tests sit beside source files as
`*.spec.ts`; PostgreSQL-backed end-to-end tests live in `test/` as
`*.e2e-spec.ts`.

Organize backend code by domain first. Domain-owned behavior belongs directly
under `src/<domain>/`, using meaningful nested capability directories such as
`src/group/membership-intent/`, `src/group/meta/`, or `src/group/shared/` when
another level is warranted. Put a primitive
in `src/common/` only when it is genuinely shared by multiple domains and has
no natural domain owner. New business methods must use this layout. Migrate
older services incrementally with behavior-preserving changes when their area
is being worked on; a legacy service may remain as a thin facade while callers
are transitioned.

Durable tasks are an execution mechanism, not a replacement for the domain
model. Keep the generic scheduler, store, dispatcher, and task contracts in
`src/durable-task/`. Keep task payloads and handlers with their owning domain,
using a domain-local `task/` directory when their number warrants it. A handler
should validate and decode the task, coordinate checkpoint/retry semantics, and
delegate domain decisions to the owning `src/<domain>/` capability.
Task-specific durable orchestration may remain in the handler, but reusable
business rules must not be implemented only in a task handler. The generic
durable-task infrastructure must not import domain implementations.

The Angular user client is in `web/`, the Vite administration console in
`admin-web/`, and Tauri/native code in `src-tauri/`. Deployment templates are
under `deploy/`; architecture and protocol documentation belongs in `docs/`.

## Build, Test, and Development Commands

- `npm install` installs backend dependencies.
- `npm install --prefix web && npm install --prefix admin-web` installs both UIs.
- `npm run build:be` and `npm run build:fe` build the backend and frontends.
- `npm run dev:be` runs the built backend; `npm run dev:fe` runs frontend HMR in a separate terminal.
- `npm run dev:fe:built` serves prebuilt frontend assets.
- `npm run federation:test` resets lab databases and runs the built backend workload with diagnostics.
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

Write code comments and documentation in English. Do not mix languages within
a single file or document.

## Documentation References

Keep source code and documentation decoupled: references run from documentation
to source, never from source to documentation. Markdown documentation may link
to source files for context. Source files, SQL, and configuration must explain
their behavior directly and must not refer to documentation paths. This keeps
source comments valid when documentation is reorganized.

## CSS Integer-Pixel Rule

Every value contributing to an element's rendered height must be an integer
number of CSS pixels. This includes `height`, `min-height`, `max-height`,
vertical padding, vertical border width, vertical gap, and especially
`line-height`. Use an integer pixel length such as `line-height: 20px`; do not
use unitless, `em`, or `normal` line heights for measured content.

This rule keeps the virtual-scroll height model, which sums integer
`offsetHeight` values, aligned with `scrollHeight`. Horizontal sizing may be
fractional because it changes only the number of wrapped lines. Fractional
values are also acceptable for non-box visual properties such as opacity,
transforms, shadows, gradient angles, border radii, and animation timing.

Keep inline content no taller than its line height. Oversized emoji or inline
images can expand a line box beyond its declared integer height; chat images
instead belong in album rows whose layout rounds every cell height.

Do not replace `offsetHeight` with `getBoundingClientRect().height` to address
height drift. Bounding rectangles include active scale transforms from chat-box
animations and would introduce measurement jitter. Keep `offsetHeight` as the
transform-invariant measurement API and enforce integer heights in CSS.

## Database Concurrency and Locking

Use MVCC reads and preserve concurrency with foreign-key checks. Prefer
`FOR NO KEY UPDATE` for non-key read-modify-write operations. Avoid `FOR UPDATE`
unless physical deletion or referenced-key protection requires it; explain the
reason in source. Ordinary `SELECT` queries need no row lock. Do not use
`FOR SHARE` as a default before writing, or upgrade a non-key write lock later
in the transaction. Keep lock modes consistent across helpers and triggers,
while preserving the established resource acquisition order.

Read federation authorization and page data in one read-only repeatable-read
snapshot. Validate captured authorization epochs atomically when committing
round writes, and retain commit-time audience checks for changes not covered
by an epoch. Verify concurrency changes with PostgreSQL-backed tests.

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
