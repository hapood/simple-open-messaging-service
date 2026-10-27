import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { inArray, sql } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { relationshipIntent } from '../src/database/schema.js';
import {
  authoredIntentWriteSql,
  relationshipIntentPromotionSql,
} from '../src/common/sql/authored-relationship-intent-sql.js';
import { receivedUserIntentWriteSql } from '../src/user/p2p-intent/received/received-user-intent-write-sql.js';

describe('author-owned intent transition times', () => {
  let database: DatabaseService;
  let mod: TestingModule;
  const authors = ['time-authored', 'time-promoted', 'time-received'];
  const receiver = { account: 'time-target', namespaceId: 0 };
  const requestTime = new Date(Date.now() - 60_000);
  const ackTime = new Date(Date.now() - 30_000);
  const revokeTime = new Date(Date.now() - 10_000);

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });
  afterAll(async () => {
    await database.db
      .delete(relationshipIntent)
      .where(inArray(relationshipIntent.authorAccount, authors));
    await mod.close();
  });

  const author = (index: number) => ({
    account: authors[index],
    namespaceId: 0,
  });
  const read = (index: number) =>
    database.db.query.relationshipIntent.findFirst({
      where: inArray(relationshipIntent.authorAccount, [authors[index]]),
    });

  it('records ACK and revocation times instead of retaining request time', async () => {
    await database.db.execute(
      authoredIntentWriteSql({
        author: author(0),
        receiver,
        threadId: null,
        status: 'REQUESTED',
        note: '',
        statusChangedAt: requestTime,
        expiresAt: new Date(Date.now() + 60_000),
        snapshot: { displayName: 'Target', avatar: null },
      }),
    );
    const initial = (await read(0))!;
    await database.db.execute(
      authoredIntentWriteSql({
        author: author(0),
        receiver,
        threadId: null,
        status: 'ACCEPTED',
        note: '',
        statusChangedAt: ackTime,
        expiresAt: null,
      }),
    );
    expect((await read(0))!.statusChangedAt).toEqual(ackTime);
    await database.db.execute(
      authoredIntentWriteSql({
        author: author(0),
        receiver,
        threadId: null,
        status: 'REVOKED',
        note: '',
        statusChangedAt: revokeTime,
        expiresAt: null,
      }),
    );
    const revoked = (await read(0))!;
    expect(revoked.statusChangedAt).toEqual(revokeTime);
    expect(revoked.createdAt).toEqual(initial.createdAt);
    // Even a metadata change in the same state is not a new transition.
    await database.db.execute(
      authoredIntentWriteSql({
        author: author(0),
        receiver,
        threadId: null,
        status: 'REVOKED',
        note: 'same state',
        statusChangedAt: new Date(),
        expiresAt: null,
      }),
    );
    expect((await read(0))!.statusChangedAt).toEqual(revokeTime);
  });

  it('timestamps a local REQUESTED-to-ACCEPTED promotion and preserves it on retry', async () => {
    await database.db.execute(
      authoredIntentWriteSql({
        author: author(1),
        receiver,
        threadId: null,
        status: 'REQUESTED',
        note: 'keep note',
        statusChangedAt: requestTime,
        expiresAt: new Date(Date.now() + 60_000),
        snapshot: { displayName: 'Target', avatar: null },
      }),
    );
    await database.db.execute(
      relationshipIntentPromotionSql({ author: author(1), receiver }),
    );
    const promoted = (await read(1))!;
    expect(promoted.status).toBe('ACCEPTED');
    expect(promoted.note).toBe('keep note');
    expect(promoted.statusChangedAt.getTime()).toBeGreaterThan(
      requestTime.getTime(),
    );
    expect(promoted.expiresAt).toBeNull();
    await database.db.execute(
      relationshipIntentPromotionSql({ author: author(1), receiver }),
    );
    expect((await read(1))!.statusChangedAt).toEqual(promoted.statusChangedAt);
  });

  it('preserves received author times, including a revocation and backwards clock', async () => {
    const write = (status: 'ACCEPTED' | 'REVOKED', time: Date) =>
      receivedUserIntentWriteSql({
        author: author(2),
        receiver,
        status,
        profileNamespaceId: 0,
        profileRev: 0,
        note: '',
        statusChangedAt: time,
        expiresAt: null,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
      });
    await database.db.execute(write('ACCEPTED', ackTime));
    expect((await read(2))!.statusChangedAt).toEqual(ackTime);
    // Admission/order is the caller's responsibility, not a wall-clock comparison.
    await database.db.execute(write('REVOKED', requestTime));
    expect((await read(2))!.statusChangedAt).toEqual(requestTime);
    const duplicate = await database.db.execute(write('REVOKED', requestTime));
    expect(duplicate.rows).toEqual([]);
  });

  it('requires a non-null author timestamp with no local default', async () => {
    await expect(
      database.db.execute(sql`
      INSERT INTO "RelationshipIntent" ("authorAccount", "authorNamespaceId",
        "receiverAccount", "receiverNamespaceId", status, "profileNamespaceId",
        "profileRev", "messageEndSeq", "tombstoneEndSeq")
      VALUES ('missing-time', 0, 'time-target', 0, 'REVOKED', 0, 0, 0, 0)
    `),
    ).rejects.toMatchObject({
      cause: { code: '23502', column: 'statusChangedAt' },
    });
  });
});
