import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma 7 CLI config (replaces the CLI use of datasource.url in the schema).
// `import 'dotenv/config'` lets the CLI (migrate/generate) auto-load .env,
// so manual `source .env` before running is no longer needed.
// Uses process.env instead of the type-safe env(): generate does not need a connection string,
// so generate still runs when DATABASE_URL is unset (postinstall scenario).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL,
  },
  migrations: {
    path: 'prisma/migrations',
  },
});
