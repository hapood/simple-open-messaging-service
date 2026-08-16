# Local Development

This guide covers source checkout, local initialization, database setup, and development commands.
For an operator installation, use the [Docker deployment guide](deployment.md) instead.

## Requirements

- Node.js 24
- npm
- A reachable PostgreSQL server

## Initialize the Repository

```bash
git clone https://github.com/hapood/simple-open-chat-service.git
cd simple-open-chat-service

npm install
npm install --prefix web
npm install --prefix admin-web

cp .env.example .env
```

At minimum, configure a PostgreSQL connection and a development federation identity:

```dotenv
DATABASE_URL=postgresql://username:password@localhost:5432/soms?schema=public
SOMS_DOMAIN=aaa.local
```

Review [`.env.example`](../.env.example) for the remaining infrastructure settings. Never commit
`.env` or credentials.

## Initialize the Database

```bash
npm run db:migrate
npm run db:status
```

`database/migrations/0000_base.sql` is the greenfield baseline. Because migration history was
compacted, the runner rejects a database containing a mixed legacy and current migration ledger.
Use `npm run db:baseline` only when adopting a compatible existing schema after reviewing its state.

Set `ADMIN_BOOTSTRAP_PASSWORD` before the first server start to create the initial `admin` account.
The bootstrap is a no-op after an administrator exists.

## Start the Development Stack

```bash
npm run dev
```

This starts the NestJS API, Angular client, Vite administration console, and development web-bundle
watcher. The API normally listens on `http://localhost:3000` and Angular on
`http://localhost:4200`. The backend-free UI playground is available at `/playground/chatbox`.

Run one part independently when needed:

```bash
npm run start:dev
npm start --prefix web
npm run dev --prefix admin-web
```

## Build and Test

```bash
npm run build
npm test
npm run test:e2e
npm run federation:conformance

npm run build --prefix web
npm test --prefix web

npm run build --prefix admin-web
npm test --prefix admin-web
```

See [AGENTS.md](../AGENTS.md) for repository layout, coding conventions, and additional commands.
