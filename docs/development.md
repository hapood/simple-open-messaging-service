# Local Development

This guide covers source checkout, local initialization, database setup, and development commands.
For an operator installation, use the published [NAS deployment guide](deployment.md) instead. The
internet-facing server deployment guide is still being written.

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

Review [`.env.example`](../.env.example) for the remaining infrastructure settings. Never commit
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
manual migration is not required before `npm run dev`.

`database/migrations/0000_base.sql` is the greenfield baseline. Because migration history was
compacted, the runner rejects a database containing a mixed legacy and current migration ledger.
Use `npm run db:baseline` only when adopting a compatible existing schema after reviewing its state.

Set `ADMIN_BOOTSTRAP_PASSWORD` before the first server start to create the initial `admin` account.
The bootstrap is a no-op after an administrator exists.

## Start the Development Stack

The frontend has three intentionally separate build profiles:

| Profile            | Command                    | Hashing | Source maps | Runtime                                       |
| ------------------ | -------------------------- | ------- | ----------- | --------------------------------------------- |
| Development server | `npm run dev`              | No      | Yes         | Angular/Vite HMR through the federation edges |
| Development build  | `npm run dev:built`        | Yes     | Yes         | Prebuilt, unminified static assets            |
| Production build   | `npm run build:production` | Yes     | No          | Optimized deployment assets                   |

```bash
npm run dev
```

This builds the backend, starts the Angular and Vite development servers with HMR and unhashed
in-memory frontend assets, and exposes both through three local Caddy edges. The browser endpoints
are `http://localhost:3101`, `http://localhost:3102`, and `http://localhost:3103`; each node's admin
console is available below `/admin/`. Continue using the `310x` endpoints rather than opening the
frontend development-server ports directly, because each edge routes API traffic to the matching
federation node.

The two process groups can also be restarted independently in separate terminals:

```bash
npm run dev:backend
npm run dev:frontend
```

`dev:backend` builds and starts the three Node processes. Backend source changes require restarting
this process group. `dev:frontend` starts the shared Angular and Vite dev servers plus Caddy, does not
access PostgreSQL, and applies frontend changes through HMR.

To verify the same prebuilt frontend assets used by deployment, run:

```bash
npm run dev:built
```

This builds all three applications with development source maps, packages the client update bundle,
and serves the resulting static assets. See the [federation lab guide](../dev/federation-lab/README.md)
for topology, persistent data, browser session isolation, and reset instructions.

When the built backend is already running separately, rebuild and restart only the static frontend
group with:

```bash
npm run dev:frontend:build
npm run dev:frontend:built
```

To permanently remove the three lab databases and their local runtime state, stop both process
groups and explicitly run `npm run dev:reset`.

## Build and Test

```bash
npm run build
npm run build:production
npm test
npm run test:e2e
npm run federation:conformance

npm run build --prefix web
npm test --prefix web

npm run build --prefix admin-web
npm test --prefix admin-web
```

The root `build` command compiles only the backend and migration runner. `build:production` checks
version synchronization, builds the backend and both optimized frontends, and packages the web
client update bundle. `federation:conformance` validates the independently versioned protocol
release and is not part of the development startup chain.

See [AGENTS.md](../AGENTS.md) for repository layout, coding conventions, and additional commands.
