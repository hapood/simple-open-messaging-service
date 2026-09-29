import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import { account, message, messageThread } from '../src/database/schema.js';
import { systemAccountIdInTx } from '../src/user/system-account.js';
import { UserService } from '../src/user/user.service.js';

describe('system account attribution', () => {
  let database: DatabaseService;
  let systemId: number;
  beforeAll(async () => {
    database = new DatabaseService();
    systemId = await database.db.transaction(systemAccountIdInTx);
  });
  afterAll(async () => database.onApplicationShutdown());

  it('provisions an internal identity that cannot authenticate or publish a profile', async () => {
    const system = await database.db.query.account.findFirst({
      where: eq(account.id, systemId),
    });
    expect(system).toMatchObject({
      account: '$system',
      kind: 'SYSTEM',
      hashPwd: null,
      defaultProfileRev: 0,
    });
    expect(system?.disabledAt).toBeInstanceOf(Date);
    for (const changes of [
      { disabledAt: null },
      { hashPwd: 'a-password-hash' },
      { defaultProfileRev: 1 },
      { kind: 'USER' },
    ]) {
      await expect(
        database.db
          .update(account)
          .set(changes)
          .where(eq(account.id, systemId)),
      ).rejects.toThrow();
    }
    const users = new UserService(database);
    expect(await users.searchUsers('system', { take: 10 })).toEqual({
      list: [],
      total: 0,
    });
    expect(() =>
      users.addUser({ account: '$system', name: 'Impersonator' }),
    ).toThrow();
  });

  it('enforces the reserved system sender independently of event participants', async () => {
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: new Date() })
      .returning();
    const notification = {
      threadId: thread.id,
      seq: 1,
      contentType: 'SYSTEM' as const,
      creatorAccount: '$system',
      creatorDomain: 'local',
      content: JSON.stringify({
        type: 'GROUP_JOINED',
        member: { account: 'alice', domain: 'local' },
      }),
      updatedAt: new Date(),
    };
    const [stored] = await database.db
      .insert(message)
      .values(notification)
      .returning();
    expect(stored).toMatchObject({
      creatorAccount: '$system',
      creatorDomain: 'local',
      profileNamespaceId: 0,
      profileRev: 0,
      sourceNamespaceId: 0,
    });
    for (const invalid of [
      { creatorAccount: 'alice' },
      { creatorAccount: null, creatorDomain: null },
      { profileRev: 1 },
      { contentType: 'PURE_TEXT' as const },
    ]) {
      await expect(
        database.db
          .insert(message)
          .values({ ...notification, seq: 2, ...invalid }),
      ).rejects.toThrow();
    }
  });
});
