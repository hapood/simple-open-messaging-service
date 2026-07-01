// E2E environment bootstrap — runs in each Jest worker before tests.
//
// Loads the dev `.env` for the JWT secrets etc., then forces the database to the
// isolated `soms_test` instance so the suite can never touch dev data. The DB name
// is rewritten (last URL path segment) so this stays correct regardless of the
// credentials/host configured in `.env`.
import 'dotenv/config';

function toTestDatabase(url: string): string {
  return url.replace(/^(.*\/)[^/?]*(\?.*)?$/, '$1soms_test$2');
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL missing — copy .env.example to .env and configure it.',
  );
}
process.env.DATABASE_URL = toTestDatabase(process.env.DATABASE_URL);
