import { eq } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { account, admin } from '../database/schema.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

/** Lock before checking authorization so a concurrent grant cannot bypass protection.
 * Administrator accounts (including disabled grants) use dedicated security and
 * access-management operations, never user impersonation or generic account mutations.
 */
export async function lockOrdinaryAccount(
  tx: DatabaseTransaction,
  userId: number,
) {
  const [target] = await tx
    .select()
    .from(account)
    .where(eq(account.id, userId))
    .for('no key update');
  if (!target || target.namespaceId !== 0)
    throw new BusinessException(BusinessCode.NOT_FOUND, 'local user not found');
  const operator = await tx.query.admin.findFirst({
    where: eq(admin.userId, userId),
    columns: { id: true },
  });
  if (operator)
    throw new BusinessException(
      BusinessCode.FORBIDDEN,
      'administrator accounts require dedicated account security and access management',
    );
  return target;
}
