# Local Development

This guide covers source checkout, local initialization, database setup, and development commands.
For an operator installation, use the [deployment guide](../deployment/deployment.md) instead.

## Requirements

- Node.js 24
- npm
- Caddy
- A reachable PostgreSQL server

On Ubuntu, install the development edge with:

```bash
sudo apt-get update
sudo apt-get install caddy
```

The system service does not need to run. The development scripts start and stop their own Caddy
process with a repository-owned configuration.

## Initialize the Repository

```bash
git clone https://github.com/hapood/simple-open-messaging-service.git
cd simple-open-messaging-service

npm install
npm install --prefix web
npm install --prefix admin-web

cp .env.example .env
```

At minimum, configure a PostgreSQL connection:

```dotenv
DATABASE_URL=postgresql://username:password@localhost:5432/soms?schema=public
```

Review [`.env.example`](../../.env.example) for the remaining infrastructure settings. Never commit
`.env` or credentials. The federation lab overrides `SOMS_DOMAIN` with `alpha.test`, `bravo.test`,
and `charlie.test`; a repository-level domain is only relevant when running a backend outside the
lab.

## Initialize the Database

```bash
npm run db:migrate
npm run db:status
```

These commands operate on the single database named by the root `.env`. They are useful for schema
maintenance outside the federation lab. The lab backend command automatically creates and migrates
its isolated `soms_fed_lab_alpha`, `soms_fed_lab_bravo`, and `soms_fed_lab_charlie` databases, so a
manual migration is not required before `npm run dev:be`.

`database/migrations/0000_base.sql` is the greenfield baseline. It includes database functions,
triggers, the local namespace, and the internal system account. Future changes must use new
migration files. `npm run db:baseline` is only for adopting a compatible schema with no migration
history after reviewing its state.

Set `ADMIN_BOOTSTRAP_PASSWORD` before the first server start to create the initial `admin` account.
The bootstrap is a no-op after an administrator exists.

## Start the Development Stack

Build and run are separate. Launch the backend and frontend in separate terminals;
there is no combined `dev` command, and backend runtime commands never build automatically.

```bash
# Build the backend and compiled migration runner.
npm run build:be
# Terminal 1: start the three built backend processes.
npm run dev:be
```

```bash
# Terminal 2: start Angular/Vite with HMR through Caddy.
npm run dev:fe
```

The browser endpoints are `http://localhost:3101`, `http://localhost:3102`, and
`http://localhost:3103`; each node's admin console is available below `/admin/`.
Backend source changes require rebuilding and restarting `dev:be`. Frontend source
changes are applied through HMR. To inspect static build outputs instead, run
`npm run build:fe` followed by `npm run dev:fe:built`.
`dev:fe` does not access PostgreSQL.

`npm run build` remains the backend build entry point. `npm run build:development`
builds the backend and both frontends without starting processes. Use
`npm run build:production` for optimized deployment assets without source maps.

See the [federation lab guide](../../dev/federation-lab/README.md) for topology,
persistent data, browser session isolation, and reset instructions. To remove the
three lab databases and their runtime state, stop the processes and run
`npm run dev:reset`. The automated `npm run federation:test` command always resets
before starting its own backends and collecting diagnostics; build the backend first.

## Build and Test

```bash
npm run build
npm run build:production
npm test
npm run test:e2e
npm run federation:conformance

npm run build --prefix web
npm run build:development --prefix web
npm run test:build --prefix web
npm test --prefix web

npm run build --prefix admin-web
npm run build:development --prefix admin-web
npm test --prefix admin-web
```

The root `build` command compiles only the backend and migration runner. `build:production` checks
version synchronization and builds the backend and both optimized frontends. `build:fe` builds both
frontends using their `build:development` entry points. Frontend scripts use `development` rather
than `debug`; native APK build types retain their `debug`/`release` names.

The Angular client has these one-shot build entry points (run with `npm --prefix web run ...`):

| Script              | Default configuration | Output                        |
| ------------------- | --------------------- | ----------------------------- |
| `build`             | `production`          | `web/dist/web/browser`        |
| `build:development` | `development`         | `web/dist/web/browser`        |
| `build:native`      | `production`          | `web/dist/native/browser`     |
| `build:playground`  | `playground`          | `web/dist/playground/browser` |

All four share the same build runner: generate and type-check the push worker, build with AOT,
validate native artifacts when applicable, then inline emitted source maps in that target's output.
Use `-- --configuration development` or `-- --configuration automation` with `build:native` for
non-production builds. Additional Angular arguments such as `--base-href` are forwarded, but AOT,
output paths, and native bundle metadata are owned by the build runner and cannot be overridden.
`verify:native` separately validates reused native artifacts before packaging.

`start` and `start:playground` share worker preparation and use Angular's development server.
`watch` prepares the worker and delegates continuous builds to Angular. These long-running commands
keep external source maps rather than running one-shot postprocessing against active rebuilds.
Application builds default to AOT; the unit-test configuration explicitly uses JIT where required
by the test runner. `test:build` exercises the build pipeline, native validation and map processing.

`federation:conformance` validates the independently versioned protocol release and is not part of
the development startup chain.

See [AGENTS.md](../../AGENTS.md) for repository layout, coding conventions, and additional commands.
