import * as relations from './relations.js';
import * as schema from './schema.js';

/** Tables and relations used by every Drizzle database instance. */
export const databaseSchema = { ...schema, ...relations };
