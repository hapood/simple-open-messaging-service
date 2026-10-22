import { drizzle } from 'drizzle-orm/node-postgres';
import { DatabaseService } from '../src/database/database.service.js';
import { databaseSchema } from '../src/database/database-schema.js';

/** A DatabaseService view whose db records the business-scope advisory lock
 * keys (pg_advisory_xact_lock) acquired through it, in acquisition order for
 * lock-order assertions. */
export function withBusinessLockCapture(
  database: DatabaseService,
  locks: string[],
): DatabaseService {
  const capture = Object.create(database) as DatabaseService;
  Object.defineProperty(capture, 'db', {
    value: drizzle({
      client: database.pool,
      schema: databaseSchema,
      logger: {
        logQuery(query: string, params: unknown[]) {
          if (
            query.includes('pg_advisory_xact_lock') &&
            typeof params[0] === 'string'
          )
            locks.push(params[0]);
        },
      },
    }),
  });
  return capture;
}
