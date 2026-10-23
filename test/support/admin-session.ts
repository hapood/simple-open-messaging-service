import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseService } from '../../src/database/database.service.js';
import { adminSession } from '../../src/database/schema.js';

/** Test fixture only: RBAC tests seed a credential without a password login. */
export async function seedAdminSession(
  database: DatabaseService,
  adminId: number,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await database.db.insert(adminSession).values({
    adminId,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
  });
  return token;
}
